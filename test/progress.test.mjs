// 防的漂移：progress.mjs 破坏 manifest 状态块的写权约定（D-12：脚本唯一写入、原子落盘）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, utimesSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { assertManifestUnchanged, queryProgress, updateProgress } from '../skills/book-breakdown/scripts/progress.mjs'

const NOVEL = [
  '第一章 相遇', '张三说：「你好。」', '',
  '第二章 同行', '两人同行。', '',
  '第三章 风波', '起了风波。', '',
  '第四章 破局', '破了局。', '',
  '第五章 归途', '各自归途。', '',
].join('\n')

test('标记批与阶段：只改状态块、原子落盘、其余字段不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prog-'))
  try {
    const src = join(dir, '进度书.txt')
    await writeFile(src, NOVEL, 'utf8')
    const r = await prepare({ input: src })
    const out = r.outDir

    const { changed, progress } = await updateProgress({ root: out, batchDone: ['1:1'], stage: ['4:running'] })
    assert.ok(changed)
    assert.equal(progress.batches.done, 1)

    const manifest = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.batches[0].status, 'done')
    assert.equal(manifest.stages[4].status, 'running')
    assert.equal(manifest.chapterCount, 5, '其余字段不被改动')
    assert.equal(manifest.chapters[0].title, '第一章 相遇')

    const again = await updateProgress({ root: out })
    assert.ok(!again.changed, '无参数时只读不写')
    assert.deepEqual(queryProgress(manifest).batches, { done: 1, total: 1, failed: 0 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('批次或阶段不存在、状态非法时明确失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prog-bad-'))
  try {
    const src = join(dir, '坏进度书.txt')
    await writeFile(src, NOVEL, 'utf8')
    const r = await prepare({ input: src })
    await assert.rejects(() => updateProgress({ root: r.outDir, batchDone: ['9:9'] }), /批次不存在/)
    await assert.rejects(() => updateProgress({ root: r.outDir, stage: ['4:finished'] }), /不在枚举内/)
    await assert.rejects(() => updateProgress({ root: dir }), /缺少 manifest/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('评审遗留修复：stat 后篡改 manifest，写前复核报 E_CONFLICT（P7/A-5）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prog-conflict-'))
  try {
    const src = join(dir, '冲突书.txt')
    await writeFile(src, NOVEL, 'utf8')
    const r = await prepare({ input: src })
    const manifestPath = join(r.outDir, '工作', 'manifest.json')

    // 模拟并发交错（updateProgress 读取后记录 mtime，另一进程改写 manifest，写前复核应拒绝）。
    const observed = statSync(manifestPath).mtimeMs
    const raw = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, raw, 'utf8') // 外部进程改写，mtime 前移
    if (statSync(manifestPath).mtimeMs === observed) {
      const bumped = new Date(statSync(manifestPath).mtimeMs + 1000) // 同毫秒兜底：显式拨动时间戳
      utimesSync(manifestPath, bumped, bumped)
    }
    assert.throws(
      () => assertManifestUnchanged(manifestPath, observed),
      (err) => err.code === 'E_CONFLICT' && /已被其他进程修改/.test(err.message),
      '篡改后复核应抛 E_CONFLICT 且含「已被其他进程修改」',
    )

    // mtime 一致时不误报，写入口正常路径不受影响。
    assertManifestUnchanged(manifestPath, statSync(manifestPath).mtimeMs)
    const { changed } = await updateProgress({ root: r.outDir, batchDone: ['1:1'] })
    assert.ok(changed)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
