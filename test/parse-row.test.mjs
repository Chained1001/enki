// 防的漂移：parseRow 不认单元格内转义竖线（生成侧 buildArtifacts 的 `\|` 约定），列数误判裂列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRow } from '../skills/book-breakdown/scripts/validate-output.mjs'

test('parseRow 认转义竖线：8 列不裂列、单元格还原原始竖线', () => {
  const bs = String.fromCharCode(92) // 反斜杠（避免 shell 通道吃转义，用字符码构造）
  const row = `| 1 | 第一章 左${bs}|右 | （待填） | a | b | c | d | e |`
  const cells = parseRow(row)
  assert.equal(cells.length, 8, '转义竖线不计为列分隔')
  assert.equal(cells[1], '第一章 左|右', '单元格值还原为原始竖线')
})

test('parseRow 常规行不受影响', () => {
  assert.equal(parseRow('| a | b |').length, 2)
  assert.equal(parseRow('不是表行'), null)
})
