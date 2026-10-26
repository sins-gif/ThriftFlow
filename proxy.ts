/**
 * proxy.ts —— 轻量本地代理：在请求离开本机之前把阈值规则压上去
 *
 *   node thriftflow.ts proxy                        # 127.0.0.1:8787 → https://api.deepseek.com
 *   node thriftflow.ts proxy --dry-run              # 只统计，不改请求体
 *   node thriftflow.ts proxy --max-inline-bytes 8000 --max-prompt-tokens 200000
 *
 * 它拦的是"模型请求"，所以能管到 dsh 插件管不到的地方：
 *   - 工具结果在进入 messages 之前就被截断（不依赖 spill / pruner 是否启用）；
 *   - 可选的 prompt 上限：超了就从最旧的**非 system** 消息开始丢。
 *
 * 用它的方式：把 dsh 的 `llm-deepseek.baseURL` 指向本代理即可
 * （settings.yaml 的 `llm-deepseek:` 段），无需改 dsh 任何代码。
 *
 * 注意（如实写在这里，避免当成魔法）：
 *   - 截断会改变模型看到的内容，属于有损操作；预算内（< maxInlineBytes）不动；
 *   - prompt 上限丢消息是会破坏上下文的，默认关闭，只在明确需要时开；
 *   - 代理本身不是 dsh 插件链的一部分，它看不到 dsh 的压缩/预算事件。
 */

import http from 'node:http';
import { Readable } from 'node:stream';

const NOTICE = (bytes: number, locator: string): string =>
  `\n\n[... middle pruned by thriftflow: ${bytes} bytes omitted${locator ? `, full text at ${locator}` : ''} ...]\n\n`;

interface Options {
  readonly port: number;
  readonly host: string;
  readonly upstream: string;
  readonly maxInlineBytes: number;
  readonly maxPromptTokens: number;
  readonly dryRun: boolean;
}

interface Stats {
  requests: number;
  bytesIn: number;
  bytesOut: number;
  truncatedMessages: number;
  droppedMessages: number;
  tokensEstimatedIn: number;
  tokensEstimatedOut: number;
}

const stats: Stats = {
  requests: 0,
  bytesIn: 0,
  bytesOut: 0,
  truncatedMessages: 0,
  droppedMessages: 0,
  tokensEstimatedIn: 0,
  tokensEstimatedOut: 0,
};

function estTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** 截断一个字符串到字节预算，保留首尾（与 spill 的语义一致）。 */
function truncateText(text: string, maxBytes: number): string | null {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return null;
  const notice = NOTICE(bytes - maxBytes, '');
  const keep = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8') - 200);
  const head = Math.floor(keep * 0.75);
  const tail = Math.max(0, keep - head);
  return text.slice(0, head) + notice + (tail > 0 ? text.slice(-tail) : '');
}

interface TruncResult {
  readonly messages: unknown[];
  readonly truncated: number;
  readonly bytesSaved: number;
}

/** 遍历 messages，把超预算的文本内容就地截断。 */
function truncateMessages(messages: unknown[], maxBytes: number): TruncResult {
  let truncated = 0;
  let bytesSaved = 0;

  const pruneContent = (content: unknown): unknown => {
    if (typeof content === 'string') {
      const next = truncateText(content, maxBytes);
      if (next === null) return content;
      bytesSaved += Buffer.byteLength(content, 'utf8') - Buffer.byteLength(next, 'utf8');
      truncated++;
      return next;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') {
            const next = truncateText(p.text, maxBytes);
            if (next === null) return part;
            bytesSaved += Buffer.byteLength(p.text, 'utf8') - Buffer.byteLength(next, 'utf8');
            truncated++;
            return { ...p, text: next };
          }
          if (p.type === 'tool_result' || p.type === 'image') return part;
          if (p.content !== undefined) return { ...p, content: pruneContent(p.content) };
        }
        return part;
      });
    }
    return content;
  };

  const next = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const msg = m as Record<string, unknown>;
    // 只裁剪工具输出与超长历史，不动 system
    if (msg.role === 'system') return msg;
    if (msg.content === undefined) return msg;
    return { ...msg, content: pruneContent(msg.content) };
  });

  return { messages: next, truncated, bytesSaved };
}

/** 可选：把 prompt 压到预算以内，从最旧的非 system 消息开始丢。 */
function enforcePromptBudget(
  messages: unknown[],
  maxTokens: number,
): { messages: unknown[]; dropped: number } {
  if (maxTokens <= 0) return { messages, dropped: 0 };
  const total = estTokens(JSON.stringify(messages));
  if (total <= maxTokens) return { messages, dropped: 0 };
  const kept = [...messages];
  let dropped = 0;
  for (let i = 0; i < kept.length && estTokens(JSON.stringify(kept)) > maxTokens; i++) {
    const role = (kept[i] as { role?: string } | null)?.role;
    if (role === 'system') continue;
    kept.splice(i, 1);
    dropped++;
    i--;
  }
  return { messages: kept, dropped };
}

async function forward(
  options: Options,
  req: http.IncomingMessage,
  body: Buffer,
): Promise<{ status: number; headers: Headers; stream: ReadableStream<Uint8Array> | null }> {
  const url = new URL(req.url ?? '/', options.upstream);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === 'host' || k === 'content-length' || k === 'connection' || k === 'accept-encoding') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const response = await fetch(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  return { status: response.status, headers: response.headers, stream: response.body };
}

export function runProxy(argv: string[]): void {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const options: Options = {
    port: Number(get('port') ?? 8787),
    host: get('host') ?? '127.0.0.1',
    upstream: (get('upstream') ?? process.env.THRIFTFLOW_UPSTREAM ?? 'https://api.deepseek.com').replace(/\/$/, ''),
    maxInlineBytes: Number(get('max-inline-bytes') ?? 8_000),
    maxPromptTokens: Number(get('max-prompt-tokens') ?? 0),
    dryRun: argv.includes('--dry-run'),
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: options.upstream, ...stats }));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ options: { ...options, upstream: options.upstream }, stats }, null, 2));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      stats.requests++;
      stats.bytesIn += raw.length;

      let body = raw;
      let note = '';
      if (raw.length > 0 && (req.headers['content-type'] ?? '').includes('json')) {
        try {
          const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (Array.isArray(payload.messages)) {
            const beforeTokens = estTokens(raw.toString('utf8'));
            const truncated = truncateMessages(payload.messages as unknown[], options.maxInlineBytes);
            const budgeted = enforcePromptBudget(truncated.messages, options.maxPromptTokens);
            stats.truncatedMessages += truncated.truncated;
            stats.droppedMessages += budgeted.dropped;
            stats.tokensEstimatedIn += beforeTokens;
            if (!options.dryRun) {
              payload.messages = budgeted.messages;
              body = Buffer.from(JSON.stringify(payload), 'utf8');
            }
            const afterTokens = estTokens(body.toString('utf8'));
            stats.tokensEstimatedOut += afterTokens;
            stats.bytesOut += body.length;
            note =
              `\n  → ${payload.model ?? '?'} | ~${beforeTokens} → ~${afterTokens} tok` +
              `（截断 ${truncated.truncated} 条、丢弃 ${budgeted.dropped} 条${options.dryRun ? '，dry-run 未改' : ''}）`;
          }
        } catch {
          // 非 JSON 或畸形：原样转发
        }
      }

      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`[${stamp}] ${req.method} ${req.url} ${(raw.length / 1024).toFixed(1)}KB${note}`);

      try {
        const { status, headers, stream } = await forward(options, req, body);
        const out: Record<string, string> = {};
        headers.forEach((v, k) => {
          if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) return;
          out[k] = v;
        });
        res.writeHead(status, out);
        if (stream) Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
        else res.end();
      } catch (error) {
        console.error(`  上游失败：${(error as Error).message}`);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `thriftflow proxy: upstream unreachable (${(error as Error).message})` } }));
      }
    });
  });

  server.listen(options.port, options.host, () => {
    console.log('\n═══ thriftflow proxy ═══');
    console.log(`监听      http://${options.host}:${options.port}`);
    console.log(`上游      ${options.upstream}`);
    console.log(
      `规则      工具输出上限 ${options.maxInlineBytes} 字节` +
        `；prompt 上限 ${options.maxPromptTokens > 0 ? options.maxPromptTokens + ' tok' : '关闭'}` +
        `${options.dryRun ? '；dry-run（只统计不改体）' : ''}`,
    );
    console.log(`观测      GET /healthz   GET /stats`);
    console.log(
      `接入      在 ~/.dsh/settings.yaml 的 llm-deepseek 段把 baseURL 指向 http://${options.host}:${options.port}`,
    );
    console.log('按 Ctrl+C 停止。\n');
  });

  process.on('SIGINT', () => {
    server.close(() => {
      console.log(`\n已停止。累计：${stats.requests} 请求，截断 ${stats.truncatedMessages} 条，` +
        `丢弃 ${stats.droppedMessages} 条，省 ${((stats.bytesIn - stats.bytesOut) / 1024).toFixed(0)}KB。`);
      process.exit(0);
    });
  });
}
