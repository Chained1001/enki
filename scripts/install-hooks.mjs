#!/usr/bin/env node
// 在 git 仓库里安装 pre-commit 钩子：提交前跑 validate 与 test，任一失败则拒绝提交。只用 Node 内置模块。
// 用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]
// 退出码：0 成功，1 业务失败（不是 git 仓库、已有钩子且未加 --force），2 参数错误。
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = '用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]'

function hookText(packageDir) {
  const cd = packageDir ? `cd "$root/${packageDir}"` : 'cd "$root"'
  return `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成。提交前跑静态校验与测试，任一失败则拒绝提交。
set -e
root=$(git rev-parse --show-toplevel)
${cd}
if [ ! -f package.json ]; then
  echo "pre-commit: 该目录没有 package.json，跳过校验" >&2
  exit 0
fi
npm run validate
npm test
`
}

export class UsageError extends Error {}
export class NotGitRepoError extends Error {}
export class HookExistsError extends Error {}

export async function installHooks({ root = '.', packageDir = '', force = false, dryRun = false } = {}) {
  const dir = resolve(root)
  if (!existsSync(join(dir, '.git'))) {
    throw new NotGitRepoError(`不是 git 仓库：${dir}。先运行 git init`)
  }
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit')
  const exists = existsSync(hookPath)
  if (exists && !force) {
    throw new HookExistsError(`已存在 pre-commit 钩子：${hookPath}。加 --force 覆盖`)
  }

  if (dryRun) return { action: 'dry-run', path: hookPath, overwrite: exists }

  await mkdir(join(dir, '.git', 'hooks'), { recursive: true })
  await writeFile(hookPath, hookText(packageDir), 'utf8')
  // Windows 上 git 会忽略执行位，但类 Unix 系统需要 755。
  await chmod(hookPath, 0o755)
  return { action: 'installed', path: hookPath, overwrite: exists }
}

export function parseArgs(argv) {
  const options = { root: '.', packageDir: '', force: false, dryRun: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package-dir') options.packageDir = requireValue(argv, ++i, arg)
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`)
    else options.root = arg
  }
  return options
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith('--')) throw new UsageError(`${flag} 缺少取值。${USAGE}`)
  return argv[index]
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  try {
    const result = await installHooks({
      root: options.root,
      packageDir: options.packageDir,
      force: options.force,
      dryRun: options.dryRun,
    })
    if (options.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: result }, null, 2))
    } else if (result.action === 'dry-run') {
      console.log(`将写入 ${result.path}${result.overwrite ? '（覆盖已有钩子）' : ''}`)
    } else {
      console.log(`已安装 pre-commit 钩子：${result.path}`)
      console.log('下次 git commit 前会自动运行 npm run validate 与 npm test。')
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: 'E_HOOK', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
