// 按章号确定性写「工作/逐章记录.md」的行，替代让 agent 读整表再改。
//
// 为什么要有这个脚本：逐章记录是一行一章的长表，1000 章的书约 15 万字。
// 若每批（≤20 章）都读整表再替换「（待填）」，50 批共读 50 次同一张表——
// 实测约 4.7M tokens 全花在重复读表上（占总输入的 71%）。
// 本脚本只改目标章号对应的行，agent 无需读表，也不存在「改错行」的可能。
//
// 只写 agent 负责的 9 列：视角人物/地点/出场人物/一句话事件/剧情线/伏笔埋收/情绪/章末钩型/爽点标记。
// 全局章号、标题、章字数三列由 prepare 写好，本脚本不碰（改了会被 E_CHARCOUNT 判错）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENUMS, tableColumns } from './contract.mjs'
import { writeFileAtomic } from './io.mjs'
import { parseRow } from './validate-output.mjs'

// JSON 键 → 表头列名。表头里「伏笔埋/收」含斜杠，JSON 用「伏笔埋收」更好写。
const FIELDS = [
  ['视角人物', '视角人物'],
  ['地点', '地点'],
  ['出场人物', '出场人物'],
  ['一句话事件', '一句话事件'],
  ['剧情线', '剧情线'],
  ['伏笔埋收', '伏笔埋/收'],
  ['情绪', '情绪'],
  ['章末钩型', '章末钩型'],
  ['爽点标记', '爽点标记'],
]

// 枚举约束：写在表里就让 agent 自己查，脚本再兜一层。
const ENUM_FIELDS = [
  ['情绪', '情绪'],
  ['章末钩型', '钩型'],
  ['爽点标记', '爽点标记'],
]

const PLACEHOLDER = '（待填）'

class RowError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// 核心纯函数：给定表行与一批取值，返回新表行。不碰 IO，便于单测。
export function applyRows(lines, entries, { partial = false, enums = ENUMS } = {}) {
  const cols = tableColumns('逐章记录')
  const headerIdx = cols.map((c) => c)
  const rows = []
  const byChapter = new Map()

  // 定位表头与数据行
  let headerLine = -1
  lines.forEach((line, i) => {
    const cells = parseRow(line)
    if (!cells) return
    if (headerLine < 0 && cells.length === cols.length && cells.every((c, k) => c === headerIdx[k])) {
      headerLine = i
      return
    }
    if (headerLine < 0 || i <= headerLine) return
    if (/^[-: ]+$/.test(cells[0].replace(/\|/g, ''))) return
    rows.push({ line: i, cells })
    const no = Number(cells[cols.indexOf('全局章号')])
    if (Number.isFinite(no)) byChapter.set(no, rows[rows.length - 1])
  })

  if (headerLine < 0) throw new RowError('E_HEADER', '未找到逐章记录表头（须与 contract 的列名逐字一致）')

  // 校验输入
  const seen = new Set()
  for (const e of entries) {
    const no = Number(e.章号)
    // 章号 0 是合法的：prepare 在有前言时把前言记为 0、正文从 1 起。
    // 只禁负数与非整数（曾写成 no < 1，导致「有前言的书」前言那行永远写不进去）。
    if (!Number.isInteger(no) || no < 0) throw new RowError('E_CHAPTER', `章号「${e.章号}」不是非负整数`)
    if (seen.has(no)) throw new RowError('E_DUP', `输入里章号 ${no} 重复`)
    seen.add(no)
    if (!byChapter.has(no)) throw new RowError('E_CHAPTER', `逐章记录里没有第 ${no} 章的行`)
    for (const [key] of FIELDS) {
      const has = e[key] !== undefined && e[key] !== null && String(e[key]).trim() !== ''
      if (!has) {
        if (partial) continue
        throw new RowError('E_FIELD', `第 ${no} 章缺字段「${key}」（要只补部分列请加 --partial）`)
      }
      const v = String(e[key]).trim()
      if (v === PLACEHOLDER) throw new RowError('E_FIELD', `第 ${no} 章的「${key}」仍是占位符「${PLACEHOLDER}」，不算填写`)
      if (v.includes('|')) throw new RowError('E_FIELD', `第 ${no} 章的「${key}」含竖线，会撑裂表格；请改用全角「｜」或去掉`)
      if (v.includes('\n')) throw new RowError('E_FIELD', `第 ${no} 章的「${key}」含换行`)
    }
    for (const [key, enumName] of ENUM_FIELDS) {
      const v = e[key] === undefined || e[key] === null ? '' : String(e[key]).trim()
      if (!v) continue
      const allowed = enums[enumName]
      if (allowed && !allowed.includes(v)) {
        throw new RowError('E_ENUM', `第 ${no} 章的「${key}」为「${v}」，不在枚举内（${allowed.join('、')}）`)
      }
    }
  }

  // 改写目标行
  let updated = 0
  const out = lines.slice()
  for (const e of entries) {
    const no = Number(e.章号)
    const target = byChapter.get(no)
    const cells = target.cells.slice()
    let changed = false
    for (const [key, colName] of FIELDS) {
      const v = e[key] === undefined || e[key] === null ? '' : String(e[key]).trim()
      if (!v) continue
      const idx = cols.indexOf(colName)
      if (idx < 0) throw new RowError('E_HEADER', `contract 的逐章记录缺列「${colName}」`)
      if (cells[idx] !== v) changed = true
      cells[idx] = v
    }
    if (!changed) continue
    out[target.line] = `| ${cells.join(' | ')} |`
    updated += 1
  }

  return { lines: out, updated, total: entries.length }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { dir: null, rows: null, partial: false, dryRun: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--rows') out.rows = argv[++i]
    else if (a === '--partial') out.partial = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (!a.startsWith('-')) out.dir = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir || !args.rows) {
    console.error('用法：node write-rows.mjs <产物目录> --rows <条目.json> [--partial] [--dry-run] [--json]')
    console.error('条目格式：[{"章号":1,"视角人物":"…","地点":"…","出场人物":"…","一句话事件":"…","剧情线":"主线","伏笔埋收":"埋：…","情绪":"扬","章末钩型":"悬念","爽点标记":"小"}]')
    process.exit(2)
  }

  const file = join(args.dir, '工作', '逐章记录.md')
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    console.error(`逐章记录不可读（${file}）：${error.message}`)
    process.exit(1)
  }
  let entries
  try {
    entries = JSON.parse(await readFile(args.rows, 'utf8'))
  } catch (error) {
    console.error(`条目文件不可读或不是合法 JSON（${args.rows}）：${error.message}`)
    process.exit(1)
  }
  if (!Array.isArray(entries)) {
    console.error('条目文件应为数组')
    process.exit(1)
  }

  const lines = raw.split(/\r?\n/)
  let result
  try {
    result = applyRows(lines, entries, { partial: args.partial })
  } catch (error) {
    if (error instanceof RowError) {
      if (args.json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }))
      else console.error(`${error.code}：${error.message}`)
      process.exit(1)
    }
    throw error
  }

  if (!args.dryRun && result.updated > 0) {
    await writeFileAtomic(file, result.lines.join('\n'))
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, updated: result.updated, total: result.total, dryRun: args.dryRun }))
  } else {
    const verb = args.dryRun ? '将更新' : '已更新'
    console.log(`${verb} ${result.updated} 行（提交 ${result.total} 行，其中 ${result.total - result.updated} 行内容未变）`)
  }
}

// 仅在直接执行时跑 CLI；被 import（测试）时只导出纯函数。
// 防空：node -e 等场景下 process.argv[1] 为 undefined，直接传给 pathToFileURL 会抛错。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
