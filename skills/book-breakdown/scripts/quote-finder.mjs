// 给「某个实体在某几章」定位可引用的原句，替代「为了找一句出处而通读整章」。
//
// 为什么：阶段 5 要给每个实体建卡，卡上每条结论须带「第 N 章＋原文引句」（F-14）。
// 若每张卡都回读整章，410 张卡 × 约 3 章 × 均章 3,000 字 ≈ 3.7M 字，比阶段 4
// 读全书一遍还贵——同一本书等于被读了两遍。
// 本脚本用确定性检索把候选句挑出来（零 token），agent 只读命中的那几句。
//
// 别名：实体的别称从「工作/别名词典.md」取，避免「张三」在原文里写作「张老三」时漏检。
// 章节定位：一律走 manifest.chapters[].file，不用 glob（输出顺序非确定）。
//
// 用法：
//   node quote-finder.mjs <产物目录> --entity 张三               自动选取证章（≤4）
//   node quote-finder.mjs <产物目录> --entity 张三 --chapters 3,250,600
//   node quote-finder.mjs <产物目录> --entity 张三 --max 5 --context
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManifest } from './io.mjs'
import { parseRow } from './validate-output.mjs'
import { buildIndex, sampleChapters } from './entity-index.mjs'

const PLACEHOLDER = '（待填）'

// 中文断句：句末标点或换行。保留标点，便于直接作为引句。
// 两个细节：
// 1) 句末标点后紧跟收尾引号/括号时不切——否则「他说：“好。”」会被切成两半，
//    剩下的「”」单独成句（实测夹具第 1 章就出现这种垃圾片段）。
// 2) 连用省略号「……」不在中间切——否则引句会只剩一个「…」，读起来是断的。
export function splitSentences(text) {
  if (!text) return []
  return text
    .replace(/\r/g, '')
    .split(/(?<=[。！？…；!?;])(?![」』”’）)\]】…])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // 只剩标点的碎片不是句子，丢掉（防御：上面的后视断言覆盖不到的边角）
    .filter((s) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(s))
}

// 从别名词典的表格行里，取该实体的全部称呼（主名 + 所有别称）。
// 行格式：| 别称 | 主名 | 实体类型 | 首次出现章 | 归并依据 |
export function expandAliases(aliasLines, entity) {
  const names = new Set([entity])
  for (const line of aliasLines) {
    const cells = parseRow(line)
    if (!cells || cells.length < 2) continue
    const [alias, main] = cells
    if (!alias || !main || alias === '别称' || alias.startsWith('-')) continue
    if (alias === PLACEHOLDER || main === PLACEHOLDER) continue
    if (main === entity) names.add(alias)
    // 反向：若查的是别称，也带回主名
    if (alias === entity) names.add(main)
  }
  return [...names]
}

// 在一章正文里找含指定称呼的句子。返回 [{句, 命中词, 序号}]，每句只记一次。
// context=true 时把命中句前后各一句一并带上，便于判断人物在做什么。
export function findQuotes(text, names, { max = 3, context = false } = {}) {
  const sentences = splitSentences(text)
  const hits = []
  const seen = new Set()
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i]
    const hit = names.find((n) => s.includes(n))
    if (!hit || seen.has(s)) continue
    seen.add(s)
    const item = { 句: s, 命中词: hit, 序号: i + 1 }
    if (context) {
      item.前句 = i > 0 ? sentences[i - 1] : null
      item.后句 = i + 1 < sentences.length ? sentences[i + 1] : null
    }
    hits.push(item)
    if (hits.length >= max) break
  }
  return hits
}

// 截断过长句子，避免一条引句就吃掉上下文预算。
export function clip(s, limit = 120) {
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}…`
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { dir: null, entity: null, chapters: null, max: 3, context: false, json: false, limit: 120 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--entity') out.entity = argv[++i]
    else if (a === '--chapters') out.chapters = argv[++i]
    else if (a === '--max') out.max = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--context') out.context = true
    else if (a === '--json') out.json = true
    else if (!a.startsWith('-')) out.dir = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir || !args.entity) {
    console.error('用法：node quote-finder.mjs <产物目录> --entity 名称 [--chapters 1,2,3] [--max 3] [--limit 120] [--context] [--json]')
    process.exit(2)
  }
  if (!Number.isFinite(args.max) || args.max < 1) {
    console.error('--max 须为正整数')
    process.exit(2)
  }

  const manifest = await readManifest(args.dir)
  const byNo = new Map(manifest.chapters.map((c) => [c.no, c]))

  // 别名表（可能为空，骨架态）
  let aliasLines = []
  try {
    aliasLines = (await readFile(join(args.dir, '工作', '别名词典.md'), 'utf8')).split(/\r?\n/)
  } catch {
    aliasLines = []
  }
  const names = expandAliases(aliasLines, args.entity)

  // 取证章：显式给了就用，否则从逐章记录索引里按采样规则挑
  let chapterNos
  if (args.chapters) {
    chapterNos = args.chapters.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))
    if (!chapterNos.length) {
      console.error('--chapters 解析不出章号')
      process.exit(2)
    }
  } else {
    let recRaw = ''
    try {
      recRaw = await readFile(join(args.dir, '工作', '逐章记录.md'), 'utf8')
    } catch (error) {
      console.error(`逐章记录不可读：${error.message}。请先用 --chapters 指定章号`)
      process.exit(1)
    }
    const { index } = buildIndex(recRaw.split(/\r?\n/))
    const e = index.get(args.entity)
    if (!e) {
      console.error(`逐章记录索引里没有「${args.entity}」；请先完成阶段 4，或用 --chapters 指定章号`)
      process.exit(1)
    }
    chapterNos = sampleChapters(e.章号)
  }

  // 逐章检索
  const results = []
  for (const no of chapterNos) {
    const ch = byNo.get(no)
    if (!ch) {
      results.push({ 章号: no, 错误: 'manifest 里没有该章' })
      continue
    }
    let body
    try {
      body = await readFile(join(args.dir, '原文', '章节', ch.file), 'utf8')
    } catch (error) {
      results.push({ 章号: no, 标题: ch.title, 错误: `章节文件不可读：${error.message}` })
      continue
    }
    const hits = findQuotes(body, names, { max: args.max, context: args.context })
    results.push({ 章号: no, 标题: ch.title, 来源文件: ch.file, 命中: hits })
  }

  if (args.json) {
    console.log(JSON.stringify({ 实体: args.entity, 称呼: names, 章数: chapterNos.length, 结果: results }, null, 1))
    if (results.every((r) => !r.命中 || r.命中.length === 0)) process.exit(1)
    return
  }

  console.log(`实体「${args.entity}」｜称呼：${names.join('、')}｜检索 ${chapterNos.length} 章`)
  for (const r of results) {
    if (r.错误) {
      console.log(`\n第 ${r.章号} 章：${r.错误}`)
      continue
    }
    console.log(`\n第 ${r.章号} 章 ${r.标题}`)
    if (!r.命中.length) {
      console.log('  （未命中，考虑加到别名词典后再试）')
      continue
    }
    for (const h of r.命中) {
      console.log(`  · 「${clip(h.句, args.limit)}」（命中「${h.命中词}」，第 ${h.序号} 句）`)
      if (h.前句) console.log(`    前：「${clip(h.前句, 60)}」`)
      if (h.后句) console.log(`    后：「${clip(h.后句, 60)}」`)
    }
  }
  const total = results.reduce((n, r) => n + (r.命中?.length ?? 0), 0)
  if (total === 0) {
    console.error('\n所有目标章均未命中：该实体可能只以别称出现，请先补「工作/别名词典.md」再重试；或换章号。')
    process.exit(1)
  }
  console.log('\n以上引句可直接用于卡片出处（第 N 章＋引句，F-14）；写入前请核对引句与结论确实对应。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
