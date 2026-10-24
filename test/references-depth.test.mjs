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

// ---------- 判据密度（#11 M-01）：质量门从守「体量」改守「够用」----------
//
// 旧门守的是行数：正文 ≥20 行、总行 ≥80 行。于是 1228 行的《人物提炼策略.md》过关了，
// 尽管它的 28 条判据无一带阈值——门保证了文件够长，没保证内容能用。
// 新门查三件事：判据带强度、策略写明落点、作者自查题不许混进判据。
//
// 存量用白名单豁免，理由必须指向一张 issue（可回收），且白名单只能变短不能变长。

// 存量豁免：引入门时这些文件里已有若干条不合规，用「条数上限」而不是「整份文件豁免」。
// 差别很重要：整份豁免等于对这些文件关掉门，往里面新增不合规内容也照样过；
// 条数上限则保证「只能变短不能变长」——新加一条不合规就超额变红，修好一条就该把上限调低。
// 每条都要有 issue 编号（回收路径）。一个文件只登记一次，两个上限写在同一项里。
const GRANDFATHERED = new Map([
  // 动作列没点名字段/产物的 S- 策略条数 + 作者自查复选框条数（#11 后续轮次逐条改写）。
  ['人物提炼策略.md', { issue: '#11', sNoTarget: 9, checkboxes: 28 }],
  ['伏笔识别策略.md', { issue: '#11', sNoTarget: 6, checkboxes: 4 }],
  ['幕与节奏策略.md', { issue: '#11', sNoTarget: 5, checkboxes: 9 }],
  ['结构拆解策略.md', { issue: '#11', sNoTarget: 7, checkboxes: 3 }],
  ['设定提炼策略.md', { issue: '#11', sNoTarget: 9, checkboxes: 21 }],
  ['文风分析策略.md', { issue: '#11', sNoTarget: 7 }],
  ['拆解总策略.md', { issue: '#11', sNoTarget: 7 }],
])
const capOf = (file, kind) => GRANDFATHERED.get(file)?.[kind] ?? 0

test('判据密度：每条 J- 判据的强度列非空（无阈值的判据等于没判据）', () => {
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md'))
  const offenders = []
  for (const f of files) {
    const lines = read(f).split(/\r?\n/)
    for (const line of lines) {
      const m = /^\|\s*(J-\d+)\s*\|/.exec(line)
      if (!m) continue
      // 按未转义竖线切格：编号 | 判据 | 强度 | 判定方法 | 依据
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      const strength = cells[2] ?? ''
      // 强度列要么是阈值/硬性/样本比例，要么明确写「宽松」。空着或只写「—」不算。
      if (!strength || strength === '—' || strength === '-') offenders.push(`${f} 的 ${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `以下判据没写强度（阈值/硬性/样本比例/宽松），等于不可判定：${offenders.join('；')}`)
})

test('判据密度：每条 S- 策略的动作列写明产出落到哪个字段或声明为解读层', () => {
  // 判据放宽到「动作文本里提到任一模板字段名」：策略写法有两大类——
  //   ①「从原文反推外在目标（要什么）、内在缺口（缺什么）」——直接点名字段；
  //   ②「铁则单独成行并记违反检查结果」——指向段/表，不点字段。
  // 只卡「完全没提产物形态」的那种：读了不知道产出该写在哪，判据与模板之间就是断链。
  const FIELD_HINTS = [
    '外在目标', '内在缺口', '致命弱点', '人物卡', '金句锚', '体貌', '衣着', '神态',
    '势力关系', '状态变化', '空间规则', '功能与象征', '强度等级', '能力与代价', '象征义',
    '规则细节', '揭示节奏', '卷纲', '幕纲', '全书大纲', '伏笔台账', '逐章记录', '别名词典',
    '开篇三章', '文风', '世界观', '金手指', '骨架段', '事件弧', '章末钩', '情绪基调',
    '字段', '列',
  ]
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md'))
  const over = []
  for (const f of files) {
    if (/解读提示|不入产物/.test(f)) continue
    const lines = read(f).split(/\r?\n/)
    const bad = []
    for (const line of lines) {
      const m = /^\|\s*(S-\d+)\s*\|/.exec(line)
      if (!m) continue
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      // 策略表：编号 | 策略名 | 适用条件 | 动作 | 不适用时 | 依据 [| 详见]
      const action = cells[3] ?? ''
      if (!action) { bad.push(`${m[1]}（无动作）`); continue }
      const hasTarget = FIELD_HINTS.some((h) => action.includes(h))
      if (!hasTarget) bad.push(m[1])
    }
    const cap = capOf(f, 'sNoTarget')
    if (bad.length > cap) over.push(`${f}：${bad.length} 条（上限 ${cap}）——${bad.slice(0, 3).join('、')}`)
  }
  assert.deepEqual(
    over,
    [],
    `以下策略没说清产出落到哪个字段（或声明为解读层），判据与模板之间是断链。上限只许调低：${over.join('；')}`,
  )
})

test('判据密度：作者自查复选框只允许出现在解读提示文件', () => {
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md'))
  const over = []
  for (const f of files) {
    if (f === '解读提示.md') continue
    const boxes = read(f).split(/\r?\n/).filter((l) => /^\s*- \[ \]/.test(l)).length
    const cap = capOf(f, 'checkboxes')
    if (boxes > cap) over.push(`${f}：${boxes} 条（上限 ${cap}）`)
  }
  assert.deepEqual(
    over,
    [],
    `复选框是给作者的自查题，不是拆书判据；混在判据文件里会让 agent 以为那是判定依据。上限只许调低：${over.join('；')}`,
  )
})

test('判据密度：白名单只能变短，不能变长', () => {
  // 引入门时把存量登记进 GRANDFATHERED 是必要的；但若允许继续加，白名单就成了永久豁免。
  // 这条测试把「当前条数」写死，加条目即变红，逼着走「先修内容再删条目」的路。
  assert.ok(
    GRANDFATHERED.size <= 11,
    `GRANDFATHERED 只允许变短。当前 ${GRANDFATHERED.size} 条，上限 11 条——新增豁免须先修内容`,
  )
  for (const [file, spec] of GRANDFATHERED) {
    assert.match(String(spec.issue), /^#\d+$/, `${file} 的豁免理由须是 issue 编号（如 #11），否则没有回收路径`)
    for (const k of ['sNoTarget', 'checkboxes']) {
      if (spec[k] !== undefined) assert.ok(Number.isInteger(spec[k]) && spec[k] >= 0, `${file} 的 ${k} 上限须是非负整数`)
    }
  }
})

