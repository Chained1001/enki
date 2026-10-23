// references 索引：按节给出行范围，让调用方只读需要的那几节。
// 防的回归：
//   1) 索引过期——文件改了小标题而索引没重生成，行号全错，caller 按行号读会读到别的内容；
//   2) 索引被手改——正文写「由脚本生成」，若允许手改就失去可核查性；
//   3) 切节算错——把某一节的行范围算到下一节里去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex, sliceSections } from '../skills/book-breakdown/scripts/reference-index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const refDir = join(root, 'skills', 'book-breakdown', 'references')

test('切节：行号 1 基、含首尾、相邻节首尾相接不重叠', () => {
  const text = ['# 标题', '', '## 甲', '内容一', '## 乙', '内容二', '内容三'].join('\n')
  const s = sliceSections(text)
  assert.equal(s.length, 2)
  assert.deepEqual({ 节: s[0].节, 起: s[0].起, 止: s[0].止 }, { 节: '甲', 起: 3, 止: 4 })
  assert.deepEqual({ 节: s[1].节, 起: s[1].起, 止: s[1].止 }, { 节: '乙', 起: 5, 止: 7 })
  assert.equal(s[0].止 + 1, s[1].起, '相邻节应首尾相接')
})

test('切节：没有 ## 小节时返回空数组（不报错）', () => {
  assert.deepEqual(sliceSections('# 只有一级标题\n正文'), [])
})

test('切节：行数等于 止-起+1，字符数非零', () => {
  const s = sliceSections('## 甲\n一二三')
  assert.equal(s[0].行数, 2)
  assert.ok(s[0].字符数 > 0)
})

test('索引与磁盘上的 索引.md 完全一致（防止改动正文后忘记重生成）', async () => {
  const { readdir } = await import('node:fs/promises')
  const names = (await readdir(refDir)).filter((f) => f.endsWith('.md') && f !== '索引.md')
  const files = []
  for (const name of names.sort()) {
    files.push({ name, text: await readFile(join(refDir, name), 'utf8') })
  }
  const expected = buildIndex(files)
  const actual = await readFile(join(refDir, '索引.md'), 'utf8')
  assert.equal(
    actual.trim(),
    expected.trim(),
    '索引已过期：运行 node skills/book-breakdown/scripts/reference-index.mjs --write',
  )
})

test('索引里列出的行范围确实指向该小节标题（抽查最大的两个文件）', async () => {
  for (const name of ['人物提炼策略.md', '设定提炼策略.md']) {
    const text = await readFile(join(refDir, name), 'utf8')
    const lines = text.split(/\r?\n/)
    for (const s of sliceSections(text)) {
      assert.equal(
        lines[s.起 - 1].replace(/^##\s+/, '').trim(),
        s.节,
        `${name} 第 ${s.起} 行应是节「${s.节}」`,
      )
    }
  }
})

test('索引声明了「由脚本生成」，且不含按字节错算的旧数字', async () => {
  const text = await readFile(join(refDir, '索引.md'), 'utf8')
  assert.match(text, /由 `scripts\/reference-index\.mjs --write` 生成/)
  // 这些是按 UTF-8 字节数除以 1.6 得到的错误值（虚高约 3 倍），曾写进文档
  for (const stale of ['50156', '29639', '约 50k']) {
    assert.ok(!text.includes(stale), `索引里不应出现按字节错算的 ${stale}`)
  }
})
