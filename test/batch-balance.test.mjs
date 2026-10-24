// #7 实测：批次切分只按章数时，龙族3 切出 20 章 42.1 万字 vs 3 章 7.1 万字，
// 卷内批间字数比 5.9 倍。单批的上下文成本由字数决定，所以切分点要落在字数均衡处。
//
// 断言的是「卷内均衡」而不是「全书批间均衡」：批次不能跨卷（批属于某一卷，
// 卷纲/幕纲按卷组织），所以卷与卷之间的字数差不可能靠切批消除——龙族3 的
// 卷间字数比是 6.49（卷1 7.6 万字 vs 卷4 49.2 万字），那是分卷检测的产物，
// 不是切批的职责。把「全书批间比」写成断言只会锁死一个治不好的数字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'

// 构造一本「章长悬殊」的合成书：前 10 章各 100 字，后 10 章各 5000 字，单卷 21 章。
// 只按章数切会得到 [1-20]+[21-21]（尾批 1 章 5000 字 vs 前批 ~4.6 万字，差 9 倍）。
// 现在要求：批数不变（2 批）、每批 ≤20 章、卷内批间字数比 < 2。
function lopsidedBook() {
  const lines = []
  for (let i = 1; i <= 21; i++) {
    lines.push(`第${i}章 标题${i}`, '')
    const n = i <= 10 ? 100 : 5000
    lines.push('文'.repeat(n), '')
  }
  return lines.join('\n')
}

test('章长悬殊的书：切分点按字数均衡，不产生 1 章尾批（#7 实测）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-balance-'))
  const src = join(dir, 'a.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(src, lopsidedBook(), 'utf8')
  const r = await prepare({ input: src, out: join(dir, 'out') })
  const m = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))

  assert.equal(m.batches.length, 2, '21 章应切 2 批（批数由章数上限决定，不因字数变多）')
  for (const b of m.batches) {
    const n = b.endCh - b.startCh + 1
    assert.ok(n <= 20, `单批不超过 20 章，实得 ${n} 章`)
    assert.ok(n >= 2, `不产生只有 1 章的尾批，实得 ${n} 章`)
  }
  assert.equal(m.batches[0].startCh, 1, '首章从 1 起')
  assert.equal(m.batches.at(-1).endCh, 21, '末章到 21 止')
  for (let k = 1; k < m.batches.length; k++) {
    assert.equal(m.batches[k].startCh, m.batches[k - 1].endCh + 1, '批间连续，不漏章不重章')
  }
  // 每批的 chars 字段就是该批章字数之和——同时校验它没算错。
  const byNo = new Map(m.chapters.map((c) => [c.no, c.chars]))
  for (const b of m.batches) {
    let expect = 0
    for (let no = b.startCh; no <= b.endCh; no++) expect += byNo.get(no) ?? 0
    assert.equal(b.chars, expect, `批 [${b.startCh}-${b.endCh}] 的 chars 应等于章字数之和`)
  }
  const cs = m.batches.map((b) => b.chars)
  const ratio = Math.max(...cs) / Math.min(...cs)
  assert.ok(ratio < 2, `卷内批间字数比应 <2，实得 ${ratio.toFixed(2)}（${cs.join(' / ')}）`)
})

test('短章书不会被切成一章一批（批数仍由章数上限决定）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-short-'))
  const lines = []
  for (let i = 1; i <= 40; i++) lines.push(`第${i}章 标题${i}`, '', '短。', '')
  const src = join(dir, 'a.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(src, lines.join('\n'), 'utf8')
  const r = await prepare({ input: src, out: join(dir, 'out') })
  const m = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
  assert.equal(m.batches.length, 2, '40 章应切 2 批（不是按字数切成 40 批）')
  for (const b of m.batches) assert.ok(b.endCh - b.startCh + 1 <= 20, '每批 ≤20 章')
})

test('单章书也能切出 1 批（边界不崩）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-one-'))
  const src = join(dir, 'a.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(src, ['第一章 唯一', '', '只有一章。', '', '第二章 二', '', '两章。', '', '第三章 三', '', '三章。'].join('\n'), 'utf8')
  const r = await prepare({ input: src, out: join(dir, 'out') })
  const m = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
  assert.equal(m.batches.length, 1, '3 章应 1 批')
  assert.equal(m.batches[0].startCh, 1)
  assert.equal(m.batches[0].endCh, 3)
})
