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
    `  与内置 standard 的唯一差别是这两处 config；升级 dsh 后请重跑 apply --refresh。`,
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

  const files: PlanFile[] = [
    {
      file: hostFile,
      before: hostBefore,
      after: upsertBlock(hostBefore, buildHostBlock(values, presetId)),
      reason: '宿主层：spill-policy.maxInlineBytes + 默认 preset 指向 ' + presetId,
    },
    {
      file: path.join(presetDir, 'agent.cordis.yml'),
      before: readText(path.join(presetDir, 'agent.cordis.yml')),
      after: header + withPruner,
      reason: `agent preset：compaction-basic + tool-result-pruner（源自 ${preset}）`,
    },
    {
      file: path.join(presetDir, 'preset.yml'),
      before: readText(path.join(presetDir, 'preset.yml')),
      after: presetMetadata(presetId, values),
      reason: 'preset 元数据（名称/描述/排序）',
    },
  ];

  return { plan: { files, values, presetId, presetSource: source }, home, profile };
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
  for (const entry of manifest.files) {
    if (entry.backup === null) {
      if (fs.existsSync(entry.target)) fs.rmSync(entry.target);
      console.log(`  删除（原本不存在） ${entry.target}`);
    } else {
      writeAtomic(entry.target, fs.readFileSync(entry.backup, 'utf8'));
      console.log(`  恢复 ${entry.target}`);
    }
  }
}

function verify(plan: Plan): string[] {
  const problems: string[] = [];
  const host = plan.files[0];
  const hostText = readText(host.file) ?? '';
  if (!hostText.includes(MARK_BEGIN)) problems.push(`${host.file}: 缺少标记块`);
  if (!hostText.includes(`maxInlineBytes: ${plan.values.maxInlineBytes}`)) {
    problems.push(`${host.file}: 缺少 maxInlineBytes`);
  }
  const preset = plan.files[1];
  const presetText = readText(preset.file) ?? '';
  if (!presetText.includes(`retainTokens: ${plan.values.rho}`)) {
    problems.push(`${preset.file}: 缺少 retainTokens`);
  }
  if (!presetText.includes(`thresholdChars: ${plan.values.prunerChars}`)) {
    problems.push(`${preset.file}: 缺少 thresholdChars`);
  }
  return problems;
}

export function runApply(argv: string[]): void {
  const home = flagValue(argv, 'dsh-home') ?? dshHomeDefault();
  const restoreStamp = flagValue(argv, 'restore');
  const dryRun = argv.includes('--dry-run');

  console.log('\n═══ thriftflow apply ═══');
  console.log(`DSH_HOME  ${home}`);

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

  const backupRoot = backup(home, plan.files);
  console.log(`\n已备份到  ${backupRoot}`);
  for (const f of plan.files) writeAtomic(f.file, f.after);

  const problems = verify(plan);
  if (problems.length > 0) {
    console.error('\n写入后校验失败：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`回滚：node thriftflow.ts apply --restore ${path.basename(backupRoot)}\n`);
    process.exitCode = 1;
    return;
  }

  console.log('\n校验通过：标记块、maxInlineBytes、retainTokens、thresholdChars 均已在位。');
  console.log('\n生效方式：');
  console.log('  · 宿主层（spill-policy）与默认 preset 指向：web profile 的 patchReload=live，热重载，无需重启；');
  console.log(`  · 新 preset（${plan.presetId}）只对**新建会话**生效；已存在的会话仍用旧 preset。`);
  console.log('  · 新开一个会话后跑 `node thriftflow.ts audit --limit=1` 验证实测。');
  console.log(`\n回滚：node thriftflow.ts apply --restore ${path.basename(backupRoot)}\n`);
}

export { buildPlan, findPresetSource };
