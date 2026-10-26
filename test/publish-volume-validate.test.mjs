// 出版书卷层完整性：某卷缺卷纲或缺幕纲要报得出来，且报在「哪一卷」上。
// 与 publish-volume.test.mjs 的分工：那边测 prepare 建了什么，这边测校验器拦不拦得住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { validateOutput } from '../skills/book-breakdown/scripts/validate-output.mjs'

const unit = (n, name) => `第${n}幕 ${name}\n${'他说话了，声音很轻。'.repeat(2000)}\n`

// 造一本出版书，可选让卷界重启以得到多卷。
async function makePublish({ multiVolume = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pubval-'))
  const body = multiVolume
    // 章号重启是三级检测里的第二级信号，能让 detectVolumes 切出两卷
    ? unit('一', '开端') + '\n' + unit('二', '转折') + '\n' + unit('一', '再起') + '\n' + unit('二', '收束')
    : unit('一', '开端') + '\n' + unit('二', '转折') + '\n' + unit('三', '收束')
  const src = join(dir, '书.txt')
  await writeFile(src, body, 'utf8')
  const r = await prepare({ input: src })
  return { dir, r }
}

const withPub = async (opts, fn) => {
  const { dir, r } = await makePublish(opts)
  try { await fn(r) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('基线：完整出版书产物不报 E_ACTS／E_VOLUME_MISSING', async () => {
  await withPub({}, async (r) => {
    assert.equal(r.bookType, '出版')
    const v = await validateOutput({ root: r.outDir, mode: 'deliver' })
    const bad = v.errors.filter((e) => ['E_ACTS', 'E_VOLUME_MISSING', 'W_VOLUME_MISSING'].includes(e.code))
    assert.deepEqual(bad, [], '完整产物不应报卷层问题')
  })
})

test('删掉某卷的卷纲：报 E_VOLUME_MISSING，且消息写出是哪一卷', async () => {
  await withPub({}, async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/卷纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    assert.ok(files.length >= 1)
    await unlink(join(dir, files[0]))

    const v = await validateOutput({ root: r.outDir, mode: 'deliver' })
    const hit = v.errors.filter((e) => e.code === 'E_VOLUME_MISSING')
    assert.equal(hit.length, 1, `应报一条，实际 ${hit.length} 条：${JSON.stringify(v.errors.filter((e) => e.code === 'E_VOLUME_MISSING'))}`)
    assert.match(hit[0].message, /卷1/, '消息要指明是哪一卷')
    assert.match(hit[0].message, /卷纲/, '消息要指明缺的是什么')
  })
})

test('进度模式下缺卷纲降为 W_VOLUME_MISSING（「还没做」不算做错了）', async () => {
  await withPub({}, async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/卷纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    await unlink(join(dir, files[0]))

    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.equal(v.errors.filter((e) => e.code === 'E_VOLUME_MISSING').length, 0, '进度模式不该报 error')
    assert.ok(v.errors.some((e) => e.code === 'W_VOLUME_MISSING'), '进度模式应报 warning')
  })
})

test('缺幕纲报 E_ACTS 且不重复刷 E_VOLUME_MISSING（同一件事只报一次）', async () => {
  await withPub({}, async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    // 全删：总数不对（E_ACTS 管）与逐卷为空（E_VOLUME_MISSING 管）会同时成立
    for (const f of files) await unlink(join(dir, f))

    const v = await validateOutput({ root: r.outDir, mode: 'deliver' })
    const acts = v.errors.filter((e) => e.code === 'E_ACTS')
    const missing = v.errors.filter((e) => e.code === 'E_VOLUME_MISSING')
    assert.equal(acts.length, 1, '总数不符报一条 E_ACTS')
    assert.equal(missing.length, 0, `全删时不该再逐卷报 E_VOLUME_MISSING（重复），实际 ${missing.length} 条`)
  })
})

test('多卷：总数对得上但某卷为空、另一卷多出来时，逐卷报 E_VOLUME_MISSING', async () => {
  await withPub({ multiVolume: true }, async (r) => {
    assert.ok(r.volumes.length >= 2, `夹具须切成多卷，实际 ${r.volumes.length} 卷`)
    const [first, second] = r.volumes
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const all = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    const p1 = `卷${String(first.no).padStart(2, '0')}-`
    const p2 = `卷${String(second.no).padStart(2, '0')}-`
    const secondFiles = all.filter((f) => f.startsWith(p2))
    assert.ok(secondFiles.length > 0)
    // 把第二卷的幕纲全部改名成「第一卷」：总数不变（E_ACTS 不响），但第二卷空、第一卷多
    for (const [k, f] of secondFiles.entries()) {
      await rename(join(dir, f), join(dir, `${p1}幕${String(90 + k).padStart(2, '0')}-占位.md`))
    }

    const v = await validateOutput({ root: r.outDir, mode: 'deliver' })
    assert.equal(v.errors.filter((e) => e.code === 'E_ACTS').length, 0, '总数没变，E_ACTS 不该响')
    const missing = v.errors.filter((e) => e.code === 'E_VOLUME_MISSING')
    assert.equal(missing.length, 1, `应逐卷报第二卷一条，实际 ${missing.length} 条`)
    assert.match(missing[0].message, new RegExp(`卷${second.no}`), `消息应指向卷${second.no}`)
  })
})

test('多卷出版书：只删其中一卷的幕纲，消息要点名是那一卷', async () => {
  await withPub({ multiVolume: true }, async (r) => {
    assert.ok(r.volumes.length >= 2, `夹具须切成多卷，实际 ${r.volumes.length} 卷`)
    const second = r.volumes[1]
    const prefix = `卷${String(second.no).padStart(2, '0')}-`
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix))
    assert.ok(files.length > 0, `第二卷应有幕纲，实际没有：${(await readdir(dir)).join('、')}`)
    for (const f of files) await unlink(join(dir, f))

    const v = await validateOutput({ root: r.outDir, mode: 'deliver' })
    // 缺口只报一次：总数不符由 E_ACTS 说，但必须点名是哪一卷空着——
    // 只说「份数不对」等于让人自己数。不另开一条 E_VOLUME_MISSING（同一件事两条消息）。
    const acts = v.errors.filter((e) => e.code === 'E_ACTS')
    assert.equal(acts.length, 1, '总数不符报一条 E_ACTS')
    assert.match(acts[0].message, new RegExp(`卷${second.no}`), `消息要点名卷${second.no}，实际：${acts[0].message}`)
    assert.equal(v.errors.filter((e) => e.code === 'E_VOLUME_MISSING').length, 0, '不重复报')
  })
})
