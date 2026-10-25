// 视野分级（#23）。
// 防的回归：流程文档不约束「哪一步该读原文」，于是全书层去读原文（装不下），
// 或幕层只读摘要（丢因果）。这两件事都不会报错，只会让产物变差。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillDir = join(here, '..', 'skills', 'book-breakdown')
const wfDir = join(skillDir, 'workflows')
const read = (p) => readFileSync(p, 'utf8')
const wf = (name) => read(join(wfDir, name))

// 结构化模式的六个阶段（01-04 是快速报告模式，本工单不动）
const STAGES = [
  '05-结构化初始化.md',
  '06-口径锚定.md',
  '07-卷循环.md',
  '08-设定库.md',
  '09-全书层.md',
  '10-校验交付.md',
]

// 三档视野的规范写法
const TIERS = ['全景', '半景', '远景']

test('05–10 每个阶段都有「视野」小节，且档位取值都在三档之内', () => {
  const bad = []
  for (const name of STAGES) {
    const text = wf(name)
    const m = /^## 视野$/m.test(text)
    if (!m) { bad.push(`${name}: 缺「## 视野」小节`); continue }
    // 取该节正文
    const lines = text.split(/\r?\n/)
    const at = lines.findIndex((l) => /^## 视野$/.test(l))
    let end = lines.length
    for (let i = at + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
    const body = lines.slice(at + 1, end).join('\n')
    // 档位在第一行粗体里
    const tier = /\*\*([^*]+)\*\*/.exec(body)
    if (!tier) { bad.push(`${name}: 视野节没写档位`); continue }
    const t = tier[1]
    // 「全景（有界）」「半景（逐章）＋全景（按幕）」这类组合也算——只要至少含一个规范档位名
    if (!TIERS.some((x) => t.includes(x))) bad.push(`${name}: 档位「${t}」不在三档之内`)
    // 必须明写读原文的许可或禁止
    if (!/读原文[：:]/.test(body)) bad.push(`${name}: 视野节没写「读原文：允许/禁止」`)
  }
  assert.deepEqual(bad, [], bad.join('；'))
})

test('三档含义有统一说明，写在 SKILL.md 里', () => {
  const skill = read(join(skillDir, 'SKILL.md'))
  assert.match(skill, /### 视野分级/, 'SKILL.md 应有「视野分级」一节')
  // 三档都要定义，且各带「看得见什么」与「装得下的依据」
  for (const tier of TIERS) {
    assert.ok(skill.includes(`**${tier}**`), `SKILL.md 的视野表应定义「${tier}」`)
  }
  assert.match(skill, /装得下的依据/, '三档说明应含「装得下的依据」这一列——档位不能只靠命名')
  // 六个阶段文件都指向同一处定义，避免各自解释一套
  for (const name of STAGES) {
    assert.match(wf(name), /SKILL\.md.*视野分级|视野分级.*SKILL\.md/, `${name} 应指向 SKILL.md 的视野分级定义`)
  }
})

test('09 全书层明写「读原文：禁止」与「远景」', () => {
  const text = wf('09-全书层.md')
  // 「禁止」必须是明确的禁止，不是「尽量不读」「建议少读」
  assert.match(text, /读原文[：:]\s*\*\*禁止\*\*/, '09 必须明写「读原文：**禁止**」')
  assert.match(text, /\*\*远景\*\*/, '09 的档位应是「远景」')
  // 要给出理由，否则下一个人会以为这是遗漏
  assert.match(text, /卷纲/, '09 的视野节应说明从卷纲归并')
  assert.match(text, /装不下|45 万/, '09 的视野节应说明为什么读不了原文（装不下）')
})

test('07 的幕级执行与视野分级一致：幕装得下、卷装不下，且给出数字依据', () => {
  // 只看 07 的视野节，不看全文——「按卷读」在步骤段里也出现过，
  // 拿全文匹配会让删掉视野节里的依据也照样通过（变异测试抓到过）。
  const lines = wf('07-卷循环.md').split(/\r?\n/)
  const at = lines.findIndex((l) => /^## 视野$/.test(l))
  assert.ok(at >= 0, '07 应有「视野」节')
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
  const body = lines.slice(at + 1, end).join('\n')

  // 幕级重读原文的规定
  assert.match(body, /按幕重读|按幕读/, '07 的视野节应写明按幕重读原文')
  // 装得下：幕的字数区间与 token 量级必须同屏出现，缺一个就说明依据被删了
  assert.match(
    body,
    /\d+-\d+\s*章约\s*\d+-\d+k token/,
    '07 的视野节应给出「一幕装得下」的数字依据（章数区间 + token 量级）',
  )
  // 装不下：按卷读 + 量级，两个都要在同一句里
  assert.match(
    body,
    /按卷读[^\n]{0,40}(装不下|45 万|\d+\s*万)/,
    '07 的视野节应写明「按卷读装不下」并给量级',
  )
  // 摘要不能替代原文写幕纲——这是视野分级的直接推论
  assert.match(body, /摘要.{0,20}(丢|不能|已经丢)/, '07 的视野节应说明摘要不能替代原文写幕纲')
})

test('PRD 主流程含视野分级横向规则，且与流程文档不冲突', () => {
  const prd = read(join(here, '..', 'docs', '产品', 'PRD.md'))
  assert.match(prd, /\*\*视野分级\*\*/, 'PRD 产品流程节应有「视野分级」横向规则')
  // PRD 必须同样写明这两条硬约束，否则 PRD 与流程文档会漂移
  assert.match(prd, /全书层禁止读原文/, 'PRD 应写明全书层禁止读原文')
  assert.match(prd, /禁止按卷读原文/, 'PRD 应写明禁止按卷读原文')
  // 指向唯一事实源
  assert.match(prd, /SKILL\.md.*视野分级/, 'PRD 应指向 SKILL.md 的视野分级定义')
})

test('视野分级不改动快速报告模式（01–04 没有视野节）', () => {
  for (const name of ['01-切章.md', '02-摘要.md', '03-要素.md', '04-对账.md']) {
    const text = wf(name)
    assert.ok(!/^## 视野$/m.test(text), `${name} 不该有「视野」节——快速报告模式不走三层视野`)
  }
})

test('每个阶段的视野节都不为空，且不是同一段话复制到六处', () => {
  const bodies = []
  for (const name of STAGES) {
    const lines = wf(name).split(/\r?\n/)
    const at = lines.findIndex((l) => /^## 视野$/.test(l))
    let end = lines.length
    for (let i = at + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
    const body = lines.slice(at + 1, end).join('\n').trim()
    assert.ok(body.length >= 60, `${name} 的视野节太短（${body.length} 字符），说不清档位与依据`)
    bodies.push({ name, body })
  }
  // 六处若完全一样，说明是复制粘贴，没有针对阶段写
  const uniq = new Set(bodies.map((b) => b.body))
  assert.equal(uniq.size, bodies.length, '六个阶段的视野节内容完全相同——应各写本阶段的档位与依据')
})
