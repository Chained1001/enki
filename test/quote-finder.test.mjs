// 引句定位脚本：替代「为了一句出处通读整章」。
// 防的回归：断句把中文引号切碎、别名没生效、输出不封顶、全未命中仍报成功。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { clip, expandAliases, findQuotes, splitSentences } from '../skills/book-breakdown/scripts/quote-finder.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SCRIPT = join(root, 'skills', 'book-breakdown', 'scripts', 'quote-finder.mjs')
const fixture = join(root, 'test', 'fixtures', 'products', '合成小书_拆解')

const tmpBase = join(here, '.tmp', 'quote-finder')
function runScript(args) {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'run-'))
  const outFd = openSync(join(dir, 'o.txt'), 'w')
  const errFd = openSync(join(dir, 'e.txt'), 'w')
  let r
  try {
    r = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', outFd, errFd] })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(join(dir, 'o.txt'), 'utf8')
  const stderr = readFileSync(join(dir, 'e.txt'), 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { status: r.status, stdout, stderr }
}
after(() => rmSync(tmpBase, { recursive: true, force: true }))

test('断句：引号内的句号不切，且不产生只剩标点的碎片', () => {
  const s = splitSentences('张三走进车站。\n李四说：“这班车晚点了。”\n张三点头。')
  assert.deepEqual(s, ['张三走进车站。', '李四说：“这班车晚点了。”', '张三点头。'])
  // 只剩标点的碎片被丢弃
  assert.ok(!s.some((x) => !/[\u4e00-\u9fa5]/.test(x)))
})

test('断句：省略号与问叹号也认作句末', () => {
  const s = splitSentences('他停住了……为什么？没有人回答！')
  assert.equal(s.length, 3)
  assert.match(s[0], /……/)
})

test('别名：主名→别称、别称→主名双向展开，跳过表头与占位', () => {
  const lines = [
    '| 别称 | 主名 | 实体类型 | 首次出现章 | 归并依据 |',
    '| --- | --- | --- | --- | --- |',
    '| 张老三 | 张三 | 人物 | 5 | 同指 |',
    '| 三哥 | 张三 | 人物 | 20 | 称呼 |',
    '| （待填） | （待填） | （待填） | （待填） | （待填） |',
  ]
  const names = expandAliases(lines, '张三')
  assert.deepEqual(names.sort(), ['三哥', '张三', '张老三'].sort())
  // 用别称查，也要带回主名
  assert.ok(expandAliases(lines, '张老三').includes('张三'))
})

test('找句：每句只记一次、受 max 封顶、命中词正确', () => {
  const text = '张三来了。张三走了。张三笑了。张三哭了。'
  const hits = findQuotes(text, ['张三'], { max: 2 })
  assert.equal(hits.length, 2, 'max=2 应封顶')
  assert.equal(hits[0].命中词, '张三')
  assert.equal(hits[0].序号, 1)
})

test('找句：context 带前后句，边界章不越界', () => {
  const hits = findQuotes('甲说。张三来了。乙说。', ['张三'], { context: true })
  assert.equal(hits[0].前句, '甲说。')
  assert.equal(hits[0].后句, '乙说。')
  const first = findQuotes('张三来了。乙说。', ['张三'], { context: true })
  assert.equal(first[0].前句, null, '首句不应有前句')
})

test('截断：超长句加省略号，短句原样', () => {
  assert.equal(clip('短句', 10), '短句')
  const long = '啊'.repeat(50)
  assert.equal(clip(long, 10).length, 11)
  assert.match(clip(long, 10), /…$/)
})

test('CLI：命中时退出 0 并给出章号与引句', () => {
  const r = runScript([fixture, '--entity', '张三', '--chapters', '1'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /第 1 章/)
  assert.match(r.stdout, /张三走进车站/)
})

test('CLI：全未命中退出 1（调用方须能区分「找不到」）', () => {
  const r = runScript([fixture, '--entity', '王五', '--chapters', '1'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未命中/)
})

test('CLI：缺参数退出 2（参数错，非业务失败）', () => {
  assert.equal(runScript([]).status, 2)
  assert.equal(runScript([fixture]).status, 2, '缺 --entity 也是参数错')
})

test('CLI：--json 输出可解析，未命中时也退出 1', () => {
  const ok = runScript([fixture, '--entity', '李四', '--chapters', '1,2', '--json'])
  assert.equal(ok.status, 0, ok.stderr)
  const obj = JSON.parse(ok.stdout)
  assert.equal(obj.data.实体, '李四')
  assert.ok(obj.data.结果.length === 2)
  const bad = runScript([fixture, '--entity', '王五', '--chapters', '1', '--json'])
  assert.equal(bad.status, 1)
})
