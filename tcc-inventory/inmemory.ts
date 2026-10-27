/**
 * 内存实现（测试替身）：事务边界、时钟、ID、日志、故障注入网络。
 *
 * 之所以能在这里"假装是数据库"，是因为它把每个事务体的执行串行化在一个 Promise 队列上，
 * 等价于 DB 的行锁 + 提交顺序。真实实现请对照注释里的 SQL。
 *
 * 生产落库示例（MySQL）：
 *   -- Try 的原子冻结：一条语句完成"检查 + 扣减"，天然无竞态
 *   UPDATE stock SET available = available - ?, frozen = frozen + ?
 *    WHERE sku = ? AND available >= ?;
 *   -- 抢到行（affected=1）后，再在同一个事务里写分支行（唯一键 xid+branch_id）与 outbox
 *
 * 反面教材（禁止）：SELECT available → 业务判断 → UPDATE SET available = <内存里算的值>。
 * 两次请求读到同一个快照就会超卖，simulate.ts 里专门演示了它怎么把 20 件库存卖成 50 件。
 */

import { assertLedger } from './state-machine.ts';
import type {
  BranchCommand,
  BranchId,
  BranchReply,
  BranchRecord,
  Clock,
  IdGenerator,
  InventoryTccParticipant,
  Logger,
  MessageId,
  OutboxMessage,
  OutboxStatus,
  SkuId,
  StockLedger,
  TccTransaction,
  TccTxStatus,
  TransactionManager,
  UnitOfWork,
  Xid,
} from './types.ts';
import { TccError, asMessageId, asXid, asBranchId } from './types.ts';

const OPEN_TX_STATUSES: readonly TccTxStatus[] = [
  'TRYING',
  'TRIED',
  'TRY_FAILED',
  'CONFIRMING',
  'CANCELLING',
];

const branchKey = (xid: Xid, branchId: BranchId): string => `${xid}::${branchId}`;

interface StoreState {
  branches: Map<string, BranchRecord>;
  ledgers: Map<string, StockLedger>;
  txs: Map<string, TccTransaction>;
  outbox: Map<string, OutboxMessage>;
}

interface StoreSnapshot {
  branches: BranchRecord[];
  ledgers: StockLedger[];
  txs: TccTransaction[];
  outbox: OutboxMessage[];
}

// ---------------------------------------------------------------------------
// 单机事务存储
// ---------------------------------------------------------------------------

export class InMemoryStore implements TransactionManager {
  private state: StoreState = {
    branches: new Map(),
    ledgers: new Map(),
    txs: new Map(),
    outbox: new Map(),
  };

  /** 串行队列：保证同一时刻只有一个事务体在跑（≈ DB 行锁/提交序）。 */
  private tail: Promise<unknown> = Promise.resolve();

  seed(sku: SkuId, total: number): void {
    this.state.ledgers.set(sku, { sku, total, available: total, frozen: 0, sold: 0 });
  }

  run<T>(fn: (uow: UnitOfWork) => T): Promise<T> {
    const exec = (): T => fn(this.uow());
    const next = this.tail.then(exec, exec);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 序列化整库，用于模拟"进程被 kill"后从持久层恢复。 */
  snapshot(): string {
    const snap: StoreSnapshot = {
      branches: [...this.state.branches.values()],
      ledgers: [...this.state.ledgers.values()],
      txs: [...this.state.txs.values()],
      outbox: [...this.state.outbox.values()],
    };
    return JSON.stringify(snap);
  }

  static restore(snapshot: string): InMemoryStore {
    const parsed = JSON.parse(snapshot) as StoreSnapshot;
    const store = new InMemoryStore();
    for (const rec of parsed.branches) store.state.branches.set(branchKey(rec.xid, rec.branchId), rec);
    for (const l of parsed.ledgers) store.state.ledgers.set(l.sku, l);
    for (const tx of parsed.txs) store.state.txs.set(tx.xid, tx);
    for (const m of parsed.outbox) store.state.outbox.set(m.id, m);
    return store;
  }

  // --- 只读辅助（仅演示/断言使用，不参与业务逻辑） ---

  ledger(sku: SkuId): StockLedger {
    const l = this.state.ledgers.get(sku);
    if (!l) throw new TccError('UNKNOWN_SKU', `未知 SKU ${sku}`);
    return { ...l };
  }

  branch(xid: Xid, branchId: BranchId): BranchRecord | undefined {
    const rec = this.state.branches.get(branchKey(xid, branchId));
    return rec ? { ...rec } : undefined;
  }

  tx(xid: Xid): TccTransaction | undefined {
    return this.state.txs.get(xid);
  }

  outboxMessage(id: MessageId): OutboxMessage | undefined {
    return this.state.outbox.get(id);
  }

  allOutbox(): OutboxMessage[] {
    return [...this.state.outbox.values()];
  }

  countOutbox(status: OutboxStatus): number {
    return [...this.state.outbox.values()].filter((m) => m.status === status).length;
  }

  // --- 事务视图 ---

  private uow(): UnitOfWork {
    const state = this.state;

    const putBranch = (rec: BranchRecord): void => {
      const key = branchKey(rec.xid, rec.branchId);
      const prev = state.branches.get(key);
      if (prev) {
        if (prev.sku !== rec.sku || prev.qty !== rec.qty) {
          throw new TccError('CONFLICT', `幂等键被复用于不同参数：${key}`);
        }
        if (rec.version <= prev.version) {
          throw new TccError('CONFLICT', `分支版本回退：${key} ${prev.version} -> ${rec.version}`);
        }
      }
      state.branches.set(key, rec);
    };

    const putTx = (tx: TccTransaction): void => {
      const prev = state.txs.get(tx.xid);
      if (prev && tx.version <= prev.version) {
        throw new TccError('CONFLICT', `事务版本回退：${tx.xid} ${prev.version} -> ${tx.version}`);
      }
      state.txs.set(tx.xid, tx);
    };

    return {
      getBranch: (xid, branchId) => state.branches.get(branchKey(xid, branchId)),
      putBranch,
      listBranches: (xid) => [...state.branches.values()].filter((b) => b.xid === xid),

      getLedger: (sku) => state.ledgers.get(sku),
      putLedger: (l) => {
        assertLedger(l);
        state.ledgers.set(l.sku, l);
      },

      getTx: (xid) => state.txs.get(xid),
      putTx,
      listOpenTx: () => [...state.txs.values()].filter((t) => OPEN_TX_STATUSES.includes(t.status)),

      getOutbox: (id) => state.outbox.get(id),
      appendOutbox: (m) => {
        if (state.outbox.has(m.id)) throw new TccError('CONFLICT', `重复写消息：${m.id}`);
        state.outbox.set(m.id, m);
      },
      putOutbox: (m) => {
        state.outbox.set(m.id, m);
      },
      listDueOutbox: (now, limit) =>
        [...state.outbox.values()]
          .filter(
            (m) =>
              (m.status === 'PENDING' && m.nextAttemptAt <= now) ||
              (m.status === 'INFLIGHT' && m.leaseUntil <= now),
          )
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
          .slice(0, limit),
      countOutbox: (status) => [...state.outbox.values()].filter((m) => m.status === status).length,
    };
  }
}

// ---------------------------------------------------------------------------
// 时钟 / ID / 日志
// ---------------------------------------------------------------------------

export class ManualClock implements Clock {
  private t: number;

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}

export class SeqIdGenerator implements IdGenerator {
  private seq = 0;

  xid(): Xid {
    this.seq += 1;
    return asXid(`x-${this.seq}`);
  }

  messageId(): MessageId {
    this.seq += 1;
    return asMessageId(`m-${this.seq}`);
  }
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  private readonly verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.push('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.push('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.push('error', event, fields);
  }

  filter(event: string): LogEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  private push(level: LogEntry['level'], event: string, fields: Record<string, unknown>): void {
    this.entries.push({ level, event, fields });
    if (this.verbose) {
      console.log(`  [${level}] ${event} ${JSON.stringify(fields)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 故障注入传输层：把"网络抖动"变成可复现的剧本
// ---------------------------------------------------------------------------

/**
 * - ok            : 正常往返
 * - timeout       : 请求在链路上丢失（参与者根本没执行）
 * - lost-response : 参与者已执行并落库，但响应丢失 ← 最阴险的一种，只能靠幂等重试收敛
 * - error         : 参与者返回 5xx
 */
export type FaultMode = 'ok' | 'timeout' | 'lost-response' | 'error';

export class FaultyTransport implements InventoryTccParticipant {
  private readonly inner: InventoryTccParticipant;
  private readonly clock: Clock;
  private readonly scripted = new Map<string, FaultMode[]>();
  private readonly blocked = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(inner: InventoryTccParticipant, clock: Clock) {
    this.inner = inner;
    this.clock = clock;
  }

  plan(branchId: BranchId, action: 'TRY' | 'CONFIRM' | 'CANCEL', ...modes: FaultMode[]): void {
    const key = `${branchId}:${action}`;
    const queue = this.scripted.get(key) ?? [];
    queue.push(...modes);
    this.scripted.set(key, queue);
  }

  /** 网络黑洞：untilTs 之前该方向完全不可达。传 Infinity 表示一直不可达。 */
  block(branchId: BranchId, action: 'TRY' | 'CONFIRM' | 'CANCEL', untilTs: number): void {
    this.blocked.set(`${branchId}:${action}`, untilTs);
  }

  unblock(branchId: BranchId, action: 'TRY' | 'CONFIRM' | 'CANCEL'): void {
    this.blocked.delete(`${branchId}:${action}`);
  }

  calls(branchId: BranchId, action: 'TRY' | 'CONFIRM' | 'CANCEL'): number {
    return this.counts.get(`${branchId}:${action}`) ?? 0;
  }

  try(cmd: BranchCommand): Promise<BranchReply> {
    return this.dispatch(cmd, 'TRY');
  }

  confirm(cmd: BranchCommand): Promise<BranchReply> {
    return this.dispatch(cmd, 'CONFIRM');
  }

  cancel(cmd: BranchCommand): Promise<BranchReply> {
    return this.dispatch(cmd, 'CANCEL');
  }

  private async dispatch(cmd: BranchCommand, action: 'TRY' | 'CONFIRM' | 'CANCEL'): Promise<BranchReply> {
    const key = `${cmd.branchId}:${action}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    const blockUntil = this.blocked.get(key);
    if (blockUntil !== undefined && this.clock.now() < blockUntil) {
      throw new TccError('TIMEOUT', `${key} 网络不可达（黑洞）`);
    }

    const queue = this.scripted.get(key);
    const mode: FaultMode = queue && queue.length > 0 ? (queue.shift() as FaultMode) : 'ok';

    const forward = (): Promise<BranchReply> => {
      if (action === 'TRY') return this.inner.try(cmd);
      if (action === 'CONFIRM') return this.inner.confirm(cmd);
      return this.inner.cancel(cmd);
    };

    switch (mode) {
      case 'ok':
        return forward();
      case 'timeout':
        throw new TccError('TIMEOUT', `${key} 请求丢失`);
      case 'error':
        throw new TccError('STORAGE', `${key} 参与者 5xx`);
      case 'lost-response': {
        await forward();
        throw new TccError('TIMEOUT', `${key} 已执行但响应丢失`);
      }
    }
  }
}
