/**
 * replay.ts —— dsh 会话日志回放 / 成本审计 CLI
 *
 * 用法：
 *   node replay.ts mock_log.jsonl      # 明文 jsonl（mock 验证用）
 *   node replay.ts <session.v3.jsonl.zstd>   # 真实会话（自动识别 zstd 多帧）
 *   node replay.ts --limit=5           # 不带文件时，回放 $DSH_HOME 下最大的 5 个会话
 *
 * 输出：每轮（一次模型调用）的 promptTokens / cacheReadTokens / completionTokens /
 * durationMs，用 model.ts 预测耗时并给出残差，最后给一份终端成本审计报告。
 *
 * 三个必须处理的坑（docs/model.zh.md §8）：
 *  1. 真实日志是 zstd **多帧**拼接（一次 flush 一帧，最长会话 10,309 帧）。
 *     Node 的 zstdDecompressSync 只解第一帧 → 直接解会得到 1 行、看起来像空会话。
 *  2. SQLite 索引默认关闭（openAt: never），所以只能走文件，不走 sessionQuery。
 *  3. 目录名是转义过的（--D-~4EE3~7801~5E93-ThriftFlow--），当不透明 id 用。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MEASURED, predictCompactionSeconds, predictStepSeconds, worthCompacting } from './model.ts';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ── 类型 ──────────────────────────────────────────────────────────────────

export interface SessionFile {
  readonly path: string;
  readonly id: string;
  readonly bytes: number;
}

export interface CompactionObservation {
  readonly surfaceTokens: number;
  readonly summaryTokens: number;
  readonly seconds: number;
}

/** 一次工具结果（prescribe 用它推导 maxInlineBytes）。 */
export interface ToolResultObservation {
  readonly chars: number;
  /** 粗估 token（chars/4，与 dsh 自身启发式一致） */
  readonly tokens: number;
  /** 工具执行时长；拿不到 callId 对应关系时为 null */
  readonly durationMs: number | null;
}

/** 一次模型调用（一轮）。字段名对齐审计报告的口径。 */
export interface CallRecord {
  /** 全局调用序号，1 起 */
  readonly index: number;
  /** 所属 turn（日志里有就取日志，没有则按调用序号累加） */
  readonly turn: number;
  /** 全局步序号 */
  readonly step: number;
  /** prompt 总量 = cacheRead + input */
  readonly promptTokens: number;
  readonly cacheReadTokens: number;
  /** 未命中部分（适配器已把 cache read 从 inputTokens 里扣掉） */
  readonly freshTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly durationMs: number;
  readonly compactions: readonly CompactionObservation[];
}

/** 折叠后的日志（内部结构，供 readSession、审计与 prescribe 复用）。 */
interface FoldedLog {
  readonly events: number;
  readonly sessionId: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly calls: CallRecord[];
  readonly compactions: CompactionObservation[];
  readonly toolResults: ToolResultObservation[];
  readonly prunedTokens: number;
}

export interface StepObservation {
  readonly step: number;
  readonly cachedTokens: number;
  readonly freshTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** step/start → 该步最后一次 assistant/message（纯模型时间，不含工具执行） */
  readonly seconds: number;
  readonly calls: number;
  compactions: CompactionObservation[];
}

export interface SessionObservation {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly model: string;
  readonly contextWindow: number;
  readonly steps: readonly StepObservation[];
  readonly totals: {
    readonly steps: number;
    readonly calls: number;
    readonly cachedTokens: number;
    readonly freshTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly stepSeconds: number;
    readonly compactionSeconds: number;
    readonly summaryTokens: number;
    readonly prunedTokens: number;
    readonly compactions: number;
    /** 观测总时间 = 逐步模型时间 + 压缩调用时间 */
    readonly totalSeconds: number;
  };
}

// ── 解码 ──────────────────────────────────────────────────────────────────

/** 按 zstd 帧逐帧解压（多帧拼接）。 */
function decodeZstd(buf: Buffer): string[] {
  const offsets: number[] = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) return [zlib.zstdDecompressSync(buf).toString('utf8')];
  const frames: string[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      frames.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 单帧损坏不致命：跳过
    }
  }
  return frames;
}

// ── 折叠 ──────────────────────────────────────────────────────────────────

interface MutableStep {
  stepNo: number;
  turn: number;
  startTime: number;
  calls: Array<{
    turn: number;
    startTime: number;
    endTime: number;
    cached: number;
    fresh: number;
    output: number;
    reasoning: number;
  }>;
  compactions: CompactionObservation[];
}

/**
 * 把日志行折叠成"调用级"记录。
 *
 * 压缩发生在**步内**（`tool/result → compaction/start → summary → end → request/header → assistant/message`），
 * 所以一次压缩的 surface 取**上一次调用**的 prompt，而不是压缩后那一步的 prompt。
 */
export function foldLog(frames: Iterable<string>): FoldedLog {
  let events = 0;
  let sessionId = '';
  let model = 'unknown';
  let contextWindow = 0;
  let stepCounter = 0;
  let turnCounter = 0;
  let lastPromptTokens = 0;
  let prunedTokens = 0;

  let pendingCompactionStart: number | null = null;
  let pendingCompactionEnd = 0;
  let pendingSummaryTokens = 0;

  const steps: MutableStep[] = [];
  let current: MutableStep | null = null;
  const pendingToolCalls = new Map<string, number>();
  const toolResults: ToolResultObservation[] = [];

  const openStep = (time: number): void => {
    stepCounter++;
    current = {
      stepNo: stepCounter,
      turn: turnCounter || 1,
      startTime: time,
      calls: [],
      compactions: [],
    };
    steps.push(current);
  };

  const attachCompaction = (): void => {
    if (pendingCompactionStart === null) return;
    const seconds = Math.max(0, (pendingCompactionEnd - pendingCompactionStart) / 1000);
    const obs: CompactionObservation = {
      surfaceTokens: lastPromptTokens,
      summaryTokens: pendingSummaryTokens,
      seconds,
    };
    if (current) current.compactions.push(obs);
    else if (steps.length > 0) steps[steps.length - 1].compactions.push(obs);
    pendingCompactionStart = null;
    pendingSummaryTokens = 0;
  };

  for (const chunk of frames) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.length < 12 || !line.startsWith('{"type":"')) continue;
      const typeEnd = line.indexOf('"', 9);
      if (typeEnd < 0) continue;
      const type = line.slice(9, typeEnd);
      events++;

      if (type === 'step/start') {
        current = null;
        const ev = JSON.parse(line) as { time: number };
        openStep(ev.time);
        continue;
      }
      if (type === 'turn/start') {
        const ev = JSON.parse(line) as { data?: { turn?: number } };
        turnCounter = ev.data?.turn ?? turnCounter + 1;
        continue;
      }
      if (type === 'assistant/message') {
        const ev = JSON.parse(line) as {
          time: number;
          data?: {
            turn?: number;
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadTokens?: number;
              reasoningTokens?: number;
            };
          };
        };
        if (!current) openStep(ev.time);
        const step = current as MutableStep;
        const turn = ev.data?.turn ?? step.turn;
        if (ev.data?.turn) {
          step.turn = ev.data.turn;
          turnCounter = ev.data.turn;
        }
        const u = ev.data?.usage;
        const prev = step.calls[step.calls.length - 1];
        step.calls.push({
          turn,
          startTime: prev ? prev.endTime : step.startTime,
          endTime: ev.time,
          cached: u?.cacheReadTokens ?? 0,
          fresh: u?.inputTokens ?? 0,
          output: u?.outputTokens ?? 0,
          reasoning: u?.reasoningTokens ?? 0,
        });
        lastPromptTokens = (u?.cacheReadTokens ?? 0) + (u?.inputTokens ?? 0);
        continue;
      }
      if (type === 'compaction/start') {
        pendingCompactionStart = (JSON.parse(line) as { time: number }).time;
        pendingCompactionEnd = pendingCompactionStart;
        continue;
      }
      if (type === 'compaction/summary') {
        const ev = JSON.parse(line) as { time: number; data?: { summary?: Array<{ text?: string }> } };
        pendingCompactionEnd = Math.max(pendingCompactionEnd, ev.time);
        let chars = 0;
        for (const block of ev.data?.summary ?? []) chars += (block.text ?? '').length;
        pendingSummaryTokens += Math.round(chars / 4); // dsh 自身启发式：每 token 四字符
        continue;
      }
      if (type === 'compaction/end') {
        pendingCompactionEnd = (JSON.parse(line) as { time: number }).time;
        attachCompaction();
        continue;
      }
      if (type === 'compaction/prune') {
        const ev = JSON.parse(line) as { data?: { shadowedTokenCount?: number } };
        prunedTokens += ev.data?.shadowedTokenCount ?? 0;
        continue;
      }
      if (type === 'tool/call') {
        const ev = JSON.parse(line) as { time: number; data?: { callId?: string } };
        const id = ev.data?.callId;
        if (id) pendingToolCalls.set(id, ev.time);
        continue;
      }
      if (type === 'tool/result') {
        const ev = JSON.parse(line) as {
          time: number;
          data?: {
            message?: {
              source?: { callId?: string };
              content?: Array<{
                type?: string;
                text?: string;
                content?: Array<{ type?: string; text?: string }>;
              }>;
            };
          };
        };
        let chars = 0;
        for (const block of ev.data?.message?.content ?? []) {
          if (block.type === 'tool-result' && Array.isArray(block.content)) {
            for (const inner of block.content) if (inner.type === 'text') chars += (inner.text ?? '').length;
          } else if (block.type === 'text') {
            chars += (block.text ?? '').length;
          }
        }
        // 没有文本块时退化为整行长度（含元数据），仅供尺寸分布用
        if (chars === 0) chars = line.length;
        const id = ev.data?.message?.source?.callId;
        const start = id ? pendingToolCalls.get(id) : undefined;
        toolResults.push({
          chars,
          tokens: Math.round(chars / 4),
          durationMs: start === undefined ? null : ev.time - start,
        });
        if (id) pendingToolCalls.delete(id);
        continue;
      }
      if (type === 'request/context') {
        const ev = JSON.parse(line) as { data?: { model?: string; contextWindow?: number } };
        if (ev.data?.model) model = ev.data.model;
        if (ev.data?.contextWindow) contextWindow = ev.data.contextWindow;
        continue;
      }
      if (type === 'session') {
        const ev = JSON.parse(line) as { data?: { id?: string } };
        sessionId = ev.data?.id ?? sessionId;
        continue;
      }
    }
  }
  attachCompaction();

  // 摊平成调用级记录；丢弃没有调用的空步骤
  const calls: CallRecord[] = [];
  const compactions: CompactionObservation[] = [];
  let index = 0;
  for (const step of steps) {
    if (step.calls.length === 0) continue;
    for (const c of step.calls) {
      index++;
      calls.push({
        index,
        turn: c.turn,
        step: step.stepNo,
        promptTokens: c.cached + c.fresh,
        cacheReadTokens: c.cached,
        freshTokens: c.fresh,
        completionTokens: c.output,
        reasoningTokens: c.reasoning,
        durationMs: c.endTime - c.startTime,
        compactions: [],
      });
    }
    for (const comp of step.compactions) {
      compactions.push(comp);
      const target = calls[calls.length - 1];
      (target.compactions as CompactionObservation[]).push(comp);
    }
  }

  return { events, sessionId, model, contextWindow, calls, compactions, toolResults, prunedTokens };
}

// ── 文件级 API ────────────────────────────────────────────────────────────

/** 递归发现 `session.v3.jsonl.zstd`，按体积降序。 */
export function discoverSessions(root: string): SessionFile[] {
  const found: SessionFile[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.v3.jsonl.zstd') {
        found.push({ path: p, id: path.basename(path.dirname(p)), bytes: fs.statSync(p).size });
      }
    }
  };
  walk(root);
  found.sort((a, b) => b.bytes - a.bytes);
  return found;
}

/** 读单个文件（明文 jsonl 或 zstd 多帧），返回折叠结果。 */
export function readLogFile(filePath: string): FoldedLog & { encoding: 'jsonl' | 'zstd'; bytes: number } {
  const buf = fs.readFileSync(filePath);
  const isZstd = buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
  const frames = isZstd ? decodeZstd(buf) : [buf.toString('utf8')];
  const folded = foldLog(frames);
  return { ...folded, encoding: isZstd ? 'zstd' : 'jsonl', bytes: buf.length };
}

/** 把折叠结果映射成"逐步"观测（selftest 用）。 */
export function readSession(file: SessionFile): SessionObservation {
  const folded = readLogFile(file.path);
  const byStep = new Map<number, CallRecord[]>();
  for (const c of folded.calls) {
    const list = byStep.get(c.step) ?? [];
    list.push(c);
    byStep.set(c.step, list);
  }

  const steps: StepObservation[] = [];
  let stepSeconds = 0;
  let compactionSeconds = 0;
  let summaryTokens = 0;
  let totalCompactions = 0;

  for (const [stepNo, calls] of byStep) {
    const first = calls[0];
    const last = calls[calls.length - 1];
    const seconds =
      (last.durationMs + sumDurationBefore(calls, last)) / 1000;
    const compactions = calls.flatMap((c) => c.compactions);
    for (const comp of compactions) {
      compactionSeconds += comp.seconds;
      summaryTokens += comp.summaryTokens;
      totalCompactions++;
    }
    stepSeconds += seconds;
    steps.push({
      step: stepNo,
      cachedTokens: calls.reduce((s, c) => s + c.cacheReadTokens, 0),
      freshTokens: calls.reduce((s, c) => s + c.freshTokens, 0),
      outputTokens: calls.reduce((s, c) => s + c.completionTokens, 0),
      reasoningTokens: calls.reduce((s, c) => s + c.reasoningTokens, 0),
      seconds,
      calls: calls.length,
      compactions,
    });
    void first;
  }

  const totals = {
    steps: steps.length,
    calls: folded.calls.length,
    cachedTokens: steps.reduce((s, x) => s + x.cachedTokens, 0),
    freshTokens: steps.reduce((s, x) => s + x.freshTokens, 0),
    outputTokens: steps.reduce((s, x) => s + x.outputTokens, 0),
    reasoningTokens: steps.reduce((s, x) => s + x.reasoningTokens, 0),
    stepSeconds,
    compactionSeconds,
    summaryTokens,
    prunedTokens: folded.prunedTokens,
    compactions: totalCompactions,
    totalSeconds: stepSeconds + compactionSeconds,
  };

  return {
    id: file.id,
    path: file.path,
    bytes: file.bytes,
    model: folded.model,
    contextWindow: folded.contextWindow,
    steps,
    totals,
  };
}

/** 同一步内前几次调用的耗时之和（第 i 次调用的开始时间 = 前一次的结束时间）。 */
function sumDurationBefore(calls: readonly CallRecord[], last: CallRecord): number {
  let acc = 0;
  for (const c of calls) {
    if (c.index === last.index) break;
    acc += c.durationMs;
  }
  return acc;
}

/** 从观测里估「每步平均增长」g：取无压缩步骤的 fresh token 中位数（稳健）。 */
export function estimateGrowth(session: SessionObservation): number {
  const values = session.steps
    .filter((s) => s.compactions.length === 0 && s.freshTokens > 0)
    .map((s) => s.freshTokens)
    .sort((a, b) => a - b);
  if (values.length === 0) return 800;
  return values[Math.floor(values.length / 2)];
}

// ── 审计报告 ──────────────────────────────────────────────────────────────

const TARGET = 0.1;

function num(v: number): string {
  return v.toLocaleString('en-US');
}

function pad(v: string | number, w: number, align: 'l' | 'r' = 'r'): string {
  const s = String(v);
  return align === 'l' ? s.padEnd(w) : s.padStart(w);
}

function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface CallScore {
  readonly call: CallRecord;
  readonly predictedMs: number;
  readonly residual: number;
}

export function scoreCalls(calls: readonly CallRecord[]): CallScore[] {
  return calls
    .filter((c) => c.durationMs > 0)
    .map((call) => {
      const predictedMs =
        predictStepSeconds(
          {
            cachedTokens: call.cacheReadTokens,
            freshTokens: call.freshTokens,
            outputTokens: call.completionTokens,
          },
          MEASURED,
        ) * 1000;
      return { call, predictedMs, residual: (predictedMs - call.durationMs) / call.durationMs };
    });
}

/** 打印审计报告；返回是否通过 10% 残差判定。 */
export function printAudit(filePath: string): boolean {
  const log = readLogFile(filePath);
  const scores = scoreCalls(log.calls);
  if (scores.length === 0) {
    console.error('该日志没有可用的 assistant/message usage 记录（无法审计）');
    return false;
  }

  const observedS = scores.reduce((s, x) => s + x.call.durationMs, 0) / 1000;
  const predictedS = scores.reduce((s, x) => s + x.predictedMs, 0) / 1000;
  const residual = (predictedS - observedS) / observedS;
  const mape = scores.reduce((s, x) => s + Math.abs(x.residual), 0) / scores.length;
  const sortedAbs = scores.map((s) => Math.abs(s.residual)).sort((a, b) => a - b);
  const medianAbs = sortedAbs[Math.floor(sortedAbs.length / 2)];

  const compactionObs = log.compactions.reduce((s, c) => s + c.seconds, 0);
  const compactionPred = log.compactions.reduce(
    (s, c) => s + predictCompactionSeconds(c.surfaceTokens, c.summaryTokens),
    0,
  );

  const sumCached = log.calls.reduce((s, c) => s + c.cacheReadTokens, 0);
  const sumFresh = log.calls.reduce((s, c) => s + c.freshTokens, 0);
  const sumPrompt = sumCached + sumFresh;
  const sumOut = log.calls.reduce((s, c) => s + c.completionTokens, 0);
  const sumReason = log.calls.reduce((s, c) => s + c.reasoningTokens, 0);

  const t0 = MEASURED.tau0 * scores.length;
  const tCache = MEASURED.alphaL * sumCached;
  const tFresh = MEASURED.alphaM * sumFresh;
  const tOut = MEASURED.alphaO * sumOut;
  const attributed = t0 + tCache + tFresh + tOut;

  const turns = new Set(log.calls.map((c) => c.turn)).size;
  const peak = Math.max(...log.calls.map((c) => c.promptTokens));
  const meanPrompt = sumPrompt / log.calls.length;

  const line = '─'.repeat(68);
  console.log('\n═══ ThriftFlow 成本审计 ═══');
  console.log(`源文件    ${filePath}  (${log.encoding}, ${bytes(log.bytes)}, ${num(log.events)} 事件)`);
  const sessionLabel = log.sessionId || path.basename(path.dirname(path.resolve(filePath))) || '(未标注)';
  console.log(`会话      ${sessionLabel}`);
  console.log(
    `模型      ${log.model}${log.contextWindow ? `   窗口 ${num(log.contextWindow)}` : ''}   ` +
      `轮次 ${turns} turn / ${num(scores.length)} calls`,
  );

  console.log(`\n${line}\n总量`);
  console.log(`实际模型时间    ${pad(observedS.toFixed(2), 8)} s`);
  console.log(`预测模型时间    ${pad(predictedS.toFixed(2), 8)} s   残差 ${pad((residual >= 0 ? '+' : '') + pct(residual), 8)}`);
  console.log(`逐轮 MAPE       ${pad(pct(mape), 8)}`);
  console.log(
    `prompt 总量     ${pad(num(sumPrompt), 10)} tok  （缓存命中 ${pct(sumPrompt ? sumCached / sumPrompt : 0)}）`,
  );
  if (sumOut > 0) {
    console.log(
      `completion      ${pad(num(sumOut), 10)} tok  （reasoning ${pct(sumReason / sumOut)}）`,
    );
  }
  console.log(
    `平均 / 峰值     ${pad(num(Math.round(meanPrompt)), 10)} / ${num(peak)} tok`,
  );
  if (log.prunedTokens > 0) {
    console.log(`工具结果修剪    ${pad(num(log.prunedTokens), 10)} tok  （compaction/prune）`);
  }

  console.log(`\n${line}\n时间构成（按 model.ts 预测）`);
  const share = (v: number): string => pad(pct(attributed ? v / attributed : 0), 6);
  console.log(`固定开销 τ0      ${share(t0)}   ${pad(t0.toFixed(2), 8)} s`);
  console.log(`命中 prefill     ${share(tCache)}   ${pad(tCache.toFixed(2), 8)} s   α_L=${(MEASURED.alphaL * 1e6).toFixed(3)}µs/tok`);
  console.log(`未命中 prefill   ${share(tFresh)}   ${pad(tFresh.toFixed(2), 8)} s   α_M=${(MEASURED.alphaM * 1e6).toFixed(3)}µs/tok`);
  console.log(`生成 α_O         ${share(tOut)}   ${pad(tOut.toFixed(2), 8)} s   α_O=${(MEASURED.alphaO * 1000).toFixed(3)}ms/tok`);

  console.log(`\n${line}\n逐轮明细`);
  console.log(
    pad('#', 4),
    pad('turn', 5),
    pad('step', 5),
    pad('prompt', 9),
    pad('cache', 7),
    pad('fresh', 8),
    pad('compl', 7),
    pad('实际ms', 9),
    pad('预测ms', 9),
    pad('残差', 8),
  );
  const show = scores.slice(0, 40);
  for (const s of show) {
    const c = s.call;
    console.log(
      pad(c.index, 4),
      pad(c.turn, 5),
      pad(c.step, 5),
      pad(num(c.promptTokens), 9),
      pad(pct(c.promptTokens ? c.cacheReadTokens / c.promptTokens : 0, 0), 7),
      pad(num(c.freshTokens), 8),
      pad(num(c.completionTokens), 7),
      pad(Math.round(c.durationMs), 9),
      pad(Math.round(s.predictedMs), 9),
      pad((s.residual >= 0 ? '+' : '') + pct(s.residual), 8),
    );
  }
  if (scores.length > show.length) {
    console.log(`  … 其余 ${scores.length - show.length} 轮已省略`);
  }

  if (log.compactions.length > 0) {
    console.log(`\n${line}\n压缩`);
    const meanSummary = log.compactions.reduce((s, c) => s + c.summaryTokens, 0) / log.compactions.length;
    console.log(
      `次数 ${log.compactions.length}   实测 ${compactionObs.toFixed(2)}s / 预测 ${compactionPred.toFixed(2)}s ` +
        `(${compactionObs > 0 ? pct((compactionPred - compactionObs) / compactionObs) : 'n/a'})   ` +
        `摘要均值 ${num(Math.round(meanSummary))} tok`,
    );
    const lastPolicy = {
      theta: peak,
      rho: Math.min(peak / 2, meanPrompt),
      s: Math.round(meanSummary),
      gamma: 1,
      growth: Math.max(1, Math.round(sumFresh / scores.length)),
      obar: Math.round(sumOut / scores.length),
    };
    if (lastPolicy.rho > 0 && log.contextWindow > 0) {
      console.log(
        `峰值占窗口 ${pct(peak / log.contextWindow)}；` +
          (peak / log.contextWindow < 0.5
            ? '未接近容量压力，压缩收益来自 prefill 成本而非容量。'
            : '已接近容量压力，压缩同时兼作容量回收。'),
      );
      const w = worthCompacting(Math.max(1, Math.round((log.contextWindow - peak) / Math.max(1, lastPolicy.growth))), lastPolicy);
      console.log(
        `若继续跑到窗口上限（约 ${num(Math.round((log.contextWindow - peak) / Math.max(1, lastPolicy.growth)))} 步）：` +
          `压缩${w.worth ? '值得' : '不值得'}做` +
          `（可省 ${(w.savingSeconds / 60).toFixed(1)} 分，一次性代价 ${(w.oneTimeCostSeconds / 60).toFixed(1)} 分）`,
      );
    }
  }

  const worst = [...scores].sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 3);
  const pass = Math.abs(residual) < TARGET;
  console.log(`\n${line}\n判定`);
  console.log(
    `总时间残差 ${pad((residual >= 0 ? '+' : '') + pct(residual), 7)}  →  ${pass ? '通过' : '未通过'}` +
      `（判定口径：|总时间残差| < ${pct(TARGET, 0)}）`,
  );
  console.log(
    `逐轮离散  MAPE ${pct(mape)} / 中位 ${pct(medianAbs)}  （诊断指标，不走判定：单轮噪声来自重试与工具时序）`,
  );
  console.log('偏差最大的 3 轮：');
  for (const w of worst) {
    console.log(
      `  第 ${pad(w.call.index, 5)} 轮  prompt ${pad(num(w.call.promptTokens), 9)}  ` +
        `实测 ${pad(Math.round(w.call.durationMs), 6)}ms  预测 ${pad(Math.round(w.predictedMs), 6)}ms  ` +
        `${pad((w.residual >= 0 ? '+' : '') + pct(w.residual), 8)}`,
    );
  }
  if (!pass) {
    console.log(
      '提示：总残差偏大通常是 (a) 换了模型（α_O/τ₀ 是模型相关的）、(b) 日志含大量重试造成的多调用步骤、' +
        '(c) 时间窗混入了非模型时间。先按 model 分组再看。',
    );
  }
  console.log('');
  return pass;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/** `thriftflow audit` / `node replay.ts` 的入口。 */
export function runAudit(argv: string[]): void {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const target = argv.find((a) => !a.startsWith('--'));

  if (target) {
    if (!fs.existsSync(target)) {
      console.error(`找不到文件：${target}`);
      process.exit(2);
    }
    const pass = printAudit(target);
    if (!pass) process.exitCode = 1;
    return;
  }

  const limit = limitArg ? Number(limitArg.split('=')[1]) : 3;
  const root = path.join(dshHome(), 'sessions');
  const files = discoverSessions(root).slice(0, limit);
  if (files.length === 0) {
    console.error(`没有找到会话日志：${root}\n用法：node replay.ts <日志文件>`);
    process.exit(2);
  }
  let failures = 0;
  for (const f of files) {
    if (!printAudit(f.path)) failures++;
  }
  if (failures > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) runAudit(process.argv.slice(2));
