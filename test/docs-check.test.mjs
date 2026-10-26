// 防的漂移：AGENTS.md 的指针指向已删除的文件或缺了标题，GLOSSARY.md 的格式、长度与拼音序失守。
// 只用临时目录里的合成仓库，不读真实 GLOSSARY，避免把内容变化误判成检查器坏了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AGENTS_POINTERS, checkAgents, checkGlossary } from '../scripts/docs-check.mjs'

// 按 AGENTS_POINTERS 生成一个指针全部可解析的临时仓库；omitTarget 删目标文件，
// dropHeading 去掉某个目标文件的节标题，omitPointer 让 AGENTS.md 少写一条指针。
async function withRepo(run, { omitTarget = '', dropHeading = '', omitPointer = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-'))
  try {
    const agents = ['# 测试仓库', '']
    for (const pointer of AGENTS_POINTERS) {
      const section = pointer.heading ? ` 的「${pointer.heading}」` : ''
      if (pointer.path !== omitPointer) agents.push(`- \`${pointer.path}\`${section}`)
      if (pointer.path === omitTarget) continue
      const heading = pointer.heading && pointer.path !== dropHeading ? `## ${pointer.heading}\n` : ''
      await mkdir(dirname(join(root, pointer.path)), { recursive: true })
      await writeFile(join(root, pointer.path), `# ${pointer.path}\n\n${heading}`, 'utf8')
    }
    await writeFile(join(root, 'AGENTS.md'), `${agents.join('\n')}\n`, 'utf8')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('AGENTS 指针都指向存在的文件与节时返回空', async () => {
  await withRepo(async (root) => {
    assert.deepEqual(checkAgents(root), [])
  })
})

test('AGENTS 指针目标不存在时返回对应行的问题', async () => {
  await withRepo(
    async (root) => {
      const issues = checkAgents(root)
      assert.equal(issues.length, 1)
      assert.equal(issues[0].file, 'AGENTS.md')
      const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8').split(/\r?\n/)
      const pointerLine = agents.findIndex((line) => line.includes('`docs/规范/来源.md`')) + 1
      assert.equal(issues[0].line, pointerLine, '问题应指向 AGENTS.md 里那条指针的行号')
      assert.match(issues[0].message, /指针目标不存在：docs\/规范\/来源\.md/)
    },
    { omitTarget: 'docs/规范/来源.md' },
  )
})

test('AGENTS 指针标了节但目标缺该标题时返回问题', async () => {
  await withRepo(
    async (root) => {
      const issues = checkAgents(root)
      assert.equal(issues.length, 1)
      assert.match(issues[0].message, /指针目标缺少节：README\.md.*## 技能列表/)
    },
    { dropHeading: 'README.md' },
  )
})

test('AGENTS.md 少写必需指针时返回问题', async () => {
  await withRepo(
    async (root) => {
      const issues = checkAgents(root)
      assert.equal(issues.length, 1)
      assert.match(issues[0].message, /未写指针：scripts\/init-skill\.mjs/)
    },
    { omitPointer: 'scripts/init-skill.mjs' },
  )
})

test('GLOSSARY 格式、长度与拼音序都合法时返回空', () => {
  const text = [
    '# 术语',
    '',
    '标题与说明段落不参与条目格式判断。',
    '',
    '- **阿**：甲。',
    '- **北**：乙。',
    `- **长**：${'字'.repeat(60)}`,
  ].join('\n')
  assert.deepEqual(checkGlossary(text), [])
})

test('GLOSSARY 术语重复时返回重复行', () => {
  const issues = checkGlossary('- **alpha**：甲。\n- **alpha**：乙。')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].line, 2)
  assert.match(issues[0].message, /术语重复：alpha/)
})

test('GLOSSARY 定义超过 60 字时返回问题', () => {
  const issues = checkGlossary(`- **阿**：${'字'.repeat(61)}`)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].line, 1)
  assert.match(issues[0].message, /定义超过 60 字（61 字）：阿/)
})

test('GLOSSARY 拼音序逆序时只报第一对', () => {
  const issues = checkGlossary('- **北**：乙。\n- **阿**：甲。\n- **长**：丙。')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].line, 2)
  assert.match(issues[0].message, /拼音序逆序：北（第 1 行）应排在「阿」之后/)
})

test('GLOSSARY 条目不是「- **术语**：定义」时返回问题', () => {
  const issues = checkGlossary('- **阿**: 甲。')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].line, 1)
  assert.match(issues[0].message, /格式应为 - \*\*术语\*\*：定义/)
})
