#!/usr/bin/env node
// 原文引句回源核验（技术文档 D-07；A-19「人工抽查」的确定性替代）：把故事底本里结论行的「引句」
// 拿回原文/章节比对，判三档：通过、章号不符（引句真、章号标错）、全书找不到（引句不存在）。
// 比对口径（标点归一、术语排除、最短段长度）的唯一来源是 contract.mjs 的 QUOTE_VERIFY（D-01）。
// 用法：verify-quotes.mjs <产物目录> [--json] [--max-findings N] [--help]
// 退出码：0 全部通过（或只剩被跳过的术语标注/坐标字段引号），1 有章号不符/全书找不到，2 参数错误，3 环境缺失。只读不写。
// data.skippedMeta 计「引号条数」，含两类：① 坐标字段里不含标点的名称引号；② 含标点但分段后全书找不到的引号。
import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManifest } from './io.mjs'
import { QUOTE_VERIFY } from './contract.mjs'
// 中文数字转整数复用 prepare 的实现（同一套章号口径，不另写一份防漂移）。
import { cnToInt } from './prepare.mjs'

const USAGE = '用法：verify-quotes.mjs <产物目录> [--json] [--max-findings N] [--help]'
const DEFAULT_MAX_FINDINGS = 50

const HELP = `${USAGE}

把「故事底本/」下结论行的原文引句拿回「原文/章节/」比对，只读，不改产物。

参数：
  <产物目录>             含 工作/manifest.json 与 原文/章节/ 的拆解产物目录
  --json                  stdout 只输出一个 JSON 对象 { ok, errors, data }
  --max-findings N       data.items 最多列 N 条（默认 ${DEFAULT_MAX_FINDINGS}），计数不受此限
  --help                 输出本说明并退出

退出码：
  0  全部通过（三档里只有 pass，或只有被跳过的术语标注）
  1  存在章号不符或全书找不到
  2  参数错误（未知参数、缺少产物目录、--max-findings 取值非法）
  3  环境缺失（产物目录不存在、缺 工作/manifest.json、原文/章节/ 不可读）

算法要点：
  扫描范围：扫 故事底本/ 下的 .md，分两条通道。
  ① 结论行（以「-」开头的列表行）：判定三档，参与 ok 与退出码。
  ② 散文行（非列表、非标题/引用/表格，且带「第 N 章」）：能回源的计入 pass，
     找不到的只列「存疑」作提示，不参与 ok 与退出码——散文里的引号多为强调而非逐字引用，
     按列表行口径判会大量误报（两本真书实测 8 条误报）。
  坐标字段行：字段名属于「幕号与幕名、起止章、卷号与卷名、卷名来源、弧名、章数、字数、时段、
             名称、姓名、主名、别称、别称与马甲、标题、对象、对象A、对象B、定位、判定、指向」的行，
             这些字段的值是名称/标题/编号，其引号多为幕名、章名、别名而不是原文引句。
             行内每条引号单独判，两道门槛（见 data.skippedMeta 的两类来源）：
               ① 引号内容不含「${QUOTE_VERIFY.术语排除标点}」→ 当名称放过，跳过；
               ② 含标点 → 分段后在全书中检索，任一段找不到 → 仍当名称放过，跳过；
                  所有段都能找到 → 判为真引句，照常进入三档核验（不跳过）。
             所以「幕号与幕名：…序章「白帝城 Bai Di Cheng」」被跳过（幕名不进章节正文，必然误报），
             而「名称：…「第五元素……纯净的精神元素」」因为正文里找得到，会正常核验。
             「依据」「说话风格与人设锚点」「核心关系」「关键章节链」等字段不在此列，无条件照常核验。
  章号集合：行内每个「第 N 章」都计入（支持中文数字，如「第十二章」），一行可声明多个章号。
  标点归一：比对前引句与原文都删掉空白与中英标点，双向归一后再做子串比对。
  省略号分段：引句含「……」／「…」／「...」时切成多段，每段归一后不足 ${QUOTE_VERIFY.最短段长度} 字丢弃；
             所有有效段都在声明章号的原文中找到才算通过。
  术语标注排除：引号内容不含「${QUOTE_VERIFY.术语排除标点}」且短于 ${QUOTE_VERIFY.术语长度上限} 字，
             视为段名或术语（如「地理图志」「社会与文化」），跳过不核，计入 data.skippedTerms。

判定：
  pass           所有有效段都在该行声明章号的原文里找到
  wrong-chapter  否则，所有有效段在全书原文里都能找到（引句是真的，章号标错）
  not-found      否则，引句在全书原文里找不到
`

// 章号：与 SOURCE_PATTERN 同口径的写法，但这里只认「章」（引句核验按章定位）。
const CHAPTER_PATTERN = /第\s*([0-9一二三四五六七八九十百]+)\s*章/g
// 引句：中文引号三种，内容至少 4 字（更短的碎片无法定位，按格式问题交给 validate-output）。
const QUOTE_SCAN = /[「『“]([^」』”]{4,})[」』”]/g
// 省略号：全角「……」与半角「...」都按分段处理。
const ELLIPSIS = /…+|\.\.\./g

// ---------- 工具 ----------

async function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else out.push({ rel: full.slice(base.length + 1).split(sep).join('/'), full })
  }
  return out
}

// 标点归一：按 QUOTE_VERIFY.标点归一 拼字符类，删除全部空白与中英标点。
const PUNCT = new RegExp(`[${QUOTE_VERIFY.标点归一}]`, 'g')
const TERM_PUNCT = new RegExp(`[${QUOTE_VERIFY.术语排除标点}]`)

function stripPunct(text) {
  return text.replace(PUNCT, '')
}

const charLen = (text) => [...text].length

// 术语标注：无标点且短于阈值。引号里可能是段名（「社会与文化」）或术语（「地理图志」），不是原文引句。
function isTermQuote(quote) {
  return !TERM_PUNCT.test(quote) && charLen(quote) < QUOTE_VERIFY.术语长度上限
}

// 省略号分段：每段各自归一，不足最短段长度的段丢弃（碎片无法定位，留着会把真引句误判成找不到）。
function validSegments(quote) {
  return quote.split(ELLIPSIS)
    .map(stripPunct)
    .filter((seg) => charLen(seg) >= QUOTE_VERIFY.最短段长度)
}

// 坐标字段行：字段名命中 QUOTE_VERIFY.坐标字段 的列表行。这些字段的值是名称/标题/编号，
// 引号里多为幕名、章名、别名而不是原文引句。
// 兼容三种模板写法：括号修饰（姓名（主名）：）、斜杠并称（原型词/功能位：）、章后缀（首次出现章：）。
// 注意不能改用 SOURCE_META_LABELS：那份白名单还含「说话风格与人设锚点」「核心关系」等
// 实际会带真引句的字段，整行跳过会把真引句一起漏掉。
const COORD_LABELS = [...QUOTE_VERIFY.坐标字段].sort((a, b) => b.length - a.length).join('|')
const COORD_PATTERN = new RegExp(`^(?:${COORD_LABELS})(?:章)?(?:[（(][^）)]*[）)])?(?:/[^：:]*)?：`)

function isCoordLine(body) {
  return COORD_PATTERN.test(body)
}

// 坐标字段里的引号该不该当名称放过（返回 true＝跳过，false＝照常核验）。
// 两道门槛，缺一不可：
//   ① 不含标点 → 名称/代号/幕名（「独裁官」「昂热校长」「白帝城 Bai Di Cheng」），跳过。
//   ② 含标点 → 才算「像原文引句」的候选，但要先在全书中检索：所有有效段都能找到才核验，
//      否则仍是名称（幕名「哥哥—弟弟」含破折号但正文里不存在，走这条，不误报）。
// 只做①会漏掉「我没有正式的名字，他们给我的编号是『0…」这类真引句；
// 只做②会把「哥哥—弟弟」这类含标点的幕名误报回来。
function coordQuoteIsLabel(quote, bookText) {
  if (!TERM_PUNCT.test(quote)) return true
  const segments = validSegments(quote)
  if (!segments.length) return true
  return !segments.every((seg) => bookText.includes(seg))
}

function chaptersInLine(line) {
  const nos = []
  for (const m of line.matchAll(CHAPTER_PATTERN)) {
    const no = cnToInt(m[1])
    if (Number.isInteger(no) && !nos.includes(no)) nos.push(no)
  }
  return nos
}

function quotesInLine(line) {
  return [...line.matchAll(QUOTE_SCAN)].map((m) => m[1])
}

// ---------- 主流程 ----------

export async function verifyQuotes({ root, maxFindings = DEFAULT_MAX_FINDINGS } = {}) {
  root = resolve(root)
  const problems = []
  const zero = { total: 0, pass: 0, wrongChapter: 0, notFound: 0, skippedTerms: 0, skippedMeta: 0 }
  const fail = (code, file, message) => problems.push(file ? { code, file, message } : { code, message })

  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail('E_IO', '', `产物目录不存在：${root}。请传入拆解产物目录（含 工作/manifest.json 与 原文/章节/）`)
    return { ok: false, errors: problems, data: { ...zero, chapters: 0, files: 0, items: [] } }
  }

  let manifest
  try {
    manifest = await readManifest(root)
  } catch (error) {
    fail(error.code ?? 'E_MANIFEST', '工作/manifest.json', error.message)
    return { ok: false, errors: problems, data: { ...zero, chapters: 0, files: 0, items: [] } }
  }

  // 章号 → 归一后的原文。按 manifest 的 no 直接索引（no 从 0 起，0 是序章/前言），不从文件名前缀推导。
  const chapterText = new Map()
  const chapterDir = join(root, '原文', '章节')
  let chapterEntries
  try {
    chapterEntries = readdirSync(chapterDir, { withFileTypes: true })
  } catch (error) {
    fail('E_IO', '原文/章节/', `原文章节目录不可读（${chapterDir}）：${error.message}。请用 prepare 重建产物后再核验`)
    return { ok: false, errors: problems, data: { ...zero, chapters: 0, files: 0, items: [] } }
  }
  if (!chapterEntries.some((e) => e.isFile())) {
    fail('E_IO', '原文/章节/', `原文章节目录为空（${chapterDir}）。请用 prepare 重建产物后再核验`)
    return { ok: false, errors: problems, data: { ...zero, chapters: 0, files: 0, items: [] } }
  }
  for (const chapter of manifest.chapters) {
    if (!chapter || typeof chapter.file !== 'string' || !Number.isInteger(chapter.no)) continue
    const file = join(chapterDir, chapter.file)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      fail('E_IO', `原文/章节/${chapter.file}`, `章节原文不可读：${error.message}。请用 prepare --force 重建产物`)
      return { ok: false, errors: problems, data: { ...zero, chapters: chapterText.size, files: 0, items: [] } }
    }
    chapterText.set(chapter.no, stripPunct(raw))
  }
  // 全书串：各章归一后拼接（归一已删空白，拼接不引入边界字符）。
  const bookText = [...chapterText.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('')

  // 作者的话（Q-32）：prepare 会把正文里的前言/后记归集到 原文/作者的话.md，它是合法的引用来源，
  // 但不在 manifest 的章节清单里，旧版完全不读——作者原话一律被判「全书找不到」。
  // 真书实测：长安的荔枝的「我本来只打算写四章…」出自作者的话，却被判成自拟短语。
  // 只并入 bookText（全书兜底查找），不并入任何章的 declaredText（它没有章号，不该让某章背这口锅）。
  let authorNoteText = ''
  try {
    authorNoteText = stripPunct(await readFile(join(root, '原文', '作者的话.md'), 'utf8'))
  } catch {
    authorNoteText = '' // 没有该文件是正常情况（多数书没有作者的话）
  }
  const bookTextWithNote = bookText + authorNoteText

  const docsDir = join(root, '故事底本')
  let docsStat
  try {
    docsStat = statSync(docsDir)
  } catch {
    docsStat = null
  }
  if (!docsStat?.isDirectory()) {
    fail('E_IO', '故事底本/', `故事底本目录不可读：${docsDir}。请确认产物目录完整后再核验`)
    return { ok: false, errors: problems, data: { ...zero, chapters: chapterText.size, files: 0, items: [] } }
  }

  let scannedFiles = 0
  let total = 0
  let pass = 0
  let wrongChapter = 0
  let notFound = 0
  let skippedTerms = 0
  let skippedMeta = 0
  const found = []
  // 散文行通道（Q-31）：非列表行里带章号的引句。只统计、不判失败——原因见下方注释。
  let proseTotal = 0
  let prosePass = 0
  const proseSuspect = []

  let files
  try {
    files = (await walkFiles(docsDir)).filter((f) => f.rel.endsWith('.md')).sort((a, b) => a.rel.localeCompare(b.rel))
  } catch (error) {
    fail('E_IO', '故事底本/', `故事底本目录遍历失败：${error.message}。请检查目录权限后重试`)
    return { ok: false, errors: problems, data: { ...zero, chapters: chapterText.size, files: 0, items: [] } }
  }
  for (const { rel, full } of files) {
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch (error) {
      fail('E_IO', `故事底本/${rel}`, `产物文件不可读：${error.message}。请检查文件权限后重试`)
      return { ok: false, errors: problems, data: { ...zero, chapters: chapterText.size, files: scannedFiles, items: [] } }
    }
    scannedFiles++
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line.startsWith('-')) {
        // 散文行（Q-31）：不是列表行，但内容是一整句带章号的结论，同样会带引句。
        // 旧版直接跳过，导致「把结论写成散文」成为引句核验的盲区（真书实测：129 行 169 条引句从未被检查）。
        // 但散文里的引号大多是**强调**而非逐字引用（「规则失效」「一个不得志的诗人朋友」），
        // 若按列表行的口径判失败，两本真书会一次报出 8 条误报、把信号淹掉。
        // 故此处只做两件事：① 能回源的计入 prosePass（说明这段散文引的是真原文）；
        // ② 找不到的记为「存疑」列出，供人工看，不阻断退出码。
        if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|')) continue
        const proseQuotes = quotesInLine(line)
        if (!proseQuotes.length) continue
        const proseChapters = chaptersInLine(line)
        if (!proseChapters.length) continue
        for (const quote of proseQuotes) {
          if (isTermQuote(quote)) continue
          const segments = validSegments(quote)
          if (!segments.length) continue
          proseTotal++
          const declaredText = proseChapters.map((no) => chapterText.get(no) ?? '').join('')
          if (segments.every((seg) => declaredText.includes(seg)) || segments.every((seg) => bookTextWithNote.includes(seg))) {
            prosePass++
            continue
          }
          proseSuspect.push({ file: `故事底本/${rel}`, line: i + 1, chapters: proseChapters, quote })
        }
        continue
      }
      const quotes = quotesInLine(line)
      if (!quotes.length) continue
      const chapters = chaptersInLine(line)
      if (!chapters.length) continue // 没有章号的行不归本脚本判
      // 坐标字段行（幕名/章名/别名）里的引号逐条判：只有「确实像原文引句」的才核验，其余当名称放过。
      const body = line.replace(/^-\s*/, '').trim()
      const coordLine = isCoordLine(body)
      for (const quote of quotes) {
        if (coordLine && coordQuoteIsLabel(quote, bookText)) { skippedMeta++; continue }
        if (isTermQuote(quote)) { skippedTerms++; continue }
        const segments = validSegments(quote)
        // 全由省略号碎片构成的引句无法定位（最短段长度以下），归入跳过，不制造找不到的误报。
        if (!segments.length) { skippedTerms++; continue }
        // total 只计真正参与判定的引句：三档之和＝total，术语标注另计（与实测口径一致）。
        total++
        const declaredText = chapters.map((no) => chapterText.get(no) ?? '').join('')
        if (segments.every((seg) => declaredText.includes(seg))) { pass++; continue }
        const bucket = segments.every((seg) => bookTextWithNote.includes(seg)) ? 'wrong-chapter' : 'not-found'
        if (bucket === 'wrong-chapter') wrongChapter++
        else notFound++
        found.push({ file: `故事底本/${rel}`, line: i + 1, chapters, quote, bucket })
      }
    }
  }

  const items = found.slice(0, maxFindings)
  const ok = problems.length === 0 && wrongChapter === 0 && notFound === 0
  return {
    ok,
    errors: problems,
    data: {
      total, pass, wrongChapter, notFound, skippedTerms, skippedMeta,
      chapters: chapterText.size,
      files: scannedFiles,
      truncated: found.length - items.length,
      items,
      // 散文行通道：proseSuspect 只作提示，不参与 ok 判定与退出码。
      prose: {
        total: proseTotal,
        pass: prosePass,
        suspect: proseSuspect.length,
        items: proseSuspect.slice(0, maxFindings),
      },
    },
  }
}

function rate(n, total) {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '0.0%'
}

function humanReport(d) {
  const out = []
  out.push(`引句回源核验：${d.total} 条（跳过术语标注 ${d.skippedTerms} 条、坐标字段引号 ${d.skippedMeta} 条）`)
  out.push(`  通过 ${d.pass}（${rate(d.pass, d.total)}）`)
  out.push(`  章号不符 ${d.wrongChapter}（${rate(d.wrongChapter, d.total)}）`)
  out.push(`  全书找不到 ${d.notFound}（${rate(d.notFound, d.total)}）`)
  const groups = [['wrong-chapter', '章号不符', d.wrongChapter], ['not-found', '全书找不到', d.notFound]]
  for (const [bucket, title, count] of groups) {
    if (!count) continue
    out.push(`${title}：`)
    for (const item of d.items.filter((it) => it.bucket === bucket)) {
      out.push(`  ${item.file}:${item.line} 第${item.chapters.join('、')}章「${item.quote}」`)
    }
  }
  if (d.truncated > 0) out.push(`（仅列出前 ${d.items.length} 条问题，共 ${d.wrongChapter + d.notFound} 条，完整计数见上）`)
  // 散文行通道（Q-31）：只报数，不改判定——散文引号多为强调，误报率高，交由人工看。
  if (d.prose?.total) {
    out.push(`散文行引句：${d.prose.total} 条，可回源 ${d.prose.pass}，存疑 ${d.prose.suspect}（提示项，不阻断）`)
    for (const it of d.prose.items) {
      out.push(`  [存疑] ${it.file}:${it.line} 第${it.chapters.join('、')}章「${it.quote}」`)
    }
  }
  out.push(`结论：${d.wrongChapter + d.notFound ? '不通过' : '通过'}`)
  return out.join('\n')
}

export function parseArgs(argv) {
  const options = { root: undefined, json: false, maxFindings: DEFAULT_MAX_FINDINGS, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--max-findings') {
      const v = argv[++i]
      if (v === undefined) throw new Error(`--max-findings 缺少取值（应给 0 或正整数）。${USAGE}`)
      if (!/^\d+$/.test(v)) throw new Error(`--max-findings 取值「${v}」非法，应为 0 或正整数。${USAGE}`)
      options.maxFindings = Number(v)
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数 ${arg}，无法识别。${USAGE}；执行 --help 查看说明`)
    } else if (options.root === undefined) options.root = arg
    else throw new Error(`多余的参数 ${arg}，只接受一个产物目录。${USAGE}`)
  }
  if (!options.help && options.root === undefined) throw new Error(`缺少产物目录。${USAGE}`)
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: 'E_ARGS', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  const result = await verifyQuotes({ root: options.root, maxFindings: options.maxFindings })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const e of result.errors) console.error(`错误 [${e.code}] ${e.file ? `${e.file}: ` : ''}${e.message}`)
    if (result.data.total > 0 || !result.errors.length) console.log(humanReport(result.data))
  }
  if (!result.ok) {
    // 环境缺失：目录/ manifest / 章节原文不可读 → 3；业务失败（引句对不上）→ 1。
    process.exitCode = result.errors.length ? 3 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
