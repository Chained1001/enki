// 生成「references 索引.md」：列出每份文件每个小节的**行范围**与体量，
// 让调用方用 read 的 offset/limit 只读需要的那几节，而不是整读一个大文件。
//
// 为什么需要：方法论搬进 references 后单文件已经很大——
// 人物提炼策略 50k tokens、设定提炼策略 30k tokens。
// 阶段 5 要按「人物/势力/地点/物品/概念/世界观与专题/文风」七组推进，
// 若每组都整读一次这两个文件，就是 596k tokens，比阶段 4 读全书还贵十几倍。
// 而建主角卡只需要「主角三要素/读者凭什么/成长弧/认知控制」四节，
// 建反派卡只需要「反派」一节——按行范围读，能省掉六七成。
//
// 索引由脚本生成，行号漂移由 test/reference-index.test.mjs 守住。
//
// 用法：
//   node reference-index.mjs --write      # 重新生成 索引.md
//   node reference-index.mjs --check      # 与磁盘上的 索引.md 比对，不一致退出 1
//   node reference-index.mjs              # 打印到 stdout
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const refDir = join(here, '..', 'references')
const INDEX_NAME = '索引.md'
const CHARS_PER_TOKEN = 1.6

// 从一段 markdown 里切出「## 」小节，返回 [{节, 起, 止, 字符数}]（行号 1 基，含首尾）。
export function sliceSections(text) {
  const lines = text.split(/\r?\n/)
  const starts = []
  lines.forEach((l, i) => {
    if (/^## /.test(l)) starts.push(i)
  })
  const out = []
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k]
    const e = (k + 1 < starts.length ? starts[k + 1] : lines.length) - 1
    const title = lines[s].replace(/^##\s+/, '').trim()
    const chars = lines.slice(s, e + 1).join('\n').length
    out.push({ 节: title, 起: s + 1, 止: e + 1, 字符数: chars, 行数: e - s + 1 })
  }
  return out
}

// 生成索引文本。文件按体量降序，便于一眼看出哪份最贵。
export function buildIndex(files) {
  const rows = []
  for (const { name, text } of files) {
    const sections = sliceSections(text)
    const total = text.length
    rows.push({ name, sections, total })
  }
  rows.sort((a, b) => b.total - a.total)

  const grand = rows.reduce((n, r) => n + r.total, 0)
  const T = (c) => Math.round(c / CHARS_PER_TOKEN)
  const biggest = rows[0]
  const Tbig = biggest ? `${(T(biggest.total) / 1000).toFixed(1)}k` : '0'
  const out = []
  out.push('# references 索引')
  out.push('')
  out.push('> 本文件由 `scripts/reference-index.mjs --write` 生成，勿手改；行号漂移由测试守住。')
  out.push('>')
  out.push('> 用法：先用本表定位，再用 `read` 的 `offset`/`limit` 只读需要的那几节。')
  out.push(
    `> **不要整读大文件**——${biggest ? `\`${biggest.name}\` 约 ${Tbig} tokens` : '最大的文件很大'}，` +
      '整读一次抵得上读六七章原文。',
  )
  out.push('')
  out.push(`合计 ${rows.length} 份、${grand} 字符 ≈ ${T(grand)} tokens（全部加载的代价，仅作参照）。`)
  out.push('')
  out.push('| 文件 | 节 | 起止行 | 行数 | tokens |')
  out.push('|---|---|---|---|---|')
  for (const r of rows) {
    if (!r.sections.length) {
      out.push(`| ${r.name} | （无 ## 小节） | 1-${Math.max(1, r.total ? 1 : 1)} | — | ${T(r.total)} |`)
      continue
    }
    for (const s of r.sections) {
      out.push(`| ${r.name} | ${s.节} | ${s.起}-${s.止} | ${s.行数} | ${T(s.字符数)} |`)
    }
  }
  out.push('')
  out.push('## 常用取用组合')
  out.push('')
  out.push('按用途，只读这些节即可，不必整读整份文件：')
  out.push('')
  out.push('| 要做什么 | 读哪些节 |')
  out.push('|---|---|')
  out.push('| 建主角五文件 | `人物提炼策略.md` 的「主角三要素与三级欲望链」「读者凭什么跟百万字」「主角成长弧怎么排」「人物认知怎么控制」 |')
  out.push('| 建主要配角深化卡 | 同文件「配角与群像」「人物关系怎么织」 |')
  out.push('| 建反派卡 | 同文件「反派：三层与强度」 |')
  out.push('| 定主次档位 | `主次判定判据.md` 全份（仅 1.1k tokens） |')
  out.push('| 填六专题 | `设定提炼策略.md` 的「世界铁则与规则」「力量体系与天花板」（地理/年表类专题还需「随文潜入与世界观暗面」） |')
  out.push('| 判金手指类型与边界 | `金手指判据.md` 全份（仅 0.6k tokens） |')
  out.push('| 写文风定性六段 | `文风分析策略.md` 全份（仅 0.7k tokens） |')
  out.push('| 幕判定与卷纲 | `幕边界判据.md` 全份 + `幕与节奏策略.md` 全份（合计约 5k） |')
  out.push('| 全书大纲与骨架定位 | `结构拆解策略.md` 全份（约 2.1k）+ `拆书概念辞典.md`（约 1.2k） |')
  out.push('| 伏笔识别与对账 | `伏笔识别策略.md` 全份（约 2k） |')
  out.push('')
  return out.join('\n')
}

async function loadFiles() {
  const names = (await readdir(refDir)).filter((f) => f.endsWith('.md') && f !== INDEX_NAME)
  const files = []
  for (const name of names.sort()) {
    files.push({ name, text: await readFile(join(refDir, name), 'utf8') })
  }
  return files
}

async function main() {
  const argv = process.argv.slice(2)
  const files = await loadFiles()
  const expected = buildIndex(files)
  const indexPath = join(refDir, INDEX_NAME)

  if (argv.includes('--check')) {
    let actual = null
    try {
      actual = await readFile(indexPath, 'utf8')
    } catch {
      console.error(`E_INDEX_MISSING：${INDEX_NAME} 不存在。运行 node reference-index.mjs --write 生成。`)
      process.exit(1)
    }
    if (actual.trim() !== expected.trim()) {
      console.error('E_INDEX_STALE：索引与实际文件不一致（有文件增删或改了小标题）。运行 --write 重新生成。')
      process.exit(1)
    }
    console.log('索引与文件一致')
    return
  }

  if (argv.includes('--write')) {
    await writeFile(indexPath, `${expected}\n`, 'utf8')
    console.log(`已写出 ${indexPath}`)
    return
  }

  console.log(expected)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`E_INTERNAL：${error.stack ?? error.message}`)
    process.exit(1)
  })
}
