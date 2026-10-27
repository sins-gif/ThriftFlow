/**
 * simulator.ts —— model.ts 的极简过程模拟器。
 *
 * model.ts 给的是**闭式解**（sessionCost 用 (ρ+θ)/2 的均值一步到位）；
 * 这里把同一个模型**逐步展开**：按状态方程推进上下文，按代价泛函累加时间与
 * prompt token，从而看到压缩（锯齿）与不压缩（单调爬升）两条轨迹的差距。
 *
 *   node simulator.ts                          # 默认 100 步 + recommend() 策略
 *   node simulator.ts --steps=1000             # 换步数
 *   node simulator.ts --rho=15000 --s=500 --growth=800 --gamma=1
 *
 * 纯函数 + 一个 CLI 入口，无第三方依赖（import 也只从 model.ts 来）。
 */

import { pathToFileURL } from 'node:url';
import {
  DEFAULT_INITIAL_CONTEXT,
  DEFAULT_OBAR,
  MEASURED,
  optimalThreshold,
  predictCompactionSeconds,
  recommend,
  sessionCost,
  type Coefficients,
  type Policy,
} from './model.ts';

export type Mode = 'uncompressed' | 'compressed';

/** 单步记账。`compacted` 表示本步结束后刚做过一次压缩。 */
export interface SimStep {
  readonly step: number;
  /** 本步模型可见的 prompt token（模型看到的 L_i） */
  readonly context: number;
  readonly compacted: boolean;
  /** 本步时间（含摊销到本步的压缩代价），s */
  readonly seconds: number;
}

export interface SimResult {
  readonly mode: Mode;
  readonly steps: number;
  /** 模型侧总时间，s */
  readonly seconds: number;
  /** Σ L_i，即 prompt token 总量 */
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly compactions: number;
  readonly peakContext: number;
  readonly meanContext: number;
  readonly trace: readonly SimStep[];
}

export interface Comparison {
  readonly policy: Policy;
  readonly plain: SimResult;
  readonly compacted: SimResult;
  readonly promptTokensSaved: number;
  readonly promptSavedPct: number;
  readonly secondsSaved: number;
  readonly secondsSavedPct: number;
  /** 盈亏平衡步数：省下的每步时间×剩余步数 = 一次性压缩代价 */
  readonly breakEvenSteps: number;
}

// ── 两个代价泛函的单步形式 ────────────────────────────────────────────────

/**
 * 单步时间：T_i = γ·[τ₀ + α_L·c_i + α_M·f_i + α_O·o_i]。
 *
 * `freshTokens` 是这一步新增的表面（未命中），其余视为命中缓存。
 * γ 只放大「工作」项，压缩代价不打折（压缩本身不降智）。
 */
export function stepSeconds(
  context: number,
  freshTokens: number,
  outputTokens: number,
  gamma = 1,
  k: Coefficients = MEASURED,
): number {
  const fresh = Math.min(freshTokens, context);
  const cached = context - fresh;
  return gamma * (k.tau0 + k.alphaL * cached + k.alphaM * fresh + k.alphaO * outputTokens);
}

/**
 * 一次压缩的时间：摘要器读全量 surface(θ+ρ) + 读摘要 + 生成摘要。
 * 直接用 model.ts 的预测式，避免两处公式漂移：α_M·(θ+ρ) + (α_M+α_O)·s。
 */
export function compactionSeconds(
  policy: Policy,
  k: Coefficients = MEASURED,
): number {
  return predictCompactionSeconds(policy.theta + policy.rho, policy.s, k);
}

// ── 模拟 ──────────────────────────────────────────────────────────────────

/**
 * 跑一条 `steps` 步的轨迹。
 *
 * 状态方程（聚合形式）：L_{i+1} = L_i + g，其中 g = ō + 工具结果 + 插件注入；
 * 压缩把 L 从越界的 θ 砍回 ρ（文档 §3 的锯齿）。
 *
 * 压缩发生在步内：先累加本步增长，越界则付一次性代价并重置，再做这次模型调用。
 */
export function simulate(
  steps: number,
  policy: Policy,
  mode: Mode = 'compressed',
  k: Coefficients = MEASURED,
): SimResult {
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new Error(`simulate(): steps 必须是正整数，收到 ${steps}`);
  }
  if (mode === 'compressed' && policy.theta <= policy.rho) {
    throw new Error(`simulate(): 需要 theta > rho，收到 theta=${policy.theta} rho=${policy.rho}`);
  }

  const growth = policy.growth;
  const output = policy.obar ?? DEFAULT_OBAR;
  const start = policy.initialContext ?? DEFAULT_INITIAL_CONTEXT;

  let context = start;
  let seconds = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let compactions = 0;
  let peak = start;
  const trace: SimStep[] = [];

  for (let step = 1; step <= steps; step++) {
    context += growth; // 本步新增的表面（输出 + 工具结果 + 注入）
    let compacted = false;
    let cost = 0;

    if (mode === 'compressed' && context > policy.theta) {
      // 步内压缩：先付一次性代价，再把 L 拉回 ρ
      cost += compactionSeconds(policy, k);
      context = policy.rho;
      compactions += 1;
      compacted = true;
    }

    const t = stepSeconds(context, growth, output, policy.gamma, k);
    cost += t;
    seconds += cost;
    promptTokens += context;
    outputTokens += output;
    peak = Math.max(peak, context);
    trace.push({ step, context, compacted, seconds: cost });
  }

  return {
    mode,
    steps,
    seconds,
    promptTokens,
    outputTokens,
    compactions,
    peakContext: peak,
    meanContext: promptTokens / steps,
    trace,
  };
}

/** 两条轨迹一起跑，并算出差额。 */
export function compare(
  steps: number,
  policy: Policy,
  k: Coefficients = MEASURED,
): Comparison {
  const plain = simulate(steps, policy, 'uncompressed', k);
  const compacted = simulate(steps, policy, 'compressed', k);
  return {
    policy,
    plain,
    compacted,
    promptTokensSaved: plain.promptTokens - compacted.promptTokens,
    promptSavedPct: (1 - compacted.promptTokens / plain.promptTokens) * 100,
    secondsSaved: plain.seconds - compacted.seconds,
    secondsSavedPct: (1 - compacted.seconds / plain.seconds) * 100,
    breakEvenSteps: breakEvenSteps(policy, k),
  };
}

/** 「值得压缩」的临界步数：一次压缩代价 ÷ 每步省下的 prefill。 */
export function breakEvenSteps(policy: Policy, k: Coefficients = MEASURED): number {
  const perStepSaving = k.alphaL * ((policy.theta - policy.rho) / 2); // 文档 §6.3
  return Math.ceil(compactionSeconds(policy, k) / perStepSaving);
}

// ── 展示 ──────────────────────────────────────────────────────────────────

const dispWidth = (s: string): number =>
  [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);

const pad = (v: string | number, w: number, align: 'l' | 'r' = 'r'): string => {
  const s = String(v);
  const gap = ' '.repeat(Math.max(0, w - dispWidth(s)));
  return align === 'l' ? s + gap : gap + s;
};

const num = (n: number): string => Math.round(n).toLocaleString('en-US');

const kb = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export function formatReport(c: Comparison): string {
  const { policy, plain, compacted } = c;
  const signed = (n: number, digits = 0): string =>
    `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(digits)}`;
  const steady = sessionCost(compacted.steps, policy);
  const lines: string[] = [];

  lines.push(
    `ThriftFlow · ${compacted.steps} 步会话模拟（θ=${kb(policy.theta)} ρ=${kb(policy.rho)} ` +
      `s=${policy.s} g=${policy.growth} γ=${policy.gamma.toFixed(2)}）`,
  );
  lines.push('');
  lines.push(`${pad('指标', 16, 'l')}${pad('不压缩', 15)}${pad('压缩', 15)}${pad('差值', 15)}`);
  lines.push('─'.repeat(61));
  lines.push(
    `${pad('prompt token', 16, 'l')}${pad(num(plain.promptTokens), 15)}` +
      `${pad(num(compacted.promptTokens), 15)}` +
      `${pad(`−${num(c.promptTokensSaved)}`, 15)}  (${c.promptSavedPct.toFixed(1)}%)`,
  );
  lines.push(
    `${pad('输出 token', 16, 'l')}${pad(num(plain.outputTokens), 15)}` +
      `${pad(num(compacted.outputTokens), 15)}${pad('0', 15)}`,
  );
  lines.push(
    `${pad('总时间 s', 16, 'l')}${pad(plain.seconds.toFixed(1), 15)}` +
      `${pad(compacted.seconds.toFixed(1), 15)}` +
      `${pad(signed(-c.secondsSaved, 1), 15)}  (${signed(-c.secondsSavedPct, 1)}%)`,
  );
  lines.push(
    `${pad('均值上下文', 16, 'l')}${pad(kb(plain.meanContext), 15)}` +
      `${pad(kb(compacted.meanContext), 15)}${pad(kb(plain.meanContext - compacted.meanContext), 15)}`,
  );
  lines.push(
    `${pad('峰值上下文', 16, 'l')}${pad(kb(plain.peakContext), 15)}` +
      `${pad(kb(compacted.peakContext), 15)}${pad('', 15)}`,
  );
  lines.push(
    `${pad('压缩次数', 16, 'l')}${pad(plain.compactions, 15)}` +
      `${pad(compacted.compactions, 15)}` +
      `${pad(kb(compacted.steps / Math.max(1, compacted.compactions)), 15)} 步/次`,
  );
  lines.push('');
  lines.push(
    `判据：一次压缩 ${compactionSeconds(policy).toFixed(2)} s，每步省 ` +
      `${(MEASURED.alphaL * ((policy.theta - policy.rho) / 2)).toFixed(4)} s，` +
      `盈亏平衡 ${c.breakEvenSteps} 步 → ${compacted.steps >= c.breakEvenSteps ? '划算' : '不划算'}`,
  );
  lines.push(
    `对账：sessionCost 稳态 ${steady.totalSeconds.toFixed(1)} s / ` +
      `${num(steady.promptTokens)} tok（${steady.regime}），模拟 ` +
      `${compacted.seconds.toFixed(1)} s / ${num(compacted.promptTokens)} tok`,
  );
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const v = Number(hit.slice(name.length + 3));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} 需要正数，收到 ${hit}`);
  return v;
}

export function main(): void {
  const steps = arg('steps', 100);
  const seed = recommend();
  const rho = arg('rho', seed.rho);
  const s = arg('s', seed.s);
  const gamma = arg('gamma', seed.gamma);
  const growth = arg('growth', 800);
  // θ 由 ρ/γ/s/g 解出来（model.ts 的结构性结论：θ 是绝对值闭式解，不是窗口比例）
  const policy: Policy = {
    theta: optimalThreshold(rho, s, growth, gamma),
    rho,
    s,
    gamma,
    growth,
  };
  const report = formatReport(compare(steps, policy));
  console.log(report);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
