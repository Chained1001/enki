// 快速模式对账（C-12、C-28）。
//
// 原先 04 的三项核对全是纯心算：摘要行数＝章节数、要素首现章在区间内、各章字数之和＝总字数。
// 三项都是确定性算术，却由 agent 算完写进对话——算错了没人知道，产物里也看不出是数是猜。
//
// 这里做成脚本，输入是「报告文件 + 源码文件（或 prepare 的 dry-run 结果）」，
// 输出是一张对账表 + 退出码。agent 只负责转述，不负责算。
//
// 口径对齐 validate-output 的 E_ROW_COUNT / E_CHARCOUNT：
//   - 行数对不上是错误（少一行就是少一章的摘要）
//   - 字数对不上也是错误（差值来自漏章或错切）
// 但快速模式不落逐章记录，所以这里核的是「报告里的摘要行」与「detectChapters 的章数」。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COLUMNS, THRESHOLDS } from './contract.mjs'
import { parseRow } from './validate-output.mjs'

export const SUMMARY_MAX = 60

const 元素 = new Set(['人物', '设定', '情节线', '技法'])
// 摘要表的三列不在 COLUMNS 里（它不是「要素表」，没有 E_COLUMN 契约），
// 就写在这里当唯一来源，模板与脚本都对齐它。
const SUMMARY_COLS = ['序号', '标题', '摘要']

// 从报告文本里取出四张要素表的行与摘要表的行。纯函数，便于单测。
export function parseReport(text) {
  const lines = text.split(/\r?\n/)
  const summaryHeader = SUMMARY_COLS
  const out = { summary: [], elements: { 人物: [], 设定: [], 情节线: [], 技法: [] }, meta: {} }

  // 书名 / 总字数 / 章节数：报告头部的「- 键：值」行
  for (const line of lines) {
    const m = /^-\s*(书名|总字数|章节数)[：:]\s*(.*)$/.exec(line.trim())
    if (m) out.meta[m[1]] = m[2].trim()
  }

  let section = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (h) { section = h[1]; continue }
    if (!section) continue

    if (section === '章节摘要' && !out._summaryHeaderSeen) {
      const cells = parseRow(line)
      if (cells && cells.length === summaryHeader.length) { out._summaryHeaderSeen = true; continue }
    }
    if (section === '章节摘要' && out._summaryHeaderSeen) {
      const cells = parseRow(line)
      if (!cells) continue
      if (/^[-: ]+$/.test(cells[0].replace(/\|/g, ''))) continue
      out.summary.push({ 序号: cells[0], 标题: cells[1], 摘要: cells[2] })
      continue
    }
    if (元素.has(section)) {
      const expect = COLUMNS[`报告_${section}`]
      if (!out._elHeaderSeen?.[section]) {
        const cells = parseRow(line)
        if (cells && cells.join('|') === expect.join('|')) {
          out._elHeaderSeen ??= {}
          out._elHeaderSeen[section] = true
          continue
        }
      }
      if (out._elHeaderSeen?.[section]) {
        const cells = parseRow(line)
        if (!cells) continue
        if (/^[-: ]+$/.test(cells[0].replace(/\|/g, ''))) continue
        out.elements[section].push({ 名: cells[0], 说明: cells[1], 首现: cells[2] })
      }
    }
  }
  return out
}

// 对账主体。chapters 是 detectChapters 的结果（只用到 no 与 chars）。
export function reconcile(report, chapters, opts = {}) {
  const rows = []
  const add = (item, expect, actual, ok, note = '') => rows.push({ 项: item, 期望: String(expect), 实际: String(actual), 结论: ok ? '对得上' : '对不上', note })

  // ① 摘要行数 = 章节数
  const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
  add('摘要行数', units.length, report.summary.length, units.length === report.summary.length)

  // ② 摘要长度：超过 60 字的行数（C-28）。02 要求「不超过 60 字」，此前没有任何校验。
  const tooLong = report.summary.filter((r) => [...String(r.摘要 ?? '').trim()].length > SUMMARY_MAX)
  add(`摘要超 ${SUMMARY_MAX} 字行数`, 0, tooLong.length, tooLong.length === 0,
    tooLong.slice(0, 3).map((r) => `第${r.序号}章`).join('、'))

  // ③ 无法摘要行数（C-28）。02 允许写「无法摘要」但要记原因；
  // 这不是错误，但要让人看见有多少章写不出来——写多了说明这本书的章节切分或原文有问题。
  const unable = report.summary.filter((r) => /^无法摘要$/.test(String(r.摘要 ?? '').trim()))
  add('无法摘要行数', '—', unable.length, true, unable.slice(0, 3).map((r) => `第${r.序号}章`).join('、'))

  // ④ 要素首现章落在 1..章节数 之间
  const maxNo = Math.max(0, ...units.map((c) => c.no))
  const bad = []
  for (const [kind, list] of Object.entries(report.elements)) {
    for (const row of list) {
      const n = Number(String(row.首现).trim())
      if (!Number.isInteger(n) || n < 1 || n > maxNo) bad.push(`${kind}·${row.名}（首现=${row.首现}）`)
    }
  }
  const totalEl = Object.values(report.elements).reduce((s, l) => s + l.length, 0)
  add('要素首现章越界', 0, bad.length, bad.length === 0, bad.slice(0, 3).join('、'))

  // ⑤ 各章字数之和 = 总字数
  const sum = units.reduce((s, c) => s + (c.chars ?? 0), 0)
  const declared = Number(String(report.meta.总字数 ?? '').replace(/[^\d]/g, '')) || null
  if (declared === null) {
    add('各章字数和＝总字数', sum, '报告未写总字数', false, '报告头部的「总字数」缺失或非数字')
  } else {
    add('各章字数和＝总字数', declared, sum, declared === sum)
  }

  // ok 只看「结论」一列，不再额外排除任何行。
  //
  // 原先这里写的是 `r.结论 === '对得上' || r.项 === '无法摘要行数'`，那个例外是死代码：
  // 「无法摘要行数」这行的结论写死为「对得上」（它只计数、不判失败），every 根本碰不到它。
  // 变异测试显示删掉那个例外也不变红，正说明它不起作用——留着只会让下一个人以为
  // 「无法摘要」在某个分支里会被判失败，进而去别处找那个分支。
  return { rows, totalElements: totalEl, ok: rows.every((r) => r.结论 === '对得上') }
}

export function humanTable(result) {
  const head = '| 项 | 期望 | 实际 | 结论 |'
  const sep = '| --- | --- | --- | --- |'
  const body = result.rows.map((r) => `| ${r.项} | ${r.期望} | ${r.实际} | ${r.结论}${r.note ? `（${r.note}）` : ''} |`)
  return [head, sep, ...body].join('\n')
}

// ---------- CLI ----------

const USAGE = '用法：reconcile.mjs <报告文件> --source <小说 txt> [--json] [--help]\n' +
  '      各章字数之和需要切章结果，所以必须给 --source（跑 detectChapters，与 prepare 同一口径）。'

class CliError extends Error {
  constructor(message, code = 'E_ARGS') {
    super(message)
    this.code = code
  }
}

// --json 声明后，成功与失败都只输出一个 { ok, errors, data } 对象（规范 02「接口」）。
// data 保留原字段；非 --json 路径的默认输出保持原样。
function emitFailure({ code, message, data = {}, exitCode = 1, json = false, withCode = true }) {
  if (json) {
    console.log(JSON.stringify({ ok: false, errors: [{ code, file: '', message }], data }, null, 2))
  } else {
    console.error(withCode ? `${code}：${message}` : message)
  }
  process.exitCode = exitCode
}

function parseArgs(argv) {
  const out = { report: null, source: null, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--source') {
      out.source = argv[++i]
      if (!out.source) throw new CliError(`--source 缺少取值。\n${USAGE}`)
    } else if (a.startsWith('-')) throw new CliError(`未知参数「${a}」。\n${USAGE}`)
    else if (out.report === null) out.report = a
    else throw new CliError(`多余的参数「${a}」。\n${USAGE}`)
  }
  if (!out.help && !out.report) throw new CliError(USAGE)
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    emitFailure({
      code: error.code ?? 'E_ARGS',
      message: error.message,
      exitCode: 2,
      json: process.argv.includes('--json'),
      withCode: false,
    })
    return
  }
  if (args.help) {
    console.log(USAGE)
    return
  }

  if (!existsSync(args.report)) {
    emitFailure({
      code: 'E_FILE',
      message: `E_FILE：读不到报告「${args.report}」。\n快速模式未指定输出路径时报告只在对话里，没有文件可核——先让用户确认报告已落盘。`,
      json: args.json,
      withCode: false,
    })
    return
  }
  if (!args.source) {
    emitFailure({
      code: 'E_ARGS',
      message: `E_ARGS：缺 --source。各章字数之和要跑 detectChapters 才能算，不能从报告里推。\n${USAGE}`,
      exitCode: 2,
      json: args.json,
      withCode: false,
    })
    return
  }

  let text
  let src
  try {
    text = await readFile(args.report, 'utf8')
    src = await readFile(args.source, 'utf8')
  } catch (error) {
    emitFailure({ code: 'E_FILE', message: error.message, json: args.json, withCode: false })
    return
  }
  const { detectChapters } = await import('./prepare.mjs')
  const chapters = detectChapters(src)

  const report = parseReport(text)
  const result = reconcile(report, chapters)
  if (args.json) {
    // 对不上的项是「对账发现」，原样留在 data.rows 里（每行带结论），不另造错误码。
    console.log(JSON.stringify({
      ok: result.ok,
      errors: [],
      data: { rows: result.rows, totalElements: result.totalElements },
    }, null, 2))
  } else {
    console.log(humanTable(result))
  }
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
