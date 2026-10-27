/**
 * 状态机流转 —— 纯函数，无 I/O。
 *
 * 整个 TCC 的正确性锚点就在这里：
 *   - 同一 (状态, 事件) 只可能有一个 Decision；
 *   - 表是全覆盖的（15 个组合全部显式声明），漏一格会在启动自检里直接报错；
 *   - 所有"重复请求"都落在 noop 上，"非法时机"都落在 reject 上，
 *     没有任何一条路径允许 Confirm 之后回滚，也没有任何路径允许 Cancelled 之后冻结。
 */

import type {
  BranchEvent,
  BranchStatus,
  SettleEffect,
  StockLedger,
  TccErrorCode,
  TccTxStatus,
} from './types.ts';

// ---------------------------------------------------------------------------
// 分支决策
// ---------------------------------------------------------------------------

export type BranchDecision =
  | { readonly kind: 'apply'; readonly to: BranchStatus; readonly effect: SettleEffect; readonly note: string }
  | { readonly kind: 'noop'; readonly reason: string }
  | { readonly kind: 'reject'; readonly code: TccErrorCode; readonly reason: string };

const apply = (to: BranchStatus, effect: SettleEffect, note: string): BranchDecision => ({
  kind: 'apply',
  to,
  effect,
  note,
});

const noop = (reason: string): BranchDecision => ({ kind: 'noop', reason });

const reject = (code: TccErrorCode, reason: string): BranchDecision => ({ kind: 'reject', code, reason });

type BranchKey = `${BranchStatus}|${BranchEvent}`;

/**
 * 分支状态迁移表（5 状态 × 3 事件 = 15 格）。
 *
 * 关键几格：
 *  - INIT+CANCEL  → EMPTY_CANCELLED（空回滚，写墓碑）
 *  - CANCELED+TRY → reject（悬挂防御：回滚后绝不允许再冻结）
 *  - CONFIRMED+CANCEL → reject（Confirm 不可逆，这是"不能超卖"的最后一道闸）
 *  - TRIED+TRY / TRIED+CONFIRM 重复 / CONFIRMED+CONFIRM → noop（幂等）
 */
const BRANCH_TABLE: Readonly<Record<BranchKey, BranchDecision>> = {
  'INIT|TRY': apply('TRIED', 'FREEZE', 'Try：校验可用量后冻结'),
  'INIT|CONFIRM': reject(
    'BRANCH_NOT_FOUND',
    'Try 未落库就收到 Confirm：不能凭空实扣，必须重试或补 Try',
  ),
  'INIT|CANCEL': apply('EMPTY_CANCELLED', 'NONE', '空回滚：Try 未到达，登记墓碑'),

  'TRIED|TRY': noop('重复 Try：冻结已生效，直接返回同一结果'),
  'TRIED|CONFIRM': apply('CONFIRMED', 'SETTLE', 'Confirm：冻结转实扣'),
  'TRIED|CANCEL': apply('CANCELLED', 'RELEASE', 'Cancel：释放冻结'),

  'CONFIRMED|TRY': reject(
    'ALREADY_CONFIRMED',
    '悬挂 Try 迟到于 Confirm：事务已终结，拒绝任何资源动作',
  ),
  'CONFIRMED|CONFIRM': noop('重复 Confirm：幂等，实扣只发生一次'),
  'CONFIRMED|CANCEL': reject(
    'ALREADY_CONFIRMED',
    'Confirm 不可逆：已实扣的库存不得回滚为可用，否则必然超卖',
  ),

  'CANCELLED|TRY': reject(
    'LATE_TRY_REJECTED',
    '悬挂防御：Cancel 已终结该分支，迟到 Try 必须被拒绝，绝不能重新冻结',
  ),
  'CANCELLED|CONFIRM': reject('ALREADY_CANCELLED', '分支已取消，Confirm 无意义：需人工对账'),
  'CANCELLED|CANCEL': noop('重复 Cancel：幂等'),

  'EMPTY_CANCELLED|TRY': reject(
    'LATE_TRY_REJECTED',
    '悬挂防御：空回滚后再收到 Try，拒绝并留痕',
  ),
  'EMPTY_CANCELLED|CONFIRM': reject(
    'ALREADY_CANCELLED',
    '分支已被空回滚，Confirm 说明协调者状态失真：需人工对账',
  ),
  'EMPTY_CANCELLED|CANCEL': noop('重复空回滚：幂等'),
};

export function decideBranch(from: BranchStatus, event: BranchEvent): BranchDecision {
  const decision: BranchDecision | undefined = BRANCH_TABLE[`${from}|${event}` as BranchKey];
  // 状态来自数据库，可能被人工改脏；宁可直接拒绝也不猜。
  if (!decision) {
    return reject('ILLEGAL_TRANSITION', `未知的状态迁移：${from} + ${event}`);
  }
  return decision;
}

/** 启动自检：确认迁移表全覆盖，避免"漏一格"演变成线上悬空。 */
export function assertBranchTableComplete(): void {
  const statuses: readonly BranchStatus[] = ['INIT', 'TRIED', 'CONFIRMED', 'CANCELLED', 'EMPTY_CANCELLED'];
  const events: readonly BranchEvent[] = ['TRY', 'CONFIRM', 'CANCEL'];
  for (const s of statuses) {
    for (const e of events) {
      if (!BRANCH_TABLE[`${s}|${e}` as BranchKey]) {
        throw new Error(`状态机缺格：${s} + ${e}`);
      }
    }
  }
  if (Object.keys(BRANCH_TABLE).length !== 15) {
    throw new Error(`状态机格数异常：${Object.keys(BRANCH_TABLE).length} !== 15`);
  }
}

export function describeDecision(d: BranchDecision): string {
  switch (d.kind) {
    case 'apply':
      return `apply → ${d.to} (${d.effect}) ${d.note}`;
    case 'noop':
      return `noop ${d.reason}`;
    case 'reject':
      return `reject ${d.code} ${d.reason}`;
  }
}

// ---------------------------------------------------------------------------
// 协调者（事务级）迁移
// ---------------------------------------------------------------------------

/**
 * 注意 CONFIRMING 只有一条出边：CONFIRMED。
 * 也就是说"Confirm 阶段超时"在状态机层面根本不存在"改判 Cancel"的权力。
 */
const TX_TABLE: Readonly<Record<TccTxStatus, readonly TccTxStatus[]>> = {
  TRYING: ['TRIED', 'TRY_FAILED', 'CANCELLING'],
  TRIED: ['CONFIRMING', 'CANCELLING'],
  TRY_FAILED: ['CANCELLING'],
  CONFIRMING: ['CONFIRMED'],
  CONFIRMED: [],
  CANCELLING: ['CANCELLED'],
  CANCELLED: [],
};

/** 允许"原地重写"（幂等重放），但不允许跨状态乱跳。 */
export function canTransitionTx(from: TccTxStatus, to: TccTxStatus): boolean {
  return from === to || TX_TABLE[from].includes(to);
}

export function nextStatusesTx(from: TccTxStatus): readonly TccTxStatus[] {
  return TX_TABLE[from];
}

export const isTerminalTx = (s: TccTxStatus): boolean => s === 'CONFIRMED' || s === 'CANCELLED';

// ---------------------------------------------------------------------------
// 台账不变式
// ---------------------------------------------------------------------------

/**
 * 每次写库存都必须过这一关：总量守恒、分量非负、整数。
 * 只要它恒成立，"超卖"在数据层就不可能出现。
 */
export function assertLedger(l: StockLedger): void {
  const parts = [l.available, l.frozen, l.sold];
  if (parts.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error(`台账分量非法：${JSON.stringify(l)}`);
  }
  if (l.available + l.frozen + l.sold !== l.total) {
    throw new Error(`台账不守恒：available+frozen+sold=${l.available + l.frozen + l.sold} != total=${l.total}`);
  }
}
