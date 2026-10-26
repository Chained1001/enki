// validate-output 的 CLI 外壳：用法文案、参数解析、结果输出与退出码。
// 「直接运行才执行」的入口判断留在 validate-output.mjs；这里接收 validateOutput，
// 避免 cli.mjs 反向 import 入口模块造成循环依赖。
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const USAGE = '用法：validate-output.mjs <产物目录> [--mode deliver|progress] [--json] [--help]'

export function parseArgs(argv) {
  const options = { root: undefined, mode: 'deliver', json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--mode') {
      const v = argv[++i]
      if (v !== 'deliver' && v !== 'progress') throw new Error(`--mode 只接受 deliver 或 progress。${USAGE}`)
      options.mode = v
    } else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}。${USAGE}`)
    else if (options.root === undefined) options.root = arg
    else throw new Error(`多余的参数 ${arg}。${USAGE}`)
  }
  if (!options.help && !options.root) throw new Error(USAGE)
  return options
}

export async function runCli(validateOutput) {
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
  const root = resolve(options.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`产物目录不存在：${root}`)
    process.exitCode = 2
    return
  }
  const result = await validateOutput({ root, mode: options.mode })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const e of result.errors) {
      const tag = e.severity === 'warning' ? '警告' : '错误'
      console.error(`${tag} [${e.code}] ${e.file}: ${e.message}`)
    }
    const d = result.data
    console.log(`总判定：${d.verdict}（错误 ${d.errors}，警告 ${d.warnings}${modeLabel(options.mode)}）`)
    if (options.mode === 'progress') {
      console.log(`完成度：文件已填 ${d.files.filled}/${d.files.total}，批次 ${d.batches.done}/${d.batches.total}`)
    }
  }
  if (!result.ok) process.exitCode = 1
}

export function modeLabel(mode) {
  return mode === 'progress' ? '，进度模式不阻断' : ''
}
