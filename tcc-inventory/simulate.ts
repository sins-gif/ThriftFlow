/**
 * 可执行验证：把三条需求（CP 不超卖 / TCC 幂等 / 三类异常）跑成断言。
 *
 *   node simulate.ts
 *
 * 每个场景都独立建库，互不影响。全部 ✓ 才算通过（退出码 0）。
 */

import { setTimeout as tick } from 'node:timers/promises';

import { TccCoordinator } from './coordinator.ts';
import { FaultyTransport, InMemoryStore, ManualClock, RecordingLogger, SeqIdGenerator } from './inmemory.ts';
import { ClientNotifier, OutboxRelay } from './outbox.ts';
import { InventoryTccService } from './participant.ts';
import { assertBranchTableComplete } from './state-machine.ts';
import type { BranchRef, ExecutePlan, RetryPolicy, SkuId } from './types.ts';
import { DEFAULT_RETRY_POLICY, asBranchId, asSkuId, asXid } from './types.ts';

// ---------------------------------------------------------------------------
// 断言与输出
// ---------------------------------------------------------------------------

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n### ${title}`);
}

const stableRng = (): number => 0.5; // 抖动固定为 1.0x，保证演示可复现

const policy: RetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
  maxSyncAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxNotifyAttempts: 6,
  leaseMs: 30_000,
};

interface Rig {
  readonly clock: ManualClock;
  readonly store: InMemoryStore;
  readonly sku: SkuId;
  readonly ids: SeqIdGenerator;
  readonly svc: InventoryTccService;
  readonly transport: FaultyTransport;
  readonly coord: TccCoordinator;
  readonly relay: OutboxRelay;
  readonly log: RecordingLogger;
}

function fresh(total: number): Rig {
  const clock = new ManualClock();
  const store = new InMemoryStore();
  const sku = asSkuId('SKU-001');
  store.seed(sku, total);

  const log = new RecordingLogger(false);
  const ids = new SeqIdGenerator();
  const svc = new InventoryTccService({ tm: store, clock, log });
  const transport = new FaultyTransport(svc, clock);
  const coord = new TccCoordinator({ tm: store, client: transport, clock, ids, log, policy, rng: stableRng });
  const relay = new OutboxRelay({
    tm: store,
    notifier: new ClientNotifier(transport),
    clock,
    log,
    policy,
    ids,
    rng: stableRng,
  });

  return { clock, store, sku, ids, svc, transport, coord, relay, log };
}

const branchOf = (sku: SkuId, qty: number, shard = 'inv-shard-1'): BranchRef => ({
  branchId: asBranchId(shard),
  sku,
  qty,
});

// ---------------------------------------------------------------------------
// 场景 1：并发 Try 绝不超卖（CP 的核心断言）
// ---------------------------------------------------------------------------

async function scenarioConcurrentTry(): Promise<void> {
  section('场景 1：60 个节点同时 Try 扣减，库存 20 —— 不得超卖');
  const rig = fresh(20);
  const cmd = (i: number) => ({
    xid: asXid(`t-${i}`),
    branchId: asBranchId('inv-shard-1'),
    sku: rig.sku,
    qty: 1,
  });

  const replies = await Promise.all(Array.from({ length: 60 }, (_, i) => rig.svc.try(cmd(i))));
  const okCount = replies.filter((r) => r.ok).length;
  const insufficient = replies.filter((r) => r.code === 'INSUFFICIENT_STOCK').length;
  const ledger = rig.store.ledger(rig.sku);

  check('成功冻结数 == 库存总量（20）', okCount === 20, `实际 ${okCount}`);
  check('其余 40 次明确返回 INSUFFICIENT_STOCK', insufficient === 40, `实际 ${insufficient}`);
  check('available 归零、frozen=20、sold=0', ledger.available === 0 && ledger.frozen === 20 && ledger.sold === 0, JSON.stringify(ledger));
  check('台账守恒 available+frozen+sold == total', ledger.available + ledger.frozen + ledger.sold === ledger.total);

  // 冻结全部转实扣，验证最终仍是 20 件，不多也不少
  for (let i = 0; i < 60; i += 1) {
    const r = replies[i];
    if (r && r.ok) await rig.svc.confirm(cmd(i));
  }
  const after = rig.store.ledger(rig.sku);
  check('全部 Confirm 后 sold == 20，frozen == 0', after.sold === 20 && after.frozen === 0, JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// 场景 1b：反面教材 —— 读-改-写（SELECT → 判断 → UPDATE）必然超卖
// ---------------------------------------------------------------------------

class NaiveStock {
  available = 20;
  sold = 0;

  async deduct(qty: number): Promise<boolean> {
    const snapshot = this.available; // 读到的是共享快照
    await tick(); // 业务逻辑/网络往返期间，其他请求也在读同一个快照
    if (snapshot < qty) return false;
    this.available = snapshot - qty; // 用过期快照写回 → 覆盖别人的扣减
    this.sold += qty;
    return true;
  }
}

async function scenarioNaiveOversell(): Promise<void> {
  section('场景 1b：反面对照 —— 同样的 60 并发，用读-改-写实现');
  const naive = new NaiveStock();
  const results = await Promise.all(Array.from({ length: 60 }, () => naive.deduct(1)));
  const okCount = results.filter(Boolean).length;

  check(`读-改-写果然超卖（成交 ${okCount} 件 / 库存 20 件）`, okCount > 20, `成交 ${okCount}`);
  check(
    '这正是必须用「单行条件更新 UPDATE ... WHERE available >= ?」的原因',
    naive.sold > 20,
    `sold=${naive.sold}`,
  );
}

// ---------------------------------------------------------------------------
// 场景 2：Try 成功、Confirm 响应丢失（已执行但协调者不知道）
// ---------------------------------------------------------------------------

async function scenarioConfirmResponseLost(): Promise<void> {
  section('场景 2：Confirm 已执行，但响应在抖动网络中丢失');
  const rig = fresh(100);
  const branch = branchOf(rig.sku, 7);
  const plan: ExecutePlan = { xid: asXid('tx-lost-resp'), branches: [branch] };

  // 第一次 Confirm：参与者真的执行了（分支变 CONFIRMED），然后抛超时
  rig.transport.plan(branch.branchId, 'CONFIRM', 'lost-response');

  const outcome = await rig.coord.execute(plan);
  const rec = rig.store.branch(plan.xid, branch.branchId);
  const ledger = rig.store.ledger(rig.sku);

  check('同步重试后事务仍收敛到 CONFIRMED', outcome.status === 'CONFIRMED', outcome.status);
  check('分支状态 CONFIRMED', rec?.status === 'CONFIRMED', rec?.status);
  check('实扣只发生一次：sold=7、frozen=0', ledger.sold === 7 && ledger.frozen === 0, JSON.stringify(ledger));
  check('协调者没有误判失败去 Cancel', rig.transport.calls(branch.branchId, 'CANCEL') === 0);
  check('Confirm 被调用了 2 次（1 次丢响应 + 1 次幂等重放）', rig.transport.calls(branch.branchId, 'CONFIRM') === 2, String(rig.transport.calls(branch.branchId, 'CONFIRM')));
  check('未产生待发消息', rig.store.allOutbox().length === 0);
}

// ---------------------------------------------------------------------------
// 场景 3：宕机 —— Try 已提交、进程被杀、重启后恢复
// ---------------------------------------------------------------------------

async function scenarioCrashRecovery(): Promise<void> {
  section('场景 3：Try 成功后协调者宕机（进程被杀），重启恢复');
  const rig = fresh(50);
  const branch = branchOf(rig.sku, 12);
  const plan: ExecutePlan = { xid: asXid('tx-crash'), branches: [branch] };

  const tryPhase = await rig.coord.begin(plan); // 崩溃点就在这之后
  check('宕机前：Try 已提交，冻结 12 件', tryPhase.status === 'TRIED' && rig.store.ledger(rig.sku).frozen === 12);

  const snapshot = rig.store.snapshot(); // 持久层落盘
  const restarted = InMemoryStore.restore(snapshot); // 新进程，内存全丢

  const log2 = new RecordingLogger(false);
  const svc2 = new InventoryTccService({ tm: restarted, clock: rig.clock, log: log2 });
  const coord2 = new TccCoordinator({
    tm: restarted,
    client: svc2,
    clock: rig.clock,
    ids: rig.ids,
    log: log2,
    policy,
    rng: stableRng,
  });

  check('恢复前：未终结事务可见（不会被遗忘）', restarted.tx(plan.xid)?.status === 'TRIED');
  rig.clock.advance(5 * 60_000); // 5 分钟后巡检发现悬挂

  const stats = await coord2.recover();
  const ledger = restarted.ledger(rig.sku);
  check('恢复扫描推进了 1 个事务并置为 CONFIRMED', stats.confirmed === 1 && restarted.tx(plan.xid)?.status === 'CONFIRMED', JSON.stringify(stats));
  check('冻结被正确转实扣：sold=12、frozen=0', ledger.sold === 12 && ledger.frozen === 0, JSON.stringify(ledger));

  // 恢复动作重复执行必须无副作用（重放安全）
  const before = restarted.ledger(rig.sku);
  await coord2.recover();
  const after = restarted.ledger(rig.sku);
  check('重复恢复无副作用（幂等重放）', JSON.stringify(before) === JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// 场景 4：空回滚 + 悬挂（Cancel 先到、Try 后到）
// ---------------------------------------------------------------------------

async function scenarioEmptyRollback(): Promise<void> {
  section('场景 4：Cancel 先到（空回滚），迟到的 Try 必须被拒绝');
  const rig = fresh(30);
  const branch = branchOf(rig.sku, 5);
  const cmd = { xid: asXid('tx-suspend'), branchId: branch.branchId, sku: rig.sku, qty: branch.qty };

  const cancelReply = await rig.svc.cancel(cmd);
  check('Cancel 未找到 Try → 空回滚成功', cancelReply.ok && cancelReply.status === 'EMPTY_CANCELLED', cancelReply.status);

  const lateTry = await rig.svc.try(cmd);
  const ledger = rig.store.ledger(rig.sku);
  check('迟到 Try 被拒绝（LATE_TRY_REJECTED）', !lateTry.ok && lateTry.code === 'LATE_TRY_REJECTED', String(lateTry.code));
  check('被拒绝后库存分毫未动', ledger.available === 30 && ledger.frozen === 0, JSON.stringify(ledger));

  const again = await rig.svc.cancel(cmd);
  check('重复 Cancel 幂等', again.ok && again.idempotent);
}

// ---------------------------------------------------------------------------
// 场景 5：Confirm 之后再来 Cancel —— 必须拒绝（否则必然超卖）
// ---------------------------------------------------------------------------

async function scenarioCancelAfterConfirm(): Promise<void> {
  section('场景 5：Confirm 已实扣后，迟到的 Cancel 必须被拒绝');
  const rig = fresh(10);
  const cmd = { xid: asXid('tx-irreversible'), branchId: asBranchId('inv-shard-1'), sku: rig.sku, qty: 4 };

  await rig.svc.try(cmd);
  await rig.svc.confirm(cmd);
  const cancelReply = await rig.svc.cancel(cmd);
  const ledger = rig.store.ledger(rig.sku);

  check('Cancel 被拒绝（ALREADY_CONFIRMED）', !cancelReply.ok && cancelReply.code === 'ALREADY_CONFIRMED', String(cancelReply.code));
  check('库存未被回滚成可用：available=6、sold=4', ledger.available === 6 && ledger.sold === 4, JSON.stringify(ledger));
  check('重复 Confirm 幂等且不重复扣减', (await rig.svc.confirm(cmd)).idempotent && rig.store.ledger(rig.sku).sold === 4);
}

// ---------------------------------------------------------------------------
// 场景 6：最大努力通知 —— 长时间不可达 → 退避重试 → 死信 → 人工重投
// ---------------------------------------------------------------------------

async function scenarioBestEffort(): Promise<void> {
  section('场景 6：Confirm 方向长时间黑洞 → 退避重试 → 死信 → 恢复后重投');
  const rig = fresh(40);
  const branch = branchOf(rig.sku, 9);
  const plan: ExecutePlan = { xid: asXid('tx-best-effort'), branches: [branch] };

  // 进入 Confirm 阶段时网络对 Confirm 完全黑洞（参与者一次都没执行）
  rig.transport.block(branch.branchId, 'CONFIRM', Number.POSITIVE_INFINITY);

  const outcome = await rig.coord.execute(plan);
  check('在线重试耗尽 → 事务停在 CONFIRMING（绝不改判 Cancel）', outcome.status === 'CONFIRMING', outcome.status);
  check('冻结仍被锁住：frozen=9，available=31', rig.store.ledger(rig.sku).frozen === 9 && rig.store.ledger(rig.sku).available === 31);
  check('待发消息已随事务同库落盘', rig.store.countOutbox('PENDING') === 1, String(rig.store.countOutbox('PENDING')));

  // 周期性调度：每轮推进时钟，让指数退避到期
  let rounds = 0;
  for (let i = 0; i < 12; i += 1) {
    rig.clock.advance(120_000);
    const stats = await rig.relay.tick();
    rounds += 1;
    if (rig.store.countOutbox('DEAD') === 1) break;
  }
  const dead = rig.store.allOutbox()[0];
  check('退避重试若干轮后进入 DEAD（触发告警）', dead?.status === 'DEAD', `${dead?.status} after ${rounds} rounds`);
  check('DEAD 记录了尝试次数与原因', (dead?.attempts ?? 0) >= policy.maxNotifyAttempts - 1 && !!dead?.lastError, `attempts=${dead?.attempts} err=${dead?.lastError}`);
  check('死信期间冻结仍未释放（可用性下降，但一致性保住）', rig.store.ledger(rig.sku).frozen === 9);

  // 网络恢复 + 人工对账后重投
  rig.transport.unblock(branch.branchId, 'CONFIRM');
  const replayed = await rig.relay.replayDead(dead!.id);
  const stats = await rig.relay.tick();
  check('死信被重新投递并成功', replayed && stats.delivered === 1, JSON.stringify(stats));
  check('参与者侧最终 CONFIRMED', rig.store.branch(plan.xid, branch.branchId)?.status === 'CONFIRMED');

  // 协调者巡检把事务收尾
  const recovery = await rig.coord.recover();
  const ledger = rig.store.ledger(rig.sku);
  check('事务最终 CONFIRMED', recovery.confirmed === 1 && rig.store.tx(plan.xid)?.status === 'CONFIRMED', JSON.stringify(recovery));
  check('最终账实一致：sold=9、frozen=0、available=31', ledger.sold === 9 && ledger.frozen === 0 && ledger.available === 31, JSON.stringify(ledger));
}

// ---------------------------------------------------------------------------
// 场景 7：Try 失败 → Cancel 已冻结分支（原生回滚路径）
// ---------------------------------------------------------------------------

async function scenarioTryFailedRollback(): Promise<void> {
  section('场景 7：库存不足导致 Try 失败，已冻结分支必须回滚');
  const rig = fresh(5);
  const plan: ExecutePlan = {
    xid: asXid('tx-partial'),
    branches: [branchOf(rig.sku, 3, 'inv-shard-1'), branchOf(rig.sku, 4, 'inv-shard-2')],
  };

  // 两个分片共用同一 SKU 台账，第二个分片 Try 时只剩 2 件 → 失败
  const outcome = await rig.coord.execute(plan);
  const ledger = rig.store.ledger(rig.sku);
  const first = rig.store.branch(plan.xid, asBranchId('inv-shard-1'));

  check('事务以 CANCELLED 收场', outcome.status === 'CANCELLED', outcome.status);
  check('第一个分支已被释放', first?.status === 'CANCELLED', first?.status);
  check('库存完全归还：available=5、frozen=0、sold=0', ledger.available === 5 && ledger.frozen === 0 && ledger.sold === 0, JSON.stringify(ledger));
  check('没有留下待发消息', rig.store.allOutbox().length === 0);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('TCC 库存扣减 —— 可执行验证');

  // 启动自检：状态机表必须 15 格全覆盖
  assertBranchTableComplete();
  console.log('  ✓ 分支状态迁移表全覆盖（5 状态 × 3 事件）');

  await scenarioConcurrentTry();
  await scenarioNaiveOversell();
  await scenarioConfirmResponseLost();
  await scenarioCrashRecovery();
  await scenarioEmptyRollback();
  await scenarioCancelAfterConfirm();
  await scenarioBestEffort();
  await scenarioTryFailedRollback();

  console.log(`\n—— ${passed} 项通过，${failed} 项失败 ——`);
  if (failed > 0) process.exitCode = 1;
}

await main();
