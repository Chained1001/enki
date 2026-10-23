// 防的漂移：references/ 退化成「索引卡」——只有一张「编号＋一句动作」的表格，
// 机制、正反例、边界情形全丢，且正文依据只指向不随技能下发的本地知识库。
// 背景：2026-10-23 实测 13 份 references 共 379 行，引用知识库某节时只写一行
// （如「卷纲-情节类型骨架 §4.4」一行 8 个词代替源节 260 行的正反例与常见错误）。
// 技能靠 npx skills add 分发，知识库不进包，故这种写法对安装者是断链的索引卡。
//
// 判据设计原则：只断言「结构必须存在且不能退化」，不锁定具体字数或篇目，
// 否则每加一个字都要改测试。阈值取自 2026-10-23 实测分布（见下方注释）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const refDir = join(here, '..', 'skills', 'book-breakdown', 'references')

// 已按「详细说明书」标准搬运完成的文件。新增文件必须先补内容才能进此表。
// 这份清单是「进度账」而非白名单：不在表里的文件不受本测试约束（仍是索引卡形态）。
// 幕边界判据不在内：它是判据件（J 编号），本来就以表格为主，不搬知识库方法论正文。
const PORTED = [
  '幕与节奏策略.md', '结构拆解策略.md', '伏笔识别策略.md',
  '人物提炼策略.md', '设定提炼策略.md',
]

// 搬运节必须含的三类小标题（知识库方法论各节的固定骨架）。
// 只要求「机制＋判据＋错误」三类：这三类缺任一类，文件就退回成一句动作。
// 标题层级不锁定：搬运时可能降级为 #### （嵌在「## 一、」之下），3-6 个 # 都认。
const REQUIRED_KINDS = [
  { name: '机制', re: /^#{3,6} .*(机制|为什么)/m },
  { name: '判据', re: /^#{3,6} .*(判断标准|判断你想清楚了没有)/m },
  { name: '常见错误', re: /^#{3,6} .*常见错误/m },
]

const read = (f) => readFileSync(join(refDir, f), 'utf8')

// 正文行：非空、非表格、非标题、非引用块、非列表短项。用于衡量「有没有解释」。
function proseLines(text) {
  return text.split(/\r?\n/).filter((l) => {
    const s = l.trim()
    return s && !s.startsWith('|') && !s.startsWith('#') && !s.startsWith('>') && s.length > 20
  }).length
}

test('references 已搬运文件含机制/判据/常见错误三类小节，且不只是表格', () => {
  for (const f of PORTED) {
    const text = read(f)
    for (const k of REQUIRED_KINDS) {
      assert.ok(k.re.test(text), `${f} 缺「${k.name}」小节——退回成一句动作即索引卡`)
    }
    // 实测：搬运后正文 23-220 行；退化形态为 7-11 行。取 20 为下限，留 3 行余量。
    const prose = proseLines(text)
    assert.ok(prose >= 20, `${f} 正文仅 ${prose} 行（下限 20）——解释了机制与反例才不是索引卡`)
    // 实测：搬运后 107-1228 行；退化形态为 26-33 行。取 80 为下限。
    const lines = text.split(/\r?\n/).length
    assert.ok(lines >= 80, `${f} 仅 ${lines} 行（下限 80）——搬运整节后不应这么短`)
  }
})

test('references 保留速查表：编号策略行不得因搬运而丢失', () => {
  // 速查表是 agent 的快速定位入口，搬运不得把它替换掉；两种形态必须共存。
  const tableRe = /^\| [A-Z]-\d{2} \|/m
  for (const f of PORTED) {
    assert.ok(tableRe.test(read(f)), `${f} 丢了编号速查表（形如「| S-01 |」），它是 agent 的定位入口`)
  }
})

test('references 不得把「知识库」写成唯一的可执行依据', () => {
  // 知识库不随技能下发，故「某条策略的怎么做」必须在本文件内写清。
  // 判据不是「不许提知识库」（依据节说明来源是好事），而是：
  // 凡正文里把知识库当唯一依据的策略，必须落在下列两种自足形态之一：
  //   a) 已搬运：本文件含机制/判据小节，正文齐全（走 PORTED 那条测试）；
  //   b) 自足型：本文件本身是定义表或纪律表，每条自带可执行内容（如概念辞典的 25 条定义、
  //      总策略的 10 条动作列），不依赖外部正文。
  // 因此这里只查一类真问题：自称搬运了知识库某节，但正文仍是空的。
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md'))
  for (const f of files) {
    const text = read(f)
    if (!text.includes('知识库·方法论')) continue
    // 「搬运」标记：文件里出现了知识库小节标题形态（## 一、/## 二、…）却正文不足＝搬运没落地。
    const hasPortedHeading = /^## [一二三四五六七八九十]、/m.test(text)
    if (!hasPortedHeading) continue
    assert.ok(
      proseLines(text) >= 20,
      `${f} 有搬运小节标题但正文仅 ${proseLines(text)} 行——搬运没落地，等于断链`,
    )
  }
})

test('references 已搬运文件不得引用 docs/（不随技能下发）', () => {
  for (const f of PORTED) {
    assert.ok(!/\]\(docs\/|`docs\//.test(read(f)), `${f} 引用了 docs/，安装者拿不到`)
  }
})
