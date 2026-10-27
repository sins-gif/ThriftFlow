/**
 * simulator.ts 的单元测试（5 个）。
 *
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand
 *
 * 断言分两类：
 *   ① 过程量（每步上下文、累加和）—— 直接对照状态方程的逐步展开；
 *   ② 与 model.ts 的闭式解对账 —— 模拟 1000 步应收敛到 sessionCost 的稳态值。
 */

import {
  DEFAULT_INITIAL_CONTEXT,
  DEFAULT_OBAR,
  MEASURED,
  optimalThreshold,
  perStep,
  predictCompactionSeconds,
  sessionCost,
  type Policy,
} from '../model.ts';
import {
  breakEvenSteps,
  compare,
  compactionSeconds,
  simulate,
  stepSeconds,
} from '../simulator.ts';

const G = 800;
const RHO = 30_000;
const S = 500;
const THETA = optimalThreshold(RHO, S, G); // ≈ 59.7k，与 docs/model.zh.md §6.2 的 s=500 行一致

const policy: Policy = { theta: THETA, rho: RHO, s: S, gamma: 1, growth: G };

describe('simulator: 不压缩轨迹', () => {
  test('prompt token = Σ L_i，时间 = 逐步累加的闭式解', () => {
    const steps = 100;
    const sim = simulate(steps, policy, 'uncompressed');

    // ① 状态方程：L_i = L_0 + i·g，最后一次调用都看得见
    let expectedTokens = 0;
    for (let i = 1; i <= steps; i++) expectedTokens += DEFAULT_INITIAL_CONTEXT + i * G;
    expect(sim.promptTokens).toBe(expectedTokens);
    expect(sim.meanContext).toBeCloseTo(expectedTokens / steps, 6);

    // ② 代价泛函：T_i = τ₀ + α_L·c_i + α_M·f_i + α_O·ō，f_i = g（每步新增表面）
    let expectedSeconds = 0;
    for (let i = 1; i <= steps; i++) {
      const context = DEFAULT_INITIAL_CONTEXT + i * G;
      expectedSeconds +=
        MEASURED.tau0 +
        MEASURED.alphaL * (context - G) +
        MEASURED.alphaM * G +
        MEASURED.alphaO * DEFAULT_OBAR;
    }
    expect(sim.seconds).toBeCloseTo(expectedSeconds, 6);

    // 单调爬升、从不压缩
    expect(sim.compactions).toBe(0);
    expect(sim.trace[0].context).toBe(DEFAULT_INITIAL_CONTEXT + G);
    expect(sim.trace.at(-1)!.context).toBe(DEFAULT_INITIAL_CONTEXT + steps * G);
    expect(sim.peakContext).toBe(DEFAULT_INITIAL_CONTEXT + steps * G);
  });
});

describe('simulator: 压缩轨迹', () => {
  test('越界即回落到 ρ，上下文永不超过 θ', () => {
    const sim = simulate(100, policy, 'compressed');
    expect(sim.compactions).toBeGreaterThanOrEqual(1);

    for (const step of sim.trace) {
      expect(step.context).toBeLessThanOrEqual(policy.theta);
      if (step.compacted) expect(step.context).toBe(policy.rho); // 压缩后立刻回落到 ρ
      expect(Number.isFinite(step.seconds)).toBe(true);
    }
    expect(sim.peakContext).toBeLessThanOrEqual(policy.theta);
    expect(sim.peakContext).toBeGreaterThan(policy.rho);
  });

  test('省 token 但不同比例省时间（token 省 >20%，时间省得远少于此）', () => {
    const c = compare(100, policy);
    expect(c.plain.promptTokens).toBeGreaterThan(c.compacted.promptTokens);
    expect(c.promptSavedPct).toBeGreaterThan(20);
    // 模型的核心结论：账单与时间解耦 —— 时间节省比例严格小于 token 节省比例
    expect(c.secondsSavedPct).toBeLessThan(c.promptSavedPct);
    // 输出 token 与压缩无关
    expect(c.compacted.outputTokens).toBe(c.plain.outputTokens);
  });

  test('1000 步模拟收敛到 sessionCost 的稳态闭式解（±8%）', () => {
    const steps = 1000;
    const sim = simulate(steps, policy, 'compressed');
    const closed = sessionCost(steps, policy);
    expect(closed.regime).toBe('steady');
    expect(sim.promptTokens / closed.promptTokens).toBeGreaterThan(0.92);
    expect(sim.promptTokens / closed.promptTokens).toBeLessThan(1.08);
    expect(sim.seconds / closed.totalSeconds).toBeGreaterThan(0.92);
    expect(sim.seconds / closed.totalSeconds).toBeLessThan(1.08);
  });
});

describe('simulator: 压缩代价与参数守卫', () => {
  test('压缩代价与 model.ts 口径一致，且非法策略抛错', () => {
    // 与 predictCompactionSeconds(surface=θ+ρ, summary=s) 同源
    expect(compactionSeconds(policy)).toBeCloseTo(
      predictCompactionSeconds(policy.theta + policy.rho, S),
      9,
    );
    // 与 perStep 的摊销口径对账：compactionPerStep = g·κ/band
    const ps = perStep(policy);
    expect(ps.compactionPerStep * ps.band / G).toBeCloseTo(compactionSeconds(policy), 6);

    // 盈亏平衡步数落在合理区间（一次压缩 ≈ 3.9 s，每步省 ≈ 0.088 s）
    expect(breakEvenSteps(policy)).toBeGreaterThan(30);
    expect(breakEvenSteps(policy)).toBeLessThan(60);

    // 守卫：θ ≤ ρ、steps ≤ 0 都必须抛错，而不是静默算错
    expect(() => simulate(10, { ...policy, theta: RHO })).toThrow(/theta > rho/);
    expect(() => simulate(0, policy)).toThrow(/steps/);
    // 不压缩模式即使越过 θ 也不重置
    const plain = simulate(100, policy, 'uncompressed');
    expect(plain.peakContext).toBeGreaterThan(policy.theta);
    expect(stepSeconds(1000, 100, 10)).toBeGreaterThan(0);
  });
});
