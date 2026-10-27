/**
 * apply.ts —— 把处方真正写进 dsh 配置（带备份、可回滚、fail-closed）
 *
 *   node thriftflow.ts apply --dry-run        # 只打印计划，不落盘
 *   node thriftflow.ts apply                  # 写入（备份到 $DSH_HOME/.thriftflow/backups/<ts>）
 *   node thriftflow.ts apply --restore <ts>   # 从备份恢复
 *
 * 为什么要写两个地方（这不是能一把梭的事情）：
 *   - `spill-policy` 是**宿主层**行（dsh-base 里挂着），所以改 `profiles/<p>/cordis.patch.yml`。
 *   - `compaction-basic` / `tool-result-pruner` 在 Web 形态下被 `dsh-web-app` 在宿主层
 *     `disabled: true`，真正生效的实例挂在 **agent preset** 里，所以必须生成一份用户
 *     preset（$DSH_HOME/.agent-presets/<id>/）并把默认 preset 指过去。
 *
 * 安全策略：
 *   1. 任何一处匹配不到 / 匹配到多处 → 整体中止，不写任何文件（fail-closed）；
 *   2. 写前把每个文件备份到带时间戳的目录，并写 manifest.json；
 *   3. 写完回读校验关键键值确实存在；
 *   4. 所有改动集中在 `# thriftflow:begin/end` 标记块内，重跑幂等。
 */

import fs from 'node:fs';
import path from 'node:path';
import { recommend, MEASURED } from './model.ts';
import { discoverSessions, readLogFile } from './replay.ts';
import { deriveStats, prescribe } from './prescribe.ts';

const MARK_BEGIN = '# thriftflow:begin';
const MARK_END = '# thriftflow:end';

interface Values {
  readonly theta: number;
  readonly rho: number;
  readonly maxInlineBytes: number;
  readonly prunerChars: number;
  readonly windowTokens: number;
  readonly source: string;
  /** 没找到日志、也没给显式数值时，取值是"文档默认值"——这种情况必须显式确认 */
  readonly usedDefaults: boolean;
}

interface PlanFile {
  readonly file: string;
  readonly before: string | null;
  readonly after: string;
  readonly reason: string;
}

interface Plan {
  readonly files: PlanFile[];
  readonly values: Values;
  readonly presetId: string;
  readonly presetSource: string;
  /** 指向 `default: <presetId>` 的那份宿主 patch；必须**最后**写（见 writePlan）。 */
  readonly hostFile: string;
  /** agent preset 的组合文件；必须先于宿主 patch 落盘。 */
  readonly presetFile: string;
}

function dshHomeDefault(): string {
  return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  // 同时支持 `--name value` 形式（值不以 -- 开头）
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1) {
    const next = argv[idx + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
  }
  return undefined;
}

/** 找 shipped preset 的源目录（只读）。 */
function findPresetSource(home: string, profile: string, preset: string): string | null {
  const roots = [
    process.env.DSH_PRESET_SOURCE,
    path.join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'),
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'),
    path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets',
  ].filter((p): p is string => Boolean(p));
  for (const root of roots) {
    const dir = path.join(root, preset);
    if (fs.existsSync(path.join(dir, 'agent.cordis.yml'))) return dir;
  }
  return null;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function resolveValues(argv: readonly string[], home: string): Values {
  const explicitTheta = flagValue(argv, 'theta');
  const explicitRetain = flagValue(argv, 'retain');
  const explicitInline = flagValue(argv, 'inline');
  const from = flagValue(argv, 'from');

  let windowTokens = 1_000_000;
  let theta = 90_000;
  let rho = 30_000;
  let maxInlineBytes = 8_000;
  let source = '文档默认值（未找到可用日志）';

  const logFile = from ?? discoverSessions(path.join(home, 'sessions'))[0]?.path;
  let usedDefaults = true;
  if (logFile && fs.existsSync(logFile)) {
    const log = readLogFile(logFile);
    if (log.calls.length > 0) {
      const stats = deriveStats(log);
      const p = prescribe(stats);
      windowTokens = stats.windowTokens;
      theta = Math.round(p.theta);
      rho = p.rho;
      maxInlineBytes = p.maxInlineBytes;
      source = `${path.basename(logFile)}（${stats.steps} 步）`;
      usedDefaults = false;
    }
  }
  if (explicitTheta || explicitRetain || explicitInline) usedDefaults = false;
  if (explicitTheta) theta = Number(explicitTheta);
  if (explicitRetain) rho = Number(explicitRetain);
  if (explicitInline) maxInlineBytes = Number(explicitInline);

  return {
    theta,
    rho,
    maxInlineBytes,
    prunerChars: maxInlineBytes,
    windowTokens,
    source,
    usedDefaults,
  };
}

/** 把 thriftflow 的标记块替换/追加到一份 patch 文件里。 */
function upsertBlock(text: string, block: string): string {
  const begin = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const tail = text.slice(end + MARK_END.length);
    return text.slice(0, begin) + block + tail;
  }
  const trimmed = text.trimEnd();
  // 空数组 `[]` 直接整段替换（保留它上面的注释）
  const emptyArray = trimmed.match(/(^|\n)(\s*\[\s*\])\s*$/);
  if (emptyArray) {
    const idx = trimmed.lastIndexOf('[]');
    return trimmed.slice(0, idx) + block.trimEnd() + '\n';
  }
  return `${trimmed}\n\n${block}`;
}

function buildHostBlock(values: Values, presetId: string): string {
  return [
    `${MARK_BEGIN} (generated by \`thriftflow apply\`; 块内手改会被下次 apply 覆盖)`,
    '- id: spill-policy',
    '  config:',
    `    maxInlineBytes: ${values.maxInlineBytes}`,
    '- id: agent-presets',
    '  config:',
    `    default: ${presetId}`,
    MARK_END,
    '',
  ].join('\n');
}

/** 在 preset 里给 compaction-basic 注入 config（fail-closed）。 */
function patchCompaction(presetText: string, values: Values): string {
  const rowRe = /^([ \t]*)- id: compaction-basic[ \t]*\n[ \t]*name: '@deepseek-ai\/dsh-compaction-basic'[ \t]*$/gm;
  const hits = presetText.match(rowRe) ?? [];
  if (hits.length !== 1) {
    throw new Error(`preset 里 compaction-basic 行匹配到 ${hits.length} 处（期望 1），中止`);
  }
  return presetText.replace(rowRe, (matched, indent: string) => {
    const keyIndent = `${indent}  `;
    const valIndent = `${indent}    `;
    return (
      `${matched}\n` +
      `${keyIndent}config:\n` +
      `${valIndent}thresholdRatio: ${(values.theta / values.windowTokens).toFixed(4)}\n` +
      `${valIndent}retainTokens: ${values.rho}`
    );
  });
}

/** 重写 tool-result-pruner 的 config（fail-closed）。 */
function patchPruner(presetText: string, values: Values): string {
  const re =
    /^([ \t]*)- id: tool-result-pruner[ \t]*\n[ \t]*name: '@deepseek-ai\/dsh-compaction-tool-result-pruner'[ \t]*\n(?:[ \t]*config:[ \t]*\n(?:[ \t]+(?:thresholdChars|headChars|tailChars):.*\n)*)/gm;
  const hits = presetText.match(re) ?? [];
  if (hits.length !== 1) {
    throw new Error(`preset 里 tool-result-pruner 行匹配到 ${hits.length} 处（期望 1），中止`);
  }
  return presetText.replace(re, (matched, indent: string) => {
    const keyIndent = `${indent}  `;
    const valIndent = `${indent}    `;
    return (
      `${indent}- id: tool-result-pruner\n` +
      `${keyIndent}name: '@deepseek-ai/dsh-compaction-tool-result-pruner'\n` +
      `${keyIndent}config:\n` +
      `${valIndent}thresholdChars: ${values.prunerChars}\n` +
      `${valIndent}headChars: ${Math.round(values.prunerChars / 2)}\n` +
      `${valIndent}tailChars: ${Math.round(values.prunerChars / 8)}\n`
    );
  });
}

function presetMetadata(presetId: string, values: Values): string {
  return [
    `name: ThriftFlow 节流模式`,
    `description: >-`,
    `  由 thriftflow apply 生成：压缩阈值 ${values.theta} tok（= 窗口的 ${(values.theta / values.windowTokens).toFixed(3)}）、`,
    `  保留 ${values.rho} tok、工具输出上限 ${values.maxInlineBytes} 字节。`,
    `  与内置 standard 的唯一差别是这两处 config。升级 dsh 后重跑 apply 即可幂等刷新（无 --refresh 参数）。`,
    `order: 2`,
    '',
  ].join('\n');
}

function buildPlan(argv: readonly string[]): { plan: Plan; home: string; profile: string } {
  const home = flagValue(argv, 'dsh-home') ?? dshHomeDefault();
  const profile = flagValue(argv, 'profile') ?? 'web';
  const preset = flagValue(argv, 'preset') ?? 'standard';
  const presetId = flagValue(argv, 'preset-id') ?? 'thriftflow';

  const values = resolveValues(argv, home);
  const source = findPresetSource(home, profile, preset);
  if (!source) {
    throw new Error(
      `找不到内置 preset "${preset}" 的源目录。请用 --preset-source=<.../dsh-agent-presets/presets> 指定。`,
    );
  }

  const hostFile = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  const hostBefore = readText(hostFile);
  if (hostBefore === null) {
    throw new Error(`profile patch 文件不存在：${hostFile}（profile 名写错了？）`);
  }

  const presetDir = path.join(home, '.agent-presets', presetId);
  const baseText = fs.readFileSync(path.join(source, 'agent.cordis.yml'), 'utf8');
  const withCompaction = patchCompaction(baseText, values);
  const withPruner = patchPruner(withCompaction, values);
  const header =
    `${MARK_BEGIN}: 由 thriftflow 从内置 preset "${preset}" 复制并改写\n` +
    `# 唯一差别：compaction-basic.thresholdRatio/retainTokens、tool-result-pruner.thresholdChars\n` +
    `# 升级 dsh 后重跑 \`thriftflow apply\` 刷新本文件。\n`;

  const compositionFile = path.join(presetDir, 'agent.cordis.yml');
  const metadataFile = path.join(presetDir, 'preset.yml');

  // 顺序是安全边界，不是风格：web profile 是 `patchReload: live`，
  // 宿主 patch 一旦落盘就会触发热重载并去解析 `default: <presetId>`。
  // 如果那时 preset 目录还没写出来，dsh 当场报
  // `presets: preset "thriftflow" not found`——这正是本项目踩过的启动崩溃。
  // 所以：先把 preset 完整落盘，最后再改指向它的宿主 patch。
  const files: PlanFile[] = [
    {
      file: compositionFile,
      before: readText(compositionFile),
      after: header + withPruner,
      reason: `agent preset：compaction-basic + tool-result-pruner（源自 ${preset}）`,
    },
    {
      file: metadataFile,
      before: readText(metadataFile),
      after: presetMetadata(presetId, values),
      reason: 'preset 元数据（名称/描述/排序）',
    },
    {
      file: hostFile,
      before: hostBefore,
      after: upsertBlock(hostBefore, buildHostBlock(values, presetId)),
      reason: '宿主层：spill-policy.maxInlineBytes + 默认 preset 指向 ' + presetId + '（最后写）',
    },
  ];

  return {
    plan: { files, values, presetId, presetSource: source, hostFile, presetFile: compositionFile },
    home,
    profile,
  };
}

function unifiedDiff(before: string | null, after: string, file: string): string {
  if (before === after) return `${file}: 无变化`;
  const lines: string[] = [`--- ${file}`, `+++ ${file}`];
  const b = after.split('\n');

  if (before === null) {
    lines.push('(新建文件)');
    for (const line of b.slice(0, 40)) lines.push(`+ ${line}`);
    if (b.length > 40) lines.push(`+ … 共 ${b.length} 行`);
    return lines.join('\n');
  }

  // 去掉公共前缀/后缀，只把中间的变化成对展示（比逐行配对好读）
  const a = before.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) {
    tailA--;
    tailB--;
  }

  const contextBefore = Math.max(0, head - 2);
  for (let i = contextBefore; i < head; i++) lines.push(`  ${a[i]}`);
  for (let i = head; i <= tailA; i++) if (i >= head) lines.push(`- ${a[i]}`);
  for (let i = head; i <= tailB; i++) if (i >= head) lines.push(`+ ${b[i]}`);
  const contextAfter = Math.min(b.length - 1, tailB + 3);
  if (contextAfter > tailB + 1) lines.push('  …');
  for (let i = tailB + 1; i <= Math.min(contextAfter, b.length - 1); i++) lines.push(`  ${b[i]}`);
  if (tailB >= b.length - 1) lines.push('  (EOF)');
  return lines.join('\n');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-thriftflow`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function backup(home: string, files: readonly PlanFile[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(home, '.thriftflow', 'backups', stamp);
  const entries: Array<{ target: string; backup: string | null }> = [];
  for (const f of files) {
    if (f.before === null) {
      entries.push({ target: f.file, backup: null });
      continue;
    }
    const rel = path.relative(home, f.file).replace(/[\\/]/g, '__');
    ensureDir(root);
    const target = path.join(root, rel);
    fs.writeFileSync(target, f.before, 'utf8');
    entries.push({ target: f.file, backup: target });
  }
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), files: entries }, null, 2),
    'utf8',
  );
  return root;
}

function restore(home: string, stamp: string): void {
  const root = path.join(home, '.thriftflow', 'backups', stamp);
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`找不到备份：${root}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    files: Array<{ target: string; backup: string | null }>;
  };
  const removed: string[] = [];
  for (const entry of manifest.files) {
    if (entry.backup === null) {
      if (fs.existsSync(entry.target)) fs.rmSync(entry.target);
      removed.push(entry.target);
      console.log(`  删除（原本不存在） ${entry.target}`);
    } else {
      writeAtomic(entry.target, fs.readFileSync(entry.backup, 'utf8'));
      console.log(`  恢复 ${entry.target}`);
    }
  }
  // 回滚后 preset 目录会剩一个空壳；留着会占住 id，下次 apply 会报"已存在"。
  for (const target of removed) pruneEmptyDirs(path.dirname(target));
}

function verify(plan: Plan): string[] {
  const problems: string[] = [];
  const hostText = readText(plan.hostFile) ?? '';
  if (!hostText.includes(MARK_BEGIN)) problems.push(`${plan.hostFile}: 缺少标记块`);
  if (!hostText.includes(`maxInlineBytes: ${plan.values.maxInlineBytes}`)) {
    problems.push(`${plan.hostFile}: 缺少 maxInlineBytes`);
  }
  const presetText = readText(plan.presetFile) ?? '';
  if (!presetText.includes(`retainTokens: ${plan.values.rho}`)) {
    problems.push(`${plan.presetFile}: 缺少 retainTokens`);
  }
  if (!presetText.includes(`thresholdChars: ${plan.values.prunerChars}`)) {
    problems.push(`${plan.presetFile}: 缺少 thresholdChars`);
  }
  return problems;
}

/**
 * 写入前的低成本自检。
 *
 * 目标是抓「loader 连开头都读不下去」的形态，而不是完整校验 YAML——本项目零依赖，
 * 不引 YAML 解析器。真正致命的两种：顶层不是列表、缩进里混进制表符。
 */
function preflight(plan: Plan): string[] {
  const problems: string[] = [];
  const of = (file: string): string => plan.files.find((f) => f.file === file)?.after ?? '';

  const checkTopLevelList = (file: string, text: string): void => {
    const first = text
      .split(/\r?\n/)
      .find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    if (first === undefined) {
      problems.push(`${file}: 有效内容为空`);
      return;
    }
    if (!first.trimStart().startsWith('- ') && first.trim() !== '[]') {
      problems.push(`${file}: 顶层不是列表（首行有效内容 ${JSON.stringify(first.slice(0, 40))}）`);
    }
  };

  const composition = of(plan.presetFile);
  checkTopLevelList(plan.presetFile, composition);
  if (!composition.includes('- id: compaction-basic')) {
    problems.push(`${plan.presetFile}: 找不到 compaction-basic 行`);
  }

  const host = of(plan.hostFile);
  checkTopLevelList(plan.hostFile, host);
  if (host.includes(MARK_BEGIN) !== host.includes(MARK_END)) {
    problems.push(`${plan.hostFile}: thriftflow 标记块不配对`);
  }

  for (const f of plan.files) {
    if (f.after.includes('\t')) problems.push(`${f.file}: 含制表符，YAML 缩进非法`);
  }
  return problems;
}

/** 从宿主 patch 里剥掉 thriftflow 标记块（连同块内的行）。 */
function stripThriftflowBlock(text: string): string {
  const begin = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  if (begin === -1 || end === -1 || end < begin) return text;
  return text.slice(0, begin) + text.slice(end + MARK_END.length);
}

/**
 * 卸载：不依赖备份内容，直接回到「配置里没有 thriftflow」的状态。
 *
 * 为什么不用 `--restore`：备份存的是**上一次 apply 之前**的现场，而那份现场本身
 * 可能已经带着更早一轮的 thriftflow 块。真正安全的目标状态只有一个——
 * 宿主 patch 里没有我们的块、preset 目录不存在、生效记录不再指向它。
 *
 * 全程只碰文件，不需要 dsh 起来，也不依赖任何 UI。
 */
function uninstallEverything(home: string, profile: string, presetId: string): void {
  const hostFile = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  const text = readText(hostFile);
  if (text === null) {
    console.log(`  跳过（文件不存在） ${hostFile}`);
  } else if (!text.includes(MARK_BEGIN)) {
    console.log(`  跳过（没有 thriftflow 标记块） ${hostFile}`);
  } else {
    const stripped = stripThriftflowBlock(text);
    const hasRows = stripped.split(/\r?\n/).some((line) => line.trimStart().startsWith('- '));
    // 剥完只剩注释时补一个 `[]`：空文件在 loader 那边读成 null，同样起不来。
    const next = hasRows ? `${stripped.trimEnd()}\n` : `${stripped.trimEnd()}\n[]\n`;
    writeAtomic(hostFile, next);
    console.log(`  已移除标记块 ${hostFile}`);
  }

  const presetDir = path.join(home, '.agent-presets', presetId);
  if (fs.existsSync(presetDir)) {
    fs.rmSync(presetDir, { recursive: true, force: true });
    pruneEmptyDirs(path.dirname(presetDir));
    console.log(`  已删除 preset 目录 ${presetDir}`);
  } else {
    console.log(`  跳过（目录不存在） ${presetDir}`);
  }

  const recordFile = appliedRecordPath(home);
  if (fs.existsSync(recordFile)) {
    fs.rmSync(recordFile);
    console.log(`  已删除生效记录 ${recordFile}（compare --after-apply 不会再拿旧锚点报数）`);
  }
}

/** 删掉空目录（回滚后 preset 目录会剩下一个空壳，留着会占住 id）。 */
function pruneEmptyDirs(dir: string): void {
  let current = dir;
  for (;;) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// ── 生效记录（compare --after-apply 的锚点）───────────────────────────────

/**
 * `apply` 成功后写一份"什么时候、用什么值、覆盖了哪份备份"的记录。
 *
 * 为什么需要它：备份目录名只含时间戳，取值和 preset 得靠人肉回忆；
 * 而 `compare --after-apply` 需要一条**可信的时间分界**才能把会话日志切成
 * before / after 两组。没有这把尺子，就只能按体积猜，那是编数。
 */
export interface AppliedRecord {
  readonly appliedAt: string;
  /** 与 mtime 同单位（毫秒），用于和会话文件比较 */
  readonly appliedAtMs: number;
  readonly values: {
    readonly theta: number;
    readonly rho: number;
    readonly maxInlineBytes: number;
    readonly windowTokens: number;
  };
  readonly backupId: string;
  readonly presetId: string;
  readonly profile: string;
  readonly source: string;
}

export function appliedRecordPath(home: string): string {
  return path.join(home, '.thriftflow', 'applied.json');
}

function writeAppliedRecord(
  home: string,
  plan: Plan,
  backupId: string,
  profile: string,
): string {
  const now = new Date();
  const file = appliedRecordPath(home);
  const record: AppliedRecord = {
    appliedAt: now.toISOString(),
    appliedAtMs: now.getTime(),
    values: {
      theta: plan.values.theta,
      rho: plan.values.rho,
      maxInlineBytes: plan.values.maxInlineBytes,
      windowTokens: plan.values.windowTokens,
    },
    backupId,
    presetId: plan.presetId,
    profile,
    source: plan.values.source,
  };
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return file;
}

/** 读生效记录；没跑过 apply（或文件损坏）时返回 null，调用方负责报"样本不足"。 */
export function readAppliedRecord(home: string): AppliedRecord | null {
  const text = readText(appliedRecordPath(home));
  if (text === null) return null;
  try {
    // 手改过的文件在 Windows 上常带 BOM，JSON.parse 不认
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '').trim()) as Partial<AppliedRecord>;
    if (typeof parsed.appliedAtMs !== 'number' || !Number.isFinite(parsed.appliedAtMs)) return null;
    const values = parsed.values;
    if (!values || typeof values.theta !== 'number' || typeof values.rho !== 'number') return null;
    return parsed as AppliedRecord;
  } catch {
    return null;
  }
}

/**
 * 校验 `applied.json` 里记下来的取值，**此刻**是否还真的落在配置文件里。
 *
 * 为什么必须有这一步：这份记录只证明"某个时刻写过这些值"，不证明它们还在。
 * 实际踩过——apply 成功、applied.json 留下记录，几天后 `cordis.patch.yml`
 * 被改回 `[]`、`.agent-presets/thriftflow/` 整个消失。此时 `compare --after-apply`
 * 会把一组**没吃到处理**的会话当成 after 组，算出漂亮的"实测收益"。
 * 实验设计已经破了，再精确的模型也救不回来。
 */
export function verifyApplied(home: string, record: AppliedRecord): string[] {
  const problems: string[] = [];

  const hostFile = path.join(home, 'profiles', record.profile, 'cordis.patch.yml');
  const hostText = readText(hostFile);
  if (hostText === null) {
    problems.push(`${hostFile}: 文件不存在`);
  } else {
    if (!hostText.includes(MARK_BEGIN)) problems.push(`${hostFile}: 缺少 # thriftflow:begin 标记块`);
    if (!hostText.includes(`maxInlineBytes: ${record.values.maxInlineBytes}`)) {
      problems.push(`${hostFile}: maxInlineBytes: ${record.values.maxInlineBytes} 不在位`);
    }
  }

  const presetFile = path.join(home, '.agent-presets', record.presetId, 'agent.cordis.yml');
  const presetText = readText(presetFile);
  if (presetText === null || presetText.trim() === '') {
    problems.push(`${presetFile}: 文件不存在或为空`);
  } else {
    if (!presetText.includes(`retainTokens: ${record.values.rho}`)) {
      problems.push(`${presetFile}: retainTokens: ${record.values.rho} 不在位`);
    }
  }

  return problems;
}

export function runApply(argv: string[]): void {
  const home = flagValue(argv, 'dsh-home') ?? dshHomeDefault();
  const restoreStamp = flagValue(argv, 'restore');
  const dryRun = argv.includes('--dry-run');

  console.log('\n═══ thriftflow apply ═══');
  console.log(`DSH_HOME  ${home}`);

  const uninstall = argv.includes('--uninstall');
  if (uninstall) {
    const profile = flagValue(argv, 'profile') ?? 'web';
    const presetId = flagValue(argv, 'preset-id') ?? 'thriftflow';
    try {
      uninstallEverything(home, profile, presetId);
    } catch (error) {
      console.error(`\n卸载失败：${(error as Error).message}\n`);
      process.exit(1);
      return;
    }
    console.log('\n已回到安全状态。若 dsh 在跑，patch 层会热重载（web profile 为 patchReload: live）。');
    console.log('若 dsh 仍然起不来，手工确认：');
    console.log(`  · ${path.join(home, 'profiles', profile, 'cordis.patch.yml')} 里没有 thriftflow 标记块`);
    console.log(`  · ${path.join(home, '.agent-presets', presetId)} 已不存在\n`);
    return;
  }

  if (restoreStamp) {
    console.log(`恢复备份  ${restoreStamp}`);
    restore(home, restoreStamp);
    console.log('\n已恢复。若 dsh 在跑，patch 层会热重载（web profile 为 patchReload: live）。\n');
    return;
  }

  let plan: Plan;
  try {
    plan = buildPlan(argv).plan;
  } catch (error) {
    console.error(`\n中止（未写入任何文件）：${(error as Error).message}\n`);
    process.exit(1);
    return;
  }

  const profile = flagValue(argv, 'profile') ?? 'web';
  console.log(`profile   ${profile}`);
  console.log(`preset 源 ${plan.presetSource}`);
  console.log(`取值来源  ${plan.values.source}`);
  console.log(
    `处方      θ=${plan.values.theta}（=${(plan.values.theta / plan.values.windowTokens).toFixed(4)}W）  ` +
      `ρ=${plan.values.rho}  maxInlineBytes=${plan.values.maxInlineBytes}`,
  );

  console.log(`\n计划写入：`);
  for (const f of plan.files) {
    console.log(`  ${f.before === null ? '新建' : '改写'}  ${f.file}`);
    console.log(`        ${f.reason}`);
  }

  if (plan.values.usedDefaults && !argv.includes('--allow-defaults')) {
    console.error(
      '\n中止（未写入任何文件）：既没有可用会话日志，也没有给显式数值。\n' +
        '  用 --from=<log> 指定日志，或 --theta= --retain= --inline= 指定数值，\n' +
        '  确实要用文档默认值请加 --allow-defaults。\n',
    );
    process.exit(1);
    return;
  }

  console.log('\n逐文件 diff：');
  for (const f of plan.files) {
    console.log('\n' + unifiedDiff(f.before, f.after, f.file));
  }

  if (dryRun) {
    console.log('\n--dry-run：未写入任何文件。去掉 --dry-run 即执行。\n');
    return;
  }

  const blockers = preflight(plan);
  if (blockers.length > 0) {
    console.error('\n中止（未写入任何文件）：生成结果自检不通过。');
    for (const b of blockers) console.error(`  ✗ ${b}`);
    console.error('');
    process.exit(1);
    return;
  }

  const backupRoot = backup(home, plan.files);
  console.log(`\n已备份到  ${backupRoot}`);
  for (const f of plan.files) {
    // 顺序保证：preset 组合必须先落盘，宿主 patch 才能把 default 指过去。
    // web profile 是 patchReload: live，写早一步就是热重载瞬间 "preset not found"。
    if (f.file === plan.hostFile && !fs.existsSync(plan.presetFile)) {
      console.error(`\n中止：preset 组合文件未落盘（${plan.presetFile}），拒绝写宿主 patch。`);
      console.error(`回滚：node thriftflow.ts apply --restore ${path.basename(backupRoot)}\n`);
      process.exit(1);
      return;
    }
    writeAtomic(f.file, f.after);
  }

  const problems = verify(plan);
  if (problems.length > 0) {
    console.error('\n写入后校验失败：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`回滚：node thriftflow.ts apply --restore ${path.basename(backupRoot)}\n`);
    process.exitCode = 1;
    return;
  }

  const recordFile = writeAppliedRecord(home, plan, path.basename(backupRoot), profile);

  console.log('\n校验通过：标记块、maxInlineBytes、retainTokens、thresholdChars 均已在位。');
  console.log(`生效记录  ${recordFile}`);
  console.log('\n生效方式：');
  console.log('  · 宿主层（spill-policy）与默认 preset 指向：web profile 的 patchReload=live，热重载，无需重启；');
  console.log(`  · 新 preset（${plan.presetId}）只对**新建会话**生效；已存在的会话仍用旧 preset。`);
  console.log('  · 新开一个会话后跑 `node thriftflow.ts audit --limit=1` 验证实测；');
  console.log('  · 攒够几个新会话后跑 `node thriftflow.ts compare --after-apply` 看实测趋势。');
  console.log(`\n回滚：node thriftflow.ts apply --restore ${path.basename(backupRoot)}\n`);
}

export { buildPlan, findPresetSource };
