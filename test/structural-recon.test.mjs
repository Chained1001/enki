// 防的漂移：三处写着同一件事（同一弧的起止章、同一伏笔编号、同一个人的首现章），写岔了没人拦。
// 背景：2026-10-25 产物实证——全书大纲/卷纲/幕纲对同一弧的起止章各写一个数；
// 伏笔编号 F01-01 大量悬空（台账里根本没有这条）；人物卡首现章与词典不一致（写 239，实为 197）。
// 这四类都是纯文本可对账的，不需要读原文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { validateOutput } from '../skills/book-breakdown/scripts/validate-output.mjs'
import { SECTIONS, tableColumns } from '../skills/book-breakdown/scripts/contract.mjs'

const NOVEL = [
  '第一章 相遇', '张三说：「把刀放下。」李四点头。', '',
  '第二章 同行', '两人同行三十里。', '',
  '第三章 风波', '起了风波。', '',
  '第四章 破局', '破了局。', '',
  '第五章 归途', '各自归途。', '',
].join('\n')

const quote = '（第 1 章：「张三，把刀放下。」）'
const line = (text) => `- ${text}${quote}`

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

// 造一份可交付产物，幕纲/卷纲弧名与起止章互相对得上。
async function makeProduct() {
  const dir = await mkdtemp(join(tmpdir(), 'rec-'))
  const src = join(dir, '书.txt')
  await writeFile(src, NOVEL, 'utf8')
  const r = await prepare({ input: src })
  const out = r.outDir

  const write = (rel, text) => writeFile(join(out, rel), text, 'utf8')
  const fillAll = async (rel, sectionKey) => {
    const file = join(out, rel)
    let text = await readFile(file, 'utf8')
    for (const s of SECTIONS[sectionKey]) {
      text = text.replace(new RegExp(`(## ${s}\\n\\n)（待填）`), `$1${line(`${sectionKey}·${s}`)}`)
    }
    await writeFile(file, text, 'utf8')
  }

  await fillAll('故事底本/全书设定/世界观.md', '世界观')
  {
    const f = join(out, '故事底本/全书设定/金手指.md')
    let t = await readFile(f, 'utf8')
    t = t.replace('- 金手指名称：（待填）', '- 金手指名称：后世记忆')
    await writeFile(f, t, 'utf8')
  }
  await fillAll('故事底本/全书设定/金手指.md', '金手指')

  // 卷纲：弧名与起止章
  await writeFile(join(out, '故事底本/故事剧情/卷纲/卷01-全书.md'),
    `# 卷纲 卷01\n\n` + SECTIONS.卷纲.map((s) => {
      if (s === '事件弧清单') {
        return `## ${s}\n\n| 弧号 | 弧名 | 起止章 | 弧型 | 五拍完成度 |\n| --- | --- | --- | --- | --- |\n| A01 | 相遇弧 | 1-2 | 关系阶段弧 | 全 |\n| A02 | 风波弧 | 3-5 | 案件弧 | 全 |\n`
      }
      return `## ${s}\n\n${line(`卷纲·${s}`)}\n`
    }).join('\n'), 'utf8')

  // 幕纲：文件名带弧名，正文有起止章
  const acts = [['相遇弧', 'A01', '1-2'], ['风波弧', 'A02', '3-5']]
  for (const [i, [arc, arcNo, span]] of acts.entries()) {
    const body = SECTIONS.幕纲.map((s) => {
      if (s === '与卷纲的对应') return `## ${s}\n\n卷纲弧号 ${arcNo}\n`
      if (s === '情绪基调与走向') return `## ${s}\n\n入幕：抑；幕中峰值：扬；出口：抑\n`
      return `## ${s}\n\n${line(`${arc}·${s}`)}\n`
    }).join('\n')
    await write(join('故事底本/故事剧情/幕纲', `卷01-幕0${i + 1}-${arc}.md`),
      `# 幕纲 ${arc}\n\n起止章：第 ${span.split('-')[0]}-${span.split('-')[1]} 章\n\n${body}`)
  }

  // 别名词典（首现章）与伏笔台账（编号）
  await write('工作/别名词典.md',
    `# 别名词典\n\n| 主名 | 别称 | 首次出现章 | 归属 |\n| --- | --- | --- | --- |\n| 张三 | 三郎 | 1 | 主线 |\n| 李四 | 四哥 | 2 | 青云门 |\n`)
  await write('故事底本/故事剧情/伏笔台账.md',
    `# 伏笔台账\n\n| 编号 | 内容 | 埋设章 | 回收章 | 状态 |\n| --- | --- | --- | --- | --- |\n| F01-01 | 断刀 | 1 | 5 | 已收 |\n`)

  // 人物卡：李四首现章写 2（与词典一致）
  const card = (title, fields) =>
    `# ${title}\n\n` + fields.map(([k, v]) => `- ${k}：${v}`).join('\n') + '\n'
  await write('故事底本/全书设定/人物/主要配角/李四.md', card('李四', [
    ['姓名（主名）', '李四'], ['别称与马甲', '四哥'], ['归属势力', '青云门'], ['力量/成长坐标', line('炼气三段')],
    ['首次出场章', '第2章'], ['关键章节链', line('第2章同行')], ['核心关系', line('张三的挚友')],
    ['说话风格与人设锚点', line('话说得少')], ['体貌锚点', line('瘦高')], ['衣着与装束', line('青衫')],
    ['神态与动作锚', line('摸鼻子')], ['外在目标（要什么）', line('求道')], ['内在缺口（缺什么）', line('怕被抛下')],
    ['致命弱点（会毁在哪）', line('心软')], ['原型词/功能位', '挚友'], ['结局状态与死亡/退场章', '在世'],
    ['金句锚', line('「张三那把刀，我一直替他留着。」')],
  ]))
  return { dir, out }
}

const run = async (fn) => {
  const { dir, out } = await makeProduct()
  try { await fn(out) } finally { await rm(dir, { recursive: true, force: true }) }
}
const read = (out, rel) => readFile(join(out, rel), 'utf8')
const write = (out, rel, t) => writeFile(join(out, rel), t, 'utf8')

test('基线：弧名章号、伏笔编号、首现章三处对得上时不报这四类', async () => {
  await run(async (out) => {
    const r = await validateOutput({ root: out })
    for (const code of ['E_ARC_SPAN', 'E_FORESHADOW_REF', 'W_FIRST_SEEN', 'W_STALE_MARK']) {
      assert.ok(!r.errors.some((e) => e.code === code), `基线不该报 ${code}：${JSON.stringify(r.errors.filter((e) => e.code === code))}`)
    }
  })
})

test('E_ARC_SPAN：同一弧在卷纲与幕纲的起止章不等时报错，且写明两处各自的值', async () => {
  await run(async (out) => {
    const rel = '故事底本/故事剧情/幕纲/卷01-幕02-风波弧.md'
    const t = await read(out, rel)
    await write(out, rel, t.replace('起止章：第 3-5 章', '起止章：第 3-6 章'))
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'E_ARC_SPAN')
    assert.equal(hit.length, 1)
    assert.match(hit[0].message, /风波弧/)
    assert.match(hit[0].message, /3-5/, '须写出卷纲侧的值')
    assert.match(hit[0].message, /3-6/, '须写出幕纲侧的值')

    await write(out, rel, t)
  })
})

test('E_ARC_SPAN：弧名对不上时不误报（不同名的弧不参与对账）', async () => {
  await run(async (out) => {
    const rel = '工作/别名词典.md'
    const t = await read(out, rel)
    await write(out, rel, t) // 无关改动
    const r = await validateOutput({ root: out })
    assert.ok(!r.errors.some((e) => e.code === 'E_ARC_SPAN'))
  })
})

test('E_FORESHADOW_REF：引用了台账里不存在的伏笔编号时报错，写明悬空编号', async () => {
  await run(async (out) => {
    const rel = '故事底本/故事剧情/卷纲/卷01-全书.md'
    const t = await read(out, rel)
    await write(out, rel, t + '\n伏笔 F01-01 与 F01-99 埋设于本卷。\n')
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'E_FORESHADOW_REF')
    assert.equal(hit.length, 1, '只该报一条（按文件汇总）')
    assert.match(hit[0].message, /F01-99/, '须写出悬空编号')
    assert.ok(!/F01-01/.test(hit[0].message), '台账里有的编号不该被列为悬空')

    await write(out, rel, t)
  })
})

test('E_FORESHADOW_REF：台账空着（还没开始记）时不把全书引用判成悬空', async () => {
  await run(async (out) => {
    const ledger = '故事底本/故事剧情/伏笔台账.md'
    const orig = await read(out, ledger)
    await write(out, ledger, `# 伏笔台账\n\n| 编号 | 内容 | 埋设章 | 回收章 | 状态 |\n| --- | --- | --- | --- | --- |\n`)
    const rel = '故事底本/故事剧情/卷纲/卷01-全书.md'
    const t = await read(out, rel)
    await write(out, rel, t + '\n伏笔 F01-01 埋设于本卷。\n')
    const r = await validateOutput({ root: out })
    assert.ok(!r.errors.some((e) => e.code === 'E_FORESHADOW_REF'), '台账无编号时不该判悬空')

    await write(out, ledger, orig)
    await write(out, rel, t)
  })
})

test('W_FIRST_SEEN：人物卡首现章与词典不一致时告警，写明两边的值', async () => {
  await run(async (out) => {
    const rel = '故事底本/全书设定/人物/主要配角/李四.md'
    const t = await read(out, rel)
    await write(out, rel, t.replace('- 首次出场章：第2章', '- 首次出场章：第3章'))
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'W_FIRST_SEEN')
    assert.equal(hit.length, 1)
    assert.match(hit[0].message, /李四/)
    assert.match(hit[0].message, /3/, '须写卡片侧的值')
    assert.match(hit[0].message, /2/, '须写词典侧的值')

    await write(out, rel, t)
  })
})

test('W_FIRST_SEEN：卡主名不在词典主名列时也告警（这种情况首现章根本无从对账）', async () => {
  await run(async (out) => {
    const rel = '故事底本/全书设定/人物/主要配角/李四.md'
    const t = await read(out, rel)
    await write(out, rel, t.replace('- 姓名（主名）：李四', '- 姓名（主名）：赵六'))
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'W_FIRST_SEEN')
    assert.ok(hit.length >= 1)
    assert.match(hit[0].message, /赵六/)
    assert.match(hit[0].message, /不在别名词典主名列/)

    await write(out, rel, t)
  })
})

test('W_STALE_MARK：卷纲已存在但仍标「本卷未拆」时告警', async () => {
  await run(async (out) => {
    const rel = '故事底本/全书设定/世界观.md'
    const t = await read(out, rel)
    await write(out, rel, t + '\n（第 2 卷尚未拆解）\n')
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'W_STALE_MARK')
    assert.equal(hit.length, 1)
    assert.match(hit[0].message, /卷纲已有 1 份/)

    await write(out, rel, t)
  })
})

test('W_STALE_MARK 与 E_ARC_SPAN 只是警告/错误各归各位，不互相顶替', async () => {
  await run(async (out) => {
    const rel = '故事底本/全书设定/世界观.md'
    const t = await read(out, rel)
    await write(out, rel, t + '\n（第 2 卷尚未拆解）\n')
    const r = await validateOutput({ root: out })
    const stale = r.errors.find((e) => e.code === 'W_STALE_MARK')
    assert.equal(stale.severity, 'warning', '状态未更新是提示，不该阻断交付')
    await write(out, rel, t)
  })
})
