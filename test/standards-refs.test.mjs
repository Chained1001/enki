// 防的漂移：规范合并后仍残留「NN:行号」旧引用，或指向已删除的旧标准文件；
// 规范目录的编号文件必须恰好 6 份（00–05），编号连续。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const standards = join(root, 'docs', '规范')
const adrDir = join(root, 'docs', 'adr')

const LINE_REF = /\b(0\d|10)[:：]\d+\b/g
const LINK = /docs\/规范\/(\d{2}-[^\s`"'）)\]]+?\.md)/g

const rel = (path) => relative(root, path).split(sep).join('/')
const read = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '')

async function mdFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await mdFiles(path))
    else if (entry.name.endsWith('.md')) out.push(path)
  }
  return out
}

async function filesToScan() {
  const standardsFiles = (await readdir(standards)).filter((n) => n.endsWith('.md')).sort().map((n) => join(standards, n))
  const adrFiles = (await readdir(adrDir)).filter((n) => n.endsWith('.md')).sort().map((n) => join(adrDir, n))
  const templateFiles = await mdFiles(join(root, 'templates'))
  const fixed = [join(root, 'AGENTS.md'), join(root, 'README.md'), join(root, 'docs', '产品', 'PRD.md'), join(root, 'docs', '技术', '技术文档.md')]
  for (const path of fixed) assert.ok(existsSync(path), `${rel(path)} 不存在`)
  return [...standardsFiles, ...fixed, ...adrFiles, ...templateFiles]
}

test('规范相关文档不再用 NN:行号 形式引用', async () => {
  const hits = []
  for (const path of await filesToScan()) {
    read(path)
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const match of line.match(LINE_REF) ?? []) hits.push(`${rel(path)}:${index + 1} ${match}`)
      })
  }
  assert.deepEqual(hits, [], `仍有「NN:行号」引用：\n${hits.join('\n')}`)
})

test('引用的 docs/规范/NN-*.md 文件都存在', async () => {
  const missing = []
  for (const path of await filesToScan()) {
    for (const match of read(path).matchAll(LINK)) {
      const name = match[1]
      if (!existsSync(join(standards, name))) missing.push(`${rel(path)} -> docs/规范/${name}`)
    }
  }
  assert.deepEqual(missing, [], `引用了不存在的规范文件：\n${missing.join('\n')}`)
})

test('docs/规范/ 恰好 6 个编号文件，编号 00–05 连续', async () => {
  const names = (await readdir(standards)).filter((n) => /^\d{2}-.+\.md$/.test(n)).sort()
  assert.equal(names.length, 6, `编号文件应为 6 份，实际 ${names.length} 份：${names.join('、')}`)
  names.forEach((name, index) => {
    const expected = String(index).padStart(2, '0')
    assert.equal(name.slice(0, 2), expected, `${name} 的编号应为 ${expected}，编号须从 00 起连续`)
  })
})
