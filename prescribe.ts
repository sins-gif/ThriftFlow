/**
 * prescribe.ts —— 把"咨询"变成配置处方
 *
 *   node prescribe.ts test/fixtures/synthetic-long-session.jsonl   # 对合成夹具出 Diff 建议表
 *   node prescribe.ts <session.v3.jsonl.zstd>
 *   node prescribe.ts --limit=1             # 不带文件：取 $DSH_HOME 下最大的 N 个会话
 *
 * 它不引入任何新的数学：所有数值都由 model.ts 的 recommend() / sessionCost() /
 * perStep() 给出；本文件只做三件事——从日志里量出当前的策略参数、
 * 把推荐值与当前值摆成一张 Diff 表、把差值折算成"分钟 / 万 token"。
 *
 * 两个判据的来源：
 *  - thresholdRatio：θ* 是绝对值（与窗口无关），所以比例 = θ* / W；
 *  - maxInlineBytes：用 n_c/2 算"一个结果在剩余周期里的持有成本"，
 *    与"从 spill 重取一次"的代价做比较得到 break-even，再取工程上限。
 */

import path from 'node:path';
import { DEFAULT_OBAR, MEASURED, optimalBand, perStep, recommend, sessionCost, type Policy } from './model.ts';
import { discoverSessions, readLogFile, type CallRecord, type ToolResultObservation } from './replay.ts';
import { fileURLToPath } from 'node:url';

/** 当前 dsh 默认值（dsh-base / 各 preset 里写死的那些）。 */
const CURRENT = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxInlineBytes: 50_000,
  prunerThresholdChars: 8_192,
} as const;

/** 早前对真实日志的建议值：41 个工具结果里 8 个超过 8,192 字符，最大 54,045 字符。 */
const TARGET_INLINE_BYTES = 8_000;
/** 保留量：作为约束给，不求解（见 docs/model.zh.md §6.1）。 */
const RETAIN_TOKENS = 30_000;
/** 汇总口径外推的参考步数（用于"这份处方对一个典型长会话值多少"）。 */
const REFERENCE_STEPS = 1_000;

// ── 统计 ──────────────────────────────────────────────────────────────────

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface Stats {
  readonly steps: number;
  readonly windowTokens: number;
  readonly growth: number;
  readonly meanOutput: number;
  readonly summaryTokens: number;
  readonly meanPrompt: number;
  readonly peakPrompt: number;
  readonly firstPrompt: number;
  readonly observedSeconds: number;
  readonly observedPerStep: number;
  readonly toolResults: readonly ToolResultObservation[];
  readonly toolMs: number;
  readonly prunedTokens: number;
}

export function deriveStats(log: ReturnType<typeof readLogFile>): Stats {
  const calls: readonly CallRecord[] = log.calls;
  const steps = calls.length;
  const first = calls[0];
  const freshClean = calls
    .filter((c) => c.compactions.length === 0 && c.freshTokens > 0)
    .map((c) => c.freshTokens);
  const durations = log.toolResults
    .map((t) => t.durationMs)
    .filter((d): d is number => d !== null && d > 0);
  return {
    steps,
    windowTokens: log.contextWindow || 1_000_000,
    growth: Math.max(1, Math.round(median(freshClean)) || 800),
    meanOutput: Math.round(calls.reduce((s, c) => s + c.completionTokens, 0) / Math.max(1, steps)),
    summaryTokens:
      log.compactions.length > 0
        ? Math.round(log.compactions.reduce((s, c) => s + c.summaryTokens, 0) / log.compactions.length)
        : 2_000,
    meanPrompt: Math.round(calls.reduce((s, c) => s + c.promptTokens, 0) / Math.max(1, steps)),
    peakPrompt: Math.max(...calls.map((c) => c.promptTokens)),
    firstPrompt: first?.promptTokens ?? 10_000,
    observedSeconds: calls.reduce((s, c) => s + c.durationMs, 0) / 1000,
    observedPerStep:
      calls.reduce((s, c) => s + c.durationMs, 0) / 1000 / Math.max(1, steps),
    toolResults: log.toolResults,
    toolMs: durations.length > 0 ? Math.round(median(durations)) : 700,
    prunedTokens: log.prunedTokens,
  };
}

// ── 处方 ──────────────────────────────────────────────────────────────────

export interface Prescription {
  readonly theta: number;
  readonly rho: number;
  readonly band: number;
  readonly cycleSteps: number;
  readonly thresholdRatio: number;
  readonly maxInlineBytes: number;
  readonly maxInlineReason: string;
  readonly policy: Policy;
  readonly currentPolicy: Policy;
  readonly current: ReturnType<typeof sessionCost>;
  readonly proposed: ReturnType<typeof sessionCost>;
  /** 稳态（不看会话长度）的每步分解：用于"外推到 N 步"的折算 */
  readonly curSteady: ReturnType<typeof perStep>;
  readonly propSteady: ReturnType<typeof perStep>;
  readonly perStepCurrent: number;
  readonly perStepProposed: number;
  readonly savedSeconds: number;
  readonly savedTokens: number;
  readonly projectedGrowth: number;
  readonly truncationTokensSaved: number;
}

export function prescribe(stats: Stats, k = MEASURED): Prescription {
  const rec = recommend({
    growth: stats.growth,
    s: stats.summaryTokens,
    gamma: 1,
    rho: RETAIN_TOKENS,
    k,
  });
  const band = rec.band;
  const cycleSteps = band / stats.growth;

  // —— maxInlineBytes：n_c/2 持有的边际成本 vs 从 spill 重取一次 ——
  const halfLife = cycleSteps / 2;
  const perTokenSeconds = k.alphaM + k.alphaL * halfLife; // 一个 token 在整个持有期内的时间成本
  const refetchSeconds = k.tau0 + stats.toolMs / 1000; // 重取一次 ≈ 一次 read 调用
  const breakEvenTokens = perTokenSeconds > 0 ? refetchSeconds / perTokenSeconds : Infinity;
  const breakEvenBytes = Math.round((breakEvenTokens * 4) / 500) * 500;
  const maxInlineBytes = Math.max(2_000, Math.min(TARGET_INLINE_BYTES, breakEvenBytes));

  // —— 截断对增长的贡献：超预算部分的 token 不再进上下文 ——
  const excess = stats.toolResults.reduce((s, t) => {
    const tokens = t.tokens;
    const budgetTokens = maxInlineBytes / 4;
    return s + Math.max(0, tokens - budgetTokens);
  }, 0);
  const truncationTokensSaved = excess;
  const projectedGrowth = Math.max(
    1,
    Math.round(stats.growth - excess / Math.max(1, stats.steps)),
  );

  const currentPolicy: Policy = {
    theta: CURRENT.thresholdRatio * stats.windowTokens,
    rho: CURRENT.retainRatio * stats.windowTokens,
    s: stats.summaryTokens,
    gamma: 1,
    growth: stats.growth,
    obar: stats.meanOutput || DEFAULT_OBAR,
    initialContext: stats.firstPrompt,
  };
  const policy: Policy = {
    theta: rec.theta,
    rho: RETAIN_TOKENS,
    s: stats.summaryTokens,
    gamma: 1,
    growth: projectedGrowth,
    obar: stats.meanOutput || DEFAULT_OBAR,
    initialContext: stats.firstPrompt,
  };

  const current = sessionCost(stats.steps, currentPolicy, k);
  const proposed = sessionCost(stats.steps, policy, k);
  const curSteady = perStep(currentPolicy, k);
  const propSteady = perStep(policy, k);
  const savedSeconds = current.totalSeconds - proposed.totalSeconds;
  const savedTokens = current.promptTokens - proposed.promptTokens;

  return {
    theta: rec.theta,
    rho: RETAIN_TOKENS,
    band,
    cycleSteps,
    thresholdRatio: rec.theta / stats.windowTokens,
    maxInlineBytes,
    maxInlineReason:
      `${(perTokenSeconds * 1e6).toFixed(1)}µs/token × n_c/2(${halfLife.toFixed(0)} 步) → ` +
      `break-even ${(breakEvenBytes / 1000).toFixed(1)}k 字节（重取一次 ${refetchSeconds.toFixed(2)}s）`,
    policy,
    currentPolicy,
    current,
    proposed,
    curSteady,
    propSteady,
    perStepCurrent: curSteady.totalPerStep,
    perStepProposed: propSteady.totalPerStep,
    savedSeconds,
    savedTokens,
    projectedGrowth,
    truncationTokensSaved,
  };
}

// ── 输出 ──────────────────────────────────────────────────────────────────

function num(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** 终端显示宽度：CJK 与全角符号算 2 列，否则表格会错位。 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function dispLen(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function pad(v: string | number, w: number, align: 'l' | 'r' = 'r'): string {
  const s = String(v);
  const fill = ' '.repeat(Math.max(0, w - dispLen(s)));
  return align === 'l' ? s + fill : fill + s;
}

/** 把秒/ token 折算成人话（分钟 / 万 / 亿）。 */
function humanTime(seconds: number): string {
  const sign = seconds < 0 ? '−' : '';
  const abs = Math.abs(seconds);
  if (abs < 60) return `${sign}${abs.toFixed(1)} 秒`;
  if (abs < 3600) return `${sign}${(abs / 60).toFixed(1)} 分钟`;
  return `${sign}${(abs / 3600).toFixed(2)} 小时`;
}

function humanTokens(tokens: number): string {
  const sign = tokens < 0 ? '−' : '';
  const abs = Math.abs(tokens);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)} 亿`;
  return `${sign}${(abs / 1e4).toFixed(1)} 万`;
}

function render(
  source: string,
  log: ReturnType<typeof readLogFile>,
  stats: Stats,
  p: Prescription,
): void {
  const bar = '─'.repeat(78);
  const est = Math.abs(stats.observedSeconds - p.current.totalSeconds) / Math.max(1, stats.observedSeconds);

  console.log('\n═══ ThriftFlow 处方（prescribe）═══');
  console.log(`源文件    ${source}`);
  console.log(
    `会话      ${log.sessionId || path.basename(path.dirname(path.resolve(source)))}   ` +
      `模型 ${log.model}   窗口 ${num(stats.windowTokens)}`,
  );
  console.log(
    `规模      ${num(stats.steps)} 步   平均上下文 ${num(stats.meanPrompt)} / 峰值 ${num(stats.peakPrompt)}   ` +
      `实测 ${humanTime(stats.observedSeconds)}（${stats.observedPerStep.toFixed(2)} s/步）`,
  );
  console.log(
    `观测量    g=${num(stats.growth)} tok/步   ō=${num(stats.meanOutput)} tok/步   ` +
      `s=${num(stats.summaryTokens)} tok   工具结果 ${num(stats.toolResults.length)} 个`,
  );

  console.log(`\n${bar}\nDiff 建议表\n`);
  const row = (item: string, cur: string, prop: string, why: string): void => {
    console.log(pad(item, 40, 'l') + pad(cur, 12, 'r') + '  ' + pad(prop, 12, 'r') + '  ' + why);
  };
  row('配置项', '当前', '建议', '依据');
  console.log(bar);
  row(
    'compaction-basic.thresholdRatio',
    CURRENT.thresholdRatio.toFixed(4),
    p.thresholdRatio.toFixed(4),
    `θ* = ${num(p.theta)}（绝对值）；band ${num(p.band)} = √(2g[α_M(2ρ+s)+α_O·s]/(γ·α_L))`,
  );
  row(
    'spill-policy.maxInlineBytes',
    num(CURRENT.maxInlineBytes),
    num(p.maxInlineBytes),
    p.maxInlineReason,
  );
  row(
    'compaction-basic.retainTokens（附带）',
    num(Math.round(CURRENT.retainRatio * stats.windowTokens)),
    num(p.rho),
    'ρ 是约束不是解：再压到 10k 只值 7 分钟，却要押 γ 上涨 3.3%',
  );
  row(
    'tool-result-pruner.thresholdChars（附带）',
    num(CURRENT.prunerThresholdChars),
    num(p.maxInlineBytes),
    '与 spill 预算对齐，避免"先落盘再剪枝"两道工序',
  );
  console.log(bar);

  const EST = '[ESTIMATED]';
  console.log(`\n${bar}\n${EST} 预计影响（模型投影，非实测；实测请跑 compare --after-apply）\n`);
  console.log(
    `${EST} 每步成本（稳态）   ${pad(p.perStepCurrent.toFixed(3) + ' s', 10)} → ${pad(p.perStepProposed.toFixed(3) + ' s', 12)}   ` +
      `(${humanTime(p.perStepProposed - p.perStepCurrent)}/步)`,
  );
  console.log(
    `${EST} 平均上下文（稳态） ${pad(num(p.curSteady.meanContext), 10)} → ${pad(num(p.propSteady.meanContext), 12)}   tok`,
  );
  console.log(
    `${EST} 压缩周期（稳态）   ${pad(p.curSteady.band / stats.growth >= 1 ? (p.curSteady.band / stats.growth).toFixed(0) : '∞', 10)} → ${pad((p.propSteady.band / stats.growth).toFixed(0), 12)}   步   ` +
      `（模型投影压缩 ${num(p.current.compactions)} → ${num(p.proposed.compactions)} 次，非观测值；观测值见 audit 的「压缩 次数」）`,
  );
  if (p.projectedGrowth !== stats.growth) {
    console.log(
      `${EST} 每步增长 g         ${pad(num(stats.growth), 10)} → ${pad(num(p.projectedGrowth), 12)}   ` +
        `（截断省下 ${num(p.truncationTokensSaved)} tok 工具输出）`,
    );
  }

  const steadySavedSeconds = (p.perStepCurrent - p.perStepProposed) * REFERENCE_STEPS;
  const steadySavedTokens = (p.curSteady.meanContext - p.propSteady.meanContext) * REFERENCE_STEPS;

  const regimeLabel = p.current.regime === 'steady' ? '稳态' : '瞬态';
  console.log(
    `\n${EST} 本会话（${num(stats.steps)} 步，${regimeLabel}）   节省 ${humanTime(p.savedSeconds)}、${humanTokens(p.savedTokens)} token`,
  );
  if (Math.abs(p.savedSeconds) < 1) {
    console.log(
      `  ↑ 本会话峰值 ${num(stats.peakPrompt)} tok，未达到当前阈值 ${num(Math.round(p.currentPolicy.theta))}，` +
        `压缩从未发生；处方对这类会话确实无可节省。`,
    );
  }
  console.log(
    `${EST} 外推到 ${num(REFERENCE_STEPS)} 步（稳态）   节省 ${humanTime(steadySavedSeconds)}、${humanTokens(steadySavedTokens)} token`,
  );
  console.log(
    `（当前侧投影 ${humanTime(p.current.totalSeconds)} / 实测 ${humanTime(stats.observedSeconds)}，` +
      `模型误差 ${(est * 100).toFixed(1)}%）`,
  );

  const ratio = p.thresholdRatio;
  console.log(`\n${bar}\n可直接落地的 patch（$DSH_HOME/profiles/<profile>/cordis.patch.yml）\n`);
  console.log('- id: compaction-basic');
  console.log('  config:');
  console.log(`    thresholdRatio: ${ratio.toFixed(4)}   # = ${p.theta.toFixed(0)} / ${stats.windowTokens}`);
  console.log('    # 保留量用绝对值（与 retainRatio 互斥，不能同时写）');
  console.log(`    retainTokens: ${p.rho}`);
  console.log('- id: spill-policy');
  console.log('  config:');
  console.log(`    maxInlineBytes: ${p.maxInlineBytes}`);
  console.log('- id: tool-result-pruner');
  console.log('  config:');
  console.log(`    thresholdChars: ${p.maxInlineBytes}`);
  console.log(`    headChars: ${Math.round(p.maxInlineBytes / 2)}`);
  console.log(`    tailChars: ${Math.round(p.maxInlineBytes / 8)}`);
  console.log('');
}

// ── CLI ───────────────────────────────────────────────────────────────────

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/** `thriftflow prescribe` / `node prescribe.ts` 的入口。 */
export function runPrescribe(argv: string[]): void {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const target = argv.find((a) => !a.startsWith('--'));

  if (target) {
    const log = readLogFile(target);
    if (log.calls.length === 0) {
      console.error(`没有可用的模型调用记录：${target}`);
      process.exit(2);
    }
    const stats = deriveStats(log);
    render(target, log, stats, prescribe(stats));
    return;
  }

  const limit = limitArg ? Number(limitArg.split('=')[1]) : 1;
  const files = discoverSessions(
    path.join(dshHome(), 'sessions'),
    argv.includes('--newest') ? 'mtime' : 'bytes',
  ).slice(0, limit);
  if (files.length === 0) {
    console.error(`没有找到会话日志。用法：node prescribe.ts <日志文件>`);
    process.exit(2);
  }
  for (const f of files) {
    const log = readLogFile(f.path);
    if (log.calls.length === 0) continue;
    const stats = deriveStats(log);
    render(f.path, log, stats, prescribe(stats));
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) runPrescribe(process.argv.slice(2));
