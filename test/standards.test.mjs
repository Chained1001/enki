// 防的漂移：规范文件缺编号、缺结构、首行不合格式，或有标准漏登来源与偏离。
// 规范由 Enki 自有，不再与上游逐字比对；上游只作参考，来源与偏离记在 来源.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const standards = join(here, '..', 'docs', '规范')
const registryPath = join(standards, '来源.md')
const NAME = /^\d{2}-[^/\\]+\.md$/
const REGISTRY = '来源.md'

const standardFiles = async () => (await readdir(standards)).filter((n) => n.endsWith('.md') && n !== REGISTRY).sort()

test('每个标准文件名都带两位编号，且编号从 00 起连续', async () => {
  const names = await standardFiles()
  assert.ok(names.length > 0, '规范目录中没有标准')
  names.forEach((n, i) => {
    assert.match(n, NAME, `${n} 不符合 NN-名称.md`)
    assert.equal(Number(n.slice(0, 2)), i, `${n} 的编号应为 ${String(i).padStart(2, '0')}，编号须连续`)
  })
})

test('来源.md 存在', () => {
  assert.ok(existsSync(registryPath), 'docs/规范/来源.md 缺失')
})

test('每个标准文件都在来源.md 里逐字出现', async () => {
  const names = await standardFiles()
  const registry = readFileSync(registryPath, 'utf8')
  for (const n of names) {
    assert.ok(registry.includes(n), `${n} 未在 docs/规范/来源.md 中逐字出现`)
  }
})

test('每个标准文件以「# NN 」开头', async () => {
  const names = await standardFiles()
  for (const n of names) {
    const first = readFileSync(join(standards, n), 'utf8').split(/\r?\n/, 1)[0]
    const prefix = `# ${n.slice(0, 2)} `
    assert.ok(first.startsWith(prefix), `${n} 的首行应为「${prefix}<名称>」，实际为「${first}」`)
  }
})
