/**
 * ThriftFlow model —— 上下文成本治理的定量模型。
 *
 * 纯函数、无 I/O、无第三方依赖。推导见 `docs/model.zh.md`。
 *
 * 单位约定：对外一律 **秒**（`s`）；文档里常用的毫秒只在展示层换算。
 * 三档 prefill 单价：
 *   alphaL  = 每 token *命中缓存* 的 prefill 时间（s/token/step）
 *   alphaM  = 每 token *未命中*  的 prefill 时间（s/token，一次性）
 *   alphaO  = 每 token 生成时间（含 reasoning）（s/token）
 */

/** 常数的证据等级。写文档时必须带上，否则数字会被当成实测。 */
export type Provenance = 'measured' | 'assumed' | 'needs-calibration';

export interface CoefficientProvenance {
  readonly tau0: Provenance;
  readonly alphaL: Provenance;
  readonly alphaM: Provenance;
  readonly alphaO: Provenance;
  readonly note: string;
}

/**
 * 四个回归常数。
 *
 * 拟合自单个会话（3,233 步），OLS：
 *   ms = 486 + 0.005950*cached + 0.020992*fresh + 4.0321*output
 *   R² = 0.764
 * 换算成秒即下面的值。重新标定时用 `fit()`。
 */
export interface Coefficients {
  /** 每次模型调用的固定开销（网络 + 调度），s */
  readonly tau0: number;
  /** 命中缓存 prompt 的每 token prefill 时间，s/token/step */
  readonly alphaL: number;
  /** 未命中 prompt 的每 token prefill 时间，s/token（一次性） */
  readonly alphaM: number;
  /** 输出（含 reasoning）每 token 的生成时间，s/token */
  readonly alphaO: number;
}

export const MEASURED: Coefficients = {
  tau0: 0.486,
  alphaL: 5.95e-6,
  alphaM: 20.992e-6,
  alphaO: 4.0321e-3,
};

export const PROVENANCE: CoefficientProvenance = {
  tau0: 'measured',
  alphaL: 'measured',
  alphaM: 'measured',
  alphaO: 'measured',
  note:
    '四常数均由 25 个会话中最大者（3,233 步）的日志拟合；未命中/命中单价之比 3.5x。' +
    '摘要调用的真实 usage 未在日志中（compaction/summary 不带 usage），' +
    '所以「摘要器读 θ 全量」是按模型假设折算的，未独立标定。',
};

/** 一次策略：压缩阈值 θ、保留量 ρ、摘要输出长度 s、降智惩罚 γ、每步增长 g、每步输出 ō。 */
export interface Policy {
  /** 压缩触发阈值（prompt token，绝对值，不是窗口比例） */
  readonly theta: number;
  /** 压缩后保留量（prompt token，绝对值） */
  readonly rho: number;
  /** 摘要输出 token 数 */
  readonly s: number;
  /** 降智惩罚系数：>1 表示压缩导致返工/降智，每步成本按此放大 */
  readonly gamma: number;
  /** 每步平均上下文增长（token/step） */
  readonly growth: number;
  /** 每步平均输出 token（含 reasoning）；省略时用 824（实测均值） */
  readonly obar?: number;
  /** 会话起始上下文（transient 段的起点）；省略时用 10k */
  readonly initialContext?: number;
}

export interface StepCost {
  readonly band: number;
  readonly theta: number;
  readonly meanContext: number;
  /** 每步纯工作成本（含 τ0、prefill、生成），未乘 γ */
  readonly workPerStep: number;
  /** 每步摊销的压缩代价（保留区重读 + 摘要读入 + 摘要生成） */
  readonly compactionPerStep: number;
  /** γ·work + compaction */
  readonly totalPerStep: number;
}

// ── 核心方程 ──────────────────────────────────────────────────────────────

/**
 * 最优压缩带宽度。
 *
 *   band* = √( 2g·[α_M(2ρ + s) + α_O·s] / (γ·α_L) )
 *
 * 由目标函数 Φ(θ) = γ·[τ₀ + α_L(ρ+θ)/2 + (α_M-α_L)ḡ + α_O·ō]
 *                 + g·[α_M(θ+ρ+s) + α_O·s]/(θ-ρ)
 * 对 θ 求导置零得到：∂Φ/∂θ = γ·α_L/2 - g·[α_M(2ρ+s) + α_O·s]/(θ-ρ)² = 0
 *
 * 注意：κ 里的 `α_M·θ` 随 θ 变化，必须代入后再求导（这会把 `α_M·ρ` 的系数
 * 变成 2，并把 `s` 带进分子）；把它当常数得到的是错误结果。
 */
export function optimalBand(
  rho: number,
  s: number,
  growth: number,
  gamma = 1,
  k: Coefficients = MEASURED,
): number {
  const numerator = 2 * growth * (k.alphaM * (2 * rho + s) + k.alphaO * s);
  return Math.sqrt(numerator / (gamma * k.alphaL));
}

/** θ* = ρ + band* */
export function optimalThreshold(
  rho: number,
  s: number,
  growth: number,
  gamma = 1,
  k: Coefficients = MEASURED,
): number {
  return rho + optimalBand(rho, s, growth, gamma, k);
}

/** 该策略下每步成本的分解。 */
export function perStep(policy: Policy, k: Coefficients = MEASURED): StepCost {
  const { rho, s, gamma, growth } = policy;
  const obar = policy.obar ?? DEFAULT_OBAR;
  const band = policy.theta - rho;
  if (band <= 0) throw new Error(`invalid policy: theta(${policy.theta}) 必须 > rho(${rho})`);
  const theta = policy.theta;
  const meanContext = (rho + theta) / 2;

  // 工作项：固定开销 + 平均上下文 prefill + 增长量的"未命中溢价" + 生成
  const work = k.tau0 + k.alphaL * meanContext + (k.alphaM - k.alphaL) * growth + k.alphaO * obar;
  // 压缩项：一次压缩要读全量 surface(θ)、重读保留区(ρ)、读 + 生成摘要(s)
  const compactionOnce = k.alphaM * (theta + rho + s) + k.alphaO * s;
  const compactionPerStep = (growth * compactionOnce) / band;

  return {
    band,
    theta,
    meanContext,
    workPerStep: work,
    compactionPerStep,
    totalPerStep: gamma * work + compactionPerStep,
  };
}

/** 实测每步平均输出 token（25 个大会话的均值约 824）。 */
export const DEFAULT_OBAR = 824;

export interface SessionCost {
  readonly perStep: StepCost;
  /** 模型侧总时间，s */
  readonly totalSeconds: number;
  /** 平均上下文 × 步数 ≈ prompt 总量 */
  readonly promptTokens: number;
  /** 压缩次数 */
  readonly compactions: number;
  /** 一个压缩周期的步数 */
  readonly cycleSteps: number;
  /**
   * `steady`：会话长到能跑满一个压缩周期（锯齿稳态，用文档里的方程）；
   * `transient`：会话根本没压过，上下文从 initialContext 线性爬升 —— 只用稳态式会
   * 把 L̄ 高估成 (ρ+θ)/2，短会话的预测会离谱（这是政策级预测的主要误差源）。
   */
  readonly regime: 'steady' | 'transient';
}

/** 会话起始上下文（system + 工具 schema + 首条消息）的默认估计。 */
export const DEFAULT_INITIAL_CONTEXT = 10_000;

/** 从策略推整个会话的成本。 */
export function sessionCost(
  steps: number,
  policy: Policy,
  k: Coefficients = MEASURED,
): SessionCost {
  const band = policy.theta - policy.rho;
  const span = steps * policy.growth;

  if (band > 0 && span <= band) {
    // 整个会话都没触发压缩：上下文从起点线性爬升
    const obar = policy.obar ?? DEFAULT_OBAR;
    const initial = policy.initialContext ?? DEFAULT_INITIAL_CONTEXT;
    const meanContext = initial + span / 2;
    const work =
      k.tau0 + k.alphaL * meanContext + (k.alphaM - k.alphaL) * policy.growth + k.alphaO * obar;
    const ps: StepCost = {
      band: Math.max(1, span),
      theta: policy.theta,
      meanContext,
      workPerStep: work,
      compactionPerStep: 0,
      totalPerStep: policy.gamma * work,
    };
    return {
      perStep: ps,
      totalSeconds: steps * ps.totalPerStep,
      promptTokens: steps * meanContext,
      compactions: 0,
      cycleSteps: span / policy.growth,
      regime: 'transient',
    };
  }

  const ps = perStep(policy, k);
  return {
    perStep: ps,
    totalSeconds: steps * ps.totalPerStep,
    promptTokens: steps * ps.meanContext,
    compactions: Math.ceil((steps * policy.growth) / ps.band),
    cycleSteps: ps.band / policy.growth,
    regime: 'steady',
  };
}

// ── 逐条日志的预测（自测用） ──────────────────────────────────────────────

export interface StepUsage {
  readonly cachedTokens: number;
  readonly freshTokens: number;
  readonly outputTokens: number;
}

/** 单步预测时间（秒）。给定实测 token 数，只检验常数本身。 */
export function predictStepSeconds(u: StepUsage, k: Coefficients = MEASURED): number {
  return k.tau0 + k.alphaL * u.cachedTokens + k.alphaM * u.freshTokens + k.alphaO * u.outputTokens;
}

/** 一次压缩的预测时间：摘要器读全量 + 读+生成摘要。 */
export function predictCompactionSeconds(
  surfaceTokens: number,
  summaryTokens: number,
  k: Coefficients = MEASURED,
): number {
  return k.alphaM * surfaceTokens + (k.alphaM + k.alphaO) * summaryTokens;
}

// ── 决策判据 ──────────────────────────────────────────────────────────────

export interface ExchangeRate {
  /** ∂Φ/∂ρ：每多保留 1 token 的每步成本增量，s/token（恒为正） */
  readonly dPerStepPerToken: number;
  /** 每少保留 10k token 省下的每步时间，s */
  readonly per10kPerStep: number;
  /** 等价的 γ 变化（百分点）：砍 10k 保留量只值这么多 γ */
  readonly gammaPercentPer10k: number;
}

/**
 * 保留量 ↔ γ 的汇率。
 *
 * ∂Φ/∂ρ = γ·α_L/2 + γ'(ρ)·W + g·[α_M(2θ+s) + α_O·s]/(θ-ρ)²
 * 该式置零即 ρ* 的一阶条件；把它写成「γ 的余地」就是汇率。
 */
export function exchangeRate(
  policy: Policy,
  k: Coefficients = MEASURED,
  deltaRho = 10_000,
): ExchangeRate {
  const ps = perStep(policy, k);
  const band = ps.band;
  const dPhi =
    policy.gamma * (k.alphaL / 2) +
    (policy.growth * (k.alphaM * (2 * policy.theta + policy.s) + k.alphaO * policy.s)) / (band * band);
  const perWorkStep = ps.workPerStep;
  return {
    dPerStepPerToken: dPhi,
    per10kPerStep: dPhi * deltaRho,
    gammaPercentPer10k: ((dPhi * deltaRho) / perWorkStep) * 100,
  };
}

export interface BreakEven extends ExchangeRate {
  readonly steps: number;
  /** 把保留量压到 rho 时，γ 必须小于这个值才不亏 */
  readonly requiredGamma: number;
  readonly secondsSaved: number;
}

/** 给定步数，把保留量从基线压到 `rho` 的盈亏平衡 γ。 */
export function breakEvenGamma(
  steps: number,
  baseline: Policy,
  rho: number,
  k: Coefficients = MEASURED,
): BreakEven {
  const base = perStep(baseline, k);
  const target = perStep({ ...baseline, theta: optimalThreshold(rho, baseline.s, baseline.growth, baseline.gamma, k), rho }, k);
  const baseTotal = steps * base.totalPerStep;
  const targetCompaction = steps * target.compactionPerStep;
  const targetWork = steps * target.workPerStep;
  // 解 baseTotal = γ_need·targetWork + targetCompaction
  const requiredGamma = (baseTotal - targetCompaction) / targetWork;
  const ex = exchangeRate(baseline, k, baseline.rho - rho);
  return {
    ...ex,
    steps,
    requiredGamma,
    secondsSaved: baseTotal - (targetWork + targetCompaction),
  };
}

/** 压缩是否值得做：收益按剩余步数摊销，代价（κ）立刻支付。 */
export function worthCompacting(
  remainingSteps: number,
  policy: Policy,
  k: Coefficients = MEASURED,
): { worth: boolean; savingSeconds: number; oneTimeCostSeconds: number } {
  const ps = perStep(policy, k);
  // 压缩把 L̄ 从 θ 附近拉到 ρ 附近，每步省 α_L·(θ-ρ)/2（近似）
  const perStepSaving = k.alphaL * ((policy.theta - policy.rho) / 2);
  const oneTime = k.alphaM * (policy.theta + policy.rho + policy.s) + k.alphaO * policy.s;
  return {
    worth: remainingSteps * perStepSaving > oneTime,
    savingSeconds: remainingSteps * perStepSaving,
    oneTimeCostSeconds: oneTime,
  };
}

// ── 推荐值 ────────────────────────────────────────────────────────────────

export interface Recommendation {
  readonly theta: number;
  readonly rho: number;
  readonly s: number;
  readonly gamma: number;
  readonly band: number;
  readonly perStep: StepCost;
  readonly rationale: readonly string[];
}

/**
 * 给出建议配置。
 *
 * 关键设计判断（见 docs/model.zh.md §6）：
 * - θ 解出来（绝对值，与窗口 W 无关）；
 * - ρ **不解**，当约束给（因为它的全部调整空间只值几分钟，见 exchangeRate）；
 * - s 由摘要器决定，取保守值。
 */
export function recommend(options?: {
  readonly growth?: number;
  readonly s?: number;
  readonly gamma?: number;
  readonly rho?: number;
  readonly k?: Coefficients;
}): Recommendation {
  const growth = options?.growth ?? 800;
  const s = options?.s ?? 500;
  const gamma = options?.gamma ?? 1;
  const rho = options?.rho ?? 30_000;
  const k = options?.k ?? MEASURED;
  const theta = optimalThreshold(rho, s, growth, gamma, k);
  const ps = perStep({ theta, rho, s, gamma, growth }, k);  return {
    theta,
    rho,
    s,
    gamma,
    band: ps.band,
    perStep: ps,
    rationale: [
      'θ 是绝对值解出来的，不是 W 的比例：默认值 0.8·W 在 1M 窗口下等于 800k，几乎不压缩。',
      `ρ 当约束给（${rho}）：把它从 30k 压到 5k 只省几分钟，却要押 γ 上涨 4%。`,
      `s=${s}：摘要输出长度直接决定 θ*（θ* ∝ √s），是比"压缩率"更有效的旋钮。`,
      'γ 只影响 ρ 的余地和总成本；把它降到 1 靠可回取（定位符/原文冷存），不靠摘要器措辞。',
    ],
  };
}

// ── 标定：OLS ────────────────────────────────────────────────────────────

export interface FitRow {
  readonly cachedTokens: number;
  readonly freshTokens: number;
  readonly outputTokens: number;
  readonly seconds: number;
}

/** 四参数 OLS（截距 + 三个 token 项）。 */
export function fit(rows: readonly FitRow[]): Coefficients {
  if (rows.length < 32) throw new Error(`fit(): 样本太少（${rows.length} < 32）`);
  const n = rows.length;
  const x = [
    rows.map(() => 1),
    rows.map((r) => r.cachedTokens),
    rows.map((r) => r.freshTokens),
    rows.map((r) => r.outputTokens),
  ];
  const y = rows.map((r) => r.seconds);
  const dim = 4;

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < dim; i++) {
    a.push([]);
    for (let j = 0; j < dim; j++) a[i].push(dot(x[i], x[j]));
    b.push(dot(x[i], y));
  }

  // 高斯消元（部分主元）
  for (let i = 0; i < dim; i++) {
    let pivot = i;
    for (let r = i + 1; r < dim; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    if (Math.abs(a[pivot][i]) < 1e-12) throw new Error('fit(): 设计矩阵奇异（token 列共线）');
    [a[i], a[pivot]] = [a[pivot], a[i]];
    [b[i], b[pivot]] = [b[pivot], b[i]];
    for (let r = i + 1; r < dim; r++) {
      const f = a[r][i] / a[i][i];
      for (let c = 0; c < dim; c++) a[r][c] -= f * a[i][c];
      b[r] -= f * b[i];
    }
  }
  const sol = new Array<number>(dim).fill(0);
  for (let i = dim - 1; i >= 0; i--) {
    let acc = b[i];
    for (let c = i + 1; c < dim; c++) acc -= a[i][c] * sol[c];
    sol[i] = acc / a[i][i];
  }

  const k: Coefficients = { tau0: sol[0], alphaL: sol[1], alphaM: sol[2], alphaO: sol[3] };
  if (k.alphaL <= 0 || k.alphaM <= 0 || k.alphaO <= 0) {
    throw new Error(`fit(): 出现非正系数 ${JSON.stringify(k)}`);
  }
  return k;
}

export function rSquared(rows: readonly FitRow[], k: Coefficients): number {
  const y = rows.map((r) => r.seconds);
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < rows.length; i++) {
    const p = predictStepSeconds(rows[i], k);
    ssRes += (y[i] - p) ** 2;
    ssTot += (y[i] - mean) ** 2;
  }
  return 1 - ssRes / ssTot;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * b[i];
  return acc;
}
