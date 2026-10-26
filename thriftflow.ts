/**
 * thriftflow —— 统一入口
 *
 *   node thriftflow.ts audit [--limit=N] [--newest] [<log>]          成本审计（replay.ts）
 *   node thriftflow.ts prescribe [--limit=N] [--newest] [<log>]      处方 Diff 表（prescribe.ts）
 *   node thriftflow.ts compare [--limit=N] [--newest] [--after-apply] [<log>]
 *                                                                    before/after 对照（compare.ts）
 *   node thriftflow.ts apply [--dry-run]                              写入 dsh 配置（apply.ts）
 *   node thriftflow.ts proxy [--port=N]                               本地请求代理（proxy.ts）
 *
 * 也接受 `--compare` / `--apply` / `--prescribe` / `--audit` / `--proxy` 作为子命令别名，
 * 因为这是最顺手的写法：`thriftflow --compare`。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApply } from './apply.ts';
import { runCompare } from './compare.ts';
import { runPrescribe } from './prescribe.ts';
import { runProxy } from './proxy.ts';
import { runAudit } from './replay.ts';

const ALIASES: Record<string, string> = {
  '--audit': 'audit',
  '--prescribe': 'prescribe',
  '--compare': 'compare',
  '--apply': 'apply',
  '--proxy': 'proxy',
};

const HELP = `
惜流 ThriftFlow —— dsh 的上下文成本控制系统

  thriftflow audit      [<log>] [--limit=N] [--newest]   成本审计：时间/账单花在哪
  thriftflow prescribe  [<log>] [--limit=N] [--newest]   处方：Diff 建议表 + 预计节省 + patch
  thriftflow compare    [<log>] [--limit=N] [--newest] [--after-apply]
                                             before/after 对照：处方到底省多少
  thriftflow apply      [--dry-run]           把处方写进 dsh 配置（带备份，可 --restore）
  thriftflow proxy      [--port=N]            本地代理：在请求出本机前压阈值

通用选项：
  --limit=<n>            不带日志时，取几个会话（audit 默认 3、prescribe 1、compare 25）
  --newest               按 mtime 取最新的（默认按体积取最大的）

compare 选项：
  --after-apply          按 apply 的生效时间切分 before/after，两边都只比实测

apply 选项：
  --dsh-home=<path>      覆盖 $DSH_HOME
  --profile=<name>       目标 profile（默认 web）
  --preset=<name>        复制哪个内置 preset（默认 standard）
  --preset-id=<name>     新 preset 的 id（默认 thriftflow）
  --from=<log>           用这份日志的处方取值（默认取最大的真实会话）
  --theta= / --retain= / --inline=   手动指定数值
  --dry-run              只打印计划
  --restore=<ts>         从 .thriftflow/backups/<ts> 恢复
                         成功后写 .thriftflow/applied.json（compare --after-apply 的锚点）

proxy 选项：
  --upstream=<url>       上游（默认 https://api.deepseek.com）
  --max-inline-bytes=<n> 工具输出上限（默认 8000）
  --max-prompt-tokens=<n> prompt 上限（默认关闭）
  --dry-run              只统计，不改请求体
`;

function main(argv: string[]): void {
  const first = argv[0];
  let command: string;
  let rest: string[];

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP);
    return;
  }
  if (ALIASES[first]) {
    command = ALIASES[first];
    rest = argv.slice(1);
  } else if (first.startsWith('--')) {
    console.error(`未知选项 ${first}\n${HELP}`);
    process.exit(2);
    return;
  } else {
    command = first;
    rest = argv.slice(1);
  }

  switch (command) {
    case 'audit':
      runAudit(rest);
      return;
    case 'prescribe':
      runPrescribe(rest);
      return;
    case 'compare':
      runCompare(rest);
      return;
    case 'apply':
      runApply(rest);
      return;
    case 'proxy':
      runProxy(rest);
      return;
    default:
      console.error(`未知子命令 ${command}\n${HELP}`);
      process.exit(2);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main(process.argv.slice(2));

export { main };
