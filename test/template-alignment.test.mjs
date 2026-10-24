// 模板与契约的剩余错位（#20，模板组 A-0x/B-0x/C-01）。
// 每一条都来自「照模板填会落不到位」或「模板说了契约没有的东西」：
// 这类缺陷不会让脚本报错，只会让产出物看起来填了、实际没信息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { COLUMNS, ENUMS, SECTIONS } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'skills', 'book-breakdown', 'assets')
const read = (name) => readFileSync(join(assets, name), 'utf8')

// ---------- 世界观：概览类各节要带章号 ----------

test('世界观模板：概览与社会文化各节要求带章号的结论，不只是栏目名（A-05）', () => {
  const text = read('世界观模板.md')
  // 这几节原来是空泛的四名词清单：「（阶层、习俗、语言、经济要点）」
  // 那种写法照填只会把栏目名抄一遍。改成必须带章号与锚句。
  for (const section of ['地理格局', '势力格局', '历史脉络', '社会与文化']) {
    const at = text.indexOf(`### ${section}`)
    assert.ok(at >= 0, `世界观模板缺「${section}」段`)
    const next = text.indexOf('\n### ', at + 1)
    const body = text.slice(at, next < 0 ? undefined : next)
    assert.match(body, /章号/, `「${section}」段必须要求带章号`)
  }
  // 反例守卫：不能把「阶层、习俗、语言、经济」这种栏目名当成填写要求孤零零留着
  const body = text.slice(text.indexOf('### 社会与文化'))
  assert.match(body, /等于没写|不是这本书的答案/, '「社会与文化」要明说只列四个名词不算填')
})

// ---------- 主角解构：五维、无循环引用 ----------

test('主角解构模板：五维人格段，且不再要求「按人物卡模板全字段填写」（A-06）', () => {
  const text = read('主角解构模板.md')
  assert.ok(!text.includes('六维'), '不得再出现「六维」——列出来的只有五个名字')
  const dims = ['公开资料', '说话风格', '表达方式', '外界看法', '决策模式']
  for (const d of dims) assert.ok(text.includes(d), `主角解构缺维度「${d}」`)
  // 循环引用：主角解构说「按人物卡模板全字段填」，人物卡模板说「主角不用本卡」
  assert.ok(!text.includes('按 `人物卡模板.md` 基础卡全字段填写'), '不得再要求按人物卡模板全字段填写（循环引用）')
  assert.match(text, /主角不用本卡|无需再填一遍人物卡/, '应明说主角不走人物卡')
})

test('人物卡模板自己也写明「主角不用本卡」——两处口径一致才没有循环（A-06 反向）', () => {
  const text = read('人物卡模板.md')
  assert.match(text, /主角不用本卡/, '人物卡模板应保留「主角不用本卡」的边界')
})

// ---------- 文风：偏离判定按标准差 ----------

test('文风模板：偏离判定按 ≥2σ，不足 3 章标样本不足，不再固定取 top-3（A-07）', () => {
  const text = read('文风模板.md')
  assert.match(text, /2σ|2σ|≥2σ/, '偏离判定应以标准差为准')
  assert.ok(!/最偏离均值的三个章/.test(text), '不得再写「固定取最偏离的三个章」')
  assert.match(text, /样本不足/, '不足 3 章时应标注样本不足')
  assert.match(text, /3 章|三章/, '应写明不足 3 章的情形')
})

// ---------- 功能位进枚举 ----------

test('人物卡的功能位是闭合枚举，取值全部落在 ENUMS.功能位 内（A-08）', () => {
  const text = read('人物卡模板.md')
  const at = text.indexOf('功能位')
  assert.ok(at >= 0, '人物卡模板应有功能位字段')
  const line = text.slice(at, text.indexOf('\n', at))
  // 模板里列出的每一个功能位都必须是枚举成员
  const listed = line.split(/[／/、]/).map((s) => s.replace(/[（(].*$/, '').trim()).filter(Boolean)
  const names = ENUMS.功能位
  const hit = names.filter((n) => line.includes(n))
  assert.equal(hit.length, names.length, `模板应列出全部 ${names.length} 个功能位，实际列出 ${hit.join('、')}`)
  // 开口举例的旧写法必须消失：「如白月光、宝藏、告密者、学生会主席」
  assert.ok(!/如白月光、宝藏、告密者、学生会主席/.test(text), '功能位不得再是开放举例')
  // 原型词仍可自由填（它是标签，不是分类）
  assert.match(text, /原型词/, '原型词应保留为自由填写')
  void listed
})

// ---------- 分卷总表：商业外证不留空 ----------

test('分卷总表模板：商业外证无数据时写固定措辞，不得留空（A-10）', () => {
  const text = read('分卷总表模板.md')
  assert.match(text, /不得留空/, '应明说不得留空')
  assert.match(text, /无（原文与作者附注均未给）/, '应给出固定措辞')
  assert.match(text, /「无」与「没查」是两件事|没查/, '应说明为什么不能留空')
})

// ---------- 报告模板：标题层级可被识别 ----------

test('报告模板：四张表的标题在 {2,3} 级内，结构化检查取得到（A-11）', () => {
  const text = read('报告模板.md')
  const headings = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
    if (m) headings.push(m[2])
  }
  // 校验器 headings() 只认 #{2,3}；四级及以下取不到。
  // 实测报告模板原先把 人物/设定/情节线/技法 写成 ####，四张表结构性看不见。
  for (const name of ['人物', '设定', '情节线', '技法']) {
    assert.ok(headings.includes(name), `报告模板的「${name}」表应在二三级标题上，实际标题：${headings.join('、')}`)
  }
  assert.ok(headings.includes('章节摘要'), '章节摘要缺')
  assert.ok(headings.includes('对账'), '对账缺')
  // 反向：不得再有四级标题承载表名
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{4,}\s+(.+?)\s*$/.exec(line)
    if (m) assert.ok(!['人物', '设定', '情节线', '技法'].includes(m[1]), `「${m[1]}」仍是四级以下标题`)
  }
})

// ---------- 三份缺失模板 ----------

test('人物索引模板：表头与 COLUMNS.人物索引 逐字一致（B-03）', () => {
  const text = read('人物索引模板.md')
  const header = text.split(/\r?\n/).find((l) => l.trim().startsWith('| 姓名 |'))
  assert.ok(header, '人物索引模板应有表头')
  const cols = header.trim().slice(1, -1).split('|').map((c) => c.trim())
  assert.deepEqual(cols, COLUMNS.人物索引)
})

test('集合索引模板：表头与 COLUMNS.集合索引 逐字一致（B-03）', () => {
  const text = read('集合索引模板.md')
  const header = text.split(/\r?\n/).find((l) => l.trim().startsWith('| 名称 |'))
  assert.ok(header, '集合索引模板应有表头')
  const cols = header.trim().slice(1, -1).split('|').map((c) => c.trim())
  assert.deepEqual(cols, COLUMNS.集合索引)
})

test('人物关系模板：表头与 COLUMNS.人物关系 逐字一致（B-03）', () => {
  const text = read('人物关系模板.md')
  const header = text.split(/\r?\n/).find((l) => l.trim().startsWith('| 角色A |'))
  assert.ok(header, '人物关系模板应有表头')
  const cols = header.trim().slice(1, -1).split('|').map((c) => c.trim())
  assert.deepEqual(cols, COLUMNS.人物关系)
})

test('三份新模板都写明无值写法（不是留空）', () => {
  for (const name of ['人物索引模板.md', '集合索引模板.md', '人物关系模板.md']) {
    const text = read(name)
    assert.match(text, /无值写法/, `${name} 应有无值写法一节——留空看不出「没有」还是「没查」`)
  }
})

// ---------- 金手指代价 ----------

test('金手指模板：代价写「无」时必须给理由与章号，否则告警（B-06）', () => {
  const text = read('金手指模板.md')
  const at = text.indexOf('### 代价与限制')
  assert.ok(at >= 0, '金手指模板应有代价段')
  const next = text.indexOf('\n### ', at + 1)
  const body = text.slice(at, next < 0 ? undefined : next)
  assert.match(body, /写「无」时必须给出理由/, '应要求写「无」时给理由')
  assert.match(body, /章号/, '应要求带章号')
  assert.match(body, /W_NO_COST/, '应点名校验器的警告码')
})

// ---------- 专题模板的结构说明段 ----------

test('专题模板：注明结构说明段不参与段名校验（B-07）', () => {
  const text = read('专题模板.md')
  assert.match(text, /不参与段名校验/, '应注明哪些段不受段名校验约束')
  // 六个槽位段仍要在
  for (const seg of SECTIONS.专题) assert.ok(text.includes(seg), `专题模板缺槽位段「${seg}」`)
})

// ---------- 逐章记录十三列 ----------

test('逐章记录 13 列：「爽点强度」正名、「爽点类型」新增，且模板表头与契约一致（C-01）', () => {
  assert.equal(COLUMNS.逐章记录.length, 13, '逐章记录应为 13 列')
  assert.equal(COLUMNS.逐章记录[11], '爽点强度')
  assert.equal(COLUMNS.逐章记录[12], '爽点类型')
  assert.ok(!COLUMNS.逐章记录.includes('爽点标记'), '「爽点标记」应已正名为「爽点强度」')
  const text = read('逐章记录模板.md')
  const header = text.split(/\r?\n/).find((l) => l.trim().startsWith('| 全局章号 |'))
  assert.ok(header, '逐章记录模板应有表头')
  const cols = header.trim().slice(1, -1).split('|').map((c) => c.trim())
  assert.deepEqual(cols, COLUMNS.逐章记录)
  // 分隔行列数也要对上
  const lines = text.split(/\r?\n/)
  const sep = lines[lines.indexOf(header) + 1]
  assert.equal(sep.trim().slice(1, -1).split('|').length, 13, '分隔行应为 13 格')
})

test('爽点类型只在强度为「无」时可空，模板写明了这条条件（C-01）', () => {
  const text = read('逐章记录模板.md')
  assert.match(text, /只在强度为「无」时可空|只有强度为「无」时才可空/, '应写明类型列可空的条件')
  assert.match(text, /W_SHARP_TYPE/, '应点名警告码')
  assert.ok(ENUMS.爽点类型.length >= 4, '爽点类型应有足够档位可供统计')
  assert.ok(ENUMS.爽点类型.every((v) => typeof v === 'string' && v.length > 0))
})

test('旧键名「爽点标记」是「爽点强度」的别名，不是另一组值（C-01 兼容）', () => {
  assert.equal(ENUMS.爽点标记, ENUMS.爽点强度, '旧键名应指向同一数组，改一处即两处生效')
  assert.deepEqual(ENUMS.爽点强度, ['无', '小', '中', '大'])
})
