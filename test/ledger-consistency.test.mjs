// 核查账的自洽性：账上写的条数必须等于报告里实际的条数。
//
// 这份账曾经错过两次，而且两次都是同一种错：
//   ① 模板系列记「20 条」，报告里实有 25 条——总数本身就错了；
//   ② 「未落地 3」却不列是哪三条——数字对不上清单，没人能知道该做什么。
// 所以这里断的不是「某个功能存在」，而是「账与磁盘一致」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const LEDGER = read('docs/研究/改造清单落实核查.md')

// 报告里的条目编号行。用「表首列是编号」判定，不靠标题里的字样。
const counts = {
  '流程 C': { file: '拆书质量审查-流程.md', re: /^\| C-\d+ \|/gm },
  '方法论 M': { file: '拆书质量审查-方法论.md', re: /^\| M-\d+ \|/gm },
  '模板 A/B/C': { file: '拆书质量审查-模板.md', re: /^\| [A-CR]-\d+ \|/gm },
  // 这份报告有五张以数字开头的表，全局 grep 数成 20。只数 §9.2 那一节。
  '产物实证（§9.2）': {
    file: '拆书质量审查-产物实证.md',
    re: /^\| \d+ \|/gm,
    slice: /### 9\.2[\s\S]*?(?=###|$)/,
  },
  '总报告 T 系列': { file: '拆书质量审查-总报告.md', re: /^\| T\d+b? \|/gm },
}

for (const [series, { file, re, slice }] of Object.entries(counts)) {
  test(`核查账：${series} 的总数必须等于报告里的实际条数`, () => {
    const body = slice ? (read('docs/研究/' + file).match(slice)?.[0] ?? '') : read('docs/研究/' + file)
    const actual = (body.match(re) ?? []).length
    const row = new RegExp(`\\| ${series.replace(/[()（）]/g, '.')} \\| (\\d+) \\| (\\d+) \\| \\*\\*(\\d+)\\*\\* \\|`).exec(LEDGER)
    assert.ok(row, `账上要有「${series}」这一行`)
    const [, total, done, left] = row.map(Number)
    assert.equal(total, actual, `${series} 账记 ${total} 条，报告里实有 ${actual} 条`)
    assert.equal(total - done, left, `${series}：总数 ${total} − 已落地 ${done} 应等于未落地 ${left}`)
  })
}

test('核查账：未落地清单里列出的条目数必须等于各系列未落地之和', () => {
  const section = LEDGER.slice(LEDGER.indexOf('## 未落地清单'))
  const listed = (section.match(/^\| [A-Z]-\d+b? \|/gm) ?? []).length
  // 各系列的未落地数（从总表读）
  const rows = [...LEDGER.matchAll(/^\| [^|]+ \| \d+ \| \d+ \| \*\*(\d+)\*\* \|/gm)].map((m) => Number(m[1]))
  const sum = rows.reduce((a, b) => a + b, 0)
  assert.equal(listed, sum, `清单里列了 ${listed} 条，但总表说共 ${sum} 条未落地——数字与清单必须对得上`)
})

test('核查账：账里不出现「待核」这种没有结论的状态', () => {
  // 「待核」看起来像一个中性的占位，实际上是「不知道」的委婉说法。
  // 它在一份用来判断「还剩多少活」的账里没有位置：要么核了，要么明确记成未落地。
  assert.ok(!/待核/.test(LEDGER), '账里不该留「待核」：要么核完，要么记进未落地清单')
})
