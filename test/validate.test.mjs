import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSkillText, validateRepo } from '../scripts/validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const tmpBase = async () => {
  const { mkdir } = await import('node:fs/promises')
  const base = join(here, '.tmp', 'validate')
  await mkdir(base, { recursive: true })
  return base
}
const fixtures = join(here, 'fixtures')
const codes = (errors) => errors.map((e) => e.code)
const skill = (frontmatter, body = '# 正文\n') => `---\n${frontmatter}\n---\n${body}`
const OK = 'name: sample\ndescription: 当需要测试时使用。'

test('合法的 frontmatter 与正文通过', () => {
  assert.deepEqual(checkSkillText('sample', skill(OK)), [])
})

test('name 含大写报 E_NAME', () => {
  assert.deepEqual(codes(checkSkillText('Sample', skill('name: Sample\ndescription: x'))), ['E_NAME'])
})

test('name 含连续连字符报 E_NAME', () => {
  assert.deepEqual(codes(checkSkillText('a--b', skill('name: a--b\ndescription: x'))), ['E_NAME'])
})

test('name 与目录名不一致报 E_NAME_MISMATCH', () => {
  assert.deepEqual(codes(checkSkillText('dir-name', skill('name: other\ndescription: x'))), ['E_NAME_MISMATCH'])
})

test('缺少 description 报 E_DESCRIPTION', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill('name: sample'))), ['E_DESCRIPTION'])
})

test('description 长度边界：1024 通过，1025 报错', () => {
  assert.deepEqual(checkSkillText('sample', skill(`name: sample\ndescription: ${'字'.repeat(1024)}`)), [])
  assert.deepEqual(codes(checkSkillText('sample', skill(`name: sample\ndescription: ${'字'.repeat(1025)}`))), ['E_DESCRIPTION'])
})

test('未知字段报 E_UNKNOWN_KEY', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill(`${OK}\nfoo: bar`))), ['E_UNKNOWN_KEY'])
})

test('布尔字段拼写错误报 E_BOOLEAN，合法拼写通过', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill(`${OK}\nuser-invocable: maybe`))), ['E_BOOLEAN'])
  assert.deepEqual(checkSkillText('sample', skill(`${OK}\nuser-invocable: No`)), [])
})

test('缺少 frontmatter 报 E_FRONTMATTER', () => {
  assert.deepEqual(codes(checkSkillText('sample', '# 没有 frontmatter\n')), ['E_FRONTMATTER'])
})

test('多行块标量报 E_FRONTMATTER', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill('name: sample\ndescription: >\n  多行'))), ['E_FRONTMATTER'])
})

test('正文超过 500 行报 E_BODY_LINES，500 行通过', () => {
  const ok = skill(OK, Array(500).fill('行').join('\n') + '\n')
  const tooLong = skill(OK, Array(501).fill('行').join('\n') + '\n')
  assert.deepEqual(checkSkillText('sample', ok), [])
  assert.deepEqual(codes(checkSkillText('sample', tooLong)), ['E_BODY_LINES'])
})

test('合法仓库通过校验', async () => {
  assert.deepEqual(await validateRepo(join(fixtures, 'valid')), [])
})

test('断开的引用报 E_LINK', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'broken-link'))), ['E_LINK'])
})

test('嵌套的 SKILL.md 报 E_NESTED', async () => {
  assert.ok(codes(await validateRepo(join(fixtures, 'invalid', 'nested'))).includes('E_NESTED'))
})

test('平铺的 .md 报 E_FLAT', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'flat-file'))), ['E_FLAT'])
})

test('目录缺少 SKILL.md 报 E_NO_SKILL_MD', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'no-skill-md'))), ['E_NO_SKILL_MD'])
})

test('本基座自身通过校验', async () => {
  assert.deepEqual(await validateRepo(join(here, '..')), [])
})

test('workflows 中的流程文件缺少固定小节报 E_WORKFLOW_SECTION', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n## 目的\n\n只有目的。\n')
    assert.ok(codes(await validateRepo(root)).includes('E_WORKFLOW_SECTION'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workflows 序号不连续报 E_WORKFLOW_ORDER', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  const full = '## 目的\n\nx\n\n## 输入\n\nx\n\n## 步骤\n\nx\n\n## 产出\n\nx\n\n## 停止条件\n\nx\n'
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n' + full)
    await writeFile(join(dir, 'workflows', '03-校对.md'), '# 校对\n\n' + full)
    assert.ok(codes(await validateRepo(root)).includes('E_WORKFLOW_ORDER'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workflows 文件结构完整且序号连续时通过', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  const full = '## 目的\n\nx\n\n## 输入\n\nx\n\n## 步骤\n\nx\n\n## 产出\n\nx\n\n## 停止条件\n\nx\n'
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n' + full)
    await writeFile(join(dir, 'workflows', '02-校对.md'), '# 校对\n\n' + full)
    assert.deepEqual(await validateRepo(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

after(async () => {
  await rm(join(here, '.tmp', 'validate'), { recursive: true, force: true })
  try {
    await rmdir(join(here, '.tmp'))
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
})
