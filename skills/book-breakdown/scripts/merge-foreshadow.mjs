// 伏笔台账的增量合并与统一重编号（B-05）。
//
// 为什么要有这个脚本：幕末记账时，agent 只该报「这一幕看到了什么伏笔」，
// 不该报编号。一旦让它自己排号，就会出现两种必然的错——
//   1) 编号撞车或跳号：多卷并行时两个批次各自从 F001 编起；
//   2) 引用悬空：卷纲/幕纲里写了「埋 F012」，而主台账重编号后 F012 变成了 F009。
// 实测就是这样：编号靠手排，引用大面积对不上。纯文本处理、零 token，交给脚本。
//
// 分工：
//   agent → 增量文件（工作/伏笔台账-卷N.md）：编号可以留空或乱写，脚本会重排；
//   脚本 → 主台账（故事底本/故事剧情/伏笔台账.md）：连续编号 + 全产物引用改写。
//
// 用法：
//   node merge-foreshadow.mjs <产物目录>              合并所有 工作/伏笔台账-卷*.md
//   node merge-foreshadow.mjs <产物目录> --dry-run     只报告将要做的改动，不落盘
//   node merge-foreshadow.mjs <产物目录> --json        输出结构化结果
// 退出码：0 成功，1 业务失败（缺台账、增量不合法），2 参数错。
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COLUMNS, ENUMS } from './contract.mjs'
import { writeFileAtomic } from './io.mjs'
import { parseRow } from './validate-output.mjs'

const LEDGER_REL = '故事底本/故事剧情/伏笔台账.md'
// 增量文件：工作/伏笔台账-卷N.md（契约的白名单已经接受这个形态）
const INCREMENT_RE = /^工作\/伏笔台账-卷(\d{1,2})\.md$/
// 编号形如 F001。旧数据里也见过 F1、F01，一并认，重排时统一成三位。
const ID_RE = /^F(\d{1,4})$/

export class UsageError extends Error {
  constructor(message, code = 'E_MERGE') { super(message); this.code = code }
}

// ---------- 表格读写 ----------

// 把一份 markdown 拆成「表前文字 / 表头 / 数据行 / 表后文字」，写回时保持原位。
// 不重排整份文件：台账前后有说明文字，整体重写会把它们挪走。
export function splitTable(text, expectColumns = COLUMNS.伏笔台账) {
  const lines = text.split(/\r?\n/)
  let headerIdx = -1
  let header = null
  for (let i = 0; i < lines.length; i += 1) {
    const cells = parseRow(lines[i])
    if (!cells) continue
    if (cells.length === expectColumns.length && cells[0] === expectColumns[0]) {
      headerIdx = i
      header = cells
      break
    }
  }
  if (headerIdx < 0) return null
  // 跳过分隔行
  let bodyStart = headerIdx + 1
  if (parseRow(lines[bodyStart])?.every((c) => /^[-: ]*$/.test(c))) bodyStart += 1
  const rows = []
  let end = bodyStart
  for (let i = bodyStart; i < lines.length; i += 1) {
    const cells = parseRow(lines[i])
    if (!cells) break
    if (cells.every((c) => /^[-: ]*$/.test(c))) { end = i + 1; continue }
    rows.push(cells)
    end = i + 1
  }
  return { lines, headerIdx, header, rows, headEnd: bodyStart, tailStart: end }
}

// 用新行替换旧数据区，其余行原样保留。
export function rebuild(text, parsed, rows) {
  const { lines, headEnd, tailStart } = parsed
  const before = lines.slice(0, headEnd)
  const after = lines.slice(tailStart)
  const formatted = rows.map((cells) => `| ${cells.join(' | ')} |`)
  return [...before, ...formatted, ...after].join('\n')
}

// 一行台账的「内容指纹」：不含编号，用于判重。
// 描述 + 埋点章 + 类型是最小可判组合：同一章埋了两件事，描述会不同；
// 同一件事被两卷各记一次，这三样会一样。
export function rowFingerprint(cells) {
  const col = (name) => cells[COLUMNS.伏笔台账.indexOf(name)] ?? ''
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ').replace(/[。，,；;]$/u, '')
  return [norm(col('描述')), norm(col('埋点章')), norm(col('类型'))].join('\u0000')
}

// ---------- 编号与引用 ----------

const idOf = (cells) => {
  const m = ID_RE.exec(String(cells[0] ?? '').trim())
  return m ? Number(m[1]) : null
}

// 主台账与增量合并：按「先主后增」的顺序保留首次出现，指纹去重，再连续重编号。
// 返回 { rows, remap: Map(旧编号 → 新编号), added, dupSkipped }
//
// 只有**主台账**的旧编号进 remap。增量文件里的编号是 agent 手排的、不可信，
// 而且会和主台账的编号撞（两卷各自从 F001 编起）——拿它去建映射，
// 会把卷纲里引用主台账 F003 的地方指到增量那条上去，是真正的错改。
// 增量的定位靠内容指纹，不靠它自己写的编号。
export function mergeRows(masterRows, incRows) {
  const seen = new Map() // fingerprint → 新编号
  const out = []
  const remap = new Map()
  let added = 0
  let dupSkipped = 0

  const push = (cells, { isNew, mapOld }) => {
    const fp = rowFingerprint(cells)
    const dup = seen.get(fp)
    if (dup !== undefined) {
      dupSkipped += 1
      // 主台账的旧编号也要能映射到已有条目，否则引用它的地方会变成悬空
      const oldId = idOf(cells)
      if (mapOld && oldId !== null && !remap.has(oldId)) remap.set(oldId, dup)
      return
    }
    const newId = out.length + 1
    seen.set(fp, newId)
    // 重编号的「改名数」按主台账的旧编号与新编号之差算
    const oldId = mapOld ? idOf(cells) : null
    if (oldId !== null && !remap.has(oldId)) remap.set(oldId, newId)
    const next = cells.slice()
    next[0] = `F${String(newId).padStart(3, '0')}`
    out.push(next)
    if (isNew) added += 1
  }

  for (const r of masterRows) push(r, { isNew: false, mapOld: true })
  for (const r of incRows) push(r, { isNew: true, mapOld: false })
  return { rows: out, remap, added, dupSkipped }
}

// 在一段文本里改写伏笔编号引用。
// 只认「独立成词」的 F 编号：F001 会改，F0010 不会（那是另一个编号），
// 嵌入在其他字母数字里的不改（避免把文件名或哈希改坏）。
// 改写结果里若出现「台账没有的新编号」就是悬空引用，单独统计出来。
export function rewriteRefs(text, remap) {
  let changed = 0
  const dangling = new Set()
  const out = text.replace(/(?<![A-Za-z0-9])F(\d{1,4})(?!\d)/g, (whole, digits) => {
    const oldId = Number(digits)
    if (!remap.has(oldId)) {
      dangling.add(whole)
      return whole
    }
    const newId = remap.get(oldId)
    const next = `F${String(newId).padStart(3, '0')}`
    if (next !== whole) changed += 1
    return next
  })
  return { text: out, changed, dangling: [...dangling] }
}

// ---------- 主流程 ----------

// 需要改写引用的产物：卷纲、幕纲、逐章记录（含分卷片段）。
async function listRefFiles(root) {
  const files = []
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (rel === '原文') continue
        await walk(join(dir, e.name), rel)
      } else if (/\.md$/.test(e.name) && rel !== LEDGER_REL) {
        files.push(rel)
      }
    }
  }
  await walk(root, '')
  return files.sort()
}

export async function mergeForeshadow({ root, dryRun = false }) {
  root = resolve(root)
  const ledgerPath = join(root, LEDGER_REL)
  if (!existsSync(ledgerPath)) throw new UsageError(`产物目录缺少伏笔台账：${LEDGER_REL}`, 'E_LEDGER')

  const ledgerText = await readFile(ledgerPath, 'utf8')
  const parsed = splitTable(ledgerText)
  if (!parsed) throw new UsageError(`伏笔台账找不到表头，或表头与契约不符（应为 ${COLUMNS.伏笔台账.length} 列）`, 'E_HEADER')

  // 收集增量
  const all = await listRefFiles(root)
  const incFiles = all.filter((rel) => INCREMENT_RE.test(rel))
  const incRows = []
  const incReport = []
  for (const rel of incFiles) {
    const text = await readFile(join(root, rel), 'utf8')
    const p = splitTable(text)
    if (!p) throw new UsageError(`增量文件表头不合契约：${rel}`, 'E_HEADER')
    let kept = 0
    for (const cells of p.rows) {
      // 全空的占位行跳过（prepare 造的骨架里带这种行）
      if (cells.every((c) => !c.trim() || c.trim() === '（待填）')) continue
      incRows.push(cells)
      kept += 1
    }
    incReport.push({ file: rel, rows: kept })
  }

  const { rows, remap, added, dupSkipped } = mergeRows(parsed.rows, incRows)
  const renamed = [...remap.entries()].filter(([o, n]) => o !== n).length
  const nextLedger = rebuild(ledgerText, parsed, rows)

  // 改写引用
  const refFiles = []
  let refChanges = 0
  const dangling = new Set()
  for (const rel of all) {
    if (rel === LEDGER_REL) continue
    const text = await readFile(join(root, rel), 'utf8')
    if (!/F\d{1,4}/.test(text)) continue
    const r = rewriteRefs(text, remap)
    for (const d of r.dangling) dangling.add(d)
    if (r.changed === 0) continue
    refChanges += r.changed
    refFiles.push({ file: rel, changed: r.changed })
    if (!dryRun) await writeFileAtomic(join(root, rel), r.text)
  }
  if (!dryRun && nextLedger !== ledgerText) await writeFileAtomic(ledgerPath, nextLedger)

  return {
    dryRun,
    ledger: LEDGER_REL,
    before: parsed.rows.length,
    after: rows.length,
    added,
    dupSkipped,
    renumbered: renamed,
    increments: incReport,
    refs: { files: refFiles, changes: refChanges, dangling: [...dangling].sort() },
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { root: null, dryRun: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (!a.startsWith('-')) out.root = a
    else throw new UsageError(`未知参数 ${a}。用法：node merge-foreshadow.mjs <产物目录> [--dry-run] [--json]`, 'E_ARGS')
  }
  if (!out.root) throw new UsageError('用法：node merge-foreshadow.mjs <产物目录> [--dry-run] [--json]', 'E_ARGS')
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_ARGS', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 2
    return
  }
  try {
    const r = await mergeForeshadow({ root: args.root, dryRun: args.dryRun })
    if (args.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: r }, null, 2))
      return
    }
    console.log(`${r.dryRun ? '（预演，未落盘）' : ''}伏笔台账：${r.before} → ${r.after} 行（新增 ${r.added}，去重 ${r.dupSkipped}，重编号 ${r.renumbered}）`)
    for (const inc of r.increments) console.log(`  增量 ${inc.file}：${inc.rows} 行`)
    if (r.refs.changes) {
      console.log(`引用改写 ${r.refs.changes} 处，涉及 ${r.refs.files.length} 个文件：`)
      for (const f of r.refs.files) console.log(`  ${f.file}：${f.changed} 处`)
    } else {
      console.log('引用无需改写')
    }
    if (r.refs.dangling.length) {
      console.log(`悬空引用 ${r.refs.dangling.length} 个（台账里没有这个编号）：${r.refs.dangling.join('、')}`)
    }
  } catch (error) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_MERGE', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
