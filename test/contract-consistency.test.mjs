// 防的漂移：contract.mjs 与 assets/ 模板、PRD、判据的取值不一致（技术文档 D-01）。
// 期望值一律硬编码为本文件内的字面量：期望由被测的 tableColumns()/COLUMNS 自身生成＝测试跟着实现走，
// 漂移不可见（评审 P21）。SOURCE_PATTERN 本身仍从 contract 导入（它就是被测对象），样本硬编码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COLLECTIONS, COLUMNS, ENUMS, PROTAGONIST_FILES, QUOTE_PATTERN, SECTIONS, SOURCE_CLAIM_LABELS, SOURCE_META_LABELS,
  SOURCE_PATTERN, THRESHOLDS, TOPICS, tableColumns,
} from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const assets = join(root, 'skills', 'book-breakdown', 'assets')

const PRODUCT_STYLE = {
  全书大纲: '全书大纲模板.md',
  卷纲: '卷纲模板.md',
  幕纲: '幕纲模板.md',
  金手指: '金手指模板.md',
  世界观: '世界观模板.md',
  文风: '文风模板.md',
  作者的话: '作者的话模板.md',
  开篇三章: '开篇三章模板.md',
  专题: '专题模板.md',
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('SECTIONS 的每个段名都出现在对应模板里（标题或字段）', async () => {
  for (const [product, file] of Object.entries(PRODUCT_STYLE)) {
    const text = await readFile(join(assets, file), 'utf8')
    for (const section of SECTIONS[product]) {
      const asHeading = new RegExp(`^#{2,3}\\s+${escapeRe(section)}(?=\\s|$|（)`, 'm').test(text)
      const asField = new RegExp(`^-\\s*${escapeRe(section)}：`, 'm').test(text)
      assert.ok(asHeading || asField, `${file} 缺段名「${section}」`)
    }
  }
})

// 三张表的期望表头＝字面量（评审 P21）。
// 列数跟进（Q-23/Q-24 跟进）：逐章记录 9→11 列（加章末钩型/爽点标记）、伏笔台账 8→11 列（加类型/回收幕/重要度）、
// 分卷总表 13→15 列单数组（加本卷主要对手/追读钩，商业外证常驻，去「（可选）」后缀）。
const EXPECTED_TABLE_COLUMNS = {
  分卷总表: [
    '卷', '卷名', '卷名来源与释义', '起止章', '章数', '字数与均章长', '爽点密度', '一句话钩子', '核心压力源',
    '本卷主要对手', '主角状态变化', '新地图与新势力', '卷末状态（悬念定格方式）', '追读钩', '时间跨度', '商业外证',
  ],
  // 九列跟进（Q-22）：「剧情线」插在「一句话事件」之后、「伏笔埋/收」之前。
  // 十一列跟进（Q-23/Q-24 跟进）：「章末钩型」「爽点强度」接在「情绪」之后。
  // 十二列：「章字数」紧跟「标题」——三书实测章长波动需章级可见，且该列由脚本填不由 agent 判断。
  // 十三列（A-09）：原「爽点标记」正名为「爽点强度」（值本来就是强度四档），并追加「爽点类型」。
  // 十四列（模板审查 §2.6 第 8 项）：末尾追加「故事内时间」——卷级时间跨度看不出「这段故事过了多久」。
  // 十五列（第三轮盲写复测）：末尾追加「章首句」——复测里唯一整项崩掉的是开场方式。
  逐章记录: ['全局章号', '标题（清洗后）', '章字数', '视角人物', '地点', '出场人物', '一句话事件', '剧情线', '伏笔埋/收', '情绪', '章末钩型', '爽点强度', '爽点类型', '故事内时间', '章首句'],
  // 十一列跟进（Q-23/Q-24 跟进）：「类型」在「描述」后、「回收幕」在「回收/引爆章」后、「重要度」在「状态」前。
  // 十四列（反向可写性审查 §5.1 的 P0）：加「埋点时读者以为／回收时真相／颗粒度」——
  // 知识库的最小伏笔表是「埋点／表层理解／真实作用／回收位置」，中间那两层原先整片缺失。
  伏笔台账: ['编号', '描述', '埋点时读者以为', '回收时真相', '类型', '埋点章', '强化章', '回收/引爆章', '回收幕', '跨度', '涉及实体', '颗粒度', '重要度', '状态'],
  别名词典: ['别称', '主名', '实体类型', '首次出现章', '归并依据'],
}
const TABLE_TEMPLATE = {
  分卷总表: '分卷总表模板.md',
  逐章记录: '逐章记录模板.md',
  伏笔台账: '伏笔台账模板.md',
  别名词典: '别名词典模板.md',
}

test('表头契约与模板表头一致', async () => {
  for (const [name, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    assert.deepEqual(tableColumns(name), expected, `${name} 的契约表头与硬编码期望不一致`)
    const text = await readFile(join(assets, TABLE_TEMPLATE[name]), 'utf8')
    for (const column of expected) {
      assert.ok(text.includes(column), `${TABLE_TEMPLATE[name]} 缺表头列「${column}」`)
    }
  }
})

// 段名跟进（Q-23/Q-24 跟进）：大纲 3→4 块、卷纲 8→9 段、幕纲 9→10 段；期望段名硬编码防漂移。
const EXPECTED_SECTIONS = {
  全书大纲: ['故事设计', '核心冲突装置', '全书骨架段清单', '九节点检查单'],
  卷纲: [
    '卷命题与目标', '主要冲突与对手', '事件弧清单', '关键事件链', '人物弧线',
    '伏笔埋设与回收', '新地图与新设定投放', '节奏与章末钩画像', '卷末收束与悬念定格',
  ],
  幕纲: [
    '幕定位', '幕目标', '对手与对抗', '信息差账', '核心事件链', '场次表', '出场与退场人物账', '地点与时段',
    '主角所得与所失', '幕末钩子', '情绪基调与走向', '与卷纲的对应',
  ],
}

test('段名契约：全书大纲 4 块、卷纲 9 段、幕纲 12 段（A-2；幕纲 12 段＝10 段＋信息差账＋场次表）', () => {
  for (const [product, expected] of Object.entries(EXPECTED_SECTIONS)) {
    assert.deepEqual(SECTIONS[product], expected, `${product} 的段名与硬编码期望不一致`)
  }
})

// 取值枚举（Q-23/Q-24、A-08/A-09 跟进）：钩型/爽点强度/爽点类型/功能位/伏笔类型/伏笔重要度入 ENUMS，硬编码防漂移。
test('枚举契约：钩型／爽点强度／爽点类型／功能位／伏笔类型／伏笔重要度入 ENUMS', () => {
  assert.deepEqual(ENUMS.钩型, ['危机', '悬念', '期待', '反差', '钝收'])
  assert.deepEqual(ENUMS.爽点强度, ['无', '小', '中', '大'])
  assert.deepEqual(ENUMS.爽点类型, ['打脸', '逆袭', '获得', '解惑', '情感', '奇观'])
  assert.deepEqual(ENUMS.功能位, ['导师', '镜子', '压力源', '氛围', '线索人', '对手', '工具人'])
  assert.deepEqual(ENUMS.伏笔类型, ['道具', '身份', '情感', '设定', '事件'])
  assert.deepEqual(ENUMS.伏笔重要度, ['主线', '支线', '边角'])
  // A-09 的兼容别名：旧键名仍可用，且与正名指向同一组值（同一个引用，改一处即两处生效）
  assert.equal(ENUMS.爽点标记, ENUMS.爽点强度, '旧键名「爽点标记」应指向「爽点强度」同一数组')
})

test('人物卡模板含三要素与面具与真相（Q-24，A-6）', async () => {
  const text = await readFile(join(assets, '人物卡模板.md'), 'utf8')
  for (const field of ['外在目标（要什么）', '内在缺口（缺什么）', '致命弱点（会毁在哪）']) {
    assert.ok(text.includes(`- ${field}`), `人物卡模板缺三要素字段「${field}」`)
  }
  assert.ok(text.includes('### 面具与真相'), '人物卡模板缺深化段「面具与真相」')
})

test('出处格式接受枚举、区间与幕（龙族1 卡壳修复回归）', () => {
  for (const good of ['（第 1 章：「引」）', '第4、10章', '第 2-11 章', '第3幕', '第2至5章', '第 1、3、5 章']) {
    assert.ok(SOURCE_PATTERN.test(good), `应接受出处写法：${good}`)
  }
  for (const bad of ['无出处', '某章']) {
    assert.ok(!SOURCE_PATTERN.test(bad), `应拒绝：${bad}`)
  }
})

test('出处区间的连接符认 en dash 与全角短横（真书实测回归）', () => {
  // 《长安的荔枝》实测：模板写「第 2–5 章」时被判缺出处，改写成「第 2 至 5 章」才过。
  // en dash 是中文排版最常见的区间符，必须认。
  for (const good of ['第 2–5 章', '第 2－5 章', '第 2—5 章', '第 2~5 章', '第 2-5 章', '第 2 至 5 章', '第 0–6 幕']) {
    assert.ok(SOURCE_PATTERN.test(good), `应接受区间连接符：${good}`)
  }
  // 反向：不能因为放宽连接符就吞掉无章号的写法
  for (const bad of ['第 2 到 5 章', '第几章', '第 2 段']) {
    assert.ok(!SOURCE_PATTERN.test(bad), `不该误判为出处：${bad}`)
  }
})

test('引句正则要求引号内至少两字（防空引号与单字引号冒充引句）', () => {
  for (const good of ['（「荔枝鲜」）', '（“一日色变”）', '『甲乙』']) {
    assert.ok(QUOTE_PATTERN.test(good), `应认作引句：${good}`)
  }
  for (const bad of ['（「」）', '（“”）', '（「十」）', '（“一”）']) {
    assert.ok(!QUOTE_PATTERN.test(bad), `不该认作引句：${bad}`)
  }
})

// 人物索引列的期望＝字面量；PRD 侧按 F-15 的原文措辞断言。
// 原断言对「全局主次/弧内主次」带 `|| column === '…'` 恒真分支，列漂移不会被发现（评审 P21）。
const EXPECTED_CHARACTER_INDEX_COLUMNS = ['姓名', '别称', '全局主次', '弧内主次', '立场', '首次出场章', '文件路径']

test('目录契约与 PRD 产物结构一致', async () => {
  const prd = await readFile(join(root, 'docs', '产品', 'PRD.md'), 'utf8')
  for (const types of Object.values(COLLECTIONS)) {
    for (const t of types) assert.ok(prd.includes(t), `PRD 缺集合分类「${t}」`)
  }
  for (const t of TOPICS) assert.ok(prd.includes(t), `PRD 缺专题槽位「${t}」`)
  for (const f of PROTAGONIST_FILES) assert.ok(prd.includes(f), `PRD 缺主角五文件「${f}」`)
  assert.deepEqual(COLUMNS.人物索引, EXPECTED_CHARACTER_INDEX_COLUMNS)
  for (const column of ['姓名', '别称', '立场', '首次出场章', '文件路径']) {
    assert.ok(prd.includes(column), `PRD 缺人物索引列「${column}」`)
  }
  assert.ok(prd.includes('主次（全局＋弧内双口径）'), 'PRD 缺人物索引主次双口径措辞（F-15）')
})

test('阈值与判据、PRD 一致', async () => {
  const prd = await readFile(join(root, 'docs', '产品', 'PRD.md'), 'utf8')
  const judge = await readFile(join(root, 'skills', 'book-breakdown', 'references', '判据', '主次判定判据.md'), 'utf8')
  assert.ok(judge.includes('60%'), '判据缺主角阈值 60%')
  assert.ok(judge.includes('30%'), '判据缺弧内阈值 30%')
  assert.ok(judge.includes('10 倍'), '判据缺别名归并 10 倍')
  assert.ok(prd.includes('20 章'), 'PRD 缺单批 20 章')
  assert.ok(prd.includes('章节数 < 3') || prd.includes('< 3'), 'PRD 缺 <3 章护栏')
  assert.ok(prd.includes('1.5 万字'), 'PRD 缺出版书均章阈值')
  assert.equal(THRESHOLDS.主角全局占比, 0.6)
  assert.equal(THRESHOLDS.弧线配角卷内占比, 0.3)
  assert.equal(THRESHOLDS.单批章数上限, 20)
  assert.equal(THRESHOLDS.最少章节数, 3)
  assert.deepEqual(ENUMS.每卷幕数, [2, 6])
  assert.ok(prd.includes('2-6'), 'PRD 缺每卷幕数 2-6')
})

// M-04 回归：模板「内容」节的每个「- 字段名：」标签，要么是元字段（豁免出处检查），
// 要么必须是 SOURCE_CLAIM_LABELS 里登记过的结论字段。两处都不在＝照模板填写会被 E_SOURCE 误判（86% 误报的根因）。
// 反向同时守住：结论字段不得被登记进元字段白名单，否则出处门禁被悄悄放水。
const SOURCE_GOVERNED_TEMPLATES = [
  '全书大纲模板.md', '卷纲模板.md', '幕纲模板.md', '开篇三章模板.md', '世界观模板.md',
  '金手指模板.md', '专题模板.md', '主角解构模板.md', '人物卡模板.md', '势力卡模板.md',
  '地点卡模板.md', '物品卡模板.md', '概念卡模板.md',
]

function contentFieldLabels(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+内容/.test(l))
  if (start === -1) return []
  const labels = []
  for (const line of lines.slice(start + 1)) {
    const m = /^-\s*([^：:]{1,24})[：:]/.exec(line.trim())
    if (!m) continue
    const label = m[1].trim()
    // 排除「说明条目」被误读成字段声明：模板里的字段名是「外在目标（要什么）」这种纯名词，
    // 不会含 Markdown 强调符。写「- **写机制，不抄台词**：…」这类强调式说明时，
    // 那个全角冒号会被当成字段分隔符，报「未登记字段」——而它压根不是字段。
    // 这个误报在写模板时反复出现（三轮验证里踩了三次），故从源头排除。
    if (label.includes('**') || label.includes('`')) continue
    labels.push(label)
  }
  return labels
}

test('模板字段标签：元字段可豁免出处，结论字段必须受出处检查（M-04）', async () => {
  const unregistered = []
  for (const file of SOURCE_GOVERNED_TEMPLATES) {
    const text = await readFile(join(assets, file), 'utf8')
    for (const label of contentFieldLabels(text)) {
      const isMeta = SOURCE_META_LABELS.test(`${label}：`)
      const isClaim = SOURCE_CLAIM_LABELS.includes(label)
      if (!isMeta && !isClaim) unregistered.push(`${file} 的「${label}」`)
      assert.ok(!(isMeta && isClaim), `「${label}」不能同时登记为元字段与结论字段`)
    }
  }
  assert.deepEqual(unregistered, [], `以下字段照模板填写会被 E_SOURCE 误判，须登记进 SOURCE_META_LABELS 或 SOURCE_CLAIM_LABELS：${unregistered.join('；')}`)
})

test('结论字段不得被元字段白名单放水（M-04 反向）', () => {
  for (const label of SOURCE_CLAIM_LABELS) {
    assert.ok(!SOURCE_META_LABELS.test(`${label}：`), `结论字段「${label}」不得豁免出处检查`)
  }
})

// 人物可感知信息三字段（三书实测补齐）：体貌/衣着/神态动作是结论不是档案坐标，
// 必须留在人物卡模板里且继续受出处检查——否则又退回「户口本」形态。
test('人物卡模板含人物可感知三字段，且不得被豁免出处检查', async () => {
  const text = await readFile(join(assets, '人物卡模板.md'), 'utf8')
  for (const field of ['体貌锚点', '衣着与装束', '神态与动作锚']) {
    assert.ok(text.includes(`- ${field}`), `人物卡模板缺可感知字段「${field}」`)
    assert.ok(SOURCE_CLAIM_LABELS.includes(field), `「${field}」须登记进 SOURCE_CLAIM_LABELS`)
    assert.ok(!SOURCE_META_LABELS.test(`${field}：`), `「${field}」是结论字段，不得豁免出处检查`)
  }
  // 三字段都必须写明「原文没有时怎么办」，这是防止 agent 编造的关键。
  for (const field of ['体貌锚点', '衣着与装束', '神态与动作锚']) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`- ${field}：`))
    assert.ok(/无则写「无」/.test(line), `「${field}」须写明「无则写「无」，不得推断」`)
  }
})

// 幕型枚举漂移（12 vs 10）只有这条能抓住：模板枚举括号里列出的每一类都必须是契约里的一类。
// 只取「幕型枚举…：A／B／C）」这段括号内的取值，不扫正文里出现的「事件弧」等叙述词。
test('模板列出的幕型全部在 ENUMS.幕型 内，且数量一致（12 vs 10 回归）', async () => {
  for (const file of ['幕纲模板.md', '卷纲模板.md']) {
    const text = await readFile(join(assets, file), 'utf8')
    // 只认同一行内、紧跟在「幕型枚举」或「弧型枚举同幕纲幕型」之后的那个括注，不跨行。
    const line = text.split(/\r?\n/).find((l) => /幕型枚举|弧型枚举同幕纲幕型/.test(l))
    assert.ok(line, `${file} 找不到幕型枚举行`)
    const block = /（([^）]*)）/.exec(line)
    assert.ok(block, `${file} 的幕型枚举行没有括注`)
    // 括注里可能带前缀说明（「起止章＋幕型；幕型枚举：…」），只取全角冒号之后的部分。
    const listText = block[1].replace(/^[^：]*：/, '')
    // 模板允许用缩写（「案件」代「案件弧」）：比较时统一去掉末尾的「弧」。
    const strip = (s) => s.replace(/弧$/, '')
    const listed = [...new Set(listText.split('／').map((s) => strip(s.trim())).filter(Boolean))]
    const known = new Set(ENUMS.幕型.map(strip))
    const missing = listed.filter((t) => !known.has(t))
    assert.deepEqual(missing, [], `${file} 列了契约里没有的幕型：${missing.join('、')}`)
    assert.equal(listed.length, known.size, `${file} 列出 ${listed.length} 类幕型，契约是 ${known.size} 类`)
  }
})

// 模板与骨架必须同形：骨架由 contract 的 mdSkeleton 生成（## 标题），
// 模板若把段名写成「- 字段：」列表条目，照模板填写就会被 E_SECTION 判缺段（M-01/M-02 的根因）。
test('模板段名写成标题而非列表条目，与骨架同形（M-01/M-02）', async () => {
  const offenders = []
  for (const [product, file] of Object.entries(PRODUCT_STYLE)) {
    const text = await readFile(join(assets, file), 'utf8')
    for (const section of SECTIONS[product]) {
      const asHeading = new RegExp(`^#{2,3}\\s+${escapeRe(section)}\\s*$`, 'm').test(text)
      if (asHeading) continue
      // 允许作为段内字段出现（如卷纲的「卷号与卷名」），但不得是 SECTIONS 里的段名本身。
      const asField = new RegExp(`^-\\s*${escapeRe(section)}：`, 'm').test(text)
      if (asField) offenders.push(`${file} 的「${section}」写成了列表条目`)
    }
  }
  assert.deepEqual(offenders, [], `段名须写成 ## 或 ### 标题（校验器 headings() 只认标题）：${offenders.join('；')}`)
})
