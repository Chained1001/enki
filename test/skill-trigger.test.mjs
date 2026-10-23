// 防的漂移：book-breakdown 的触发方式被改回模糊意图识别。
// 背景：本项目拆书是重活（跑十几步、产出上百个文件、可能耗时很久），
// 用户在对话里顺口说「看看这本书」不应自动进入全流程。故取显式调用：
// disable-model-invocation: true，模型不主动调，须用户点名。
// 这条测试锁住三处口径同步：frontmatter、SKILL.md 正文、README。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const skillPath = join(root, 'skills', 'book-breakdown', 'SKILL.md')
const readmePath = join(root, 'README.md')

test('book-breakdown 取显式调用：disable-model-invocation 为 true', async () => {
  const text = await readFile(skillPath, 'utf8')
  assert.match(
    text,
    /^disable-model-invocation:\s*true$/m,
    '必须是 true——否则模型会按模糊意图自动进入，重活不该被一句话触发',
  )
})

test('book-breakdown 的 description 以「当」开头且写明显式调用、不自动触发', async () => {
  const text = await readFile(skillPath, 'utf8')
  const m = /^description:\s*(.+)$/m.exec(text)
  assert.ok(m, '缺 description')
  assert.equal(m[1][0], '当', '规范 01：description 以「当」开头')
  assert.match(m[1], /显式/, 'description 须写明「显式」调用')
  assert.match(m[1], /不按模糊意图自动触发|不自动触发/, 'description 须写明不自动触发')
})

test('SKILL.md 的「何时使用」与 frontmatter 口径一致', async () => {
  const text = await readFile(skillPath, 'utf8')
  const body = text.split(/^---$/m).slice(2).join('---')
  assert.match(body, /只由用户显式调用/, '「何时使用」须写明只由用户显式调用')
  assert.match(body, /不自动触发/, '「何时使用」须列出不自动触发的情形')
})

test('README 的扩展键列登记了 disable-model-invocation', async () => {
  const text = await readFile(readmePath, 'utf8')
  const line = text.split(/\r?\n/).find((l) => l.startsWith('| book-breakdown |'))
  assert.ok(line, 'README 技能列表缺 book-breakdown 行')
  assert.match(line, /disable-model-invocation/, '扩展键列须登记 disable-model-invocation，否则读者不知道它不自动触发')
  assert.match(line, /显式调用/, '用途列须写明仅用户显式调用')
})
