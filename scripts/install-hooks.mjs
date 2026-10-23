#!/usr/bin/env node
// 在 git 仓库里安装 pre-commit 钩子：提交前拦下 _拆解/ 产物目录的暂存文件，再跑 validate 与 test，任一失败则拒绝提交。只用 Node 内置模块。
// 用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]
// 退出码：0 成功，1 业务失败（不是 git 仓库、已有钩子且未加 --force），2 参数错误。
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = '用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]'

function hookText(packageDir) {
  const cd = packageDir ? `cd "$root/${packageDir}"` : 'cd "$root"'
  return `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成。提交前检查暂存路径、跑静态校验与测试，任一失败则拒绝提交。
set -e
root=$(git rev-parse --show-toplevel)
${cd}

# 产物目录（*_拆解/）不得入库：暂存区只要出现路径中含 _拆解/ 的文件就拒绝提交。
# 测试夹具 test/fixtures/products/ 是有意入库的合成数据，按前缀豁免，与 .gitignore 口径一致。
# core.quotePath=false 让中文路径原样输出，否则会被转义成八进制序列而匹配不到 _拆解/。
staged=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)
offenders=$(printf '%s\\n' "$staged" | grep -F '_拆解/' | grep -v '^test/fixtures/products/' || true)
if [ -n "$offenders" ]; then
  echo "pre-commit: 产物目录（*_拆解/）不得入库；测试夹具 test/fixtures/products/ 除外。" >&2
  echo "以下暂存文件位于 *_拆解/ 目录内：" >&2
  printf '%s\\n' "$offenders" | sed 's/^/  /' >&2
  echo "修法：把产物目录移到仓库外；已暂存的用 git rm --cached <路径> 撤销暂存（文件仍留在工作区）。" >&2
  exit 1
fi

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

// packageDir 会拼进钩子脚本的 `cd "$root/${packageDir}"：绝对路径没有 $root 前缀可依，
// " ` $ 与反斜杠则会破坏 sh 引号或被展开，一律在入口拒绝。
function validatePackageDir(packageDir) {
  if (!packageDir) return
  if (isAbsolute(packageDir)) {
    throw new UsageError(`--package-dir 须为相对仓库根的路径，当前为 "${packageDir}"`)
  }
  if (/["`$\\]/.test(packageDir)) {
    throw new UsageError(`--package-dir 不得含 "、\`、$ 或反斜杠，路径分隔请用 /，当前为 "${packageDir}"`)
  }
  if (/[\x00-\x1f\x7f]/.test(packageDir)) {
    throw new UsageError('--package-dir 不得含控制字符（含换行），当前值含不可见字符')
  }
}

export async function installHooks({ root = '.', packageDir = '', force = false, dryRun = false } = {}) {
  validatePackageDir(packageDir)
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
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package-dir') options.packageDir = requireValue(argv, ++i, arg)
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`)
    else positional.push(arg)
  }
  // 第二个位置参数不再静默覆盖 root，与兄弟脚本一致报「多余的参数」。
  if (positional.length > 1) throw new UsageError(`多余的参数 ${positional.slice(1).join(' ')}。${USAGE}`)
  if (positional.length === 1) options.root = positional[0]
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
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_ARGS', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
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
      console.log('下次 git commit 前会先拦下 *_拆解/ 产物目录的暂存文件，再运行 npm run validate 与 npm test。')
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
