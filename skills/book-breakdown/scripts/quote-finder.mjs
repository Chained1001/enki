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
import { QUOTE_VERIFY } from './contract.mjs'

const PLACEHOLDER = '（待填）'

// 归一用的标点集与 verify-quotes 同源（都读 contract 的 QUOTE_VERIFY.标点归一）。
// 两处各写一份字符类，新增一种标点时必然漏掉一处，然后就出现「核验认、定位不认」。
const PUNCT = new RegExp(`[${QUOTE_VERIFY.标点归一}]`, 'g')

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

// 引句模糊定位（C-14）。
//
// 出处核验子代理的活是「判断某条引句是不是转述/拼接/编造」，但它此前**自己检索**：
// 每条最多 8 轮全书搜索，绍宋实测 not-found 120 条 × 3 分钟 ≈ 6 小时，
// 而且大部分时间花在「这本书里到底有没有这句」——那是确定性检索，不是语义判断。
//
// 本函数把这部分做掉：给一批引句，用 4-gram 倒排找候选章，再在候选章里算相似度，
// 返回每条命中的章号与最高相似度。子代理只判「命中的那句是不是同一意思」。
//
// 判据与 verify-quotes 的 notFound 分流同源（都读 contract 的 QUOTE_VERIFY.notFound还原），
// 不另立一套阈值——两处各定一个下限，改了一处另一处不会动。
export function locateQuotes(chapters, quotes, opts = {}) {
  const cfg = QUOTE_VERIFY.notFound还原
  const n = cfg.四字窗长
  const minScore = opts.minScore ?? cfg.四字重合率下限

  // 归一：去掉标点与空白。搜索用，展示仍用原句。
  const norm = (s) => String(s ?? '').replace(PUNCT, '')

  // 全书 4-gram 倒排：gram → 出现过的章号集合
  const gramToCh = new Map()
  for (const ch of chapters) {
    const text = norm(ch.text)
    const seen = new Set()
    for (let i = 0; i + n <= text.length; i += 1) {
      const g = text.slice(i, i + n)
      if (seen.has(g)) continue // 同一章内重复的 gram 只记一次
      seen.add(g)
      let set = gramToCh.get(g)
      if (!set) { set = new Set(); gramToCh.set(g, set) }
      set.add(ch.no)
    }
  }

  const results = []
  for (const q of quotes) {
    const target = norm(q.引句 ?? q.quote ?? q)
    const id = q.编号 ?? q.id ?? null
    if (target.length < n) {
      results.push({ 编号: id, 引句: q.引句 ?? q, 命中: [], 说明: `引句短于 ${n} 字，无法检索` })
      continue
    }

    // 候选章：该引句所有 gram 覆盖到的章，按覆盖 gram 数降序取前 N。
    // 只取前 N 是因为后续要算 LCS，全量算等于回到「每条扫全书」。
    const cover = new Map()
    for (let i = 0; i + n <= target.length; i += 1) {
      const set = gramToCh.get(target.slice(i, i + n))
      if (!set) continue
      for (const no of set) cover.set(no, (cover.get(no) ?? 0) + 1)
    }
    const totalGrams = Math.max(1, target.length - n + 1)
    const cands = [...cover.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, cfg.候选章上限)

    const byNo = new Map(chapters.map((c) => [c.no, c]))
    const scored = cands.map(([no, hits]) => {
      const text = norm(byNo.get(no)?.text ?? '')
      // 比例用「命中 gram 数 / 引句 gram 总数」而不是 LCS：
      // 子代理要的是「这句话有没有可能在这章」，gram 覆盖率已经够，
      // 而 LCS 在两位数候选上会让单条耗时涨一个量级。
      return { 章号: no, 相似度: Number((hits / totalGrams).toFixed(3)), 命中句: pickSentence(byNo.get(no)?.text ?? '', q.引句 ?? q) }
    }).filter((x) => x.相似度 >= minScore)

    results.push({ 编号: id, 引句: q.引句 ?? q, 命中: scored })
  }
  return results
}

// 从候选章里挑出最可能是目标的那一句：取包含最多引句字符的句子。
// 找不到就返回该章第一句——总得给子代理一句话去看，空着它还得自己读整章。
function pickSentence(chapterText, quote) {
  const sentences = splitSentences(chapterText)
  if (!sentences.length) return null
  const norm = (s) => String(s ?? '').replace(PUNCT, '')
  const target = norm(quote)
  let best = sentences[0]
  let bestScore = -1
  for (const s of sentences) {
    const ns = norm(s)
    let hit = 0
    for (let i = 0; i + 4 <= target.length; i += 1) if (ns.includes(target.slice(i, i + 4))) hit += 1
    if (hit > bestScore) { bestScore = hit; best = s }
  }
  return best
}

// 截断过长句子，避免一条引句就吃掉上下文预算。
export function clip(s, limit = 120) {
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}…`
}

// ---------- CLI ----------

const USAGE =
  '用法：node quote-finder.mjs <产物目录> --entity 名称 [--chapters 1,2,3] [--max 3] [--limit 120] [--context] [--json]\n' +
  '      node quote-finder.mjs <产物目录> --grep-all 引句.json [--min-score 0.8] [--json]  批量定位（出处核验用）\n' +
  '      node quote-finder.mjs --help'

const HELP = `${USAGE}

按实体与章号定位可引用的原句，替代「为了找一句出处而通读整章」。

参数：
  <产物目录>        含 工作/manifest.json 与 原文/章节/ 的拆解产物目录
  --entity 名称      要检索的实体（别称从 工作/别名词典.md 取）
  --chapters 1,2,3  指定取证章；不给则按逐章记录索引自动采样
  --max N           每章最多取 N 句（默认 3）
  --limit N         引句截断长度（默认 120）
  --context         命中句前后各带一句
  --grep-all 文件    批量定位引句（格式 [{"编号":"n1","引句":"……"}]）
  --min-score 0.8   配合 --grep-all 的相似度下限（0-1）
  --json            stdout 只输出一个 { ok, errors, data } 对象
  --help            输出本说明并退出`

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
  const out = { dir: null, entity: null, chapters: null, max: 3, context: false, json: false, help: false, limit: 120, grepAll: null, minScore: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--entity') out.entity = argv[++i]
    else if (a === '--chapters') out.chapters = argv[++i]
    else if (a === '--max') out.max = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--context') out.context = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--grep-all') out.grepAll = argv[++i]
    else if (a === '--min-score') out.minScore = Number(argv[++i])
    else if (a.startsWith('-')) throw new CliError(`未知参数 ${a}。${USAGE}`)
    else if (out.dir === null) out.dir = a
    else throw new CliError(`多余的参数 ${a}。${USAGE}`)
  }
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
  if (!args.dir || (!args.entity && !args.grepAll)) {
    emitFailure({ code: 'E_ARGS', message: USAGE, exitCode: 2, json: args.json, withCode: false })
    return
  }
  if (!Number.isFinite(args.max) || args.max < 1) {
    emitFailure({ code: 'E_ARGS', message: '--max 须为正整数', exitCode: 2, json: args.json, withCode: false })
    return
  }

  // --grep-all：批量定位，给出处核验子代理用（C-14）。
  // 提前返回，不走后面「按实体找句」那条路——两者用途不同：
  // --entity 是建卡取证（要原文句子），--grep-all 是核验定位（要知道这句在哪一章）。
  if (args.grepAll) {
    let manifest
    try {
      manifest = await readManifest(args.dir)
    } catch (error) {
      emitFailure({ code: error.code ?? 'E_MANIFEST', message: error.message, json: args.json })
      return
    }
    let quotes
    try {
      const raw = await readFile(args.grepAll, 'utf8')
      const parsed = JSON.parse(raw)
      quotes = Array.isArray(parsed) ? parsed : parsed.引句 ?? parsed.quotes
    } catch (error) {
      emitFailure({
        code: 'E_ARGS',
        message: `E_ARGS：读不出引句文件「${args.grepAll}」：${error.message}\n格式：[{"编号":"n1","引句":"……"}]，或 {"引句":[…]}`,
        exitCode: 2,
        json: args.json,
        withCode: false,
      })
      return
    }
    if (!Array.isArray(quotes) || !quotes.length) {
      emitFailure({
        code: 'E_ARGS',
        message: 'E_ARGS：引句文件里没有条目。应为 [{"编号":"n1","引句":"……"}]',
        exitCode: 2,
        json: args.json,
        withCode: false,
      })
      return
    }
    if (args.minScore !== null && !(args.minScore >= 0 && args.minScore <= 1)) {
      emitFailure({ code: 'E_ARGS', message: 'E_ARGS：--min-score 应在 0 与 1 之间', exitCode: 2, json: args.json, withCode: false })
      return
    }

    // 把每章正文读进来。全书一遍，之后所有引句共用这份文本与倒排索引——
    // 这正是「子代理逐条检索」做不到的事：它每条都要重扫一遍。
    const chapters = []
    for (const c of manifest.chapters) {
      try {
        chapters.push({ no: c.no, text: await readFile(join(args.dir, '原文', '章节', c.file), 'utf8') })
      } catch { /* 缺章文件时跳过：该章定位不到，由下面「命中为空」体现 */ }
    }

    const results = locateQuotes(chapters, quotes, { minScore: args.minScore ?? undefined })
    const hit = results.filter((r) => r.命中.length).length
    if (args.json) {
      const data = { 引句数: results.length, 有命中: hit, 结果: results }
      if (hit === 0) {
        emitFailure({
          code: 'E_NOT_FOUND',
          message: '所有引句均未命中：全书找不到与这些引句相近的句子',
          data,
          json: true,
          withCode: false,
        })
        return
      }
      console.log(JSON.stringify({ ok: true, errors: [], data }, null, 2))
      return
    }
    for (const r of results) {
      const id = r.编号 ? `[${r.编号}] ` : ''
      if (!r.命中.length) {
        console.log(`${id}无命中　${clip(r.引句, args.limit)}${r.说明 ? `（${r.说明}）` : ''}`)
        continue
      }
      const top = r.命中[0]
      console.log(`${id}第 ${top.章号} 章（相似度 ${top.相似度}）　${clip(r.引句, args.limit)}`)
      console.log(`     候选句：${clip(top.命中句 ?? '', args.limit)}`)
      if (r.命中.length > 1) {
        console.log(`     其他候选章：${r.命中.slice(1).map((x) => `第${x.章号}章(${x.相似度})`).join('、')}`)
      }
    }
    console.log(`\n共 ${results.length} 条，${hit} 条有命中。子代理只需判断命中的那句是不是同一意思，不必自己检索。`)
    // 全无命中时退出 1：调用方要能区分「定位完了但都没找到」与「根本没跑」。
    if (hit === 0) process.exitCode = 1
    return
  }

  let manifest
  try {
    manifest = await readManifest(args.dir)
  } catch (error) {
    emitFailure({ code: error.code ?? 'E_MANIFEST', message: error.message, json: args.json })
    return
  }
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
      emitFailure({ code: 'E_ARGS', message: '--chapters 解析不出章号', exitCode: 2, json: args.json, withCode: false })
      return
    }
  } else {
    let recRaw = ''
    try {
      recRaw = await readFile(join(args.dir, '工作', '逐章记录.md'), 'utf8')
    } catch (error) {
      emitFailure({
        code: 'E_FILE',
        message: `逐章记录不可读：${error.message}。请先用 --chapters 指定章号`,
        json: args.json,
        withCode: false,
      })
      return
    }
    const { index } = buildIndex(recRaw.split(/\r?\n/))
    const e = index.get(args.entity)
    if (!e) {
      emitFailure({
        code: 'E_NOT_FOUND',
        message: `逐章记录索引里没有「${args.entity}」；请先完成阶段 4，或用 --chapters 指定章号`,
        json: args.json,
        withCode: false,
      })
      return
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

  const total = results.reduce((n, r) => n + (r.命中?.length ?? 0), 0)

  if (args.json) {
    const data = { 实体: args.entity, 称呼: names, 章数: chapterNos.length, 结果: results }
    if (total === 0) {
      emitFailure({
        code: 'E_NOT_FOUND',
        message: '所有目标章均未命中：该实体可能只以别称出现，请先补「工作/别名词典.md」再重试；或换章号',
        data,
        json: true,
        withCode: false,
      })
      return
    }
    console.log(JSON.stringify({ ok: true, errors: [], data }, null, 2))
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
  if (total === 0) {
    console.error('\n所有目标章均未命中：该实体可能只以别称出现，请先补「工作/别名词典.md」再重试；或换章号。')
    process.exitCode = 1
  } else {
    console.log('\n以上引句可直接用于卡片出处（第 N 章＋引句，F-14）；写入前请核对引句与结论确实对应。')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
