// 技能文档里的脚本调用必须能从技能根直接跑：`node scripts/名称.mjs`。
//
// 反例：`node ../scripts/…` 解析到 skills/scripts/（不存在）；`node skills/book-breakdown/scripts/…`
// 在技能根下会多套一层。01:78 已规定唯一写法，但 26 处调用没有一处符合——文档是 agent 唯一的
// 执行依据，写一个跑不了的命令，它会跑到报错再自行发挥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SKILL = join(here, '..', 'skills', 'book-breakdown')

const mdFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return mdFiles(full)
    return e.name.endsWith('.md') ? [full] : []
  })

const invocations = []
for (const file of mdFiles(SKILL)) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/node\s+([^\s`"'<>]+\.mjs)/g)) {
    invocations.push({ file, rel: file.slice(SKILL.length + 1), cmd: m[1] })
  }
}

test('技能文档里的脚本调用都写成 node scripts/名称.mjs', () => {
  assert.ok(invocations.length >= 10, `至少应有 10 处脚本调用，实际 ${invocations.length}`)
  const bad = invocations
    .filter(({ cmd }) => !/^scripts\/[a-z0-9-]+\.mjs$/.test(cmd))
    .map((b) => `${b.rel}: ${b.cmd}`)
  assert.deepEqual(bad, [], `这些调用不能从技能根解析：${bad.join('；')}`)
})

test('每个被调用的脚本都真实存在', () => {
  const missing = invocations
    .filter(({ cmd }) => !existsSync(join(SKILL, cmd)))
    .map((m) => `${m.rel}: ${m.cmd}`)
  assert.deepEqual(missing, [], `这些脚本不存在：${missing.join('；')}`)
})

test('SKILL.md 的阶段自检命令从技能根可运行', () => {
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  assert.match(skill, /node scripts\/validate-output\.mjs/, '自检命令要写成 node scripts/validate-output.mjs')
  assert.ok(!/node \.\.\/scripts\/validate-output\.mjs/.test(skill), '不能再用 ../scripts')
})

// 只查 `node …` 会漏掉裸命令：05–09 的阶段自检曾写 `validate-output.mjs <产物目录>`。
test('带 <产物目录> 的内联命令都从技能根运行', () => {
  const bad = []
  for (const file of mdFiles(SKILL)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/`([^`]*\.mjs[^`]*)`/g)) {
      const cmd = m[1].trim()
      if (!/<产物目录>/.test(cmd)) continue
      if (!/^node scripts\/[a-z0-9-]+\.mjs\b/.test(cmd)) {
        bad.push(`${file.slice(SKILL.length + 1)}: ${cmd}`)
      }
    }
  }
  assert.deepEqual(bad, [], `这些命令没有从技能根运行：${bad.join('；')}`)
})
