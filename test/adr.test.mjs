// 防的漂移：Q/D 决策表新增条目而 ADR 索引没跟；索引里同一 ID 重复或写了表里没有的 ID；
// 4 个承重决策的 ADR 文件缺段、段序错或状态不在允许集合里。
// 索引只记账：这里不查标题抄得对不对，正文仍以 PRD／技术文档与 ADR 文件为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adrDir = join(root, 'docs', 'adr')
const readmePath = join(adrDir, 'README.md')
const STATUSES = new Set(['accepted', 'superseded', 'rejected', 'proposed'])
const ADR_FILES = [
  '0001-规范自有化.md',
  '0002-过程路径以契约与脚本为准.md',
  '0003-子代理接口字段以-AGENT_REVIEW-为准.md',
  '0004-docs-check-门禁.md',
]
const REQUIRED_SECTIONS = ['## 状态', '## 背景', '## 决策', '## 后果']

const text = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')

const sourceIds = async (path, prefix) => {
  const source = await text(path)
  return [...new Set([...source.matchAll(new RegExp(`\\b${prefix}-\\d{2}\\b`, 'g'))].map((m) => m[0]))]
}

// 只取「## 决策索引」到下一个二级标题之间的行，避免把 ADR 表的 0001 当决策 ID。
async function indexIds() {
  const readme = await text(readmePath)
  const section = readme.split(/^## 决策索引$/m)[1]?.split(/^## /m)[0] ?? ''
  const ids = [...section.matchAll(/^\|\s*([QD]-\d{2})\s*\|/gm)].map((m) => m[1])
  return { readme, ids }
}

test('docs/adr/README.md 存在，且有决策索引表头', async () => {
  assert.ok(existsSync(readmePath), 'docs/adr/README.md 不存在')
  const readme = await text(readmePath)
  assert.match(readme, /^## 决策索引$/m, 'README 缺少「## 决策索引」')
  assert.match(readme, /^\| ID \| 决策 \| 状态 \| 来源 \| 备注 \|$/m, '决策索引表头应为 | ID | 决策 | 状态 | 来源 | 备注 |')
})

test('PRD 里的每个 Q 编号都出现在索引里', async () => {
  const { ids } = await indexIds()
  for (const id of await sourceIds(join(root, 'docs', '产品', 'PRD.md'), 'Q')) {
    assert.ok(ids.includes(id), `${id} 在 PRD 的 Q 表里，但 docs/adr/README.md 的索引没有它`)
  }
})

test('技术文档里的每个 D 编号都出现在索引里', async () => {
  const { ids } = await indexIds()
  for (const id of await sourceIds(join(root, 'docs', '技术', '技术文档.md'), 'D')) {
    assert.ok(ids.includes(id), `${id} 在技术文档的 D 表里，但 docs/adr/README.md 的索引没有它`)
  }
})

test('索引 ID 不重复，且不写两份决策表里没有的 ID', async () => {
  const { ids } = await indexIds()
  const seen = new Set()
  for (const id of ids) {
    assert.ok(!seen.has(id), `索引里 ID 重复：${id}`)
    seen.add(id)
  }
  const known = new Set([
    ...(await sourceIds(join(root, 'docs', '产品', 'PRD.md'), 'Q')),
    ...(await sourceIds(join(root, 'docs', '技术', '技术文档.md'), 'D')),
  ])
  for (const id of seen) assert.ok(known.has(id), `索引里有来源表没有的 ID：${id}`)
})

test('4 个承重决策的 ADR 文件都存在，且索引里有链接', async () => {
  const { readme } = await indexIds()
  for (const file of ADR_FILES) {
    assert.ok(existsSync(join(adrDir, file)), `ADR 文件不存在：docs/adr/${file}`)
    assert.ok(readme.includes(file), `README 的 ADR 表缺少指向 ${file} 的链接`)
  }
})

test('每个 ADR 按「状态→背景→决策→后果」写，状态在允许集合内', async () => {
  for (const file of ADR_FILES) {
    const body = await text(join(adrDir, file))
    const positions = REQUIRED_SECTIONS.map((heading) => body.indexOf(`\n${heading}\n`))
    REQUIRED_SECTIONS.forEach((heading, i) => {
      assert.ok(positions[i] >= 0, `${file} 缺少小节「${heading}」`)
    })
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
      `${file} 的小节顺序应为 状态→背景→决策→后果`,
    )

    const statusBody = body.slice(positions[0] + 1 + REQUIRED_SECTIONS[0].length).split(/\n## /)[0]
    const status = statusBody.split('\n').map((line) => line.trim()).find(Boolean)
    assert.ok(STATUSES.has(status), `${file} 的「## 状态」值「${status}」不在 accepted／superseded／rejected／proposed 内`)
  }
})
