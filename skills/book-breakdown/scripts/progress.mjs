#!/usr/bin/env node
// manifest 状态块唯一写入口（技术文档 D-12：批表/阶段表只由脚本写入，agent 不得手改）。
// 写入口带 mtime 冲突检测（评审 P7）：读取后记录 mtime，写盘前复核，不一致报 E_CONFLICT，不覆盖。
// 用法：progress.mjs <产物目录> [--batch-done 卷号:批号]... [--stage 阶段号:状态]... [--json] [--help]
//       不带参数时只读输出当前进度（阶段、批完成度、文件四态概览）。
// 退出码：0 成功，1 业务失败（manifest 缺失、批次不存在、状态非法、写冲突），2 参数错误。
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENUMS } from './contract.mjs'
import { IoError, readManifest, writeFileAtomic } from './io.mjs'

const USAGE = '用法：progress.mjs <产物目录> [--batch-done 卷号:批号]... [--stage 阶段号:状态]... [--file 相对路径:状态]... [--file-state 相对路径]... [--resync-files] [--json] [--help]'

export class UsageError extends Error {
  constructor(message, code = 'E_PROGRESS') { super(message); this.code = code }
}

// manifest 写前冲突检测（评审 P7）：读-改-写窗口内 mtime 变化说明有并发写或外部手改，拒绝覆盖。
// 独立导出以便单测：stat 记录 mtime 后篡改文件，再复核应报 E_CONFLICT。
export function assertManifestUnchanged(file, mtimeMs) {
  const current = existsSync(file) ? statSync(file).mtimeMs : -1
  if (current !== mtimeMs) {
    throw new UsageError(
      `manifest 已被其他进程修改（${file}）：读取时 mtime=${mtimeMs}，写前复核 mtime=${current}。放弃本次写入以免覆盖，请重试`,
      'E_CONFLICT',
    )
  }
}

export function queryProgress(manifest) {
  const batches = manifest.batches ?? []
  const done = batches.filter((b) => b.status === 'done')
  return {
    book: manifest.book,
    bookType: manifest.bookType,
    stages: manifest.stages ?? [],
    batches: { done: done.length, total: batches.length, failed: batches.filter((b) => b.status === 'failed').length },
    // 文件状态一起给出（C-24）：流程里「回填前先看这个文件填没填」需要它。
    // 没这个字段时，唯一的读法是让 agent 自己去翻 manifest.json——
    // 那等于把脚本该做的事推回给模型，还多一次读。
    files: manifest.files ?? {},
  }
}

// 骨架态判据与 validate-output.mjs 保持一致：正文里还有没有「还没填」的证据。
// 不一致会让「按内容判定」出现两套结果——一处说填好了，另一处说还是骨架。
// 这里刻意不复用 validate-output 的内部函数：那是个校验器，progress 只是改状态，
// 为了一个判据把整个校验器拖进来不划算；两处判据由测试对齐（test/progress-file.test.mjs）。
function firstTable(text) {
  const lines = text.split(/\r?\n/)
  let header = null
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line.startsWith('|') || !line.endsWith('|')) continue
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim())
    if (cells.length < 2) continue
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue // 分隔行
    if (header === null) { header = cells; continue }
    rows.push(cells)
  }
  return header ? { header, rows } : null
}

// 由文件内容判定状态：filled 或 skeleton。纯表格产物（索引/台账/词典）没有「（待填）」字样，
// 只按占位判会把空表当成已填，所以再看「表头齐了但零数据行」。
export function detectFileState(text, rel = '') {
  const body = text.replace(/^>.*$/gm, '')
  if (body.includes('（待填）')) return 'skeleton'
  if (rel.endsWith('.md')) {
    const table = firstTable(body)
    if (table && !/^## /m.test(body) && table.rows.length === 0) return 'skeleton'
  }
  return 'filled'
}

export async function updateProgress({ root, batchDone = [], stage = [], file = [] }) {
  root = resolve(root)
  const manifestPath = join(root, '工作', 'manifest.json')
  if (!existsSync(manifestPath)) throw new UsageError('产物目录缺少 manifest，请先运行 prepare', 'E_MANIFEST')
  const manifest = await readManifest(root) // 评审 P5：损坏→E_MANIFEST，不抛裸 SyntaxError
  const mtimeMs = statSync(manifestPath).mtimeMs // 评审 P7：记录读取时刻的 mtime，写盘前复核
  manifest.batches ??= []
  manifest.stages ??= []
  manifest.files ??= {}

  for (const key of batchDone) {
    const m = /^(\d+):(\d+)$/.exec(key)
    if (!m) throw new UsageError(`--batch-done 取值「${key}」应为 卷号:批号，如 1:2`, 'E_ARGS')
    const batch = manifest.batches.find((b) => b.volumeNo === Number(m[1]) && b.batch === Number(m[2]))
    if (!batch) throw new UsageError(`批次不存在：卷${m[1]} 批${m[2]}`, 'E_BATCH')
    batch.status = 'done'
  }
  for (const key of stage) {
    const m = /^(\d+):(\w+)$/.exec(key)
    if (!m) throw new UsageError(`--stage 取值「${key}」应为 阶段号:状态，如 4:done`, 'E_ARGS')
    const item = manifest.stages.find((s) => s.id === Number(m[1]))
    if (!item) throw new UsageError(`阶段不存在：${m[1]}`, 'E_STAGE')
    if (!ENUMS.阶段状态.includes(m[2])) throw new UsageError(`状态「${m[2]}」不在枚举内：${ENUMS.阶段状态.join('、')}`, 'E_STAGE')
    item.status = m[2]
  }
  // 文件状态写入（B-06）：此前 manifest.files 只在 prepare 时写一次，之后没有任何写入口，
  // 于是它必然过期。这里给一个稳定的入口，路径须是产物根相对路径，且文件必须真实存在——
  // 允许给不存在的文件记状态，等于又造一套「说与做不一致」的账。
  for (const key of file) {
    const sep = key.lastIndexOf(':')
    if (sep <= 0) throw new UsageError(`--file 取值「${key}」应为 相对路径:状态，如 故事底本/文风.md:filled`, 'E_ARGS')
    const rel = key.slice(0, sep).replace(/\\/g, '/')
    const want = key.slice(sep + 1)
    if (!ENUMS.文件状态.includes(want)) {
      throw new UsageError(`文件状态「${want}」不在枚举内：${ENUMS.文件状态.join('、')}`, 'E_ARGS')
    }
    if (rel.startsWith('/') || rel.includes('..')) {
      throw new UsageError(`--file 的路径必须是产物根下的相对路径，不接受「${rel}」`, 'E_ARGS')
    }
    const full = join(root, rel)
    if (!existsSync(full)) throw new UsageError(`文件不存在：${rel}`, 'E_FILE')
    manifest.files[rel] = want
  }

  const changed = batchDone.length + stage.length + file.length > 0
  if (changed) {
    assertManifestUnchanged(manifestPath, mtimeMs) // 评审 P7：并发写/外部手改 → E_CONFLICT，不覆盖
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { changed, progress: queryProgress(manifest) }
}

// 续跑时按内容重判全部文件状态（B-06）：照抄上次记录的标签没有意义——
// 那份标签正是会过期的东西。只重判已登记的文件；新文件由 prepare/流程自己登记。
export async function resyncFileStates({ root }) {
  root = resolve(root)
  const manifestPath = join(root, '工作', 'manifest.json')
  if (!existsSync(manifestPath)) throw new UsageError('产物目录缺少 manifest，请先运行 prepare', 'E_MANIFEST')
  const manifest = await readManifest(root)
  const mtimeMs = statSync(manifestPath).mtimeMs
  manifest.files ??= {}
  let changed = 0
  for (const rel of Object.keys(manifest.files)) {
    if (rel.startsWith('原文/') || rel === '工作/manifest.json') continue
    const full = join(root, rel)
    if (!existsSync(full)) continue
    const want = detectFileState(await readFile(full, 'utf8'), rel)
    // 已经人工标成 validated/failed 的不覆盖：那是流程的判断，不是内容能推出来的。
    if (manifest.files[rel] === 'validated' || manifest.files[rel] === 'failed') continue
    if (manifest.files[rel] !== want) {
      manifest.files[rel] = want
      changed += 1
    }
  }
  if (changed) {
    assertManifestUnchanged(manifestPath, mtimeMs)
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { changed, progress: queryProgress(manifest) }
}

export function parseArgs(argv) {
  const options = { root: undefined, batchDone: [], stage: [], file: [], fileState: [], resync: false, json: false, help: false }
  let i = 0
  const valueOf = (flag) => {
    const v = argv[++i]
    if (!v) throw new UsageError(`${flag} 缺少取值。${USAGE}`, 'E_ARGS')
    return v
  }
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--batch-done') options.batchDone.push(valueOf('--batch-done'))
    else if (arg === '--stage') options.stage.push(valueOf('--stage'))
    else if (arg === '--file') options.file.push(valueOf('--file'))
    else if (arg === '--file-state') options.fileState.push(valueOf('--file-state'))
    else if (arg === '--resync-files') options.resync = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`, 'E_ARGS')
    else if (options.root === undefined) options.root = arg
    else throw new UsageError(`多余的参数 ${arg}。${USAGE}`, 'E_ARGS')
  }
  if (!options.help && !options.root) throw new UsageError(USAGE, 'E_ARGS')
  return options
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
    const { changed, progress } = options.resync
      ? await resyncFileStates(options)
      : await updateProgress(options)
    if (options.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: { changed, ...progress } }, null, 2))
    } else {
      const stage = progress.stages.find((s) => s.status === 'running') ?? progress.stages.find((s) => s.status !== 'done')
      console.log(`进度：${progress.book}（${progress.bookType}）`)
      console.log(`批次：${progress.batches.done}/${progress.batches.total} 完成${progress.batches.failed ? `，${progress.batches.failed} 失败` : ''}`)
      console.log(`当前阶段：${stage ? `${stage.id} ${stage.name}（${stage.status}）` : '全部完成'}`)
      // 文件状态（C-24）：只印被问到的那些，不把几十个文件的清单刷屏。
      for (const rel of options.fileState) {
        const state = progress.files[rel.replace(/\\/g, '/')]
        console.log(`${rel}：${state ?? '未登记（manifest 里没有这个路径）'}`)
      }
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_PROGRESS', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
