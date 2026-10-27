/**
 * TCC 库存扣减 —— 核心接口定义。
 *
 * 设计约束（对应需求三条）：
 *  1) CP：任何时刻必须满足 `available + frozen + sold === total` 且各分量 >= 0；
 *     扣减只允许"单分片单行原子条件更新"，禁止读-改-写（见 inmemory.ts 注释）。
 *  2) TCC：Try=冻结 / Confirm=冻转实扣 / Cancel=释放冻结，三段全部幂等。
 *  3) 异常语义：
 *     - 网络超时 = 结果未知，绝不等于失败（Confirm 阶段尤其致命）；
 *     - 重复请求 = 以 (xid, branchId) 为幂等键，状态机重放只允许 noop；
 *     - 系统宕机 = 状态与待发消息同库同事务持久化，重启后由恢复扫描推进。
 *
 * 本文件只放"契约"，实现见 state-machine.ts / participant.ts / coordinator.ts / outbox.ts。
 * 无第三方依赖，Node >= 22.18 可直接 `node simulate.ts` 运行。
 */

// ---------------------------------------------------------------------------
// 1. 标识类型：品牌类型防止 xid 与 branchId 混用
// ---------------------------------------------------------------------------

export type Xid = string & { readonly __brand: 'Xid' };
export type BranchId = string & { readonly __brand: 'BranchId' };
export type SkuId = string & { readonly __brand: 'SkuId' };
export type MessageId = string & { readonly __brand: 'MessageId' };

export const asXid = (v: string): Xid => v as Xid;
export const asBranchId = (v: string): BranchId => v as BranchId;
export const asSkuId = (v: string): SkuId => v as SkuId;
export const asMessageId = (v: string): MessageId => v as MessageId;

// ---------------------------------------------------------------------------
// 2. 分支（参与者侧）状态
// ---------------------------------------------------------------------------

/**
 * 分支状态。INIT 是"分支行尚未落库"的隐式初始态，实际存储中可能不存在该行；
 * EMPTY_CANCELLED 是空回滚墓碑，专门用于挡住迟到的 Try（悬挂）。
 */
export type BranchStatus = 'INIT' | 'TRIED' | 'CONFIRMED' | 'CANCELLED' | 'EMPTY_CANCELLED';

/** 分支上可能收到的三种命令。 */
export type BranchEvent = 'TRY' | 'CONFIRM' | 'CANCEL';

/** 状态迁移时需要施加的账务副作用。 */
export type SettleEffect = 'FREEZE' | 'SETTLE' | 'RELEASE' | 'NONE';

export interface BranchRecord {
  readonly xid: Xid;
  readonly branchId: BranchId;
  readonly sku: SkuId;
  readonly qty: number;
  readonly status: BranchStatus;
  /** 乐观锁版本号，每次写必须严格递增（配合 DB 的 `version` 列）。 */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 收到命令的次数，用于观测重试风暴。 */
  readonly attempts: number;
  readonly lastError: string | null;
}

/** 库存台账：单 SKU 单行，total 恒定。 */
export interface StockLedger {
  readonly sku: SkuId;
  readonly total: number;
  readonly available: number;
  readonly frozen: number;
  readonly sold: number;
}

export const isTerminalBranch = (s: BranchStatus): boolean =>
  s === 'CONFIRMED' || s === 'CANCELLED' || s === 'EMPTY_CANCELLED';

// ---------------------------------------------------------------------------
// 3. 协调者（事务级）状态
// ---------------------------------------------------------------------------

/**
 * TRYING      —— 已发起 Try，尚未集齐结果（结果未知，不能判失败）
 * TRIED       —— 全部分支 Try 成功，即将 Confirm
 * TRY_FAILED  —— 有分支 Try 失败，必须 Cancel 已成功分支
 * CONFIRMING  —— 已进入 Confirm，只能前进到 CONFIRMED（不可逆）
 * CONFIRMED   —— 终态
 * CANCELLING  —— 正在回滚
 * CANCELLED   —— 终态
 */
export type TccTxStatus =
  | 'TRYING'
  | 'TRIED'
  | 'TRY_FAILED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'CANCELLING'
  | 'CANCELLED';

export interface BranchRef {
  readonly branchId: BranchId;
  readonly sku: SkuId;
  readonly qty: number;
}

export interface TccTransaction {
  readonly xid: Xid;
  readonly status: TccTxStatus;
  readonly branches: readonly BranchRef[];
  readonly version: number;
  readonly updatedAt: number;
  /** 最近一次决策原因，用于人工对账。 */
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// 4. 本地消息表 / 最大努力通知
// ---------------------------------------------------------------------------

export type OutboxStatus = 'PENDING' | 'INFLIGHT' | 'SENT' | 'DEAD';

export interface OutboxMessage {
  readonly id: MessageId;
  readonly xid: Xid;
  readonly branchId: BranchId;
  /** 只允许向参与者推 Confirm / Cancel，绝不在同一分支上双向乱推。 */
  readonly action: 'CONFIRM' | 'CANCEL';
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  /** 租约：INFLIGHT 且过期可被其他 relay 抢占（宕机自愈）。 */
  readonly leaseUntil: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  /** 冗余参数，保证协调者重启后不依赖内存即可重建请求。 */
  readonly payload: { readonly sku: SkuId; readonly qty: number };
}

export type DeliveryOutcome = 'OK' | 'RETRY' | 'REJECTED' | 'TERMINAL';

export interface DeliveryResult {
  readonly outcome: DeliveryOutcome;
  readonly message: string | null;
}

export interface Notifier {
  deliver(cmd: BranchCommand, action: 'CONFIRM' | 'CANCEL'): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------
// 5. 错误与重试策略
// ---------------------------------------------------------------------------

export type TccErrorCode =
  | 'INSUFFICIENT_STOCK'
  | 'UNKNOWN_SKU'
  | 'BRANCH_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'ALREADY_CONFIRMED'
  | 'ALREADY_CANCELLED'
  | 'LATE_TRY_REJECTED'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'STORAGE';

const RETRYABLE_CODES: ReadonlySet<TccErrorCode> = new Set([
  'TIMEOUT',
  'CONFLICT',
  'STORAGE',
  'BRANCH_NOT_FOUND',
]);

export class TccError extends Error {
  readonly code: TccErrorCode;
  readonly retryable: boolean;

  constructor(code: TccErrorCode, message: string) {
    super(message);
    this.name = 'TccError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export interface RetryPolicy {
  /** 同步重试次数（在线路径，影响用户延迟）。 */
  readonly maxSyncAttempts: number;
  /** 退避基数。 */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** 转异步最大努力通知后的最大投递次数，超过则 DEAD + 告警。 */
  readonly maxNotifyAttempts: number;
  /** 消息租约时长，须大于单次投递超时。 */
  readonly leaseMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxSyncAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxNotifyAttempts: 6,
  leaseMs: 30_000,
};

/** 指数退避 + 抖动，避免"重试风暴"打爆正在抖动的网络。 */
export function backoffDelay(policy: RetryPolicy, attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + rng(); // 0.5x ~ 1.5x
  return Math.max(1, Math.floor(exp * jitter));
}

// ---------------------------------------------------------------------------
// 6. 基础设施端口（可替换为 Redis / MySQL / MQ 实现）
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface IdGenerator {
  xid(): Xid;
  messageId(): MessageId;
}

// ---------------------------------------------------------------------------
// 7. 存储事务边界
// ---------------------------------------------------------------------------

/**
 * 一次本地数据库事务内的全部能力。
 *
 * 真实实现对应：`BEGIN; SELECT ... FOR UPDATE; UPDATE ...; INSERT outbox ...; COMMIT;`
 * 内存实现见 inmemory.ts。注意：事务体内的函数必须是**同步**的，否则会破坏原子性假设。
 */
export interface UnitOfWork {
  getBranch(xid: Xid, branchId: BranchId): BranchRecord | undefined;
  putBranch(rec: BranchRecord): void;
  listBranches(xid: Xid): BranchRecord[];

  getLedger(sku: SkuId): StockLedger | undefined;
  putLedger(l: StockLedger): void;

  getTx(xid: Xid): TccTransaction | undefined;
  putTx(tx: TccTransaction): void;
  /** TRYING / TRIED / TRY_FAILED / CONFIRMING / CANCELLING —— 恢复扫描的工作集。 */
  listOpenTx(): TccTransaction[];

  getOutbox(id: MessageId): OutboxMessage | undefined;
  appendOutbox(m: OutboxMessage): void;
  putOutbox(m: OutboxMessage): void;
  listDueOutbox(now: number, limit: number): OutboxMessage[];
  countOutbox(status: OutboxStatus): number;
}

export interface TransactionManager {
  run<T>(fn: (uow: UnitOfWork) => T): Promise<T>;
}

// ---------------------------------------------------------------------------
// 8. 参与者契约（跨进程调用面）
// ---------------------------------------------------------------------------

export interface BranchCommand {
  readonly xid: Xid;
  readonly branchId: BranchId;
  readonly sku: SkuId;
  readonly qty: number;
}

export interface BranchReply {
  readonly ok: boolean;
  readonly status: BranchStatus;
  /** true 表示本次是幂等重放（结果与首次一致，资源未被二次变更）。 */
  readonly idempotent: boolean;
  readonly code: TccErrorCode | null;
  readonly message: string | null;
}

export interface InventoryTccParticipant {
  try(cmd: BranchCommand): Promise<BranchReply>;
  confirm(cmd: BranchCommand): Promise<BranchReply>;
  cancel(cmd: BranchCommand): Promise<BranchReply>;
}

// ---------------------------------------------------------------------------
// 9. 协调者契约
// ---------------------------------------------------------------------------

export interface ExecutePlan {
  readonly xid: Xid;
  readonly branches: readonly BranchRef[];
}

export interface ExecuteOutcome {
  readonly xid: Xid;
  readonly status: TccTxStatus;
  readonly tried: readonly BranchId[];
  readonly failed: readonly BranchId[];
  /** 尚未拿到确定答复、已转异步通知的分支。 */
  readonly confirmPending: readonly BranchId[];
  /** 参与者反馈终态冲突（例如已被 Cancel），必须人工对账。 */
  readonly conflicts: readonly BranchId[];
}
