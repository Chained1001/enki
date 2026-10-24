// 防的漂移：网文多卷（卷数 > 1）的卷层产物链路从未被测过——现有夹具都是单卷
// （卷01-全书.md）。本用例造一本两卷网文，验证：
//   1. prepare 生成的卷纲文件名是「卷NN-卷名.md」，卷号来自 detectVolumes
//   2. 幕纲按「卷NN-幕NN-弧名.md」命名，能通过 E_ACTS（每卷至少一份）
//   3. 卷纲事件弧数 = 该卷幕纲份数（E_ACT_COVER）
//   4. 幕纲「与卷纲的对应」段的弧号能在本卷弧清单里找到（W_ARC_REF）
//   5. 跨卷的弧号互不串味：卷01 的 A01 不该被卷02 的幕纲引用
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { validateOutput } from '../skills/book-breakdown/scripts/validate-output.mjs'
import { SECTIONS, tableColumns } from '../skills/book-breakdown/scripts/contract.mjs'

const quote = '（第 1 章：「张三，把刀放下。」）'
const line = (text) => `- ${text}${quote}`

// 两卷网文：第二卷的章号从 1 重启（restartVolumes 的判据），均章足够短所以判为网文。
// 每章正文写够 200 字，避免被短章合并逻辑吃掉。
const body = '他沿着长街一路走过去，风把衣角吹得猎猎作响，街边的灯笼一盏接一盏地亮起来了。'.repeat(6)
const THE_BOOK = [
  '第一卷 启程',
  '第一章 出发', body, '',
  '第二章 遇阻', body, '',
  '第三章 破关', body, '',
  '第四章 抵达', body, '',
  '第二卷 归途',
  '第一章 回望', body, '',
  '第二章 重逢', body, '',
  '第三章 终局', body, '',
].join('\n')

function tableFile(name, columnsKey, rows) {
  const cols = tableColumns(columnsKey)
  return [
    `# ${name}`, '',
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n')
}

test('网文多卷：卷纲/幕纲按卷命名，弧数与幕数对账，跨卷弧号不串味', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivol-'))
  const src = join(dir, '两卷书.txt')
  await writeFile(src, THE_BOOK, 'utf8')
  const r = await prepare({ input: src, force: true })
  const out = r.outDir

  // --- 前提：这本书确实被判为网文，且有 2 卷 ---
  assert.equal(r.bookType, '网文', `应判为网文，实际 ${r.bookType}`)
  assert.equal(r.volumes.length, 2, `应有 2 卷，实际 ${r.volumes.length}`)
  assert.equal(r.volumes[0].endCh, 4, '卷01 应止于第 4 章')
  assert.equal(r.volumes[1].startCh, 5, '卷02 应从第 5 章起')

  // --- 1. 卷纲文件名带卷号，且是每卷一份 ---
  const manifest = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
  const volFiles = manifest.files
    ? Object.keys(manifest.files).filter((k) => k.startsWith('故事底本/故事剧情/卷纲/'))
    : []
  assert.equal(volFiles.length, 2, `应有 2 份卷纲，实际 ${volFiles.length}：${volFiles.join(', ')}`)
  for (const [i, f] of volFiles.entries()) {
    assert.match(f, new RegExp(`卷0${i + 1}-`), `卷纲 ${i + 1} 文件名应含卷号前缀：${f}`)
  }

  const vol1Rel = volFiles.find((f) => f.includes('卷01-'))
  const vol2Rel = volFiles.find((f) => f.includes('卷02-'))
  assert.ok(vol1Rel && vol2Rel, '卷01、卷02 的卷纲都要存在')

  // --- 填写两份卷纲（各 2 条弧），与幕纲一一对应 ---
  const fillVol = async (rel, arcs) => {
    const file = join(out, rel)
    let text = await readFile(file, 'utf8')
    text = text.replace(/^> 骨架文件.*$\n?/m, '')
    for (const s of SECTIONS.卷纲) {
      const block = new RegExp(`## ${s}\\n\\n[\\s\\S]*?(?=\\n## |$)`)
      let content = line(`卷纲·${s}`)
      if (s === '事件弧清单') {
        content = [
          '| 弧号 | 弧名 | 起止章 | 弧型 | 五拍完成度 |',
          '| --- | --- | --- | --- | --- |',
          ...arcs.map(([no, name, range]) => `| ${no} | ${name} | ${range} | 案件弧 | 全 |`),
        ].join('\n')
      }
      text = text.replace(block, `## ${s}\n\n${content}\n`)
    }
    if (text.includes('（待填）')) throw new Error(`${rel} 填写后仍有待填`)
    await writeFile(file, text, 'utf8')
  }
  await fillVol(vol1Rel, [['A01', '启程弧', '1-2'], ['A02', '破关弧', '3-4']])
  await fillVol(vol2Rel, [['A01', '回望弧', '1-2'], ['A02', '终局弧', '3']])

  // --- 2. 幕纲：卷NN-幕NN-弧名.md，每卷 2 份 ---
  const writeAct = async (rel, arcNo) => {
    const content = `# 幕纲\n\n` + SECTIONS.幕纲.map((s) =>
      `## ${s}\n\n${line(s === '与卷纲的对应' ? `卷纲弧号 ${arcNo}` : `幕纲·${s}`)}\n`).join('\n')
    await writeFile(join(out, rel), content, 'utf8')
  }
  const ACTS = [
    ['故事底本/故事剧情/幕纲/卷01-幕01-启程弧.md', 'A01'],
    ['故事底本/故事剧情/幕纲/卷01-幕02-破关弧.md', 'A02'],
    ['故事底本/故事剧情/幕纲/卷02-幕01-回望弧.md', 'A01'],
    ['故事底本/故事剧情/幕纲/卷02-幕02-终局弧.md', 'A02'],
  ]
  for (const [rel, arc] of ACTS) await writeAct(rel, arc)

  // 其余骨架填满，避免无关错误掩盖本用例要查的项
  const fillAll = async (rel, product) => {
    const file = join(out, rel)
    let text = await readFile(file, 'utf8')
    text = text.replace(/^> 骨架文件.*$\n?/m, '')
    for (const s of SECTIONS[product]) {
      const block = new RegExp(`## ${s}\\n\\n[\\s\\S]*?(?=\\n## |$)`)
      text = text.replace(block, `## ${s}\n\n${line(`${product}·${s}`)}\n`)
    }
    await writeFile(file, text, 'utf8')
  }
  await fillAll('故事底本/故事剧情/开篇三章.md', '开篇三章')
  await fillAll('故事底本/全书设定/世界观.md', '世界观')
  await fillAll('故事底本/全书设定/金手指.md', '金手指')
  {
    const file = join(out, '故事底本/全书设定/金手指.md')
    let t = await readFile(file, 'utf8')
    await writeFile(file, t.replace('- 金手指名称：（待填）', '- 金手指名称：后世记忆'), 'utf8')
  }
  await fillAll('故事底本/故事剧情/全书大纲.md', '全书大纲')
  {
    // 全书大纲的第一块是七项引导行，不是单行（待填）
    const file = join(out, '故事底本/故事剧情/全书大纲.md')
    let t = await readFile(file, 'utf8')
    const items = ['主题母题：凡人抗天', '主角 logline：张三要归乡', '核心欲望与恐惧：回家与怕失去',
      '主要对手与对抗结构：车站困局', '弧光终点：离站→到站', '读者承诺：小人物突围', '结局形态：HE']
    const block = /## 故事设计\n\n[\s\S]*?(?=\n## |$)/
    t = t.replace(block, `## 故事设计\n\n${items.map((x) => line(x)).join('\n')}\n`)
    await writeFile(file, t, 'utf8')
  }
  await fillAll('故事底本/文风.md', '文风')

  // --- 3. 跑 deliver 校验：不该出现 E_ACTS / E_ACT_COVER ---
  const v = await validateOutput({ root: out, mode: 'deliver' })
  const actErrs = v.errors.filter((e) => e.code === 'E_ACTS' || e.code === 'E_ACT_COVER')
  assert.deepEqual(actErrs, [], `多卷网文不该有幕覆盖错误，实际：${JSON.stringify(actErrs)}`)

  // --- 3b. 正向：把卷02 的一份幕纲删掉，弧数(2)≠幕数(1)，必须报 E_ACT_COVER ---
  // 只做反向断言（「不该报错」）抓不住校验器被整个关掉的情况，故补一条正向用例。
  {
    const dropped = join(out, '故事底本/故事剧情/幕纲/卷02-幕02-终局弧.md')
    const keep = await readFile(dropped, 'utf8')
    await rm(dropped)
    const vDrop = await validateOutput({ root: out, mode: 'deliver' })
    const cover = vDrop.errors.filter((e) => e.code === 'E_ACT_COVER')
    assert.equal(cover.length, 1,
      `卷02 弧 2 条但幕纲 1 份，应报 1 条 E_ACT_COVER，实际 ${cover.length}：${JSON.stringify(vDrop.errors.map((e) => e.code))}`)
    assert.match(cover[0].message, /事件弧 2 条.*幕纲 1 份|事件弧\t2/, `文案应点明弧数与幕数：${cover[0].message}`)
    await writeFile(dropped, keep, 'utf8')   // 还原，后续用例依赖四份幕纲
  }

  // --- 4. 跨卷不串味：卷02 的幕纲引用 A01，应按卷02 自己的弧清单核对 ---
  // 把卷02 幕01 的弧号改成卷01 独有的不存在的号，应触发 W_ARC_REF
  const act2 = join(out, '故事底本/故事剧情/幕纲/卷02-幕01-回望弧.md')
  let t2 = await readFile(act2, 'utf8')
  await writeFile(act2, t2.replace('卷纲弧号 A01', '卷纲弧号 A99'), 'utf8')
  const v2 = await validateOutput({ root: out, mode: 'deliver' })
  assert.ok(v2.errors.some((w) => w.code === 'W_ARC_REF'),
    `弧号 A99 不在卷02 弧清单里，应报 W_ARC_REF，实际警告：${JSON.stringify(v2.errors.map((w) => w.code))}`)
})

test('网文多卷：某卷一份幕纲都没有时，deliver 报 E_ACTS 而 draft 只警告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivol-missing-'))
  const src = join(dir, '两卷书.txt')
  await writeFile(src, THE_BOOK, 'utf8')
  const r = await prepare({ input: src, force: true })
  const out = r.outDir

  // 一份幕纲都不建，直接校验
  const draft = await validateOutput({ root: out, mode: 'draft' })
  assert.ok(draft.errors.some((w) => w.code === 'W_ACTS'),
    'draft 模式应只警告缺幕纲')
  assert.ok(!draft.errors.some((e) => e.code === 'E_ACTS'),
    'draft 模式不该因缺幕纲报错')

  const deliver = await validateOutput({ root: out, mode: 'deliver' })
  const acts = deliver.errors.filter((e) => e.code === 'E_ACTS')
  assert.equal(acts.length, 2, `deliver 模式应对两卷各报一条 E_ACTS，实际 ${acts.length}：${JSON.stringify(acts.map((e) => e.message))}`)
})


