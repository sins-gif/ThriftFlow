/**
 * 参与者：库存分支服务（Try / Confirm / Cancel 三个幂等入口）。
 *
 * 每个入口都遵循同一个模板：
 *   1. 开启本地事务（行锁）；
 *   2. 读分支行（不存在 → 视为 INIT）；
 *   3. 交给状态机裁决（apply / noop / reject）；
 *   4. 只有 apply 才允许改库存，且库存变更与分支行变更同事务提交；
 *   5. 提交后返回，失败一律回滚 → 保证"要么冻结成功且留痕，要么什么都没发生"。
 *
 * 幂等键 = (xid, branchId)，由存储层的唯一约束兜底；
 * 状态机的 noop 分支保证重复请求不会二次冻结/二次实扣。
 */

import { decideBranch, describeDecision } from './state-machine.ts';
import type {
  BranchCommand,
  BranchId,
  BranchEvent,
  BranchReply,
  BranchStatus,
  Clock,
  InventoryTccParticipant,
  Logger,
  StockLedger,
  TransactionManager,
  UnitOfWork,
} from './types.ts';
import { TccError } from './types.ts';

export interface InventoryServiceDeps {
  readonly tm: TransactionManager;
  readonly clock: Clock;
  readonly log: Logger;
}

const okReply = (status: BranchStatus, idempotent: boolean): BranchReply => ({
  ok: true,
  status,
  idempotent,
  code: null,
  message: null,
});

const badReply = (
  status: BranchStatus,
  code: NonNullable<BranchReply['code']>,
  message: string,
): BranchReply => ({ ok: false, status, idempotent: false, code, message });

/** 组装一条新的分支行；version 严格 +1，满足存储层 CAS 要求。 */
function withStatus(
  cmd: BranchCommand,
  status: BranchStatus,
  now: number,
  prev: BranchRecordLike | undefined,
  lastError: string | null = null,
): BranchRecordLike {
  return {
    xid: cmd.xid,
    branchId: cmd.branchId,
    sku: cmd.sku,
    qty: cmd.qty,
    status,
    version: (prev?.version ?? 0) + 1,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
    lastError,
  };
}

type BranchRecordLike = import('./types.ts').BranchRecord;

export class InventoryTccService implements InventoryTccParticipant {
  private readonly tm: TransactionManager;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(deps: InventoryServiceDeps) {
    this.tm = deps.tm;
    this.clock = deps.clock;
    this.log = deps.log;
  }

  try(cmd: BranchCommand): Promise<BranchReply> {
    return this.tm.run((uow) => this.applyTry(uow, cmd));
  }

  confirm(cmd: BranchCommand): Promise<BranchReply> {
    return this.tm.run((uow) => this.applyConfirm(uow, cmd));
  }

  cancel(cmd: BranchCommand): Promise<BranchReply> {
    return this.tm.run((uow) => this.applyCancel(uow, cmd));
  }

  // -------------------------------------------------------------------------
  // Try：冻结
  // -------------------------------------------------------------------------

  private applyTry(uow: UnitOfWork, cmd: BranchCommand): BranchReply {
    const now = this.clock.now();
    const prev = uow.getBranch(cmd.xid, cmd.branchId);
    const from: BranchStatus = prev?.status ?? 'INIT';
    const decision = decideBranch(from, 'TRY');

    if (decision.kind === 'reject') {
      if (prev) uow.putBranch(withStatus(cmd, prev.status, now, prev, decision.code));
      this.log.warn('branch.try.rejected', { xid: cmd.xid, branchId: cmd.branchId, from, code: decision.code });
      return badReply(from, decision.code, decision.reason);
    }

    if (decision.kind === 'noop') {
      this.log.info('branch.try.noop', { xid: cmd.xid, branchId: cmd.branchId, status: from });
      return okReply(from, true);
    }

    const ledger = this.requireLedger(uow, cmd);

    // 库存不足：不做任何资源动作，只记一次失败尝试，便于审计"为什么没扣成"。
    if (decision.effect === 'FREEZE' && ledger.available < cmd.qty) {
      uow.putBranch(withStatus(cmd, prev?.status ?? 'INIT', now, prev, 'INSUFFICIENT_STOCK'));
      this.log.warn('branch.try.insufficient', {
        xid: cmd.xid,
        branchId: cmd.branchId,
        available: ledger.available,
        qty: cmd.qty,
      });
      return badReply(prev?.status ?? 'INIT', 'INSUFFICIENT_STOCK', '可用库存不足');
    }

    this.applyEffect(uow, decision.effect, ledger, cmd.qty);
    uow.putBranch(withStatus(cmd, decision.to, now, prev));
    this.log.info('branch.try.applied', {
      xid: cmd.xid,
      branchId: cmd.branchId,
      note: describeDecision(decision),
    });
    return okReply(decision.to, false);
  }

  // -------------------------------------------------------------------------
  // Confirm：冻结转实扣（不可逆，幂等）
  // -------------------------------------------------------------------------

  private applyConfirm(uow: UnitOfWork, cmd: BranchCommand): BranchReply {
    const now = this.clock.now();
    const prev = uow.getBranch(cmd.xid, cmd.branchId);
    const from: BranchStatus = prev?.status ?? 'INIT';
    const decision = decideBranch(from, 'CONFIRM');

    if (!prev) {
      // 分支行不存在 = Try 一定没提交成功。绝不能凭空实扣，交给协调者重试/补 Try。
      this.log.warn('branch.confirm.unknown', { xid: cmd.xid, branchId: cmd.branchId });
      return badReply('INIT', 'BRANCH_NOT_FOUND', 'Try 尚未落库，Confirm 不可执行');
    }

    if (decision.kind === 'reject') {
      uow.putBranch(withStatus(cmd, prev.status, now, prev, decision.code));
      this.log.error('branch.confirm.rejected', {
        xid: cmd.xid,
        branchId: cmd.branchId,
        from,
        code: decision.code,
      });
      return badReply(from, decision.code, decision.reason);
    }

    if (decision.kind === 'noop') {
      this.log.info('branch.confirm.noop', { xid: cmd.xid, branchId: cmd.branchId, status: from });
      return okReply(from, true);
    }

    const ledger = this.requireLedger(uow, cmd);
    this.applyEffect(uow, decision.effect, ledger, cmd.qty);
    uow.putBranch(withStatus(cmd, decision.to, now, prev));
    this.log.info('branch.confirm.applied', {
      xid: cmd.xid,
      branchId: cmd.branchId,
      note: describeDecision(decision),
    });
    return okReply(decision.to, false);
  }

  // -------------------------------------------------------------------------
  // Cancel：释放冻结 / 空回滚
  // -------------------------------------------------------------------------

  private applyCancel(uow: UnitOfWork, cmd: BranchCommand): BranchReply {
    const now = this.clock.now();
    const prev = uow.getBranch(cmd.xid, cmd.branchId);
    const from: BranchStatus = prev?.status ?? 'INIT';
    const decision = decideBranch(from, 'CANCEL');

    if (decision.kind === 'reject') {
      if (prev) uow.putBranch(withStatus(cmd, prev.status, now, prev, decision.code));
      this.log.error('branch.cancel.rejected', {
        xid: cmd.xid,
        branchId: cmd.branchId,
        from,
        code: decision.code,
      });
      return badReply(from, decision.code, decision.reason);
    }

    if (decision.kind === 'noop') {
      this.log.info('branch.cancel.noop', { xid: cmd.xid, branchId: cmd.branchId, status: from });
      return okReply(from, true);
    }

    if (decision.effect === 'RELEASE') {
      const ledger = this.requireLedger(uow, cmd);
      this.applyEffect(uow, decision.effect, ledger, cmd.qty);
    }
    // EMPTY_CANCELLED：只写墓碑，不碰库存 —— 这正是"空回滚"的定义。
    uow.putBranch(withStatus(cmd, decision.to, now, prev));
    this.log.info('branch.cancel.applied', {
      xid: cmd.xid,
      branchId: cmd.branchId,
      emptyRollback: decision.effect === 'NONE',
      note: describeDecision(decision),
    });
    return okReply(decision.to, false);
  }

  // -------------------------------------------------------------------------
  // 账务副作用：三个动作都必须原子且可逆守恒
  // -------------------------------------------------------------------------

  private applyEffect(
    uow: UnitOfWork,
    effect: 'FREEZE' | 'SETTLE' | 'RELEASE' | 'NONE',
    ledger: StockLedger,
    qty: number,
  ): void {
    let next: StockLedger;
    switch (effect) {
      case 'FREEZE':
        if (ledger.available < qty) {
          throw new TccError('INSUFFICIENT_STOCK', '冻结失败：可用不足');
        }
        next = { ...ledger, available: ledger.available - qty, frozen: ledger.frozen + qty };
        break;
      case 'SETTLE':
        if (ledger.frozen < qty) {
          // 到这里说明冻结记录与台账不一致，属于数据损坏，必须熔断并人工介入。
          throw new TccError(
            'STORAGE',
            `实扣失败：冻结量 ${ledger.frozen} < 扣减量 ${qty}，台账已损坏`,
          );
        }
        next = { ...ledger, frozen: ledger.frozen - qty, sold: ledger.sold + qty };
        break;
      case 'RELEASE':
        if (ledger.frozen < qty) {
          throw new TccError('STORAGE', `释放失败：冻结量 ${ledger.frozen} < 扣减量 ${qty}`);
        }
        next = { ...ledger, frozen: ledger.frozen - qty, available: ledger.available + qty };
        break;
      case 'NONE':
        return;
    }
    uow.putLedger(next);
  }

  private requireLedger(uow: UnitOfWork, cmd: BranchCommand): StockLedger {
    const ledger = uow.getLedger(cmd.sku);
    if (!ledger) throw new TccError('UNKNOWN_SKU', `未知 SKU：${cmd.sku}`);
    return ledger;
  }
}

export type { BranchEvent, BranchId };
