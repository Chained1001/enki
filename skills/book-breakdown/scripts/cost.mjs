// 成本计量：记录并核对每次 LLM 调用的用量（PRD 成功指标 M-06）。
//
// 为什么要有：PRD 的成本模型全是估算（12.7M → 5.0M → 2.1M tokens），
// 没有实测就无法验证优化是否生效。脚本本身不调模型，拿不到真实用量，
// 所以本脚本做两件事：
//   1) 记录——agent 每批/每阶段跑完，把它从宿主拿到的 usage 报进来；
//   2) 核对——同时用产物算出「确定性下界」，上报值低于下界即报警，防止漏记。
// 只记不核，等于允许自己填一个好看的数字。
//
// 数据落在 manifest.cost（manifest 是受管状态块，不新增产物文件——
// PRD 规定 工作/ 只有三个文件）。
//
// 用法：
//   node cost.mjs <产物目录> --record --stage 4 --in 37500 --out 1200
//   node cost.mjs <产物目录> --set    --stage 4 --in 1875000 --out 56250
//   node cost.mjs <产物目录> --report [--json]
//   node cost.mjs <产物目录> --check          # 供交付前调用：无计量即退出 1
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManifest, writeFileAtomic } from './io.mjs'

// 中文约 1.6 字/token。只用于「下界估算」，不是精确换算。
const CHARS_PER_TOKEN = 1.6

const STAGE_NAMES = {
  0: '路径询问',
  1: '输入校验',
  2: '预处理与初始化',
  3: '口径锚定',
  4: '卷循环',
  5: '设定库',
  6: '全书层',
  7: '校验交付',
}

// 解析 "37500" / "1.2m" / "37k" 这类写法。
export function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim().toLowerCase()
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s)
  if (!m) return null
  const n = Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1)
  return Number.isFinite(n) ? Math.round(n) : null
}

// 纯函数：把一次上报并入成本表。mode=record 累加、mode=set 覆盖。
export function mergeCost(cost, { stage, input, output, mode = 'record', calls = 1 }) {
  const next = {
    updatedAt: new Date().toISOString(),
    stages: { ...(cost?.stages ?? {}) },
  }
  const key = String(stage)
  const prev = next.stages[key] ?? { in: 0, out: 0, calls: 0 }
  next.stages[key] =
    mode === 'set'
      ? { in: input ?? 0, out: output ?? 0, calls: calls ?? 1 }
      : { in: prev.in + (input ?? 0), out: prev.out + (output ?? 0), calls: prev.calls + (calls ?? 1) }
  const totals = Object.values(next.stages).reduce(
    (a, s) => ({ in: a.in + s.in, out: a.out + s.out, calls: a.calls + s.calls }),
    { in: 0, out: 0, calls: 0 },
  )
  next.total = totals
  if (cost?.startedAt) next.startedAt = cost.startedAt
  return next
}

// 确定性下界：阶段 4 必须把全书读一遍，故输入不可能低于 totalChars/tokensPerChar。
// 输出下界＝非原文产物文件的字符数折算（正文产物都是 agent 写出来的）。
export function lowerBound(manifest, productCharCount, charsPerToken = CHARS_PER_TOKEN) {
  // 全书不可能不被读完，但「读完」跨阶段 3 与阶段 4：阶段 3 读开篇前三章，
  // 阶段 4 读其余（含重读）。所以下界应落在「阶段 3+4 合计」，而不是只压在阶段 4 上。
  // 实测《长安的荔枝》抓到的误报：阶段 3 读 1 章全文、阶段 4 读余下 5 章，
  // 两阶段合计 54.1K 恰好等于全书，但旧规则要求阶段 4 单独 ≥54.1K，必然报警。
  const readAll = Math.round((manifest.totalChars ?? 0) / charsPerToken)
  const openingUnits = Math.max(1, Math.min(3, manifest.chapterCount ?? 3))
  const openingChars = Math.round(
    (manifest.chapters ?? [])
      .slice(0, openingUnits)
      .reduce((n, c) => n + (c.chars ?? 0), 0),
  )
  const openingTokens = Math.round(openingChars / charsPerToken)
  return {
    阶段4输入下界: Math.max(0, readAll - openingTokens),
    阶段3与4合计下界: readAll,
    输出下界: Math.round((productCharCount ?? 0) / charsPerToken),
  }
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

// 统计产物中「非原文」部分的字符数：正文产物都是 agent 产出的输出。
// 判据看正文里还有没有占位，不看 manifest.files 的状态标签——那个标签在 prepare 时写死，
// 之后没人更新，于是填满的文件永远挂着 skeleton，被这里跳过（实测：填完实内容后
// 输出下界仍算成 0）。同一件事有两个事实源时，以磁盘上的内容为准。
const PLACEHOLDER = /（待填）/
const isUnfilled = (text) => PLACEHOLDER.test(text)

async function productChars(root, manifest) {
  let sum = 0
  // 文件清单以磁盘为准，manifest.files 只用来补「有哪些文件」，不用来判状态：
  // 产物目录里可能还有 manifest 没登记的文件（agent 新建的卡片等），漏掉它们同样会低估。
  const rels = new Set(
    Object.keys(manifest.files ?? {}).filter((rel) => !rel.startsWith('原文/')),
  )
  for (const rel of await listProductFiles(root)) rels.add(rel)
  for (const rel of rels) {
    try {
      const text = await readFile(join(root, rel), 'utf8')
      if (isUnfilled(text)) continue // 还是骨架，没有产出可计
      sum += text.length
    } catch {
      // 文件缺失不计入；validate-output 会报
    }
  }
  return sum
}

// 产物目录下的 .md/.json 文件（原文/ 之外的产物）。不带进任何原文正文。
async function listProductFiles(root) {
  const out = []
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (rel === '原文') continue
        await walk(join(dir, e.name), rel)
      } else if (/\.(md|json)$/.test(e.name)) {
        out.push(rel)
      }
    }
  }
  await walk(root, '')
  return out
}

// 记录成本到 manifest（C-08）。抽成可导出函数，是为了让「读到写之间被别人改了」
// 这个竞态能在单测里确定性复现——真起两个进程竞速是不稳定的，测试会时红时绿。
//
// options.beforeWrite：测试注入的钩子，在「已合并、尚未写盘」这一刻调用，
// 用来模拟并发进程在这个窗口里改了 manifest。
export async function recordCost({ root, stage, input, output, mode = 'record', calls = 1, beforeWrite } = {}) {
  const manifestPath = join(root, '工作', 'manifest.json')
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 每次尝试都重新读：上一轮的那份可能已过期（并发改过），
    // 重试用最新版本重新算，绝不用旧副本覆盖。
    const rawBefore = await readFile(manifestPath, 'utf8')
    const current = await readManifest(root)
    const merged = mergeCost(current.cost, { stage, input, output, mode, calls })
    if (!merged.startedAt) merged.startedAt = current.cost?.startedAt ?? new Date().toISOString()
    const candidate = { ...current, cost: merged }
    if (beforeWrite) await beforeWrite({ attempt })
    // 复核：只有磁盘内容仍与我们读到的那一份逐字相同时才写。
    // 用内容比对而不是 mtime：Windows 上 mtime 精度约 15ms，
    // 同一毫秒内的两次写会被判成「没变」，保护就失效了——这条用 mtime 时测试是红的。
    const rawNow = await readFile(manifestPath, 'utf8')
    if (rawNow !== rawBefore) continue
    await writeFileAtomic(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`)
    return { ok: true, manifest: candidate, attempts: attempt }
  }
  return {
    ok: false,
    message:
      `E_CONFLICT：manifest 连续 ${MAX_ATTEMPTS} 次在写入前被其他进程修改（${manifestPath}）。` +
      '已放弃本次写入以免覆盖并发结果，请重试',
  }
}

function parseArgs(argv) {
  const out = { dir: null, record: false, set: false, report: false, check: false, json: false, help: false, stage: null, input: null, output: null, calls: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--record') out.record = true
    else if (a === '--set') out.set = true
    else if (a === '--report') out.report = true
    else if (a === '--check') out.check = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--stage') out.stage = Number(argv[++i])
    else if (a === '--in') out.input = argv[++i]
    else if (a === '--out') out.output = argv[++i]
    else if (a === '--calls') out.calls = Number(argv[++i])
    else if (a.startsWith('-')) throw new UsageError(`未知参数 ${a}。${USAGE}`, 'E_ARGS')
    else if (out.dir === null) out.dir = a
    else throw new UsageError(`多余的参数 ${a}。${USAGE}`, 'E_ARGS')
  }
  return out
}

const USAGE =
  '用法：node cost.mjs <产物目录> --record|--set --stage N [--in 37500] [--out 1200] [--calls 1]\n' +
  '      node cost.mjs <产物目录> --report [--json]\n' +
  '      node cost.mjs <产物目录> --check [--json]'

const HELP = `${USAGE}

把每次 LLM 调用的用量记进 manifest.cost，并用产物算出确定性下界交叉核对（PRD M-06）。

参数：
  <产物目录>   含 工作/manifest.json 的拆解产物目录
  --record     累加一次上报（默认模式）
  --set        用本次上报覆盖该阶段
  --stage N    阶段号 0-7
  --in N       输入 tokens，支持 37500 / 37k / 1.2m
  --out N      输出 tokens
  --calls N    本次上报的调用次数（默认 1）
  --report     打印用量表与下界
  --check      交付前核对：没有计量即以 1 退出
  --json       stdout 只输出一个 { ok, errors, data } 对象
  --help       输出本说明并退出`

class UsageError extends Error {
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
  if (!args.dir) {
    emitFailure({ code: 'E_ARGS', message: USAGE, exitCode: 2, json: args.json, withCode: false })
    return
  }

  let manifest
  try {
    manifest = await readManifest(args.dir)
  } catch (error) {
    emitFailure({ code: error.code ?? 'E_MANIFEST', message: error.message, json: args.json })
    return
  }

  // ---- 记录 ----
  if (args.record || args.set) {
    if (!Number.isInteger(args.stage) || !STAGE_NAMES[args.stage]) {
      emitFailure({ code: 'E_ARGS', message: `--stage 须为 0-7，收到「${args.stage}」`, exitCode: 2, json: args.json, withCode: false })
      return
    }
    const input = parseAmount(args.input)
    const output = parseAmount(args.output)
    if (args.input !== null && input === null) {
      emitFailure({
        code: 'E_ARGS',
        message: `--in 无法解析为数量：「${args.input}」（支持 37500 / 37k / 1.2m）`,
        exitCode: 2,
        json: args.json,
        withCode: false,
      })
      return
    }
    if (args.output !== null && output === null) {
      emitFailure({ code: 'E_ARGS', message: `--out 无法解析为数量：「${args.output}」`, exitCode: 2, json: args.json, withCode: false })
      return
    }
    if (input === null && output === null) {
      emitFailure({ code: 'E_ARGS', message: '--in 与 --out 至少要给一个', exitCode: 2, json: args.json, withCode: false })
      return
    }
    const result = await recordCost({
      root: args.dir,
      stage: args.stage,
      input,
      output,
      mode: args.set ? 'set' : 'record',
      calls: args.calls,
      // 并发保护在 recordCost 里：读到的内容在写盘前变了就重读重试（C-08）。
    })
    if (!result.ok) {
      emitFailure({ code: 'E_CONFLICT', message: result.message, json: args.json, withCode: false })
      return
    }
    manifest = result.manifest
    const s = manifest.cost.stages[String(args.stage)]
    if (args.json) {
      console.log(JSON.stringify({
        ok: true,
        errors: [],
        data: {
          stage: args.stage,
          stageName: STAGE_NAMES[args.stage],
          stageTotal: s,
          total: manifest.cost.total,
          attempts: result.attempts,
        },
      }, null, 2))
      return
    }
    console.log(`阶段 ${args.stage}（${STAGE_NAMES[args.stage]}）累计：输入 ${fmt(s.in)}、输出 ${fmt(s.out)}、调用 ${s.calls} 次`)
    console.log(`全程累计：输入 ${fmt(manifest.cost.total.in)}、输出 ${fmt(manifest.cost.total.out)}`)
    return
  }

  // ---- 报告 / 核对 ----
  const cost = manifest.cost
  const pChars = await productChars(args.dir, manifest)
  const lb = lowerBound(manifest, pChars)

  if (!cost || !cost.total || cost.total.calls === 0) {
    if (args.check) {
      emitFailure({
        code: 'E_COST_MISSING',
        message: 'E_COST_MISSING：manifest 里没有成本计量。请在各阶段用 --record 上报用量，否则无法回答「这本书花了多少」。',
        json: args.json,
        withCode: false,
      })
      return
    }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: { cost: null, 下界: lb, 警告: [] } }, null, 2))
      return
    }
    console.log('尚未记录任何用量。')
    console.log(`确定性下界（供核对）：阶段 4 输入 ≥ ${fmt(lb.阶段4输入下界)}（全书扣掉阶段 3 已读的开篇，合计 ≥ ${fmt(lb.阶段3与4合计下界)}）；产物输出 ≈ ${fmt(lb.输出下界)}`)
    console.log('记录方式：node cost.mjs <产物目录> --record --stage 4 --in 37500 --out 1200')
    return
  }

  const warnings = []
  const missing = []
  for (const id of [3, 4, 5, 6, 7]) {
    if (!cost.stages[String(id)] || cost.stages[String(id)].calls === 0) missing.push(`${id} ${STAGE_NAMES[id]}`)
  }
  if (missing.length) warnings.push(`W_COST_STAGE_MISSING：这些阶段没有记录：${missing.join('、')}`)

  const s4 = cost.stages['4']?.in ?? 0
  if (lb.阶段4输入下界 > 0 && s4 < lb.阶段4输入下界) {
    warnings.push(
      `W_COST_UNDER：阶段 4 上报输入 ${fmt(s4)} 低于确定性下界 ${fmt(lb.阶段4输入下界)}` +
        `（全书 ${manifest.totalChars} 字，阶段 3 已读开篇、阶段 4 还需读余下部分，不可能更少）——疑似漏记`,
    )
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, errors: [], data: { cost, 下界: lb, 警告: warnings } }, null, 2))
    // 警告不阻断；缺计量才阻断
    return
  }

  const rows = Object.entries(cost.stages).sort((a, b) => Number(a[0]) - Number(b[0]))
  console.log(`阶段用量（开始于 ${cost.startedAt ?? '未知'}）`)
  console.log('')
  console.log('| 阶段 | 名称 | 调用 | 输入 | 输出 | 占总输入 |')
  console.log('|---|---|---|---|---|---|')
  for (const [id, s] of rows) {
    const pct = cost.total.in ? `${Math.round((100 * s.in) / cost.total.in)}%` : '—'
    console.log(`| ${id} | ${STAGE_NAMES[id] ?? '?'} | ${s.calls} | ${fmt(s.in)} | ${fmt(s.out)} | ${pct} |`)
  }
  console.log(`| — | **合计** | ${cost.total.calls} | **${fmt(cost.total.in)}** | **${fmt(cost.total.out)}** | 100% |`)
  console.log('')
  console.log(`确定性下界（核对用）：阶段 4 输入 ≥ ${fmt(lb.阶段4输入下界)}（阶段 3+4 合计 ≥ ${fmt(lb.阶段3与4合计下界)}）；产物输出 ≥ ${fmt(lb.输出下界)}`)
  if (warnings.length) {
    console.log('')
    for (const w of warnings) console.log(`⚠ ${w}`)
  } else {
    console.log('✅ 上报值与下界不矛盾，各阶段均有记录。')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
