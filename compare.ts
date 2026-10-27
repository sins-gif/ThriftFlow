/**
 * compare.ts —— before / after 对照
 *
 *   node thriftflow.ts compare                      # 最大的 25 个会话（策略投影对照）
 *   node thriftflow.ts compare --limit=50
 *   node thriftflow.ts compare test/fixtures/synthetic-long-session.jsonl
 *   node thriftflow.ts compare --newest --limit=5   # 最新的 5 个会话
 *   node thriftflow.ts compare --after-apply        # 按 apply 生效时间切分，只比实测
 *
 * 两种模式的区别很重要：
 *
 *   · 默认（策略投影）：两侧都用 model.ts 的同一套投影：A = 当前 dsh 默认（0.8W / 0.16W），
 *     B = 处方（θ* / W、ρ=30k、截断后的 g'）。比的是**策略差**，不是"投影 vs 实测"。
 *   · `--after-apply`：读 apply 写下的 `~/.dsh/.thriftflow/applied.json`，用其中的时间戳
 *     把会话日志切成 before / after 两组，两边都取实测中位数。它回答的是"改了之后，
 *     真实跑出来的形状变了没有"。两组任务构成不同，所以只能当趋势证据。
 *
 * 同时报 A 投影与实测的偏差，好让读者知道这张表的可信区间。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { sessionCost, type Policy } from './model.ts';
import { discoverSessions, readLogFile, type SessionFile } from './replay.ts';
import { deriveStats, prescribe, type Stats } from './prescribe.ts';
import { appliedRecordPath, readAppliedRecord } from './apply.ts';

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

// ── --after-apply：按生效时间切分实测 ─────────────────────────────────────

/** after 组样本门槛：最大的一份会话至少这么多步才肯下结论。 */
const MIN_AFTER_STEPS = 50;
/** before 组默认取体积最大的几个会话（稳态负载代表）。 */
const DEFAULT_BEFORE_LIMIT = 10;

interface Measured {
  readonly name: string;
  readonly steps: number;
  readonly mtimeMs: number;
  /** 会话开始时间（日志首事件的 time）：判断它到底跑在新配置上还是旧配置上 */
  readonly startedAtMs: number;
  readonly compactionsPer1000: number;
  readonly meanPrompt: number;
  readonly peakPrompt: number;
  readonly secondsPerStep: number;
  readonly reasoningRatio: number;
  readonly cacheHit: number;
  /** 模型在"处方策略"下对同一份日志的预测（用于量化预测误差） */
  readonly predictedSecondsPerStep: number;
  readonly predictedMeanPrompt: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 只看实测：把一份会话日志折成可比较的几个数，不做任何投影。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 读会话文件的第一条事件，取它的 time 作为"会话开始时间"（不依赖 FoldedLog 的内部形状）。 */
function readStartedAtMs(file: SessionFile): number | null {
  try {
    const buf = fs.readFileSync(file.path);
    let head: string;
    if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
      // 第一帧就包含日志开头；用第二帧的魔数切分（与 replay.ts 同一套解法）
      const next = buf.indexOf(ZSTD_MAGIC, 4);
      const end = next === -1 ? buf.length : next;
      head = zlib.zstdDecompressSync(buf.subarray(0, end)).toString('utf8');
    } else {
      head = buf.subarray(0, 65536).toString('utf8');
    }
    let seen = 0;
    for (const raw of head.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (++seen > 200) break;
      try {
        const parsed = JSON.parse(line) as { time?: unknown };
        if (typeof parsed.time === 'number' && Number.isFinite(parsed.time)) return parsed.time;
      } catch {
        // 行没写完就跳过
      }
    }
    return null;
  } catch {
    return null;
  }
}

function measure(file: SessionFile): Measured | null {
  const log = readLogFile(file.path);
  const calls = log.calls;
  if (calls.length === 0) return null;
  const stats = deriveStats(log);
  const p = prescribe(stats);
  const prompt = calls.reduce((s, c) => s + c.promptTokens, 0);
  const reasoning = calls.reduce((s, c) => s + c.reasoningTokens, 0);
  const cached = calls.reduce((s, c) => s + c.cacheReadTokens, 0);
  // 首事件时间 = 会话真正开始的时间；mtime 只说明最后一次写入，不能用来分组
  const startedAtMs = readStartedAtMs(file) ?? file.mtimeMs;
  return {
    name: file.id.slice(0, 22),
    steps: calls.length,
    mtimeMs: file.mtimeMs,
    startedAtMs,
    compactionsPer1000: (log.compactions.length / calls.length) * 1000,
    meanPrompt: stats.meanPrompt,
    peakPrompt: stats.peakPrompt,
    secondsPerStep: stats.observedPerStep,
    reasoningRatio: prompt > 0 ? reasoning / prompt : 0,
    cacheHit: prompt > 0 ? cached / prompt : 0,
    predictedSecondsPerStep: p.proposed.totalSeconds / Math.max(1, calls.length),
    // 与实测同口径：整个会话的 prompt 总量 / 步数（含爬升段），
    // 不是稳态 meanContext —— 后者会把爬升算成"预测误差"。
    predictedMeanPrompt: p.proposed.promptTokens / Math.max(1, calls.length),
  };
}

interface GroupSummary {
  readonly list: readonly Measured[];
  readonly sessions: number;
  readonly steps: number;
  readonly maxSteps: number;
  readonly compactionsPer1000: number;
  readonly meanPrompt: number;
  readonly peakPrompt: number;
  readonly secondsPerStep: number;
  readonly reasoningRatio: number;
  readonly cacheHit: number;
  readonly predictedSecondsPerStep: number;
  readonly predictedMeanPrompt: number;
}

function summarize(list: readonly Measured[]): GroupSummary {
  return {
    list,
    sessions: list.length,
    steps: list.reduce((s, m) => s + m.steps, 0),
    maxSteps: list.reduce((s, m) => Math.max(s, m.steps), 0),
    compactionsPer1000: median(list.map((m) => m.compactionsPer1000)),
    meanPrompt: median(list.map((m) => m.meanPrompt)),
    peakPrompt: median(list.map((m) => m.peakPrompt)),
    secondsPerStep: median(list.map((m) => m.secondsPerStep)),
    reasoningRatio: median(list.map((m) => m.reasoningRatio)),
    cacheHit: median(list.map((m) => m.cacheHit)),
    predictedSecondsPerStep: median(list.map((m) => m.predictedSecondsPerStep)),
    predictedMeanPrompt: median(list.map((m) => m.predictedMeanPrompt)),
  };
}

function pctChange(before: number, after: number): string {
  if (before === 0) return after === 0 ? '—' : '新增';
  const d = (after - before) / before;
  return `${d < 0 ? '−' : '+'}${(Math.abs(d) * 100).toFixed(1)}%`;
}

function ppChange(before: number, after: number): string {
  const d = (after - before) * 100;
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}pp`;
}

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/**
 * `compare --after-apply`：用 apply 留下的时间锚点，把会话日志切成 before / after，
 * 只比**实测**。分组依据是文件 mtime，不是任务内容 —— 所以这是趋势证据。
 */
function runAfterApply(argv: string[]): void {
  const home = dshHome();
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const beforeLimit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_BEFORE_LIMIT;

  const record = readAppliedRecord(home);
  if (!record) {
    console.error(
      `\n没有生效记录：${appliedRecordPath(home)}\n` +
        '  这条记录由 apply 成功后写入（--dry-run 不写）。\n' +
        '  先跑一次真的 apply，之后再用 compare --after-apply。\n',
    );
    process.exit(2);
    return;
  }

  const root = path.join(home, 'sessions');
  const all = discoverSessions(root, 'mtime');
  const beforePicked = all
    .filter((f) => f.mtimeMs < record.appliedAtMs)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, beforeLimit);
  const afterFiles = all.filter((f) => f.mtimeMs >= record.appliedAtMs);

  const before = beforePicked.map(measure).filter((m): m is Measured => m !== null);
  const afterAll = afterFiles.map(measure).filter((m): m is Measured => m !== null);
  // 跨过生效点的旧会话：文件还在写（mtime 新），但会话是在 apply 之前开跑的，
  // 跑的是旧预设，混进 after 组会把结论带偏 —— 剔除。
  const after = afterAll.filter((m) => m.startedAtMs >= record.appliedAtMs);
  const droppedAfter = afterAll.length - after.length;
  const beforeSum = summarize(before);
  const afterSum = summarize(after);

  const bar = '─'.repeat(78);
  console.log('\n═══ after-apply 实测对照（趋势证据，不是同任务 A/B）═══');
  console.log(`生效时间  ${record.appliedAt}`);
  const windowTokens = record.values.windowTokens > 0 ? record.values.windowTokens : 1_000_000;
  console.log(
    `处方      θ=${num(record.values.theta)}（=${(record.values.theta / windowTokens).toFixed(3)}W）  ` +
      `ρ=${num(record.values.rho)}  maxInlineBytes=${num(record.values.maxInlineBytes)}`,
  );
  console.log(`preset    ${record.presetId}（profile ${record.profile}）   备份 ${record.backupId}`);
  console.log(`会话目录  ${root}`);
  console.log(
    `before    ${beforeSum.sessions} 个会话 / ${num(beforeSum.steps)} 步（取时间点之前体积最大的 ${beforeLimit} 个）`,
  );
  console.log(
    `after     ${afterSum.sessions} 个会话 / ${num(afterSum.steps)} 步（最大 ${num(afterSum.maxSteps)} 步）` +
      (droppedAfter > 0 ? `，剔除 ${droppedAfter} 个跨生效点的旧会话` : ""),
  );

  const insufficient = (): void => {
    console.error(`\n样本不足：after 组需要至少 1 个会话且最大步数 ≥ ${MIN_AFTER_STEPS}，当前 ` +
      `${afterSum.sessions} 个会话 / 最大 ${num(afterSum.maxSteps)} 步。不编数，等攒够再跑。\n`);
    process.exit(2);
  };

  if (beforeSum.sessions === 0) {
    console.error('\n样本不足：时间点之前没有任何会话，没有 before 基线。不编数。\n');
    process.exit(2);
    return;
  }
  if (afterSum.sessions === 0 || afterSum.maxSteps < MIN_AFTER_STEPS) {
    insufficient();
    return;
  }

  console.log(`\n${bar}`);
  console.log(
    pad('指标', 20, 'l') + pad('before', 16) + pad('after', 16) + pad('变化', 14),
  );
  console.log(bar);
  const row = (label: string, b: string, a: string, d: string): void => {
    console.log(pad(label, 20, 'l') + pad(b, 16) + pad(a, 16) + pad(d, 14));
  };
  row(
    '每千步压缩次数',
    beforeSum.compactionsPer1000.toFixed(1),
    afterSum.compactionsPer1000.toFixed(1),
    pctChange(beforeSum.compactionsPer1000, afterSum.compactionsPer1000),
  );
  row(
    '平均 prompt',
    num(beforeSum.meanPrompt),
    num(afterSum.meanPrompt),
    pctChange(beforeSum.meanPrompt, afterSum.meanPrompt),
  );
  row(
    '峰值 prompt',
    num(beforeSum.peakPrompt),
    num(afterSum.peakPrompt),
    pctChange(beforeSum.peakPrompt, afterSum.peakPrompt),
  );
  row(
    's/步',
    beforeSum.secondsPerStep.toFixed(2),
    afterSum.secondsPerStep.toFixed(2),
    pctChange(beforeSum.secondsPerStep, afterSum.secondsPerStep),
  );
  row(
    'reasoning 占比',
    (beforeSum.reasoningRatio * 100).toFixed(1) + '%',
    (afterSum.reasoningRatio * 100).toFixed(1) + '%',
    ppChange(beforeSum.reasoningRatio, afterSum.reasoningRatio),
  );
  row(
    '缓存命中率',
    (beforeSum.cacheHit * 100).toFixed(1) + '%',
    (afterSum.cacheHit * 100).toFixed(1) + '%',
    ppChange(beforeSum.cacheHit, afterSum.cacheHit),
  );
  console.log(bar);

  console.log('\n模型对 after 组的预测（处方策略下的投影 vs 实测）');
  console.log(
    `  每步         预测 ${afterSum.predictedSecondsPerStep.toFixed(2)}s    ` +
      `实测 ${afterSum.secondsPerStep.toFixed(2)}s    误差 ${pctChange(afterSum.secondsPerStep, afterSum.predictedSecondsPerStep)}`,
  );
  console.log(
    `  平均 prompt  预测 ${num(afterSum.predictedMeanPrompt)}    ` +
      `实测 ${num(afterSum.meanPrompt)}    误差 ${pctChange(afterSum.meanPrompt, afterSum.predictedMeanPrompt)}`,
  );

  console.log(
    '\n注意      两组会话是**不同任务**，只是同一套配置前后。任务构成不同，' +
      '这是趋势证据，不是同任务 A/B。\n',
  );
}

export function runCompare(argv: string[]): void {
  if (argv.includes('--after-apply')) {
    runAfterApply(argv);
    return;
  }

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
    for (const f of discoverSessions(root, argv.includes('--newest') ? 'mtime' : 'bytes').slice(0, limit)) {
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

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) runCompare(process.argv.slice(2));
