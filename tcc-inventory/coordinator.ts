/**
 * 协调者：把一组分支串成一次 TCC 事务，并负责崩溃恢复。
 *
 * 在线路径（execute = begin + commit / abort）：
 *   begin  —— 落 TRYING → 逐分支 Try（超时=未知，同 xid 重试；幂等由参与者保证）
 *   commit —— 落 CONFIRMING → 逐分支 Confirm；拿到确定答复的结清，
 *             拿不到的写入 outbox，转异步最大努力通知
 *   abort  —— 落 CANCELLING → 逐分支 Cancel（同样允许转异步）
 *
 * 关键不变量：
 *   1. 状态只沿 TX_TABLE 走，CONFIRMING 不存在回到 CANCELLING 的边；
 *   2. Try 超时不被判成失败，只有明确的否定答复（如 INSUFFICIENT_STOCK）才算失败；
 *   3. 任何未终结事务都会被 recover() 重放，重放指令全部幂等，
 *      因此"重放任意多次"与"执行一次"效果等价。
 */

import { canTransitionTx } from './state-machine.ts';
import type {
  BranchId,
  BranchRef,
  BranchReply,
  Clock,
  ExecuteOutcome,
  ExecutePlan,
  IdGenerator,
  InventoryTccParticipant,
  Logger,
  OutboxMessage,
  RetryPolicy,
  TccErrorCode,
  TccTxStatus,
  TransactionManager,
  Xid,
} from './types.ts';
import { TccError, backoffDelay } from './types.ts';

export interface CoordinatorDeps {
  readonly tm: TransactionManager;
  readonly client: InventoryTccParticipant;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly log: Logger;
  readonly policy: RetryPolicy;
  readonly rng?: () => number;
}

export interface TryPhase {
  readonly tried: readonly BranchId[];
  readonly failed: readonly BranchId[];
  readonly status: TccTxStatus;
}

export interface CommitPhase {
  readonly status: TccTxStatus;
  readonly pending: readonly BranchId[];
  readonly conflicts: readonly BranchId[];
}

export interface AbortPhase {
  readonly status: TccTxStatus;
  readonly pending: readonly BranchId[];
}

export interface RecoveryStats {
  readonly scanned: number;
  readonly confirmed: number;
  readonly cancelled: number;
  readonly stillOpen: number;
}

type OneShot = 'ok' | 'retry' | 'rejected';

/** 结果未知或状态未就绪 → 只能重试，绝不能判失败。 */
const RETRYABLE_CODES: ReadonlySet<TccErrorCode> = new Set([
  'TIMEOUT',
  'CONFLICT',
  'STORAGE',
  'BRANCH_NOT_FOUND',
]);

const isRetryableCode = (code: TccErrorCode | null): boolean => code !== null && RETRYABLE_CODES.has(code);

const unknownReply = (err: unknown): BranchReply => ({
  ok: false,
  status: 'INIT',
  idempotent: false,
  code: 'TIMEOUT',
  message: err instanceof Error ? err.message : String(err),
});

export class TccCoordinator {
  private readonly tm: TransactionManager;
  private readonly client: InventoryTccParticipant;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly log: Logger;
  private readonly policy: RetryPolicy;
  private readonly rng: () => number;

  constructor(deps: CoordinatorDeps) {
    this.tm = deps.tm;
    this.client = deps.client;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.log = deps.log;
    this.policy = deps.policy;
    this.rng = deps.rng ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  async execute(plan: ExecutePlan): Promise<ExecuteOutcome> {
    const tryPhase = await this.begin(plan);

    if (tryPhase.failed.length > 0) {
      const abortPhase = await this.abort(plan, tryPhase.tried);
      return {
        xid: plan.xid,
        status: abortPhase.status,
        tried: tryPhase.tried,
        failed: tryPhase.failed,
        confirmPending: [],
        conflicts: [],
      };
    }

    const commitPhase = await this.commit(plan);
    return {
      xid: plan.xid,
      status: commitPhase.status,
      tried: tryPhase.tried,
      failed: [],
      confirmPending: commitPhase.pending,
      conflicts: commitPhase.conflicts,
    };
  }

  // -------------------------------------------------------------------------
  // Try
  // -------------------------------------------------------------------------

  async begin(plan: ExecutePlan): Promise<TryPhase> {
    await this.tm.run((uow) => {
      const prev = uow.getTx(plan.xid);
      if (prev) return; // 已经落过 TRYING 之后的状态，保持原样
      uow.putTx({
        xid: plan.xid,
        status: 'TRYING',
        branches: plan.branches,
        version: 1,
        updatedAt: this.clock.now(),
        reason: null,
      });
    });

    const tried: BranchId[] = [];
    const failed: BranchId[] = [];

    for (const branch of plan.branches) {
      const reply = await this.tryWithRetry(plan.xid, branch);
      if (reply.ok) {
        tried.push(branch.branchId);
        continue;
      }
      failed.push(branch.branchId);
      this.log.warn('tx.try.failed', {
        xid: plan.xid,
        branchId: branch.branchId,
        code: reply.code,
        status: reply.status,
      });
      break; // 快速失败，不再浪费后续分支的冻结额度
    }

    const status: TccTxStatus = failed.length === 0 ? 'TRIED' : 'TRY_FAILED';
    await this.patchTx(plan.xid, status, failed.length === 0 ? null : `try-failed:${failed.join(',')}`);
    return { tried, failed, status };
  }

  // -------------------------------------------------------------------------
  // Confirm
  // -------------------------------------------------------------------------

  async commit(plan: ExecutePlan): Promise<CommitPhase> {
    await this.patchTx(plan.xid, 'CONFIRMING', null);

    const pending: BranchId[] = [];
    const conflicts: BranchId[] = [];

    for (const branch of plan.branches) {
      const outcome = await this.singleShot(plan.xid, branch, 'confirm');
      if (outcome === 'ok') continue;

      pending.push(branch.branchId);
      if (outcome === 'rejected') conflicts.push(branch.branchId);

      // 无论哪种失败，都把"必须把 Confirm 送到"持久化。
      // 冲突类会被 Relay 直接打成 DEAD 并告警，等待人工对账。
      await this.enqueue(plan.xid, branch, 'CONFIRM', outcome === 'rejected' ? 'participant-conflict' : 'no-answer');
    }

    const status: TccTxStatus = pending.length === 0 ? 'CONFIRMED' : 'CONFIRMING';
    const reason =
      pending.length === 0
        ? null
        : conflicts.length > 0
          ? `confirm-conflict:${conflicts.join(',')}`
          : `confirm-pending:${pending.join(',')}`;
    await this.patchTx(plan.xid, status, reason);

    return { status, pending, conflicts };
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  async abort(plan: ExecutePlan, onlyTried?: readonly BranchId[]): Promise<AbortPhase> {
    await this.patchTx(plan.xid, 'CANCELLING', 'try-phase-failed');

    const targets = plan.branches.filter((b) => !onlyTried || onlyTried.includes(b.branchId));
    const pending: BranchId[] = [];

    for (const branch of targets) {
      const outcome = await this.singleShot(plan.xid, branch, 'cancel');
      if (outcome === 'ok') continue;
      pending.push(branch.branchId);
      await this.enqueue(plan.xid, branch, 'CANCEL', 'no-answer');
    }

    const status: TccTxStatus = pending.length === 0 ? 'CANCELLED' : 'CANCELLING';
    await this.patchTx(plan.xid, status, pending.length === 0 ? null : `cancel-pending:${pending.join(',')}`);
    return { status, pending };
  }

  // -------------------------------------------------------------------------
  // 崩溃恢复
  // -------------------------------------------------------------------------

  /**
   * 恢复的全部秘密：不需要知道"崩溃前做到哪一步"，
   * 只需要读事务的硬状态，再用幂等指令把参与者侧的真实状态读出来并对齐。
   */
  async recover(): Promise<RecoveryStats> {
    const open = await this.tm.run((uow) => uow.listOpenTx());
    let confirmed = 0;
    let cancelled = 0;
    let stillOpen = 0;

    for (const tx of open) {
      const plan: ExecutePlan = { xid: tx.xid, branches: tx.branches };
      this.log.warn('tx.recover', { xid: tx.xid, status: tx.status });

      if (tx.status === 'CONFIRMING') {
        const phase = await this.commit(plan);
        if (phase.status === 'CONFIRMED') confirmed += 1;
        else stillOpen += 1;
        continue;
      }

      if (tx.status === 'CANCELLING') {
        const phase = await this.abort(plan, plan.branches.map((b) => b.branchId));
        if (phase.status === 'CANCELLED') cancelled += 1;
        else stillOpen += 1;
        continue;
      }

      // TRYING / TRIED / TRY_FAILED：先幂等重放 Try，再按新的硬状态决策
      const tryPhase = await this.begin(plan);
      if (tryPhase.failed.length > 0) {
        const phase = await this.abort(plan, tryPhase.tried);
        if (phase.status === 'CANCELLED') cancelled += 1;
        else stillOpen += 1;
      } else {
        const phase = await this.commit(plan);
        if (phase.status === 'CONFIRMED') confirmed += 1;
        else stillOpen += 1;
      }
    }

    return { scanned: open.length, confirmed, cancelled, stillOpen };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async tryWithRetry(xid: Xid, branch: BranchRef): Promise<BranchReply> {
    let last: BranchReply = {
      ok: false,
      status: 'INIT',
      idempotent: false,
      code: 'TIMEOUT',
      message: '尚未发出',
    };
    for (let attempt = 1; attempt <= this.policy.maxSyncAttempts; attempt += 1) {
      try {
        const reply = await this.client.try(toCommand(xid, branch));
        if (reply.ok || !isRetryableCode(reply.code)) return reply;
        last = reply;
      } catch (err) {
        last = unknownReply(err);
      }
    }
    return last;
  }

  private async singleShot(xid: Xid, branch: BranchRef, action: 'confirm' | 'cancel'): Promise<OneShot> {
    for (let attempt = 1; attempt <= this.policy.maxSyncAttempts; attempt += 1) {
      try {
        const reply =
          action === 'confirm'
            ? await this.client.confirm(toCommand(xid, branch))
            : await this.client.cancel(toCommand(xid, branch));
        if (reply.ok) return 'ok';
        if (!isRetryableCode(reply.code)) return 'rejected';
      } catch {
        // 超时 = 结果未知，继续重试；幂等重放会让下一次拿到确定答复
      }
    }
    return 'retry';
  }

  private async patchTx(xid: Xid, to: TccTxStatus, reason: string | null): Promise<void> {
    await this.tm.run((uow) => {
      const prev = uow.getTx(xid);
      if (!prev) throw new TccError('STORAGE', `事务不存在：${xid}`);
      if (prev.status === to) return; // 幂等
      if (!canTransitionTx(prev.status, to)) {
        throw new TccError('ILLEGAL_TRANSITION', `非法事务迁移：${prev.status} -> ${to}（${xid}）`);
      }
      uow.putTx({
        ...prev,
        status: to,
        version: prev.version + 1,
        updatedAt: this.clock.now(),
        reason,
      });
    });
  }

  private async enqueue(
    xid: Xid,
    branch: BranchRef,
    action: 'CONFIRM' | 'CANCEL',
    reason: string,
  ): Promise<void> {
    const now = this.clock.now();
    const msg: OutboxMessage = {
      id: this.ids.messageId(),
      xid,
      branchId: branch.branchId,
      action,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now + backoffDelay(this.policy, 1, this.rng),
      leaseUntil: 0,
      lastError: reason,
      createdAt: now,
      payload: { sku: branch.sku, qty: branch.qty },
    };
    await this.tm.run((uow) => uow.appendOutbox(msg));
    this.log.warn('outbox.enqueue', { id: msg.id, xid, action, reason });
  }
}

function toCommand(xid: Xid, branch: BranchRef): import('./types.ts').BranchCommand {
  return { xid, branchId: branch.branchId, sku: branch.sku, qty: branch.qty };
}
