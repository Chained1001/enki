// 状态两套账（B-06）：manifest.files 的标签与磁盘内容不符时要说出来。
//
// 为什么值得一个文件：那个标签是 prepare 时写死的，之后没人更新。它不只影响报告好看——
// cost.mjs 曾按标签过滤统计产物字数，于是「填满的文件仍标 skeleton」会让输出下界系统性偏低，
// 而且完全静默（实测填入 13 个文件后下界仍按骨架算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { validateOutput } from '../skills/book-breakdown/scripts/validate-output.mjs'

async function makeBook() {
  const dir = await mkdtemp(join(tmpdir(), 'drift-'))
  const src = join(dir, '书.txt')
  const text = Array.from({ length: 5 }, (_, i) => `第${i + 1}章 章名\n${'正文内容。'.repeat(200)}\n`).join('\n')
  await writeFile(src, text, 'utf8')
  const r = await prepare({ input: src })
  return { dir, r }
}

const withBook = async (fn) => {
  const { dir, r } = await makeBook()
  try { await fn(r) } finally { await rm(dir, { recursive: true, force: true }) }
}

const patchManifest = async (outDir, fn) => {
  const p = join(outDir, '工作/manifest.json')
  const m = JSON.parse(await readFile(p, 'utf8'))
  fn(m)
  await writeFile(p, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
}

const fill = async (outDir, rel) => {
  const p = join(outDir, rel)
  const t = await readFile(p, 'utf8')
  await writeFile(p, t.replace(/（待填）/g, '这里是填好的内容，约二十字。'), 'utf8')
}

test('prepare 写出 generatedAt 与总量口径说明', async () => {
  await withBook(async (r) => {
    const m = JSON.parse(await readFile(join(r.outDir, '工作/manifest.json'), 'utf8'))
    assert.match(m.generatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'generatedAt 应是 ISO 时间')
    assert.ok(typeof m.totalCharsNote === 'string' && m.totalCharsNote.length > 10, 'totalCharsNote 应说明统计口径')
    // 口径说明必须写清关键边界，否则等于没写
    assert.match(m.totalCharsNote, /附录/, '口径要交代附录算不算')
    assert.match(m.totalCharsNote, /前言/, '口径要交代前言算不算')
  })
})

test('旧产物缺 generatedAt／totalCharsNote 不报错（只提示状态漂移，不因缺字段阻断）', async () => {
  await withBook(async (r) => {
    await patchManifest(r.outDir, (m) => { delete m.generatedAt; delete m.totalCharsNote })
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const bad = v.errors.filter((e) => /GENERATED|TOTAL_CHARS|E_MANIFEST/.test(e.code))
    assert.deepEqual(bad, [], '缺这两项不是错误')
  })
})

test('文件已填满而 manifest 仍记 skeleton：报 W_STATE_DRIFT，且写出两边状态', async () => {
  await withBook(async (r) => {
    const rel = '故事底本/全书设定/世界观.md'
    await fill(r.outDir, rel)
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const hit = v.errors.filter((e) => e.code === 'W_STATE_DRIFT' && e.file === rel)
    assert.equal(hit.length, 1, `应报一条，实际 ${JSON.stringify(v.errors.filter((e) => e.code === 'W_STATE_DRIFT'))}`)
    assert.match(hit[0].message, /skeleton/, '消息要写出 manifest 记的是什么')
    assert.match(hit[0].message, /占位/, '消息要说明文件里其实没有占位了')
  })
})

test('文件仍是骨架而 manifest 记 done：也报 W_STATE_DRIFT（反方向同样要说）', async () => {
  await withBook(async (r) => {
    const rel = '故事底本/全书设定/世界观.md'
    await patchManifest(r.outDir, (m) => { m.files[rel] = 'done' })
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const hit = v.errors.filter((e) => e.code === 'W_STATE_DRIFT' && e.file === rel)
    assert.equal(hit.length, 1)
    assert.match(hit[0].message, /占位/, '消息要说文件里还有占位')
  })
})

test('状态与内容一致时不报 W_STATE_DRIFT', async () => {
  await withBook(async (r) => {
    // 把 manifest 的状态改成与磁盘一致：有占位的记 skeleton，没占位的记 done
    await patchManifest(r.outDir, (m) => {
      m.files = { '工作/manifest.json': 'done' }
    })
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.equal(v.errors.filter((e) => e.code === 'W_STATE_DRIFT').length, 0)
  })
})

test('W_STATE_DRIFT 不阻断交付判定（只是警告）', async () => {
  await withBook(async (r) => {
    await fill(r.outDir, '故事底本/全书设定/世界观.md')
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const drift = v.errors.filter((e) => e.code === 'W_STATE_DRIFT')
    assert.ok(drift.length > 0, '夹具应能触发漂移')
    assert.ok(drift.every((e) => e.severity === 'warning'), '必须是 warning，不能是 error')
    assert.equal(v.data.verdict, '进行中', '进度模式判定不该被警告改变')
  })
})

test('漂移很多时不逐条刷屏（封顶 5 条 + 一条汇总）', async () => {
  await withBook(async (r) => {
    const m0 = JSON.parse(await readFile(join(r.outDir, '工作/manifest.json'), 'utf8'))
    const targets = Object.entries(m0.files)
      .filter(([rel, s]) => !rel.startsWith('原文/') && s === 'skeleton' && rel !== '工作/manifest.json')
      .map(([rel]) => rel)
    assert.ok(targets.length > 6, `夹具要有 6 个以上骨架文件，实际 ${targets.length}`)
    for (const rel of targets) await fill(r.outDir, rel)

    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const drift = v.errors.filter((e) => e.code === 'W_STATE_DRIFT')
    const perFile = drift.filter((e) => e.file !== '工作/manifest.json')
    assert.equal(perFile.length, 5, `逐条只报 5 条，实际 ${perFile.length}`)
    assert.ok(drift.some((e) => e.file === '工作/manifest.json' && /另有/.test(e.message)), '应有汇总条')
  })
})

test('空的表格骨架不算「已填写」（表格里本来就没有「待填」字样）', async () => {
  await withBook(async (r) => {
    // 索引/台账/词典这类产物整份就是一张空表：表头 + 分隔行，没有数据行。
    // 只按「有没有（待填）」判会把它们当成已填，于是满屏报「状态未更新」（实测 6 条假告警）。
    const rel = '工作/别名词典.md'
    const t = await readFile(join(r.outDir, rel), 'utf8')
    assert.ok(!t.includes('（待填）'), '夹具前提：空表格里没有占位字样')
    assert.match(t, /^\|.*\|$/m, '夹具前提：是一张表')

    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.equal(
      v.errors.filter((e) => e.code === 'W_STATE_DRIFT' && e.file === rel).length, 0,
      '空表格仍是骨架，manifest 记 skeleton 是对的，不该报漂移',
    )
  })
})

test('表格一旦有了数据行，manifest 还记 skeleton 就该报', async () => {
  await withBook(async (r) => {
    const rel = '工作/别名词典.md'
    const t = await readFile(join(r.outDir, rel), 'utf8')
    await writeFile(join(r.outDir, rel), `${t}| 张三 | 三哥 | 人物 | 第1章 | 本名 |\n`, 'utf8')
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    const hit = v.errors.filter((e) => e.code === 'W_STATE_DRIFT' && e.file === rel)
    assert.equal(hit.length, 1, `有数据行后应报漂移，实际 ${hit.length} 条`)
  })
})

test('原文/ 下的文件不参与占位判定（原文没有「待填」的概念）', async () => {
  await withBook(async (r) => {
    await patchManifest(r.outDir, (m) => {
      // 故意把原文文件标成 skeleton —— 原文是复制来的，不该被这条告警
      for (const rel of Object.keys(m.files)) if (rel.startsWith('原文/')) m.files[rel] = 'skeleton'
    })
    const v = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.equal(v.errors.filter((e) => e.code === 'W_STATE_DRIFT').length, 0)
  })
})
