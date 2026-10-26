/**
 * 自测：用真实 dsh 会话日志检验 model.ts。
 *
 *   node selftest.ts            # 回放 25 个最大会话，拟合 + 残差
 *   node selftest.ts --tables   # 打印文档用的策略表
 *   node selftest.ts --policy   # 政策级预测（只看策略参数，不看逐步 token）
 *
 * 残差定义： (predicted - observed) / observed，按会话算，再报未加权平均（MAPE）。
 * 目标：总时间预测残差 < 10%。
 */

import os from 'node:os';
import path from 'node:path';
import {
  MEASURED,
  breakEvenGamma,
  exchangeRate,
  fit,
  optimalThreshold,
  perStep,
  predictCompactionSeconds,
  predictStepSeconds,
  rSquared,
  recommend,
  sessionCost,
  type Coefficients,
  type FitRow,
  type Policy,
} from './model.ts';
import { discoverSessions, estimateGrowth, readSession, type SessionObservation } from './replay.ts';

const TARGET = 0.1;
const DEFAULT_LIMIT = 25;

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

function pad(v: string | number, width: number, align: 'l' | 'r' = 'r'): string {
  const s = String(v);
  return align === 'l' ? s.padEnd(width) : s.padStart(width);
}

function fx(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

interface Scored {
  readonly session: SessionObservation;
  readonly predicted: number;
  readonly observed: number;
  readonly residual: number;
  readonly stepsUsed: number;
}

/** 用给定常数逐条重放：预测 = Σ 每步 + Σ 压缩。 */
function replayPredict(session: SessionObservation, k: Coefficients): number {
  let total = 0;
  for (const step of session.steps) {
    total += predictStepSeconds(step, k);
    for (const c of step.compactions) {
      total += predictCompactionSeconds(c.surfaceTokens, c.summaryTokens, k);
    }
  }
  return total;
}

function score(sessions: readonly SessionObservation[], k: Coefficients): Scored[] {
  return sessions
    .filter((s) => s.steps.length > 0 && s.totals.totalSeconds > 1)
    .map((session) => {
      const observed = session.totals.totalSeconds;
      const predicted = replayPredict(session, k);
      return {
        session,
        predicted,
        observed,
        residual: (predicted - observed) / observed,
        stepsUsed: session.steps.length,
      };
    });
}

function fitRows(session: SessionObservation): FitRow[] {
  // 只拿"无压缩"的干净步骤拟合，压缩代价作为独立项单独建模
  return session.steps
    .filter((s) => s.compactions.length === 0 && s.calls === 1)
    .map((s) => ({
      cachedTokens: s.cachedTokens,
      freshTokens: s.freshTokens,
      outputTokens: s.outputTokens,
      seconds: s.seconds,
    }));
}

function printTable(rows: Scored[], title: string): void {
  console.log(`\n${title}`);
  console.log(
    pad('session', 34, 'l'),
    pad('model', 18, 'l'),
    pad('steps', 6),
    pad('observed', 10),
    pad('predicted', 10),
    pad('resid', 9),
  );
  for (const r of rows) {
    console.log(
      pad(r.session.id.slice(0, 32), 34, 'l'),
      pad(r.session.model.slice(0, 16), 18, 'l'),
      pad(r.stepsUsed, 6),
      pad(hours(r.observed), 10),
      pad(hours(r.predicted), 10),
      pad(`${(r.residual * 100).toFixed(1)}%`, 9),
    );
  }
}

function summarize(rows: Scored[], label: string): number {
  const mape = rows.reduce((s, r) => s + Math.abs(r.residual), 0) / rows.length;
  const meanBias = rows.reduce((s, r) => s + r.residual, 0) / rows.length;
  const sumObs = rows.reduce((s, r) => s + r.observed, 0);
  const sumPred = rows.reduce((s, r) => s + r.predicted, 0);
  const weighted = (sumPred - sumObs) / sumObs;
  console.log(
    `${label}: n=${rows.length}  MAPE=${(mape * 100).toFixed(1)}%  平均偏差=${(meanBias * 100).toFixed(1)}%  ` +
      `合计 ${hours(sumObs)}h vs ${hours(sumPred)}h（${(weighted * 100).toFixed(1)}%）`,
  );
  return mape;
}

// ── 模式 ──────────────────────────────────────────────────────────────────

function runReplay(limit: number, flashOnly: boolean): void {
  const sessionsDir = path.join(dshHome(), 'sessions');
  const files = discoverSessions(sessionsDir);
  if (files.length === 0) {
    console.error(`未找到会话日志：${sessionsDir}`);
    process.exit(2);
  }
  const picked = files.slice(0, limit);
  console.log(`会话根：${sessionsDir}`);
  console.log(`发现 ${files.length} 个会话，回放最大的 ${picked.length} 个…`);

  const started = Date.now();
  const sessions = picked.map(readSession);
  console.log(`回放完成：${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  const withSteps = sessions.filter((s) => s.steps.length > 0);
  const usable = flashOnly ? withSteps.filter((s) => /flash/.test(s.model)) : withSteps;
  if (usable.length < 2) {
    console.error('可用会话不足，无法做样本内/外切分');
    process.exit(2);
  }

  const calibration = usable[0];
  const rows = fitRows(calibration);
  const fitted = fit(rows);
  const r2 = rSquared(rows, fitted);

  console.log(`标定会话：${calibration.id}（${calibration.model}，${calibration.steps.length} 步，用 ${rows.length} 个干净步骤）`);
  console.log(
    `拟合：τ0=${(fitted.tau0 * 1000).toFixed(0)}ms  α_L=${(fitted.alphaL * 1e6).toFixed(3)}µs  ` +
      `α_M=${(fitted.alphaM * 1e6).toFixed(3)}µs  α_O=${(fitted.alphaO * 1000).toFixed(3)}ms  R²=${r2.toFixed(3)}`,
  );
  console.log(
    `内置常数：τ0=${(MEASURED.tau0 * 1000).toFixed(0)}ms  α_L=${(MEASURED.alphaL * 1e6).toFixed(3)}µs  ` +
      `α_M=${(MEASURED.alphaM * 1e6).toFixed(3)}µs  α_O=${(MEASURED.alphaO * 1000).toFixed(3)}ms`,
  );

  // 样本内 / 样本外
  const inSample = score([calibration], fitted);
  const outSample = score(usable.slice(1), fitted);
  printTable(inSample, '— 样本内（拟合用）—');
  printTable(outSample, '— 样本外（同一组常数，未参与拟合）—');

  console.log('');
  summarize(inSample, '样本内');
  const mape = summarize(outSample, '样本外');
  const all = summarize(score(usable, fitted), '全部');

  // 用内置常数再跑一遍（检验"常数是否可跨会话迁移"）
  const builtinOut = score(usable.slice(1), MEASURED);
  const builtinMape = builtinOut.reduce((s, r) => s + Math.abs(r.residual), 0) / builtinOut.length;
  console.log(`内置常数（样本外）：MAPE=${(builtinMape * 100).toFixed(1)}%`);

  // 压缩项单独校验
  const comp = sessions
    .flatMap((s) => s.steps.flatMap((st) => st.compactions))
    .filter((c) => c.surfaceTokens > 0 && c.seconds > 0);
  if (comp.length > 0) {
    const obs = comp.reduce((s, c) => s + c.seconds, 0);
    const pred = comp.reduce((s, c) => s + predictCompactionSeconds(c.surfaceTokens, c.summaryTokens), 0);
    console.log(
      `\n压缩调用：n=${comp.length}  实测 ${obs.toFixed(1)}s / 预测 ${pred.toFixed(1)}s ` +
        `（${(((pred - obs) / obs) * 100).toFixed(1)}%）  摘要均值=${Math.round(
          comp.reduce((s, c) => s + c.summaryTokens, 0) / comp.length,
        )} tok`,
    );
  }

  const worst = [...outSample].sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))[0];
  if (worst) {
    console.log(`最大偏差：${worst.session.id} ${(worst.residual * 100).toFixed(1)}%（${worst.session.model}）`);
  }

  const pass = mape < TARGET;
  console.log(
    `\n判定（目标 ${(TARGET * 100).toFixed(0)}%）：样本外 MAPE=${(mape * 100).toFixed(1)}%  ` +
      `内置常数=${(builtinMape * 100).toFixed(1)}%  → ${pass ? '通过' : '未通过'}`,
  );
  if (!pass) process.exitCode = 1;
}

function runPolicy(limit: number): void {
  const sessionsDir = path.join(dshHome(), 'sessions');
  const files = discoverSessions(sessionsDir).slice(0, limit);
  const sessions = files.map(readSession).filter((s) => s.steps.length > 0);

  console.log('政策级预测：只用 (θ, ρ, s, γ, N, g) 推总时间，不读逐步 token。');
  console.log('被测策略 = 当前 dsh 默认值（θ=0.8W, ρ=0.16W, s=观测摘要均值）。\n');
  console.log(
    pad('session', 30, 'l'),
    pad('steps', 6),
    pad('W', 9),
    pad('g', 6),
    pad('observed', 10),
    pad('forecast', 10),
    pad('resid', 8),
  );
  let sumObs = 0;
  let sumPred = 0;
  let mape = 0;
  let n = 0;
  for (const s of sessions) {
    const W = s.contextWindow || 1_000_000;
    const steps = s.totals.steps;
    const growth = estimateGrowth(s);
    const summaryTokens =
      s.totals.compactions > 0 ? Math.round(s.totals.summaryTokens / s.totals.compactions) : 500;
    const obar = Math.round(s.totals.outputTokens / Math.max(1, s.totals.steps));
    const policy: Policy = { theta: 0.8 * W, rho: 0.16 * W, s: summaryTokens, gamma: 1, growth, obar };
    const forecast = sessionCost(steps, policy).totalSeconds;
    const observed = s.totals.totalSeconds;
    const residual = (forecast - observed) / observed;
    console.log(
      pad(s.id.slice(0, 28), 30, 'l'),
      pad(steps, 6),
      pad(Math.round(W / 1000) + 'k', 9),
      pad(growth, 6),
      pad(hours(observed), 10),
      pad(hours(forecast), 10),
      pad(`${(residual * 100).toFixed(1)}%`, 8),
    );
    sumObs += observed;
    sumPred += forecast;
    mape += Math.abs(residual);
    n++;
  }
  console.log(
    `\n合计 ${hours(sumObs)}h vs ${hours(sumPred)}h（${(((sumPred - sumObs) / sumObs) * 100).toFixed(1)}%）  MAPE=${(
      (mape / n) *
      100
    ).toFixed(1)}%`,
  );
}

function runTables(): void {
  console.log('=== 1. γ 敏感性（ρ=30k, s=2000, g=800）===');
  console.log(pad('γ', 6), pad('θ*', 9), pad('band', 8), pad('每步', 9), pad('3,233 步', 12));
  for (const gamma of [1, 1.1, 1.3, 2, 3]) {
    const theta = optimalThreshold(30_000, 2000, 800, gamma);
    const ps = perStep({ theta, rho: 30_000, s: 2000, gamma, growth: 800 });
    console.log(
      pad(gamma.toFixed(1), 6),
      pad(Math.round(theta), 9),
      pad(Math.round(ps.band), 8),
      pad(fx(ps.totalPerStep, 3), 9),
      pad(hours(3233 * ps.totalPerStep) + 'h', 12),
    );
  }

  console.log('\n=== 2. 摘要长度 s 敏感性（ρ=30k, γ=1, g=800）===');
  console.log(pad('s', 7), pad('θ*', 9), pad('单次压缩', 11), pad('每步', 9), pad('3,233 步', 12));
  for (const s of [200, 500, 1000, 2000, 4000, 8192]) {
    const theta = optimalThreshold(30_000, s, 800, 1);
    const ps = perStep({ theta, rho: 30_000, s, gamma: 1, growth: 800 });
    const once = 20.992e-6 * (theta + 30_000 + s) + 4.0321e-3 * s;
    console.log(
      pad(s, 7),
      pad(Math.round(theta), 9),
      pad(fx(once, 1) + 's', 11),
      pad(fx(ps.totalPerStep, 3), 9),
      pad(hours(3233 * ps.totalPerStep) + 'h', 12),
    );
  }

  console.log('\n=== 3. 保留量 ρ 的盈亏（基线 ρ=30k/s=2000/γ=1，3,233 步）===');
  const baseline: Policy = { theta: optimalThreshold(30_000, 2000, 800, 1), rho: 30_000, s: 2000, gamma: 1, growth: 800 };
  console.log(pad('ρ', 8), pad('θ*', 9), pad('省下', 10), pad('需要 γ ≤', 11));
  for (const rho of [25_000, 20_000, 15_000, 10_000, 5_000]) {
    const be = breakEvenGamma(3233, baseline, rho);
    console.log(
      pad(rho, 8),
      pad(Math.round(optimalThreshold(rho, 2000, 800, 1)), 9),
      pad(fx(be.secondsSaved / 60, 0) + ' 分', 10),
      pad(be.requiredGamma.toFixed(3), 11),
    );
  }

  const ex = exchangeRate(baseline);
  console.log(`\n汇率：砍 10k 保留量 ≈ ${ex.gammaPercentPer10k.toFixed(2)}% 的 γ；每步只省 ${fx(ex.per10kPerStep, 3)}s`);

  console.log('\n=== 4. 当前默认 vs 推荐 ===');
  const current: Policy = { theta: 800_000, rho: 160_000, s: 2000, gamma: 1, growth: 800 };
  const rec = recommend({ growth: 800, s: 500, gamma: 1, rho: 30_000 });
  for (const [name, policy, note] of [
    ['dsh 默认 (0.8W/0.16W)', current, 'θ=800k, ρ=160k, s=2000'],
    ['推荐 (绝对值)', { theta: rec.theta, rho: rec.rho, s: rec.s, gamma: rec.gamma, growth: 800 }, `θ=${Math.round(rec.theta)}, ρ=${rec.rho}, s=${rec.s}`],
  ] as const) {
    const cost = sessionCost(3233, policy);
    console.log(
      `${pad(name, 26, 'l')} ${pad(note, 30, 'l')} 每步 ${fx(cost.perStep.totalPerStep, 3)}s  ` +
        `3,233 步 ${pad(hours(cost.totalSeconds) + 'h', 8)}  ` +
        `prompt ${(cost.promptTokens / 1e9).toFixed(2)}B  压缩 ${cost.compactions}×`,
    );
  }
  console.log('\n推荐理由：');
  for (const r of rec.rationale) console.log(`  · ${r}`);
}

// ── 入口 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;

if (argv.includes('--tables')) runTables();
else if (argv.includes('--policy')) runPolicy(limit);
else runReplay(limit, argv.includes('--flash-only'));
