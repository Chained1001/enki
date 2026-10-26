// 出处核验子代理的接口字段（P0-4）。
//
// 反例：10 发给子代理的是 {编号, 引句}，子代理声明 file/line/quote，10 落盘又写
// 编号/裁决/章号/依据句/说明——五处名字互不相同。按 10 自己的「缺字段不采信」，
// 每一批裁决都会判失败。字段的机器源是 contract.mjs 的 AGENT_REVIEW。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_REVIEW } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SKILL = join(here, '..', 'skills', 'book-breakdown')
const agent = readFileSync(join(SKILL, 'agents', '出处核验.md'), 'utf8')
const wf10 = readFileSync(join(SKILL, 'workflows', '10-校验交付.md'), 'utf8')

const backticked = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1])

test('子代理输出表与 AGENT_REVIEW.output + summary 一致', () => {
  const section = agent.slice(agent.indexOf('## 输出'), agent.indexOf('## 可用工具'))
  const rows = [...section.matchAll(/^\| ([^|]+?) \| (?:文本|整数|列表|对象) \|/gm)]
    .map((m) => m[1].trim())
  assert.deepEqual(rows, [...AGENT_REVIEW.output, ...AGENT_REVIEW.summary])
})

test('10 的发送与落盘都指向出处核验的字段表', () => {
  assert.match(wf10, /条目字段见 `\.\.\/agents\/出处核验\.md` 的「输入」节/)
  assert.match(wf10, /字段见 `\.\.\/agents\/出处核验\.md` 的「输出」表/)
  assert.ok(!/每条含 `编号`、`文件`/.test(wf10), '10 不该再复写第三份字段表')
})

test('子代理声明的输入条目字段与 AGENT_REVIEW.input 一致', () => {
  const m = /的每条含[^：]*：([^。]+)。/.exec(agent)
  assert.ok(m, '出处核验要写明待裁决条目含哪些字段')
  assert.deepEqual(backticked(m[1]), AGENT_REVIEW.input)
})
