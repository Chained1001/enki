// 防的漂移：出版书被 bookType 分支砍掉卷层。
// 背景：2026-10-25 产物实证——`productPlan` 写死「bookType 出版时不建分卷总表与卷纲」，
// 于是龙族（出版书）的四层骨架被压成两层，永远处于 PRD「缺一项即视为未完成」的状态。
// 但卷层不是出版书没有，是代码砍掉了：实测龙族3 检出 4 卷、龙族1/2 是单卷「全书」。
// 本文件锁住「两类书都建卷层，区别只在幕怎么落」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { productPlan, SECTIONS } from '../skills/book-breakdown/scripts/contract.mjs'

// 均章 > 15000 才会被判成出版书，所以每个单元要够长。
const unit = (n, name) => `第${n}幕 ${name}\n${'他说话了，声音很轻。'.repeat(2000)}\n`

async function makePublish() {
  const dir = await mkdtemp(join(tmpdir(), 'pubvol-'))
  const src = join(dir, '出版书.txt')
  await writeFile(src, unit('一', '开端') + '\n' + unit('二', '转折') + '\n' + unit('三', '收束'), 'utf8')
  const r = await prepare({ input: src })
  return { dir, r }
}

const withPub = async (fn) => {
  const { dir, r } = await makePublish()
  try { await fn(r) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('契约：两类书的 productPlan 都含卷纲目录与分卷总表', () => {
  for (const bookType of ['网文', '出版']) {
    const plan = productPlan({ bookType })
    assert.ok(plan.dirs.includes('故事底本/故事剧情/卷纲'), `${bookType} 缺卷纲目录`)
    assert.ok(plan.files.includes('故事底本/故事剧情/分卷总表.md'), `${bookType} 缺分卷总表`)
  }
})

test('出版书产物树含卷纲与分卷总表', async () => {
  await withPub(async (r) => {
    assert.equal(r.bookType, '出版', '夹具须被判成出版书，否则这条测的不是出版路径')
    assert.ok(existsSync(join(r.outDir, '故事底本/故事剧情/分卷总表.md')), '出版书应建分卷总表')
    assert.ok(existsSync(join(r.outDir, '故事底本/故事剧情/卷纲')), '出版书应建卷纲目录')
  })
})

test('出版书：每卷一份卷纲，且卷纲含完整九段骨架', async () => {
  await withPub(async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/卷纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    assert.equal(files.length, r.volumes.length, '卷纲份数应等于卷数')
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      for (const s of SECTIONS.卷纲) {
        assert.ok(text.includes(`## ${s}`), `卷纲 ${f} 缺段「${s}」`)
      }
    }
  })
})

test('出版书：幕纲份数等于原文单元数（前言不算）', async () => {
  await withPub(async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    // prepare 只返回 chapterCount，不返回 chapters 明细；正文单元数 = 章数 − 前言数，
    // 前言按契约是 no===0 且 title==='前言'。夹具没有前言，故两者相等。
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作/manifest.json'), 'utf8'))
    const units = manifest.chapters.filter((c) => !(c.no === 0 && c.title === '前言')).length
    assert.equal(units, r.chapterCount, '夹具无前言，正文单元数应等于章数')
    assert.equal(files.length, units, `幕纲 ${files.length} 份，应为原文单元数 ${units}`)
    assert.equal(files.length, 3)
  })
})

test('出版书：幕纲文件名与网文同形（卷NN-幕NN-名称.md），每份都挂在所属卷下', async () => {
  await withPub(async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    for (const f of files) {
      assert.match(f, /^卷\d{2}-幕\d{2}-.+\.md$/, `幕纲文件名不合形：${f}`)
    }
    // 卷号必须在 manifest 的卷表范围内，不能凭空造一个新卷
    const volNos = new Set(r.volumes.map((v) => String(v.no).padStart(2, '0')))
    for (const f of files) {
      const volNo = /^卷(\d{2})-/.exec(f)[1]
      assert.ok(volNos.has(volNo), `幕纲 ${f} 的卷号 ${volNo} 不在卷表 ${[...volNos].join(',')} 中`)
    }
  })
})

test('出版书：幕纲段名齐（十段），不是只有标题的空壳', async () => {
  await withPub(async (r) => {
    const dir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      for (const s of SECTIONS.幕纲) {
        assert.ok(text.includes(`## ${s}`), `幕纲 ${f} 缺段「${s}」`)
      }
    }
  })
})

test('网文路径不受影响：仍建卷纲与分卷总表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubvol-w-'))
  try {
    const src = join(dir, '网文.txt')
    // 短章 → 均章远低于阈值 → 网文
    const text = Array.from({ length: 5 }, (_, i) => `第${i + 1}章 章名\n正文很短。\n`).join('\n')
    await writeFile(src, text, 'utf8')
    const r = await prepare({ input: src })
    assert.equal(r.bookType, '网文')
    assert.ok(existsSync(join(r.outDir, '故事底本/故事剧情/分卷总表.md')))
    assert.ok(existsSync(join(r.outDir, '故事底本/故事剧情/卷纲')))
    // 网文的幕纲由卷循环生成，prepare 不预置
    const actDir = join(r.outDir, '故事底本/故事剧情/幕纲')
    const n = existsSync(actDir) ? (await readdir(actDir)).filter((f) => f.endsWith('.md')).length : 0
    assert.equal(n, 0, '网文幕纲由卷循环按事件弧生成，prepare 不该预置')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
