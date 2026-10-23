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
import { readFile } from 'node:fs/promises'
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
async function productChars(root, manifest) {
  let sum = 0
  for (const [rel, state] of Object.entries(manifest.files ?? {})) {
    if (rel.startsWith('原文/')) continue // 原文是复制来的，不是模型输出
    if (state !== 'done' && state !== 'filled' && state !== 'validated') continue
    try {
      sum += (await readFile(join(root, rel), 'utf8')).length
    } catch {
      // 文件缺失不计入；validate-output 会报
    }
  }
  return sum
}

function parseArgs(argv) {
  const out = { dir: null, record: false, set: false, report: false, check: false, json: false, stage: null, input: null, output: null, calls: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--record') out.record = true
    else if (a === '--set') out.set = true
    else if (a === '--report') out.report = true
    else if (a === '--check') out.check = true
    else if (a === '--json') out.json = true
    else if (a === '--stage') out.stage = Number(argv[++i])
    else if (a === '--in') out.input = argv[++i]
    else if (a === '--out') out.output = argv[++i]
    else if (a === '--calls') out.calls = Number(argv[++i])
    else if (!a.startsWith('-')) out.dir = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir) {
    console.error('用法：node cost.mjs <产物目录> --record|--set --stage N [--in 37500] [--out 1200] [--calls 1]')
    console.error('      node cost.mjs <产物目录> --report [--json]')
    console.error('      node cost.mjs <产物目录> --check')
    process.exit(2)
  }

  const manifestPath = join(args.dir, '工作', 'manifest.json')
  let manifest
  try {
    manifest = await readManifest(args.dir)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  // ---- 记录 ----
  if (args.record || args.set) {
    if (!Number.isInteger(args.stage) || !STAGE_NAMES[args.stage]) {
      console.error(`--stage 须为 0-7，收到「${args.stage}」`)
      process.exit(2)
    }
    const input = parseAmount(args.input)
    const output = parseAmount(args.output)
    if (args.input !== null && input === null) {
      console.error(`--in 无法解析为数量：「${args.input}」（支持 37500 / 37k / 1.2m）`)
      process.exit(2)
    }
    if (args.output !== null && output === null) {
      console.error(`--out 无法解析为数量：「${args.output}」`)
      process.exit(2)
    }
    if (input === null && output === null) {
      console.error('--in 与 --out 至少要给一个')
      process.exit(2)
    }
    const next = mergeCost(manifest.cost, {
      stage: args.stage,
      input,
      output,
      mode: args.set ? 'set' : 'record',
      calls: args.calls,
    })
    if (!next.startedAt) next.startedAt = new Date().toISOString()
    manifest.cost = next
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const s = next.stages[String(args.stage)]
    console.log(`阶段 ${args.stage}（${STAGE_NAMES[args.stage]}）累计：输入 ${fmt(s.in)}、输出 ${fmt(s.out)}、调用 ${s.calls} 次`)
    console.log(`全程累计：输入 ${fmt(next.total.in)}、输出 ${fmt(next.total.out)}`)
    return
  }

  // ---- 报告 / 核对 ----
  const cost = manifest.cost
  const pChars = await productChars(args.dir, manifest)
  const lb = lowerBound(manifest, pChars)

  if (!cost || !cost.total || cost.total.calls === 0) {
    if (args.check) {
      console.error('E_COST_MISSING：manifest 里没有成本计量。请在各阶段用 --record 上报用量，否则无法回答「这本书花了多少」。')
      process.exit(1)
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
    console.log(JSON.stringify({ ok: true, cost, 下界: lb, 警告: warnings }, null, 1))
    if (args.check && warnings.length) process.exitCode = 0 // 警告不阻断；缺计量才阻断
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
