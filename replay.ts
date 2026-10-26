/**
 * 会话日志回放：把 dsh 的 `session.v3.jsonl.zstd` 折叠成逐步观测量。
 *
 * 只读、无副作用。三个必须处理的坑（见 docs/model.zh.md §8）：
 *  1. 文件是 **zstd 多帧拼接**（一次 flush 一帧，最长会话 10,309 帧），
 *     Node 的 `zstdDecompressSync` 只解第一帧，直接解会得到 1 行、看起来像空会话；
 *  2. SQLite 索引默认关闭（`session-query-sqlite: openAt: never`），所以只能走文件；
 *  3. 目录名是转义过的（`--D-~4EE3~7801~5E93-ThriftFlow--`），当不透明 id 用，不要反解。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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

/** 递归发现 `session.v3.jsonl.zstd`，按体积降序（最长会话在最前）。 */
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

/** 按 zstd 帧逐帧解压（多帧拼接），返回每帧的文本。 */
function* decodeFrames(buf: Buffer): Generator<string> {
  const offsets: number[] = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) {
    // 单帧或非标准：直接尝试整份解压
    yield zlib.zstdDecompressSync(buf).toString('utf8');
    return;
  }
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      yield zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      // 单帧损坏不致命：跳过该帧
    }
  }
}

interface MutableStep {
  step: number;
  startTime: number;
  cachedTokens: number;
  freshTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
  lastTime: number;
  compactions: CompactionObservation[];
}

/** 读一个会话文件，折叠成逐步观测。 */
export function readSession(file: SessionFile): SessionObservation {
  const buf = fs.readFileSync(file.path);

  let model = 'unknown';
  let contextWindow = 0;
  let stepCounter = 0;
  let current: MutableStep | null = null;
  let pendingCompactionStart: number | null = null;
  let pendingCompactionEnd = 0;
  let pendingSummaryTokens = 0;
  /** 最近一次模型调用看到的 prompt 大小：压缩 reads 的就是它，不是压缩后的小 prompt。 */
  let lastPromptTokens = 0;
  let prunedTokens = 0;
  let stepSeconds = 0;
  let compactionSeconds = 0;

  const steps: StepObservation[] = [];
  let totalCalls = 0;
  let totalCached = 0;
  let totalFresh = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalSummaryTokens = 0;
  let totalCompactions = 0;

  const flush = (): void => {
    if (!current) return;
    const s = current;
    current = null;
    const seconds = s.lastTime > 0 ? (s.lastTime - s.startTime) / 1000 : 0;
    if (s.calls === 0) return; // 被取消/中断的步骤没有 assistant 消息，不参与比对
    stepSeconds += seconds;
    totalCalls += s.calls;
    totalCached += s.cachedTokens;
    totalFresh += s.freshTokens;
    totalOutput += s.outputTokens;
    totalReasoning += s.reasoningTokens;
    for (const c of s.compactions) {
      compactionSeconds += c.seconds;
      totalSummaryTokens += c.summaryTokens;
      totalCompactions++;
    }
    steps.push({
      step: s.step,
      cachedTokens: s.cachedTokens,
      freshTokens: s.freshTokens,
      outputTokens: s.outputTokens,
      reasoningTokens: s.reasoningTokens,
      seconds,
      calls: s.calls,
      compactions: s.compactions,
    });
  };

  /**
   * 把已完成的压缩挂到一步上。
   *
   * 压缩发生在步边界（`step/end` 之后、下一个 `step/start` 之前），所以此刻
   * `current` 通常为 null —— 此时 surface 取**上一步**的 prompt 大小，而不是 0。
   */
  const attachCompaction = (): void => {
    if (pendingCompactionStart === null) return;
    const seconds = Math.max(0, (pendingCompactionEnd - pendingCompactionStart) / 1000);

    if (current) {
      current.compactions.push({
        surfaceTokens: lastPromptTokens,
        summaryTokens: pendingSummaryTokens,
        seconds,
      });
    } else if (steps.length > 0) {
      const last = steps[steps.length - 1];
      last.compactions.push({
        surfaceTokens: lastPromptTokens,
        summaryTokens: pendingSummaryTokens,
        seconds,
      });
      compactionSeconds += seconds;
      totalSummaryTokens += pendingSummaryTokens;
      totalCompactions++;
    }
    pendingCompactionStart = null;
    pendingSummaryTokens = 0;
  };

  for (const chunk of decodeFrames(buf)) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.length < 12) continue;
      // 快速前缀筛掉绝大多数行，避免全量 JSON.parse
      if (!line.startsWith('{"type":"')) continue;
      const typeEnd = line.indexOf('"', 9);
      if (typeEnd < 0) continue;
      const type = line.slice(9, typeEnd);

      if (type === 'step/start') {
        flush();
        const ev = JSON.parse(line) as { time: number };
        stepCounter++;
        current = {
          step: stepCounter,
          startTime: ev.time,
          cachedTokens: 0,
          freshTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          calls: 0,
          lastTime: 0,
          compactions: [],
        };
        continue;
      }
      if (type === 'assistant/message') {
        if (!current) continue;
        const ev = JSON.parse(line) as {
          time: number;
          data?: {
            usage?: {
              cachedTokens?: number;
              cacheReadTokens?: number;
              inputTokens?: number;
              outputTokens?: number;
              reasoningTokens?: number;
            };
          };
        };
        const u = ev.data?.usage;
        current.calls++;
        current.lastTime = ev.time;
        if (u) {
          current.cachedTokens += u.cacheReadTokens ?? 0;
          current.freshTokens += u.inputTokens ?? 0;
          current.outputTokens += u.outputTokens ?? 0;
          current.reasoningTokens += u.reasoningTokens ?? 0;
          lastPromptTokens = (u.cacheReadTokens ?? 0) + (u.inputTokens ?? 0);
        }
        continue;
      }
      if (type === 'step/end') {
        flush();
        continue;
      }
      if (type === 'compaction/start') {
        const ev = JSON.parse(line) as { time: number };
        pendingCompactionStart = ev.time;
        pendingCompactionEnd = ev.time;
        continue;
      }
      if (type === 'compaction/summary') {
        const ev = JSON.parse(line) as { time: number; data?: { summary?: Array<{ text?: string }> } };
        pendingCompactionEnd = Math.max(pendingCompactionEnd, ev.time);
        let chars = 0;
        for (const block of ev.data?.summary ?? []) chars += (block.text ?? '').length;
        // dsh 自身的启发式：每 token 四字符（CJK 与 JSON 会低估）
        pendingSummaryTokens += Math.round(chars / 4);
        continue;
      }
      if (type === 'compaction/end') {
        const ev = JSON.parse(line) as { time: number };
        pendingCompactionEnd = ev.time;
        attachCompaction();
        continue;
      }
      if (type === 'compaction/prune') {
        const ev = JSON.parse(line) as { data?: { shadowedTokenCount?: number } };
        prunedTokens += ev.data?.shadowedTokenCount ?? 0;
        continue;
      }
      if (type === 'request/context') {
        const ev = JSON.parse(line) as { data?: { model?: string; contextWindow?: number } };
        if (ev.data?.model) model = ev.data.model;
        if (ev.data?.contextWindow) contextWindow = ev.data.contextWindow;
        continue;
      }
    }
  }
  flush();
  attachCompaction();

  return {
    id: file.id,
    path: file.path,
    bytes: file.bytes,
    model,
    contextWindow,
    steps,
    totals: {
      steps: steps.length,
      calls: totalCalls,
      cachedTokens: totalCached,
      freshTokens: totalFresh,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      stepSeconds,
      compactionSeconds,
      summaryTokens: totalSummaryTokens,
      prunedTokens,
      compactions: totalCompactions,
      totalSeconds: stepSeconds + compactionSeconds,
    },
  };
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
