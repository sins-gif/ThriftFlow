/**
 * compare.ts —— before / after 对照
 *
 *   node thriftflow.ts compare                 # 最大的 25 个会话
 *   node thriftflow.ts compare --limit=50
 *   node thriftflow.ts compare mock_log.jsonl
 *
 * 两侧都用 model.ts 的同一套投影：A = 当前 dsh 默认（0.8W / 0.16W），
 * B = 处方（θ* / W、ρ=30k、截断后的 g'）。这样比较的是**策略差**，
 * 不是"投影 vs 实测"（后者含模型误差，见 selftest：样本外 7.6%）。
 *
 * 同时报 A 投影与实测的偏差，好让读者知道这张表的可信区间。
 */

import path from 'node:path';
import { sessionCost, type Policy } from './model.ts';
import { discoverSessions, readLogFile } from './replay.ts';
import { deriveStats, prescribe, type Stats } from './prescribe.ts';

const DEFAULT_LIMIT = 25;

interface Row {
  readonly name: string;
  readonly stats: Stats;
  readonly aSeconds: number;
  readonly bSeconds: number;
  readonly aTokens: number;
  readonly bTokens: number;
  readonly aContext: number;
  readonly bContext: number;
  readonly aCompactions: number;
  readonly bCompactions: number;
  readonly regimeA: string;
  readonly gBefore: number;
  readonly gAfter: number;
  readonly truncation: number;
  readonly maxInline: number;
  readonly policyA: Policy;
  readonly policyB: Policy;
}

function num(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function pad(v: string | number, w: number, align: 'l' | 'r' = 'r'): string {
  const s = String(v);
  let width = 0;
  for (const ch of s) width += WIDE.test(ch) ? 2 : 1;
  const fill = ' '.repeat(Math.max(0, w - width));
  return align === 'l' ? s + fill : fill + s;
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

function humanTokens(tokens: number): string {
  const abs = Math.abs(tokens);
  const sign = tokens < 0 ? '−' : '';
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)} 亿`;
  return `${sign}${(abs / 1e4).toFixed(1)} 万`;
}

function analyse(log: ReturnType<typeof readLogFile>, name: string): Row | null {
  if (log.calls.length === 0) return null;
  const stats = deriveStats(log);
  const p = prescribe(stats);
  return {
    name,
    stats,
    aSeconds: p.current.totalSeconds,
    bSeconds: p.proposed.totalSeconds,
    aTokens: p.current.promptTokens,
    bTokens: p.proposed.promptTokens,
    aContext: p.current.perStep.meanContext,
    bContext: p.proposed.perStep.meanContext,
    aCompactions: p.current.compactions,
    bCompactions: p.proposed.compactions,
    regimeA: p.current.regime,
    gBefore: stats.growth,
    gAfter: p.projectedGrowth,
    truncation: p.truncationTokensSaved,
    maxInline: p.maxInlineBytes,
    policyA: p.currentPolicy,
    policyB: p.policy,
  };
}

export function runCompare(argv: string[]): void {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const target = argv.find((a) => !a.startsWith('--'));
  const rows: Row[] = [];
  let source: string;

  if (target) {
    const log = readLogFile(target);
    const row = analyse(log, path.basename(target));
    if (row) rows.push(row);
    source = target;
  } else {
    const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;
    const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
    const root = path.join(home, 'sessions');
    source = root;
    for (const f of discoverSessions(root).slice(0, limit)) {
      const row = analyse(readLogFile(f.path), f.id.slice(0, 22));
      if (row) rows.push(row);
    }
  }

  if (rows.length === 0) {
    console.error(`没有可用会话：${source}`);
    process.exit(2);
  }

  const bar = '─'.repeat(96);
  console.log('\n═══ before / after 对照（同一套投影，只差策略）═══');
  console.log(`数据源    ${source}`);
  console.log(`会话      ${rows.length} 个   共 ${num(rows.reduce((s, r) => s + r.stats.steps, 0))} 步`);

  const first = rows[0].policyA;
  const after = rows[0].policyB;
  const W = rows[0].stats.windowTokens;
  console.log(
    `策略 A    θ=${num(first.theta)}（=${(first.theta / W).toFixed(3)}W）  ρ=${num(first.rho)}  s=${num(first.s)}`,
  );
  console.log(
    `策略 B    θ=${num(after.theta)}（=${(after.theta / W).toFixed(3)}W）  ρ=${num(after.rho)}  s=${num(after.s)}  ` +
      `maxInlineBytes=${num(rows[0].maxInline)}`,
  );

  console.log(`\n${bar}`);
  console.log(
    pad('会话', 24, 'l') +
      pad('步数', 7) +
      pad('实测', 9) +
      pad('A 投影', 9) +
      pad('B 投影', 9) +
      pad('节省', 9) +
      pad('A 上下文', 11) +
      pad('B 上下文', 11) +
      pad('prompt Δ', 12),
  );
  console.log(bar);

  let sumObserved = 0;
  let sumA = 0;
  let sumB = 0;
  let sumATokens = 0;
  let sumBTokens = 0;
  let sumSteps = 0;
  for (const r of rows) {
    sumObserved += r.stats.observedSeconds;
    sumA += r.aSeconds;
    sumB += r.bSeconds;
    sumATokens += r.aTokens;
    sumBTokens += r.bTokens;
    sumSteps += r.stats.steps;
    console.log(
      pad(r.name.slice(0, 22), 24, 'l') +
        pad(num(r.stats.steps), 7) +
        pad(hours(r.stats.observedSeconds) + 'h', 9) +
        pad(hours(r.aSeconds) + 'h', 9) +
        pad(hours(r.bSeconds) + 'h', 9) +
        pad((r.aSeconds - r.bSeconds >= 0 ? '−' : '+') + hours(Math.abs(r.aSeconds - r.bSeconds)) + 'h', 9) +
        pad(num(r.aContext), 11) +
        pad(num(r.bContext), 11) +
        pad(humanTokens(r.bTokens - r.aTokens), 12),
    );
  }
  console.log(bar);
  console.log(
    pad('合计', 24, 'l') +
      pad(num(sumSteps), 7) +
      pad(hours(sumObserved) + 'h', 9) +
      pad(hours(sumA) + 'h', 9) +
      pad(hours(sumB) + 'h', 9) +
      pad('−' + hours(sumA - sumB) + 'h', 9) +
      pad(num(sumATokens / sumSteps), 11) +
      pad(num(sumBTokens / sumSteps), 11) +
      pad(humanTokens(sumBTokens - sumATokens), 12),
  );

  const timeSaving = (sumA - sumB) / sumA;
  const tokenSaving = (sumATokens - sumBTokens) / sumATokens;
  const projectionBias = (sumA - sumObserved) / sumObserved;
  const steady = rows.filter((r) => r.regimeA === 'steady').length;

  console.log(`\n${bar}\n结论\n`);
  console.log(`时间      ${hours(sumA)}h → ${hours(sumB)}h    −${(timeSaving * 100).toFixed(1)}%（${hours(sumA - sumB)} 小时）`);
  console.log(`prompt    ${humanTokens(sumATokens)} → ${humanTokens(sumBTokens)}  token   −${(tokenSaving * 100).toFixed(1)}%`);
  console.log(`每步      ${(sumA / sumSteps).toFixed(2)}s → ${(sumB / sumSteps).toFixed(2)}s`);
  console.log(
    `压缩      ${num(rows.reduce((s, r) => s + r.aCompactions, 0))} 次 → ${num(rows.reduce((s, r) => s + r.bCompactions, 0))} 次   ` +
      `（更早、更频繁、每次更便宜）`,
  );
  const trunc = rows.reduce((s, r) => s + r.truncation, 0);
  if (trunc > 0) {
    const meanG = Math.round(rows.reduce((s, r) => s + r.gBefore, 0) / rows.length);
    const meanGAfter = Math.round(rows.reduce((s, r) => s + r.gAfter, 0) / rows.length);
    console.log(
      `截断      合计少进 ${num(trunc)} tok 工具输出（g 均值 ${meanG} → ${meanGAfter} tok/步）`,
    );
  }
  console.log(
    `\n可信区间  同一模型对实测的系统性偏差 ${(projectionBias * 100).toFixed(1)}%，` +
      `样本外残差 7.6%（selftest）；${rows.length - steady} 个会话为瞬态（未压缩，节省≈0）`,
  );
  console.log('注意      这是策略差，不是重新跑一遍模型；要验证真实效果，请 apply 后跑同样的会话再 compare。\n');
}
