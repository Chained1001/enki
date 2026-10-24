// 从「工作/逐章记录.md」生成实体→章号索引，供阶段 5 定位取证范围。
//
// 为什么要有这个脚本：阶段 5 要给每个实体（人物/势力/地点/物品/概念）建卡，
// 卡片要写出处引句就得回到原文找章。若靠 agent 逐章翻，一本 1000 章的书
// 要为每个实体重扫一遍全书，成本高到不可行（实测阶段 5 约占总 token 的一半）。
// 逐章记录的「出场人物/地点/视角人物」三列已经记了每章有谁，本脚本把这张表
// 反转成「某实体出现在哪些章」，纯文本处理、零 token。
//
// 输出默认走 stdout（不写盘）。理由：PRD 规定 工作/ 只有三个文件（manifest、
// 别名词典、逐章记录），新增文件会与产物结构契约冲突。需要落盘时显式 --out。
//
// 用法：
//   node entity-index.mjs <产物目录> --list [--top N]   列出实体与出现次数（紧凑）
//   node entity-index.mjs <产物目录> --entity 张三       查单个实体的章号
//   node entity-index.mjs <产物目录> --json             输出全量 JSON
//   node entity-index.mjs <产物目录> --out 路径.json    落盘
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tableColumns } from './contract.mjs'
import { writeFileAtomic } from './io.mjs'
import { parseRow } from './validate-output.mjs'

const PLACEHOLDER = '（待填）'

// 空值记号：这些值不是实体，是「本格没有内容」的占位写法。
// 龙族3 实测：章 0 是题记，视角写「（无人称叙述）」、地点写「无」，
// 二者都被当成实体进了索引（多出两个只出现 1 章的假实体），
// 与龙族2 那次「（提及）」后缀造假实体是同一类问题。
// 判据：全角/半角括号包裹的说明性短语，或单字「无」——它们不可能是人物/地点名。
const EMPTY_MARKS = new Set([
  PLACEHOLDER, '无', '（无）', '(无)', '（无人称叙述）', '(无人称叙述)',
  '（未出场）', '（提及）', '—', '——', '-',
])

export function isEmptyMark(s) {
  const t = String(s ?? '').trim()
  if (!t) return true
  if (EMPTY_MARKS.has(t)) return true
  // 形如「（…叙述）」「（全知视角）」这类纯说明：整格被一对括号包住且不含分隔符
  if (/^[（(][^（()）]{1,12}[）)]$/.test(t) && !/[、，,／/；;]/.test(t)) return true
  return false
}

// 把一格「出场人物」拆成实体名。分隔符：顿号、逗号、斜杠、分号。
// 「多视角（甲／乙）」这类写法先去壳再拆，避免把「多视角」当人名。
//
// 括号里的分隔符不算分隔符：真书实测《长安的荔枝》写过
// 「长安至广州（灞桥、商州道、鄱阳湖、梅关、广州）」，是「一条路线 + 五个途经点」，
// 旧实现把括号内的顿号也当分隔，切出「长安至广州（灞桥」和「广州）」两个假实体，
// 地名索引因此多出 4 行脏数据。现在只在括号外拆，括号内整体保留。
export function splitEntities(cell) {
  if (!cell) return []
  let s = String(cell).trim()
  if (!s || s === PLACEHOLDER) return []
  if (isEmptyMark(s)) return []
  // 去「多视角（…）」外壳，保留括号里的名字
  const wrapped = /^多视角[（(](.+)[）)]$/.exec(s)
  if (wrapped) s = wrapped[1]
  return splitTopLevel(s)
}

// 只按「括号外」的分隔符切分；括号内的分隔符不算，括号随名字保留。
export function splitTopLevel(s) {
  const out = []
  let buf = ''
  let depth = 0
  for (const ch of String(s)) {
    const isOpen = ch === '（' || ch === '('
    const isClose = ch === '）' || ch === ')'
    if (isOpen) depth += 1
    else if (isClose) depth = Math.max(0, depth - 1)

    // 括号外的分隔符：收一段
    if (depth === 0 && !isClose && /[、，,／/;；]/.test(ch)) {
      const seg = buf.trim()
      if (seg) out.push(seg)
      buf = ''
      continue
    }
    buf += ch
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out.map((x) => x.trim()).filter((x) => x && x !== PLACEHOLDER)
}

// 纯函数：给定表行，返回 { 实体名 → {类型, 章号[], 首现章, 末次章} }
export function buildIndex(lines) {
  const cols = tableColumns('逐章记录')
  const iNo = cols.indexOf('全局章号')
  const iPov = cols.indexOf('视角人物')
  const iPlace = cols.indexOf('地点')
  const iCast = cols.indexOf('出场人物')

  const index = new Map()
  let headerSeen = false
  let chapters = 0
  let pending = 0

  for (const line of lines) {
    const cells = parseRow(line)
    if (!cells) continue
    if (!headerSeen) {
      if (cells.length === cols.length && cells[iNo] === '全局章号') headerSeen = true
      continue
    }
    if (/^[-: ]+$/.test(cells[iNo] ?? '')) continue
    const no = Number(cells[iNo])
    if (!Number.isFinite(no)) continue
    chapters += 1

    // 该行是否已填（未填的行不参与索引，避免把「（待填）」当实体）
    const filled = [cells[iPov], cells[iPlace], cells[iCast]].some(
      (c) => c && c !== PLACEHOLDER,
    )
    if (!filled) {
      pending += 1
      continue
    }

    const add = (name, type) => {
      if (!name || name === PLACEHOLDER) return
      let e = index.get(name)
      if (!e) {
        e = { 名称: name, 类型: type, 章号: [], 首现章: no, 末次章: no }
        index.set(name, e)
      }
      if (!e.章号.includes(no)) e.章号.push(no)
      if (no < e.首现章) e.首现章 = no
      if (no > e.末次章) e.末次章 = no
    }

    for (const n of splitEntities(cells[iPov])) add(n, '人物')
    for (const n of splitEntities(cells[iPlace])) add(n, '地点')
    for (const n of splitEntities(cells[iCast])) add(n, '人物')
  }

  for (const e of index.values()) e.章号.sort((a, b) => a - b)
  return { index, chapters, pending, headerSeen }
}

// 采样建议：给一个实体的章号，挑出最值得读原文的几章（首现/末次/中段/高光）。
// 阶段 5 的卡片只该读这几章，不该读该实体的全部出场章——主角可能出现在 600 章里。
export function sampleChapters(list, max = 4) {
  if (list.length <= max) return list.slice()
  const picked = new Set()
  picked.add(list[0]) // 首现：定义与初登场描写
  picked.add(list[list.length - 1]) // 末次：结局状态
  // 中段均匀取，补足 max
  const rest = max - picked.size
  for (let k = 1; k <= rest; k += 1) {
    picked.add(list[Math.floor((list.length * k) / (rest + 1))])
  }
  return [...picked].sort((a, b) => a - b)
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { dir: null, list: false, entity: null, json: false, out: null, top: 50 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--list') out.list = true
    else if (a === '--entity') out.entity = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--top') out.top = Number(argv[++i])
    else if (!a.startsWith('-')) out.dir = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir) {
    console.error('用法：node entity-index.mjs <产物目录> [--list [--top N]] [--entity 名称] [--json] [--out 路径]')
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

  const { index, chapters, pending, headerSeen } = buildIndex(raw.split(/\r?\n/))
  if (!headerSeen) {
    console.error('未找到逐章记录表头（须与 contract 的列名逐字一致）')
    process.exit(1)
  }
  if (pending === chapters) {
    console.error(`逐章记录 ${chapters} 行全是占位符，尚未填写；请先完成阶段 4`)
    process.exit(1)
  }

  const all = [...index.values()].sort((a, b) => b.章号.length - a.章号.length || a.首现章 - b.首现章)

  if (args.entity) {
    const e = index.get(args.entity)
    if (!e) {
      const near = all.filter((x) => x.名称.includes(args.entity) || args.entity.includes(x.名称)).slice(0, 5)
      console.error(`索引里没有「${args.entity}」${near.length ? `；相近的有：${near.map((x) => x.名称).join('、')}` : ''}`)
      process.exit(1)
    }
    console.log(`${e.名称}（${e.类型}）：出现 ${e.章号.length} 章，首现第 ${e.首现章} 章，末次第 ${e.末次章} 章`)
    console.log(`全部出场章：${e.章号.join(', ')}`)
    console.log(`建议取证章（≤4 章，够建卡）：${sampleChapters(e.章号).join(', ')}`)
    return
  }

  if (args.list) {
    console.log(`实体 ${all.length} 个（已填 ${chapters - pending} 章 / 共 ${chapters} 章；未填 ${pending} 章不参与索引）`)
    console.log('')
    console.log('| 实体 | 类型 | 出现章数 | 首现章 | 末次章 |')
    console.log('|---|---|---|---|---|')
    for (const e of all.slice(0, args.top)) {
      console.log(`| ${e.名称} | ${e.类型} | ${e.章号.length} | ${e.首现章} | ${e.末次章} |`)
    }
    if (all.length > args.top) console.log(`\n（只显示前 ${args.top} 个，用 --top N 调整）`)
    return
  }

  if (args.json || args.out) {
    const payload = {
      章节数: chapters,
      未填章数: pending,
      实体数: index.size,
      实体: all.map((e) => ({ ...e, 建议取证章: sampleChapters(e.章号) })),
    }
    const text = JSON.stringify(payload, null, 1)
    if (args.out) {
      await writeFileAtomic(args.out, `${text}\n`)
      console.log(`已写出 ${args.out}（实体 ${index.size} 个）`)
    } else {
      console.log(text)
    }
    return
  }

  console.log(`章节 ${chapters} 行（未填 ${pending} 行）｜实体 ${index.size} 个`)
  console.log('用 --list 看全部、--entity 名称 查单个、--json 取全量')
}

// 仅在直接执行时跑 CLI；被 import（测试）时只导出纯函数。
// 防空：node -e 等场景下 process.argv[1] 为 undefined，直接传给 pathToFileURL 会抛错。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
