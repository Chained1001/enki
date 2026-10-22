// 防的漂移：prepare.mjs 的切章与目录契约和技能文档脱节。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectChapters, prepare } from '../skills/book-breakdown/scripts/prepare.mjs'

const SAMPLE = `前言部分，交代背景。

第一章 开始

张三走进车站，雨很大。

第二章 相遇

他遇见了李四。

第三章 离开

张三坐上火车。`

async function withSample(run) {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-'))
  const src = join(dir, '测试书.txt')
  await writeFile(src, SAMPLE, 'utf8')
  try {
    await run({ dir, src })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('detectChapters 识别前言与三章', () => {
  const chapters = detectChapters(SAMPLE)
  assert.equal(chapters.length, 4)
  assert.equal(chapters[0].title, '前言')
  assert.equal(chapters[1].title, '第一章 开始')
  assert.equal(chapters[3].title, '第三章 离开')
})

test('prepare 建立产物树、复制原文、切章、写清单', async () => {
  await withSample(async ({ dir, src }) => {
    const r = await prepare({ input: src })
    assert.equal(r.book, '测试书')
    assert.equal(r.chapterCount, 4)
    assert.equal(r.outDir, join(dir, '测试书_拆解'))

    assert.ok(existsSync(join(r.outDir, '原文', '测试书.txt')), '应复制原文')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '卷纲')), '应有卷纲目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '幕纲')), '应有幕纲目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定')), '应有设定目录')

    const chapterFiles = await readdir(join(r.outDir, '原文', '章节'))
    assert.equal(chapterFiles.length, 4)

    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.chapterCount, 4)
    assert.equal(manifest.chapters[1].title, '第一章 开始')
  })
})

test('没有章节标题时明确失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-bad-'))
  const src = join(dir, '无章节.txt')
  await writeFile(src, '这是一段没有标题的文字。', 'utf8')
  try {
    await assert.rejects(() => prepare({ input: src }), /未识别到章节标题/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非 txt 文件被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-ext-'))
  const src = join(dir, 'a.md')
  await writeFile(src, 'x', 'utf8')
  try {
    await assert.rejects(() => prepare({ input: src }), /不是 \.txt 文件/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
