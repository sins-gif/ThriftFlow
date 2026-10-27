/**
 * 本地消息表 + 最大努力通知（Relay）。
 *
 * 解决的问题：Confirm 已经"决定要执行了"，但网络长时间抖动，
 * 协调者拿不到确定答复。此时唯一的正确动作是——把"必须让参与者执行 Confirm"
 * 这件事**持久化**下来，然后无限重试直到拿到确定结果。
 *
 * 机制：
 *   1. 消息与业务状态同库同事务写入（协调者的 commit 里 appendOutbox），宕机不丢；
 *   2. Relay 按 nextAttemptAt 扫描到期消息 → 领取租约（INFLIGHT + leaseUntil）；
 *   3. 投递成功 → SENT；可重试失败 → 指数退避 + 抖动；不可重试 → DEAD + 告警；
 *   4. 租约过期（持有者宕机）可被再次领取 → 至少一次投递 + 参与者幂等 = 恰好一次效果；
 *   5. DEAD 不是终点，人工对账后 replayDead 重投（"最大努力"包含人工兜底）。
 */

import { backoffDelay } from './types.ts';
import type {
  BranchCommand,
  BranchReply,
  Clock,
  DeliveryResult,
  IdGenerator,
  InventoryTccParticipant,
  Logger,
  MessageId,
  Notifier,
  OutboxMessage,
  OutboxStatus,
  RetryPolicy,
  TransactionManager,
  Xid,
} from './types.ts';
import { TccError } from './types.ts';

// ---------------------------------------------------------------------------
// 把参与者回复翻译成投递结论
// ---------------------------------------------------------------------------

export function toDeliveryResult(reply: BranchReply): DeliveryResult {
  if (reply.ok) return { outcome: 'OK', message: null };
  switch (reply.code) {
    case 'BRANCH_NOT_FOUND':
    case 'TIMEOUT':
    case 'CONFLICT':
    case 'STORAGE':
      return { outcome: 'RETRY', message: reply.message };
    case 'ALREADY_CONFIRMED':
      // 对 Cancel 而言这是"终态冲突"：分支已实扣，绝不能释放 → 人工对账
      return { outcome: 'REJECTED', message: reply.message };
    case 'ALREADY_CANCELLED':
      // 对 Confirm 而言同理：分支已被取消，不能实扣 → 人工对账
      return { outcome: 'REJECTED', message: reply.message };
    case 'LATE_TRY_REJECTED':
    case 'ILLEGAL_TRANSITION':
    case 'INSUFFICIENT_STOCK':
    case 'UNKNOWN_SKU':
    default:
      return { outcome: 'REJECTED', message: reply.message };
  }
}

/** 把网络调用包装成 Notifier；异常一律视为"可重试的未知结果"，不判失败。 */
export class ClientNotifier implements Notifier {
  private readonly client: InventoryTccParticipant;

  constructor(client: InventoryTccParticipant) {
    this.client = client;
  }

  async deliver(cmd: BranchCommand, action: 'CONFIRM' | 'CANCEL'): Promise<DeliveryResult> {
    try {
      const reply = action === 'CONFIRM' ? await this.client.confirm(cmd) : await this.client.cancel(cmd);
      return toDeliveryResult(reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: 'RETRY', message };
    }
  }
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export interface RelayStats {
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  readonly claimed: number;
}

export interface RelayDeps {
  readonly tm: TransactionManager;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly log: Logger;
  readonly policy: RetryPolicy;
  readonly ids: IdGenerator;
  readonly rng?: () => number;
  readonly batchSize?: number;
}

export class OutboxRelay {
  private readonly tm: TransactionManager;
  private readonly notifier: Notifier;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly policy: RetryPolicy;
  private readonly ids: IdGenerator;
  private readonly rng: () => number;
  private readonly batchSize: number;

  constructor(deps: RelayDeps) {
    this.tm = deps.tm;
    this.notifier = deps.notifier;
    this.clock = deps.clock;
    this.log = deps.log;
    this.policy = deps.policy;
    this.ids = deps.ids;
    this.rng = deps.rng ?? Math.random;
    this.batchSize = deps.batchSize ?? 16;
  }

  /** 一次扫描-投递-结算循环。调度器每秒调用一次即可。 */
  async tick(): Promise<RelayStats> {
    const now = this.clock.now();

    // phase 1：领取（写租约），事务内完成，保证多实例不会重复领取同一条
    const claimed = await this.tm.run((uow) => {
      const due = uow.listDueOutbox(now, this.batchSize);
      const leased: OutboxMessage[] = due.map((m) => ({
        ...m,
        status: 'INFLIGHT' as OutboxStatus,
        leaseUntil: now + this.policy.leaseMs,
      }));
      for (const m of leased) uow.putOutbox(m);
      return leased;
    });

    if (claimed.length === 0) return { delivered: 0, retried: 0, dead: 0, claimed: 0 };

    // phase 2：事务外投递（网络调用不能占着行锁）
    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const msg of claimed) {
      const cmd: BranchCommand = {
        xid: msg.xid,
        branchId: msg.branchId,
        sku: msg.payload.sku,
        qty: msg.payload.qty,
      };

      let result: DeliveryResult;
      try {
        result = await this.notifier.deliver(cmd, msg.action);
      } catch (err) {
        result = { outcome: 'RETRY', message: err instanceof Error ? err.message : String(err) };
      }

      const settled = await this.settle(msg.id, result);
      if (settled === 'SENT') delivered += 1;
      else if (settled === 'DEAD') dead += 1;
      else retried += 1;
    }

    return { delivered, retried, dead, claimed: claimed.length };
  }

  /** 人工对账后重投死信。 */
  async replayDead(id: MessageId): Promise<boolean> {
    const replayed = await this.tm.run((uow) => {
      const msg = uow.getOutbox(id);
      if (!msg || msg.status !== 'DEAD') return false;
      uow.putOutbox({
        ...msg,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: this.clock.now(),
        leaseUntil: 0,
        lastError: null,
      });
      return true;
    });
    if (replayed) this.log.warn('outbox.replay', { id });
    return replayed;
  }

  /** 排空当前所有到期消息（演示/测试用；生产由定时器驱动）。 */
  async drain(maxRounds = 32): Promise<RelayStats> {
    const total = { delivered: 0, retried: 0, dead: 0, claimed: 0 };
    for (let i = 0; i < maxRounds; i += 1) {
      const stats = await this.tick();
      total.delivered += stats.delivered;
      total.retried += stats.retried;
      total.dead += stats.dead;
      total.claimed += stats.claimed;
      if (stats.claimed === 0) break;
    }
    return total;
  }

  async pendingCount(): Promise<number> {
    return this.tm.run((uow) => uow.countOutbox('PENDING'));
  }

  private async settle(id: MessageId, result: DeliveryResult): Promise<OutboxStatus> {
    return this.tm.run((uow) => {
      const cur = uow.getOutbox(id);
      if (!cur) throw new TccError('STORAGE', `消息不存在：${id}`);
      const now = this.clock.now();

      if (result.outcome === 'OK' || result.outcome === 'TERMINAL') {
        uow.putOutbox({ ...cur, status: 'SENT', leaseUntil: 0, lastError: null });
        this.log.info('outbox.sent', { id: cur.id, xid: cur.xid, action: cur.action, attempts: cur.attempts });
        return 'SENT';
      }

      const attempts = cur.attempts + 1;

      if (result.outcome === 'REJECTED') {
        uow.putOutbox({ ...cur, status: 'DEAD', attempts, leaseUntil: 0, lastError: result.message });
        this.log.error('outbox.dead.rejected', {
          id: cur.id,
          xid: cur.xid,
          action: cur.action,
          message: result.message,
        });
        return 'DEAD';
      }

      if (attempts >= this.policy.maxNotifyAttempts) {
        uow.putOutbox({ ...cur, status: 'DEAD', attempts, leaseUntil: 0, lastError: result.message });
        this.log.error('outbox.dead.exhausted', {
          id: cur.id,
          xid: cur.xid,
          action: cur.action,
          attempts,
        });
        return 'DEAD';
      }

      const delay = backoffDelay(this.policy, attempts, this.rng);
      uow.putOutbox({
        ...cur,
        status: 'PENDING',
        attempts,
        nextAttemptAt: now + delay,
        leaseUntil: 0,
        lastError: result.message,
      });
      this.log.warn('outbox.retry', {
        id: cur.id,
        xid: cur.xid,
        action: cur.action,
        attempts,
        nextInMs: delay,
      });
      return 'PENDING';
    });
  }
}

export type { MessageId, Xid };
