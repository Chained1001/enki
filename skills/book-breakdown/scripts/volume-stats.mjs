// 卷级派生统计：从「工作/逐章记录.md」算出三条只能脚本算的卷级指标。
//
// 为什么要有这个脚本（C-01/C-02/C-03 派生）：
// 这三项原来都靠 agent 手算——每卷爽点章数、钩型分布、最大连续同型钩。
// 手算的问题是**没有正确答案可对照**：agent 数错了没人知道，产物里也看不出是数是猜。
// 而它们全都是「逐章记录里现成的列 + 一次分组统计」，脚本能算得比人准且免费。
//
// 与 D-23（章字数由 prepare 填）同款逻辑：能脚本算的列不让 agent 填。
//
// 口径上的三个决定：
//   ① 爽点与钩型都只认枚举内取值。手写的「大爽点」「危机钩」这类变体不计入，
//      但会在结果里报出来——静默丢弃会让统计看起来「干净」，而问题其实在别处。
//   ② 连续同型钩只数**同一卷内**的连续章。跨卷的连续性没有叙事意义：
//      卷末本来就该和卷首钩型相同（都是悬念），那是结构不是拖。
//   ③ 中位数用在「中爽点之间的间隔」上而不是均值：间隔分布长尾（连着几章无爽点、
//      然后一章大爽点）会把均值拉得没有代表性。偶数个间隔取中间两个的均值。
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENUMS, tableColumns } from './contract.mjs'
import { parseRow } from './validate-output.mjs'

const PLACEHOLDER = '（待填）'
// 「有爽点」的定义：强度不是「无」。小／中／大都算一次爽点投放。
const NO_SHARP = '无'

// 密度转百分比字符串。分卷总表那一列与 humanReport 共用，避免两处各留几位小数。
export function pct(ratio) {
  if (ratio === null || ratio === undefined) return ''
  return (ratio * 100).toFixed(1)
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// 纯函数：给定逐章记录的表格行与卷区间，返回每卷的派生统计。不碰 IO，便于单测。
export function computeVolumeStats(rows, { volumes = [] } = {}) {
  const cols = tableColumns('逐章记录')
  const idx = (name) => cols.indexOf(name)
  const iNo = idx('全局章号')
  const iHook = idx('章末钩型')
  const iSharp = idx('爽点强度')
  const iSharpType = idx('爽点类型')

  const chapters = []
  const offEnum = { 钩型: [], 爽点强度: [], 爽点类型: [] }
  for (const cells of rows) {
    const no = Number(cells[iNo])
    if (!Number.isFinite(no)) continue
    // 占位符按**字段**判，不按行判（C-03 修）。
    //
    // 原来是 `if (hook === PLACEHOLDER || sharp === PLACEHOLDER) continue`——任意一列还是占位
    // 就把整行丢掉。但 agent 是逐列填的：很可能爽点强度填了、章末钩型还没填，
    // 那一章就被整行跳过，于是**密度分母漏算这一章**，而产物上看不出少了。
    // 现在每列各自把占位当空：占位不算非法取值，也不阻止这一章参与别的列的统计。
    const raw = (name) => {
      const v = String(cells[name] ?? '').trim()
      return v === PLACEHOLDER || v.includes('待填') ? '' : v
    }
    const hook = raw(iHook)
    const sharp = raw(iSharp)
    const sharpType = raw(iSharpType)
    // 三列都空才是「这一行还没开始填」，整行跳过。
    if (!hook && !sharp && !sharpType) continue

    // 不在枚举内的值不算数，但要记下来报给用户——静默丢弃等于把数据问题藏起来。
    if (hook && !ENUMS.钩型.includes(hook)) offEnum.钩型.push({ no, value: hook })
    if (sharp && !ENUMS.爽点强度.includes(sharp)) offEnum.爽点强度.push({ no, value: sharp })
    if (sharpType && !ENUMS.爽点类型.includes(sharpType)) offEnum.爽点类型.push({ no, value: sharpType })

    chapters.push({
      no,
      hook: ENUMS.钩型.includes(hook) ? hook : null,
      sharp: ENUMS.爽点强度.includes(sharp) ? sharp : null,
      sharpType: ENUMS.爽点类型.includes(sharpType) ? sharpType : null,
    })
  }
  chapters.sort((a, b) => a.no - b.no)

  // 卷区间：没有 manifest 卷信息时整本当一卷（单卷书与出版书都是这种形态）。
  const spans = volumes.length
    ? volumes.map((v) => ({ no: v.no, name: v.name, start: v.startCh, end: v.endCh }))
    : [{ no: 1, name: '全书', start: -Infinity, end: Infinity }]

  const perVolume = spans.map((span) => {
    const inVol = chapters.filter((c) => c.no >= span.start && c.no <= span.end)

    // ① 爽点：有爽点的章数与间隔中位数
    const sharpChs = inVol.filter((c) => c.sharp && c.sharp !== NO_SHARP).map((c) => c.no)
    const gaps = []
    for (let i = 1; i < sharpChs.length; i += 1) gaps.push(sharpChs[i] - sharpChs[i - 1])

    // ② 钩型分布：按出现章数，降序
    //
    // 数量相同时按契约枚举顺序排，不用拼音/字典序：拼音序依赖运行环境的 ICU 数据，
    // 换个 Node 版本可能变，而「同数时谁在前」会直接改变产物里的文字。
    // 枚举顺序是人定的（危机→悬念→期待→反差→钝收），本身有含义，正好拿来当 tie-break。
    const enumOrder = new Map(ENUMS.钩型.map((h, i) => [h, i]))
    const hookCount = new Map()
    for (const c of inVol) if (c.hook) hookCount.set(c.hook, (hookCount.get(c.hook) ?? 0) + 1)
    const hookDist = [...hookCount.entries()]
      .map(([hook, count]) => ({ hook, count, ratio: inVol.length ? count / inVol.length : 0 }))
      .sort((a, b) => b.count - a.count || enumOrder.get(a.hook) - enumOrder.get(b.hook))

    // ③ 最大连续同型钩：只在本卷内数（跨卷的连续性没有叙事意义）
    let maxRun = 0
    let maxRunHook = null
    let run = 0
    let runHook = null
    for (const c of inVol) {
      if (c.hook && c.hook === runHook) run += 1
      else { runHook = c.hook; run = c.hook ? 1 : 0 }
      if (run > maxRun) { maxRun = run; maxRunHook = runHook }
    }

    // 爽点类型分布：只有类型才是能跨书比较的那一维（A-09 的理由）
    // 同数时同样按契约枚举顺序，理由同上——不依赖运行环境的排序规则。
    const typeOrder = new Map(ENUMS.爽点类型.map((t, i) => [t, i]))
    const typeCount = new Map()
    for (const c of inVol) if (c.sharpType) typeCount.set(c.sharpType, (typeCount.get(c.sharpType) ?? 0) + 1)

    // 爽点密度（C-03）：卷内爽点章数 ÷ 本卷章数。
    //
    // 单独存成字段而不只在 humanReport 里加工：分卷总表的「爽点密度」列要能由
    // `--write-total` 直接写入，而字符串「15.0%」写不进表——表里要的也是这个数，
    // 两处各算一次就会漂。这里算一次，报告与总表都用它。
    //
    // 算不出时给 null 不给 0：0% 表示「这一卷一个爽点都没有」，null 表示
    // 「逐章记录还是骨架，根本没数可算」。两者在产物上必须能分开。
    const sharpDensity = inVol.length ? sharpChs.length / inVol.length : null

    return {
      no: span.no,
      name: span.name,
      chapters: inVol.length,
      sharpChapters: sharpChs.length,
      sharpDensity,
      sharpGapMedian: median(gaps),
      sharpGaps: gaps.length,
      hookDist,
      maxHookRun: maxRun,
      maxHookRunHook: maxRun <= 1 ? null : maxRunHook,
      sharpTypeDist: [...typeCount.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || typeOrder.get(a.type) - typeOrder.get(b.type)),
    }
  })

  return { perVolume, offEnum, total: chapters.length }
}

// 把每卷的爽点密度写回分卷总表（C-03）。
//
// 为什么要有写入器，而不是让 09 的 agent 手抄：密度是纯反转（两个数相除），
// 手抄与脚本算出两个值时，产物上没有任何东西能说明哪个对。而这一列的作用正是
// 「这一卷节奏闷不闷」——它错了整张表的判断都跟着错。
//
// 三条口径：
//   ① 逐章记录还是骨架的卷写「（待填）」，不写 0%：0% 是「这一卷一个爽点都没有」，
//      与「还没数」是两件事，混在一起就没人敢信这一列。
//   ② 只改「爽点密度」这一格，其余列原样保留——agent 可能已经填了叙述列，
//      整行重写会把那些内容抹掉。
//   ③ 表里没有的卷（逐章记录有、manifest 卷区间没有）不新增行：总表一行一卷，
//      行由 09 建，脚本只填格。
export function writeTotalTable(tableText, stats, { placeholder = '（待填）' } = {}) {
  const cols = tableColumns('分卷总表')
  const iVol = cols.indexOf('卷')
  const iDensity = cols.indexOf('爽点密度')
  if (iVol < 0 || iDensity < 0) throw new Error('E_CONTRACT：分卷总表缺「卷」或「爽点密度」列')

  const byVol = new Map(stats.perVolume.map((v) => [String(v.no), v]))
  const lines = tableText.split(/\r?\n/)
  let headerSeen = false
  let changed = 0
  const out = lines.map((line) => {
    const cells = parseRow(line)
    if (!cells) return line
    if (!headerSeen) {
      // 表头判据与 write-rows 同法：逐字等于契约列名
      if (cells.length === cols.length && cells.every((c, k) => c === cols[k])) headerSeen = true
      return line
    }
    if (cells.length !== cols.length) return line
    if (/^[-: ]+$/.test(cells[0])) return line

    // 总表的「卷」列可能是 1 也可能是 01，两种都认
    const volNo = String(Number(cells[iVol]))
    const v = byVol.get(volNo)
    if (!v) return line

    const next = v.sharpDensity === null ? placeholder : pct(v.sharpDensity)
    if (cells[iDensity] === next) return line
    const patched = [...cells]
    patched[iDensity] = next
    changed += 1
    return '| ' + patched.join(' | ') + ' |'
  })

  return { text: out.join('\n'), changed, headerSeen }
}

// 人读报告。刻意把「算不出来」写成明确的一句话，而不是留空或写 0——
// 0 与「没算」是两件事，混在一起就没人知道该不该信这个数。
export function humanReport(stats) {
  const lines = []
  for (const v of stats.perVolume) {
    lines.push(`卷${v.no}（${v.name}）：${v.chapters} 章，爽点章 ${v.sharpChapters} 章`)
    if (!v.sharpChapters) {
      lines.push('  爽点：本卷没有记到爽点章（强度全为「无」或未填）')
    } else {
      lines.push(`  爽点密度：${pct(v.sharpDensity)}%（${v.sharpChapters}/${v.chapters}）`)
      lines.push(v.sharpGapMedian === null
        ? '  中爽点间隔中位数：无（本卷只记到 1 个爽点章，算不出间隔）'
        : `  中爽点间隔中位数：${v.sharpGapMedian} 章（共 ${v.sharpGaps} 个间隔）`)
    }
    if (v.hookDist.length) {
      const dist = v.hookDist.map((h) => `${h.hook} ${h.count}（${Math.round(h.ratio * 100)}%）`).join('、')
      lines.push(`  钩型分布：${dist}`)
      lines.push(v.maxHookRun <= 1
        ? '  最大连续同型钩：1 章（没有连续同型）'
        : `  最大连续同型钩：${v.maxHookRun} 章（${v.maxHookRunHook}）`)
    }
    if (v.sharpTypeDist.length) {
      lines.push(`  爽点类型分布：${v.sharpTypeDist.map((t) => `${t.type} ${t.count}`).join('、')}`)
    }
  }
  if (stats.offEnum.钩型.length || stats.offEnum.爽点强度.length || stats.offEnum.爽点类型.length) {
    lines.push('')
    lines.push('不在枚举内、未计入统计的取值（请改正后再跑，否则上面各数偏低）：')
    for (const [field, list] of Object.entries(stats.offEnum)) {
      if (!list.length) continue
      const shown = list.slice(0, 5).map((x) => `第${x.no}章「${x.value}」`).join('、')
      const more = list.length > 5 ? `，另有 ${list.length - 5} 处` : ''
      lines.push(`  ${field}：${shown}${more}`)
    }
  }
  return lines.join('\n')
}

// ---------- CLI ----------

const USAGE = '用法：volume-stats.mjs <产物目录> [--json] [--write-total [--dry-run]] [--help]'
const HELP = `${USAGE}
从 工作/逐章记录.md 算卷级派生统计：爽点章数与密度、间隔中位数、钩型分布、最大连续同型钩。
--write-total：把每卷的爽点密度写回「故事底本/故事剧情/分卷总表.md」对应行（只改这一格）。
--dry-run：配合 --write-total，只报告会改几处，不落盘。
--json：stdout 只输出一个 { ok, errors, data } 对象。
--help：输出本说明并退出。`

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
  const out = { dir: null, json: false, help: false, writeTotal: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--write-total') out.writeTotal = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('-')) throw new CliError(`未知参数「${a}」。${USAGE}`)
    else if (out.dir === null) out.dir = a
    else throw new CliError(`多余的参数「${a}」。只接受一个产物目录。${USAGE}`)
  }
  if (!out.help && !out.dir) throw new CliError(`缺少产物目录。${USAGE}`)
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
    console.log(HELP)
    return
  }

  const recPath = join(args.dir, '工作', '逐章记录.md')
  let raw
  try {
    raw = await readFile(recPath, 'utf8')
  } catch {
    emitFailure({ code: 'E_FILE', message: `E_FILE：读不到「${recPath}」。先跑 prepare 生成骨架。`, json: args.json, withCode: false })
    return
  }

  // 表头定位：与 write-rows 同法，不猜列序。
  const cols = tableColumns('逐章记录')
  const lines = raw.split(/\r?\n/)
  let headerLine = -1
  const rows = []
  lines.forEach((line, i) => {
    const cells = parseRow(line)
    if (!cells) return
    if (headerLine < 0 && cells.length === cols.length && cells.every((c, k) => c === cols[k])) { headerLine = i; return }
    if (headerLine < 0 || i <= headerLine) return
    if (/^[-: ]+$/.test(cells[0].replace(/\|/g, ''))) return
    rows.push(cells)
  })
  if (headerLine < 0) {
    emitFailure({
      code: 'E_HEADER',
      message: 'E_HEADER：未找到逐章记录表头（须与 contract 的列名逐字一致）。',
      json: args.json,
      withCode: false,
    })
    return
  }

  // manifest 里的卷区间：有就用，没有就整本当一卷。
  let volumes = []
  try {
    const m = JSON.parse(await readFile(join(args.dir, '工作', 'manifest.json'), 'utf8'))
    volumes = (m.volumes ?? []).map((v) => ({ no: v.no, name: v.name, startCh: v.startCh, endCh: v.endCh }))
  } catch { /* 没有 manifest 不阻断：整本当一卷仍能出数 */ }

  const stats = computeVolumeStats(rows, { volumes })

  if (args.writeTotal) {
    const totalPath = join(args.dir, '故事底本', '故事剧情', '分卷总表.md')
    let tableText
    try {
      tableText = await readFile(totalPath, 'utf8')
    } catch {
      emitFailure({ code: 'E_FILE', message: `E_FILE：读不到「${totalPath}」。先跑 prepare 生成骨架。`, json: args.json, withCode: false })
      return
    }
    let result
    try {
      result = writeTotalTable(tableText, stats)
    } catch (error) {
      emitFailure({ code: 'E_CONTRACT', message: error.message, exitCode: 2, json: args.json, withCode: false })
      return
    }
    if (!result.headerSeen) {
      emitFailure({
        code: 'E_HEADER',
        message: 'E_HEADER：分卷总表里没找到与契约逐字一致的表头，不猜列序（猜错会把密度写进别的列）。',
        json: args.json,
        withCode: false,
      })
      return
    }
    if (args.dryRun) {
      if (args.json) {
        console.log(JSON.stringify({ ok: true, errors: [], data: { changed: result.changed, dryRun: true } }, null, 2))
      } else {
        console.log(`会改 ${result.changed} 处（--dry-run，未落盘）`)
      }
      return
    }
    // 内容没变时不写：避免把一个没改动的文件记成刚改过（mtime 会变，产物上分不出「改过」与「跑过」）。
    if (result.changed === 0) {
      if (args.json) {
        console.log(JSON.stringify({ ok: true, errors: [], data: { changed: 0, dryRun: false } }, null, 2))
      } else {
        console.log('爽点密度列已是最新，无需改动')
      }
      return
    }
    await writeFile(totalPath, result.text, 'utf8')
    if (args.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: { changed: result.changed, dryRun: false, path: totalPath } }, null, 2))
    } else {
      console.log(`已写入 ${result.changed} 处爽点密度（${totalPath}）`)
    }
    return
  }

  if (args.json) console.log(JSON.stringify({ ok: true, errors: [], data: stats }, null, 2))
  else console.log(humanReport(stats))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
