/**
 * build.ts —— 把根目录的 .ts 剥成 .js 放进 dist/，供 npm 安装态运行。
 *
 * 为什么必须有这一层（不是审美问题）：
 *   Node 的 type stripping 明确拒绝执行 node_modules 里的 .ts：
 *     ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 *   而 `npx thriftflow` / `npm i -g` 都会把包放进 node_modules，
 *   所以 bin 入口不能直接指向 .ts。源码仍然是唯一的真相，dist/ 只是产物。
 *
 * 零依赖：用 Node 内置的 `module.stripTypeScriptTypes`（Node >= 22.13），不引 tsc。
 *
 *   node build.ts            # 生成 dist/
 *   node build.ts --check    # 只校验能剥通，不写文件
 *
 * dist/ 在 .gitignore 里；`npm pack` / `npm publish` 由 prepack 自动调用本脚本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

/** CLI 的闭包：入口 + 它直接/间接 import 的模块。tcc-inventory/ 不参与构建。 */
const ENTRIES = [
  'thriftflow',
  'replay',
  'model',
  'prescribe',
  'compare',
  'apply',
  'proxy',
  'selftest',
] as const;

const OUT_DIR = 'dist';

/** 相对 import 的 `.ts` 后缀必须改成 `.js`，否则 ESM 解析不到。 */
function rewriteImports(code: string): string {
  return code.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1$2.js$3');
}

function build(): number {
  const checkOnly = process.argv.includes('--check');
  const files: string[] = [];
  let failed = 0;

  if (!checkOnly) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  for (const name of ENTRIES) {
    const from = path.join(process.cwd(), `${name}.ts`);
    const to = path.join(OUT_DIR, `${name}.js`);
    try {
      const source = fs.readFileSync(from, 'utf8');
      const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
      const code = rewriteImports(stripped);
      if (!checkOnly) fs.writeFileSync(to, code, 'utf8');
      files.push(`${name}.ts → ${path.relative(process.cwd(), to)} (${(source.length / 1024).toFixed(1)} kB)`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${name}.ts: ${message}`);
    }
  }

  for (const line of files) console.log(`  ✓ ${line}`);
  const total = checkOnly ? 0 : fs.readdirSync(OUT_DIR).length;
  console.log(
    `\n${checkOnly ? '校验通过' : `已生成 ${total} 个文件`}；${ENTRIES.length - failed}/${ENTRIES.length} 个模块可剥离`,
  );
  if (failed > 0) process.exitCode = 1;
  return failed;
}

build();
