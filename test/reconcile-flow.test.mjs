// C-12／C-28 的流程侧断言：04 真的调用了脚本，报告模板真的有那五行。
//
// 只测脚本不测文档，会出现「能力有了但没人用」——C-04 实现 progress --file
// 而 06/07 一次没调，就是这种状态。所以两部分都要断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('C-12：04 要求跑 reconcile.mjs，不再四步手算', () => {
  const t = read('skills/book-breakdown/workflows/04-对账.md')
  assert.match(t, /reconcile\.mjs/, '04 必须调用脚本')
  // 原来的四步手算指令必须消失——留着的话 agent 会照着做
  assert.ok(!/核对摘要行数等于章节数/.test(t), '不该再让 agent 手核摘要行数')
  assert.ok(!/核对各章字数之和等于总字数/.test(t), '不该再让 agent 手核字数和')
})

test('C-12：04 写明 0／1／2 三个退出码的含义', () => {
  const t = read('skills/book-breakdown/workflows/04-对账.md')
  assert.match(t, /`0`：全对/, '要写 0')
  assert.match(t, /`1`：有项对不上/, '要写 1')
  assert.match(t, /`2`：参数错/, '要写 2，并且说清它不是对账失败')
})

test('C-12：04 写明报告没落盘时不许退回手算', () => {
  // 这是最容易发生的退化：脚本读不到文件，agent 就自己数一遍，
  // 结果和「没做过对账」在产物上完全一样。
  const t = read('skills/book-breakdown/workflows/04-对账.md')
  assert.match(t, /没落盘/, '要有一节讲这种情况')
  assert.match(t, /不要退回手算|不许退回手算|不要自己数/, '要明确禁止退回手算')
})

test('C-28：报告模板的对账节含五行，其中两行是新增的', () => {
  const t = read('skills/book-breakdown/assets/报告模板.md')
  const seg = t.slice(t.indexOf('## 对账'))
  for (const item of ['摘要行数', '摘要超 60 字行数', '无法摘要行数', '要素首现章越界', '各章字数和＝总字数']) {
    assert.ok(seg.includes(item), `对账节缺「${item}」`)
  }
})

test('C-28：报告模板的对账表列名与 reconcile 输出一致（贴进去才对得上）', () => {
  // 模板写四列、脚本输出四列，两边列名一致才不会贴错格。
  const tpl = read('skills/book-breakdown/assets/报告模板.md')
  const seg = tpl.slice(tpl.indexOf('## 对账'))
  assert.match(seg, /^\| 项 \| 期望 \| 实际 \| 结论 \|$/m, '模板表头要与 humanTable 的输出一致')
})

test('C-28：02 的 60 字上限与脚本的 SUMMARY_MAX 是同一个数', async () => {
  // 两处各写一个 60，改了一处另一处不会动。这条把它们绑在一起。
  const { SUMMARY_MAX } = await import('../skills/book-breakdown/scripts/reconcile.mjs')
  const t = read('skills/book-breakdown/workflows/02-摘要.md')
  assert.ok(t.includes(`不超过 ${SUMMARY_MAX} 字`), `02 的上限写法要与 SUMMARY_MAX=${SUMMARY_MAX} 一致`)
})
