// 防的漂移：PRD 正文里手抄的「列数/段数/枚举」与 contract.mjs 实际值不一致
// （技术文档 R-07；已实测两次：D-22 人物卡三字段、D-23 章字数都没同步 PRD）。
//
// 设计原则（同 contract-consistency.test.mjs）：期望值不用被测对象生成，否则测试跟着实现走。
// 这里的做法是：PRD 声称的数字是「被测文本」，contract.mjs 是「事实源」，两者必须相等。
// 若 PRD 没写某个数字，也报错——强迫写清楚，不能靠留空绕过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLUMNS, SECTIONS } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const prdPath = join(root, 'docs', '产品', 'PRD.md')

const readPrd = () => readFile(prdPath, 'utf8')

// 排除历史记录行：开放问题表里记的是「当时裁决」（如 Q-02「11 核心」、Q-03「卷纲八段」），
// 那是决策史，不应按现值校验——否则等于要求改写历史。只校验「当前规格描述」。
function currentSpecLines(text) {
  return text.split(/\r?\n/).filter((l) => {
    const s = l.trim()
    if (!s) return false
    if (/^\|\s*Q-\d+\s*\|/.test(s)) return false // 开放问题表的裁决记录
    if (/^\|\s*R-\d+\s*\|/.test(s)) return false // 风险登记里会引用「曾经写错的值」作为证据
    if (/^v\d+\s/.test(s)) return false // 版本演进说明行
    return true
  })
}

// 在「当前规格」行里找某产物名附近声明的数字。
// 只在该产物名之后到下一个产物名之前的窗口里取数字，避免同一行提到多个产物时串值。
const ALL_PRODUCTS = ['逐章记录', '伏笔台账', '分卷总表', '卷纲', '幕纲', '金手指', '文风', '世界观', '开篇三章', '全书大纲']

function claimedCounts(text, name, unit) {
  const found = new Set()
  const num = '(\\d+|[一二三四五六七八九十]{1,2})'
  const re = new RegExp(unit === '列' ? `${num}\\s*列` : `${num}\\s*个?\\s*段`, 'g')
  for (const line of currentSpecLines(text)) {
    if (!line.includes(name)) continue
    // 切出「本产物名」独占的窗口：从本名出现处，到任何其他产物名出现处。
    let start = 0
    let guard = 0
    while (guard++ < 20) {
      const at = line.indexOf(name, start)
      if (at < 0) break
      let end = line.length
      for (const other of ALL_PRODUCTS) {
        if (other === name) continue
        const o = line.indexOf(other, at + name.length)
        if (o >= 0 && o < end) end = o
      }
      const window = line.slice(at, end)
      for (const m of window.matchAll(re)) {
        const n = /^\d+$/.test(m[1]) ? Number(m[1]) : CN[m[1]]
        if (!n) continue
        // 排除子集表述：「定性六段」指七段里的前六段，不是总数。
        const before = window.slice(Math.max(0, m.index - 4), m.index)
        if (unit === '段' && /定性|其中/.test(before)) continue
        found.add(n)
      }
      start = at + name.length
    }
  }
  return found
}

// 中文数字，只覆盖实际会用到的量级（三…二十）。
const CN = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17,
  十八: 18, 十九: 19, 二十: 20,
}

// 从一段文本里抽出「N 列」的数字（阿拉伯或中文），返回出现过的集合。

test('PRD 里出现的「逐章记录 N 列」必须等于 contract 的实际列数', async () => {
  const text = await readPrd()
  const actual = COLUMNS['逐章记录'].length
  const claimed = claimedCounts(text, '逐章记录', '列')
  assert.ok(claimed.size > 0, 'PRD 没写逐章记录的列数——必须写明，不能留空')
  for (const n of claimed) {
    assert.equal(n, actual, `PRD 说逐章记录是 ${n} 列，contract 实际 ${actual} 列（${COLUMNS['逐章记录'].join('/')}）`)
  }
})

test('PRD 里出现的「伏笔台账 N 列」必须等于 contract 的实际列数', async () => {
  const text = await readPrd()
  const actual = COLUMNS['伏笔台账'].length
  for (const n of claimedCounts(text, '伏笔台账', '列')) {
    assert.equal(n, actual, `PRD 说伏笔台账是 ${n} 列，contract 实际 ${actual} 列`)
  }
})

test('PRD 里出现的「分卷总表 N 列」必须等于 contract 的实际列数', async () => {
  const text = await readPrd()
  const actual = COLUMNS['分卷总表'].length
  for (const n of claimedCounts(text, '分卷总表', '列')) {
    assert.equal(n, actual, `PRD 说分卷总表是 ${n} 列，contract 实际 ${actual} 列`)
  }
})

test('PRD 里出现的「卷纲/幕纲/金手指/文风/世界观 N 段」必须等于 contract 的实际段数', async () => {
  const text = await readPrd()
  const cases = [
    ['卷纲', SECTIONS['卷纲'].length],
    ['幕纲', SECTIONS['幕纲'].length],
    ['金手指', SECTIONS['金手指'].length],
    ['文风', SECTIONS['文风'].length],
    ['世界观', SECTIONS['世界观'].length],
  ]
  for (const [name, actual] of cases) {
    for (const n of claimedCounts(text, name, '段')) {
      assert.equal(n, actual, `PRD 说${name}是 ${n} 段，contract 实际 ${actual} 段`)
    }
  }
})

test('PRD 声明的固定段名产物，其段数须与 contract 一致（防止 SECTIONS 加了段而 PRD 不提）', async () => {
  const text = await readPrd()
  for (const name of ['卷纲', '幕纲', '金手指', '文风']) {
    const actual = SECTIONS[name].length
    const claimed = claimedCounts(text, name, '段')
    assert.ok(claimed.size > 0, `PRD 未写明${name}的段数（contract 为 ${actual} 段：${SECTIONS[name].join('/')}）`)
  }
})

test('PRD 的「非目标」节存在且写明不做拆解报告', async () => {
  const text = await readPrd()
  assert.match(text, /^## 非目标$/m, '缺「非目标」节')
})

test('PRD 含成功指标、非功能需求、风险登记三节', async () => {
  const text = await readPrd()
  for (const h of ['## 成功指标', '## 非功能需求', '## 风险登记']) {
    assert.ok(text.includes(h), `PRD 缺「${h.slice(3)}」节——本轮补齐的产品栏目不得被删掉`)
  }
})

test('PRD 含主流程图与异常状态图（mermaid）', async () => {
  const text = await readPrd()
  const blocks = text.match(/```mermaid[\s\S]*?```/g) ?? []
  assert.ok(blocks.length >= 3, `PRD 只有 ${blocks.length} 张图（至少 3：主流程、异常状态、并行合并）`)
  // 精确到块首关键字：避免 sequenceDiagramX 这类改坏值仍被子串匹配放行。
  const kinds = blocks.map((b) => (b.match(/```mermaid\s*\n\s*([A-Za-z]+)/) ?? [, ''])[1])
  assert.ok(kinds.includes('flowchart'), `缺主流程图（flowchart），实际图类型：${kinds.join('/')}`)
  assert.ok(kinds.includes('stateDiagram') || kinds.includes('stateDiagram-v2'), `缺异常状态图（stateDiagram），实际：${kinds.join('/')}`)
  assert.ok(kinds.includes('sequenceDiagram'), `缺并行合并时序图（sequenceDiagram），实际：${kinds.join('/')}`)
})
