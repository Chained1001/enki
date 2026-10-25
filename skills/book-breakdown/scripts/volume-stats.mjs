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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ENUMS, tableColumns } from './contract.mjs'
import { parseRow } from './validate-output.mjs'

const PLACEHOLDER = '（待填）'
// 「有爽点」的定义：强度不是「无」。小／中／大都算一次爽点投放。
const NO_SHARP = '无'

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
    const hook = String(cells[iHook] ?? '').trim()
    const sharp = String(cells[iSharp] ?? '').trim()
    const sharpType = String(cells[iSharpType] ?? '').trim()
    // 占位行整行跳过：还没填的行不该参与任何统计，也不该被报成「非法取值」。
    if (hook === PLACEHOLDER || sharp === PLACEHOLDER) continue
    if (!hook && !sharp) continue

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

    return {
      no: span.no,
      name: span.name,
      chapters: inVol.length,
      sharpChapters: sharpChs.length,
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

// 人读报告。刻意把「算不出来」写成明确的一句话，而不是留空或写 0——
// 0 与「没算」是两件事，混在一起就没人知道该不该信这个数。
export function humanReport(stats) {
  const lines = []
  for (const v of stats.perVolume) {
    lines.push(`卷${v.no}（${v.name}）：${v.chapters} 章，爽点章 ${v.sharpChapters} 章`)
    if (!v.sharpChapters) {
      lines.push('  爽点：本卷没有记到爽点章（强度全为「无」或未填）')
    } else {
      const density = v.chapters ? ((v.sharpChapters / v.chapters) * 100).toFixed(1) : '0.0'
      lines.push(`  爽点密度：${density}%（${v.sharpChapters}/${v.chapters}）`)
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

function parseArgs(argv) {
  const out = { dir: null, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('-')) throw new Error(`未知参数「${a}」。用法：volume-stats.mjs <产物目录> [--json]`)
    else if (out.dir === null) out.dir = a
    else throw new Error(`多余的参数「${a}」。只接受一个产物目录`)
  }
  if (!out.help && !out.dir) throw new Error('缺少产物目录。用法：volume-stats.mjs <产物目录> [--json]')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：volume-stats.mjs <产物目录> [--json]')
    console.log('从 工作/逐章记录.md 算卷级派生统计：爽点章数与间隔中位数、钩型分布、最大连续同型钩。')
    return
  }

  const recPath = join(args.dir, '工作', '逐章记录.md')
  let raw
  try {
    raw = await readFile(recPath, 'utf8')
  } catch {
    console.error(`E_FILE：读不到「${recPath}」。先跑 prepare 生成骨架。`)
    process.exit(1)
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
    console.error('E_HEADER：未找到逐章记录表头（须与 contract 的列名逐字一致）。')
    process.exit(1)
  }

  // manifest 里的卷区间：有就用，没有就整本当一卷。
  let volumes = []
  try {
    const m = JSON.parse(await readFile(join(args.dir, '工作', 'manifest.json'), 'utf8'))
    volumes = (m.volumes ?? []).map((v) => ({ no: v.no, name: v.name, startCh: v.startCh, endCh: v.endCh }))
  } catch { /* 没有 manifest 不阻断：整本当一卷仍能出数 */ }

  const stats = computeVolumeStats(rows, { volumes })
  if (args.json) console.log(JSON.stringify(stats, null, 2))
  else console.log(humanReport(stats))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
