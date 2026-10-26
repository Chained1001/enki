// 按章号确定性写「工作/逐章记录.md」的行，替代让 agent 读整表再改。
//
// 为什么要有这个脚本：逐章记录是一行一章的长表，1000 章的书约 15 万字。
// 若每批（≤20 章）都读整表再替换「（待填）」，50 批共读 50 次同一张表——
// 实测约 4.7M tokens 全花在重复读表上（占总输入的 71%）。
// 本脚本只改目标章号对应的行，agent 无需读表，也不存在「改错行」的可能。
//
// 只写 agent 负责的 12 列：视角人物/地点/出场人物/一句话事件/剧情线/伏笔埋收/情绪/章末钩型/爽点强度/爽点类型/故事内时间/章首句。
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
  ['爽点强度', '爽点强度'],
  ['爽点类型', '爽点类型'],
  ['故事内时间', '故事内时间'],
  ['章首句', '章首句'],
]

// 枚举约束：写在表里就让 agent 自己查，脚本再兜一层。
const ENUM_FIELDS = [
  ['情绪', '情绪'],
  ['章末钩型', '钩型'],
  ['爽点强度', '爽点强度'],
  ['爽点类型', '爽点类型'],
]

const PLACEHOLDER = '（待填）'

// 第 0 章（有前言时 prepare 把前言记为 0）是非叙事行，模板明写「情绪可空」。
// 这里只放行这一个字段：其余八列仍须填写，泛化到「整行可空」等于放弃校验。
const NON_NARRATIVE_OPTIONAL = ['情绪']

class RowError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// 核心纯函数：给定表行与一批取值，返回新表行。不碰 IO，便于单测。
export function applyRows(lines, entries, { partial = false, enums = ENUMS, collectAll = false } = {}) {
  const cols = tableColumns('逐章记录')
  const headerIdx = cols.map((c) => c)
  const rows = []
  const byChapter = new Map()

  // 收集模式（C-26）：一次跑完把所有错都报出来，而不是首错即停。
  // 为什么重要：一批 20 章，若首错即停，人改完第一条再跑、又报第二条，改 10 处要跑 10 轮。
  // 而且每轮都得重读整表——正是这个脚本存在的理由（读表成本占输入 71%）。
  // 默认 false：单条写入场景下首错即停更快，也避免把「后面全错」刷满屏。
  const errors = []
  const record = (code, message) => {
    if (!collectAll) throw new RowError(code, message)
    errors.push(new RowError(code, message))
  }

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
    if (!Number.isInteger(no) || no < 0) {
      record('E_CHAPTER', `章号「${e.章号}」不是非负整数`)
      continue // 章号都不合法，后面的检查（查行、查字段）对它没有意义，跳过以免重复报同一件事
    }
    if (seen.has(no)) record('E_DUP', `输入里章号 ${no} 重复`)
    seen.add(no)
    if (!byChapter.has(no)) {
      record('E_CHAPTER', `逐章记录里没有第 ${no} 章的行`)
      continue // 没有这一行，字段检查无从谈起
    }
    for (const [key] of FIELDS) {
      const has = e[key] !== undefined && e[key] !== null && String(e[key]).trim() !== ''
      if (!has) {
        // 前言/扉页这类非叙事行（prepare 记为第 0 章）没有情绪可言，模板明写「情绪可空」。
        // 原先 9 个字段一律必填，导致有前言的书第 0 章那一行照模板填一定报 E_FIELD。
        if (no === 0 && NON_NARRATIVE_OPTIONAL.includes(key)) continue
        // 「爽点类型」的性质是条件必填：爽点强度为「无」时无类型可填。
        // 若把它的缺失一律放行，等于给所有行开了个洞；只在这一种组合下放行。
        if (key === '爽点类型' && String(e.爽点强度 ?? '').trim() === '无') continue
        if (partial) continue
        record('E_FIELD', `第 ${no} 章缺字段「${key}」（要只补部分列请加 --partial）`)
        continue
      }
      const v = String(e[key]).trim()
      if (v === PLACEHOLDER) record('E_FIELD', `第 ${no} 章的「${key}」仍是占位符「${PLACEHOLDER}」，不算填写`)
      else if (v.includes('|')) record('E_FIELD', `第 ${no} 章的「${key}」含竖线，会撑裂表格；请改用全角「｜」或去掉`)
      else if (v.includes('\n')) record('E_FIELD', `第 ${no} 章的「${key}」含换行`)
    }
    for (const [key, enumName] of ENUM_FIELDS) {
      const v = e[key] === undefined || e[key] === null ? '' : String(e[key]).trim()
      if (!v) continue
      const allowed = enums[enumName]
      if (allowed && !allowed.includes(v)) {
        record('E_ENUM', `第 ${no} 章的「${key}」为「${v}」，不在枚举内（${allowed.join('、')}）`)
      }
    }
  }

  // 收集模式下只要有一条错就整体放弃：返回 errors 而不是半个结果，
  // 否则调用方可能拿一份「部分行已改」的表格去写盘。
  if (errors.length) return { lines, updated: 0, total: entries.length, errors }

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

  return { lines: out, updated, total: entries.length, errors: [] }
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
    console.error('条目格式：[{"章号":1,"视角人物":"…","地点":"…","出场人物":"…","一句话事件":"…","剧情线":"主线","伏笔埋收":"埋：…","情绪":"扬","章末钩型":"悬念","爽点强度":"小","爽点类型":"逆袭"}]')
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
    // --dry-run 走收集模式（C-26）：一次把全部错报出来。
    // 这条路径本来就是「先预演一遍看有没有问题」，只报第一条等于让人改一条跑一次。
    result = applyRows(lines, entries, { partial: args.partial, collectAll: args.dryRun })
  } catch (error) {
    if (error instanceof RowError) {
      if (args.json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }))
      else console.error(`${error.code}：${error.message}`)
      process.exit(1)
    }
    throw error
  }

  // 收集模式下有错：整体放弃，不写盘，把所有错列出来。
  if (result.errors?.length) {
    if (args.json) {
      console.log(JSON.stringify({
        ok: false,
        dryRun: args.dryRun,
        count: result.errors.length,
        errors: result.errors.map((e) => ({ code: e.code, message: e.message })),
      }))
    } else {
      console.error(`发现 ${result.errors.length} 处问题（本次未写入任何行）：`)
      for (const e of result.errors) console.error(`  ${e.code}：${e.message}`)
    }
    process.exit(1)
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
