// 防的漂移：validate-output.mjs 的校验项与 PRD 验收标准（A-04~A-22 可脚本部分）脱节。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { findLineGaps, validateOutput } from '../skills/book-breakdown/scripts/validate-output.mjs'
import { SECTIONS, tableColumns } from '../skills/book-breakdown/scripts/contract.mjs'

const NOVEL = [
  '第一章 相遇', '张三说：「你好。」李四点头。', '',
  '第二章 同行', '两人同行。', '',
  '第三章 风波', '起了风波。', '',
  '第四章 破局', '破了局。', '',
  '第五章 归途', '各自归途。', '',
].join('\n')

const quote = '（第 1 章：「你好。」）'
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

// 造一份「完整填写」的产物。
async function makeFilledProduct() {
  const dir = await mkdtemp(join(tmpdir(), 'vo-'))
  const src = join(dir, '验收书.txt')
  await writeFile(src, NOVEL, 'utf8')
  const r = await prepare({ input: src })
  const out = r.outDir

  const fill = async (rel, sections) => {
    const file = join(out, rel)
    let text = await readFile(file, 'utf8')
    text = text.replace(/^> 骨架文件.*$\n?/m, '')
    for (const [name, content] of Object.entries(sections)) {
      // 段块整体替换（Q-23/Q-24 跟进）：故事设计块的骨架是七项引导行，不是整段「（待填）」。
      const block = new RegExp(`## ${name}\\n\\n[\\s\\S]*?(?=\\n## |$)`)
      if (!block.test(text)) throw new Error(`${rel} 找不到段「${name}」`)
      text = text.replace(block, `## ${name}\n\n${content}\n`)
    }
    if (text.includes('（待填）')) throw new Error(`${rel} 填写后仍有待填`)
    await writeFile(file, text, 'utf8')
  }
  const writeRel = (rel, content) => writeFile(join(out, rel), content, 'utf8')
  const fillAll = (rel, product, extra = {}) => {
    const sections = {}
    for (const s of SECTIONS[product]) sections[s] = extra[s] ?? line(`${product}·${s}`)
    return fill(rel, sections)
  }

  // 全书大纲（Q-23/Q-24 跟进）：第一块故事设计七项逐行填写（骨架是七项引导行）。
  await fill('故事底本/故事剧情/全书大纲.md', {
    ...Object.fromEntries(SECTIONS.全书大纲.filter((s) => s !== '故事设计').map((s) => [s, line(`全书大纲·${s}`)])),
    故事设计: ['主题母题：凡人抗天', '主角 logline：张三要归乡', '核心欲望与恐惧：回家与怕失去', '主要对手与对抗结构：车站困局', '弧光终点：离站→到站', '读者承诺：小人物突围', '结局形态：HE'].map((t) => line(t)).join('\n'),
  })
  await fillAll('故事底本/故事剧情/开篇三章.md', '开篇三章')
  await fillAll('故事底本/全书设定/世界观.md', '世界观')
  {
    const file = join(out, '故事底本/全书设定/金手指.md')
    let text = await readFile(file, 'utf8')
    text = text.replace('- 金手指名称：（待填）', '- 金手指名称：后世记忆与认知')
    await writeFile(file, text, 'utf8')
  }
  await fillAll('故事底本/全书设定/金手指.md', '金手指')
  await fill('故事底本/文风.md', Object.fromEntries(
    SECTIONS.文风.filter((s) => s !== '定量指纹').map((s) => [s, line(`文风·${s}`)]),
  ))
  await fill('故事底本/故事剧情/卷纲/卷01-全书.md', {
    ...Object.fromEntries(SECTIONS.卷纲.filter((s) => s !== '事件弧清单').map((s) => [s, line(`卷纲·${s}`)])),
    // 弧清单加「弧号」列（Q-24）：A01 起连续，是幕纲「与卷纲的对应」的外键。
    事件弧清单: [
      '| 弧号 | 弧名 | 起止章 | 弧型 | 五拍完成度 |',
      '| --- | --- | --- | --- | --- |',
      '| A01 | 相遇弧 | 1-2 | 关系阶段弧 | 全 |',
      '| A02 | 风波弧 | 3-5 | 案件弧 | 全 |',
    ].join('\n'),
  })
  for (const [i, arc] of ['相遇弧', '风波弧'].entries()) {
    const arcNo = `A0${i + 1}`
    await writeRel(`故事底本/故事剧情/幕纲/卷01-幕0${i + 1}-${arc}.md`,
      `# 幕纲 ${arc}\n\n` + SECTIONS.幕纲.map((s) =>
        `## ${s}\n\n${line(s === '与卷纲的对应' ? `卷纲弧号 ${arcNo}` : `${arc}·${s}`)}\n`).join('\n'))
  }
  for (const topic of ['力量体系', '成长与资源体系', '历史年表', '地理图志', '规则与铁则']) {
    const file = join(out, `故事底本/全书设定/专题/${topic}.md`)
    let text = await readFile(file, 'utf8')
    text = text
      .replace(/^> 骨架文件.*$\n?/m, '')
      .replace('- 判定：（待填：涉及/弱涉及/本题材不涉及）', '- 判定：涉及')
      .replace('- 依据：（待填）', `- 依据：原文有此子域${quote}`)
    for (const s of SECTIONS.专题.filter((x) => x !== '涉及判定')) {
      text = text.replace(`## ${s}\n\n（待填）`, `## ${s}\n\n${line(`${topic}·${s}`)}\n`)
    }
    if (text.includes('（待填）')) throw new Error(`专题 ${topic} 填写后仍有待填`)
    await writeFile(file, text, 'utf8')
  }
  await writeRel('故事底本/全书设定/专题/时代参照层.md',
    `# 时代参照层\n\n## 涉及判定\n\n- 判定：本题材不涉及\n- 依据：架空世界无现实年代${quote}\n- 指向：历史年表\n`)

  await mkdir(join(out, '故事底本', '全书设定', '人物', '主角', '张三'), { recursive: true })
  for (const f of ['人物卡', '成长轨迹', '身份与马甲', '目标与动机链', '关系与阵营']) {
    await writeRel(`故事底本/全书设定/人物/主角/张三/${f}.md`, `# 张三 ${f}\n\n${line(`张三·${f}`)}\n`)
  }
  // 卡片按模板字段逐条填写（T9）：validate-output 现在查卡片字段标签的存在性与非空，
  // 单行「- 一句话」的卡会被 E_CARD_FIELD 拦下——这正是要防的那种空卡。
  const card = (title, fields) =>
    `# ${title}\n\n` + fields.map(([label, value]) => `- ${label}：${value}`).join('\n') + '\n'
  const v = (text) => `${text}${quote}`
  await writeRel('故事底本/全书设定/人物/主要配角/李四.md', card('李四', [
    ['姓名（主名）', '李四'], ['别称与马甲', '四哥'], ['归属势力', '青云门'], ['力量/成长坐标', v('炼气三段')],
    ['首次出场章', '第1章'], ['关键章节链', v('第1章相遇')], ['核心关系', v('张三的挚友')],
    ['说话风格与人设锚点', v('笑着说话')], ['体貌锚点', v('瘦高')], ['衣着与装束', v('青衫')],
    ['神态与动作锚', v('摸鼻子')], ['外在目标（要什么）', v('求道')], ['内在缺口（缺什么）', v('怕被抛下')],
    ['致命弱点（会毁在哪）', v('心软')], ['原型词/功能位', '挚友'], ['结局状态与死亡/退场章', '在世（未完）'],
    ['金句锚', v('「走吧。」')],
  ]))
  await writeRel('故事底本/全书设定/人物/次要角色/王五.md', card('王五', [
    ['姓名（主名）', '王五'], ['别称与马甲', '无'], ['归属势力', '无'], ['力量/成长坐标', v('原文未写')],
    ['首次出场章', '第2章'], ['关键章节链', v('第2章露面')], ['核心关系', v('路人')],
    ['说话风格与人设锚点', v('沉默')], ['体貌锚点', v('原文未写')], ['衣着与装束', v('原文未写')],
    ['神态与动作锚', v('原文未写')], ['外在目标（要什么）', v('原文未写')], ['内在缺口（缺什么）', v('原文未写')],
    ['致命弱点（会毁在哪）', v('原文未写')], ['原型词/功能位', '路人'], ['结局状态与死亡/退场章', '在世（未完）'],
    ['金句锚', v('「嗯。」')],
  ]))
  await writeRel('故事底本/全书设定/势力与组织/门派/青云门.md', card('青云门', [
    ['名称与俗称', '青云门'], ['性质类型', '门派'], ['所在地/据点', '青云山'], ['层级结构', v('掌门—长老—弟子')],
    ['成员表', v('李四')], ['势力关系', v('与魔教敌对')], ['与主角关系及演变', v('收留张三')],
    ['首次出场章', '第1章'], ['关键事件章', v('第3章灭门')], ['状态变化', v('由盛转衰')], ['结局', v('覆灭')],
  ]))
  await writeRel('故事底本/全书设定/地点/城市与场所/车站.md', card('车站', [
    ['名称', '车站'], ['别名与真名揭示章', '无'], ['所属区域', '县城'], ['功能与象征意义', v('离别之地')],
    ['空间规则', '常规'], ['关联人物与势力', v('张三、李四')], ['首次出场章', '第1章'],
    ['进入章', '第1章'], ['状态轨迹', v('始终原样')],
  ]))
  await writeRel('故事底本/全书设定/物品/武器/铁剑.md', card('铁剑', [
    ['名称', '铁剑'], ['类别', '武器'], ['强度等级', v('能胜寻常镖师')], ['能力与代价', v('无特殊代价')],
    ['获得章', '第1章'], ['经手与流转链', v('李四→张三')], ['象征义', v('信物')], ['结局', v('断于第5章')],
  ]))
  await writeRel('故事底本/全书设定/概念/事件/初遇.md', card('初遇', [
    ['名称', '初遇'], ['一句话定义', v('两人在车站结识')], ['首次系统阐释章', '第1章'],
    ['规则细节', v('无')], ['上位/下位概念', v('原文未提及其他概念')], ['揭示节奏', v('第1章引入')], ['与主角的关系', v('起点事件')],
  ]))

  const P = '故事底本/全书设定'
  await writeRel(`${P}/人物/索引.md`, tableFile('人物索引', '人物索引', [
    ['张三', '张三', '主角', '主角', '中立', '第1章', `${P}/人物/主角/张三`],
    ['李四', '李四', '主要配角', '弧线配角', '友方', '第1章', `${P}/人物/主要配角/李四.md`],
    ['王五', '王五', '次要', '无', '路人', '第2章', `${P}/人物/次要角色/王五.md`],
  ]))
  await writeRel(`${P}/人物/人物关系.md`, tableFile('人物关系', '人物关系', [
    ['张三', '挚友', '李四', '第1章', '不变'],
  ]))
  await writeRel(`${P}/势力与组织/索引.md`, tableFile('势力索引', '集合索引', [
    ['青云门', '门派', '主要', '第1章', `${P}/势力与组织/门派/青云门.md`],
  ]))
  await writeRel(`${P}/地点/索引.md`, tableFile('地点索引', '集合索引', [
    ['车站', '城市与场所', '次要', '第1章', `${P}/地点/城市与场所/车站.md`],
  ]))
  await writeRel(`${P}/物品/索引.md`, tableFile('物品索引', '集合索引', [
    ['铁剑', '武器', '次要', '第1章', `${P}/物品/武器/铁剑.md`],
  ]))
  await writeRel(`${P}/概念/索引.md`, tableFile('概念索引', '集合索引', [
    ['初遇', '事件', '次要', '第1章', `${P}/概念/事件/初遇.md`],
  ]))
  await writeRel('工作/别名词典.md', tableFile('别名词典', '别名词典', [
    ['张三', '张三', '人物', '第1章', '本名'],
  ]))
  await writeRel('工作/逐章记录.md', tableFile('逐章记录', '逐章记录', [
    // 十二列：第 3 格「章字数」必须与 manifest.chapters[].chars 逐字一致（E_CHARCOUNT 严格校验），
    // 本夹具由 NOVEL 真实跑 prepare 生成，故此处取实测值 14/5/5/4/5。
    ['1', '第一章 相遇', '14', '张三', '车站', '张三、李四', '相遇', '主线', '埋 F001', '扬', '悬念', '无'],
    ['2', '第二章 同行', '5', '张三', '路上', '张三、李四', '同行', '主线', '', '扬', '期待', '小'],
    ['3', '第三章 风波', '5', '张三', '路上', '张三、李四', '风波', '主线', '', '抑', '钝收', '无'],
    ['4', '第四章 破局', '4', '张三', '路上', '张三、李四', '破局', '主线', '', '扬', '反差', '大'],
    ['5', '第五章 归途', '5', '张三', '车站', '张三', '归途', '主线', '收 F001', '扬', '危机', '中'],
  ]))
  await writeRel('故事底本/故事剧情/伏笔台账.md', tableFile('伏笔台账', '伏笔台账', [
    // 十一列跟进（Q-23/Q-24 跟进）：类型/回收幕/重要度取合法枚举。
    ['F001', '信物', '道具', '第1章', '第2章', '第5章', '卷01-幕02', '4', '张三', '主线', '已收'],
  ]))
  await writeRel('故事底本/故事剧情/分卷总表.md', tableFile('分卷总表', '分卷总表', [
    // 十五列跟进（Q-23/Q-24 跟进）：本卷主要对手/追读钩入列，商业外证写「无」＝无数据。
    ['01', '全书', '书名', '1-5', '5', '100/20', '相遇钩', '关系困局', '李四', '成长', '车站', '定格', '下一卷悬念', '三天', '无'],
  ]))

  return { dir, out }
}

async function withFilled(run) {
  const { dir, out } = await makeFilledProduct()
  try {
    await run(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('完整产物通过交付校验（零错误零警告）', async () => {
  await withFilled(async (out) => {
    const result = await validateOutput({ root: out })
    assert.deepEqual(result.errors, [], '完整产物不应有任何问题')
    assert.ok(result.ok)
    assert.equal(result.data.verdict, '通过')
  })
})

test('状态列带括号说明、文件残留骨架说明行不误报（spike 修复回归）', async () => {
  await withFilled(async (out) => {
    const read = (rel) => readFile(join(out, rel), 'utf8')
    const write = (rel, text) => writeFile(join(out, rel), text, 'utf8')

    // 伏笔状态「已收（说明…）」：枚举开头即可
    const ledgerRel = '故事底本/故事剧情/伏笔台账.md'
    const ledger = await read(ledgerRel)
    await write(ledgerRel, ledger.replace('| 已收 |', '| 已收（转获鹿野战决胜的战略约束） |'))
    let r1 = await validateOutput({ root: out })
    assert.ok(!r1.errors.some((e) => e.code === 'E_FORESHADOW'), '带说明的状态不应误报')

    // 已填文件残留骨架说明行（引用块含占位字样）不算未填
    const actRel = '故事底本/故事剧情/幕纲/卷01-幕01-相遇弧.md'
    const act = await read(actRel)
    await write(actRel, `> 骨架文件：每段填写后删除「（待填）」。\n${act}`)
    let r2 = await validateOutput({ root: out })
    assert.ok(!r2.errors.some((e) => e.code === 'E_UNFILLED' && e.file === actRel), '引用块里的占位字样不应触发未填')

    await write(ledgerRel, ledger)
    await write(actRel, act)
  })
})

test('进度模式：骨架产物判定进行中且不阻断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-prog-'))
  try {
    const src = join(dir, '骨架书.txt')
    await writeFile(src, NOVEL, 'utf8')
    const r = await prepare({ input: src })
    const result = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.ok(result.ok, '进度模式不因未填写而失败')
    assert.equal(result.data.verdict, '进行中')
    assert.ok(result.data.files.skeleton > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('删段、改表头、删行、坏台账、多文件、缺文件、缺出处、弧幕不齐各自报对应错误码', async () => {
  await withFilled(async (out) => {
    const read = (rel) => readFile(join(out, rel), 'utf8')
    const write = (rel, text) => writeFile(join(out, rel), text, 'utf8')

    // E_SECTION：幕纲删段
    const actRel = '故事底本/故事剧情/幕纲/卷01-幕01-相遇弧.md'
    const act = await read(actRel)
    await write(actRel, act.replace('## 幕末钩子\n\n' + line('相遇弧·幕末钩子') + '\n', ''))
    let r1 = await validateOutput({ root: out })
    assert.ok(r1.errors.some((e) => e.code === 'E_SECTION' && e.severity === 'error'), '应有 E_SECTION')
    await write(actRel, act)

    // E_COLUMN：分卷总表表头删一列
    const tableRel = '故事底本/故事剧情/分卷总表.md'
    const table = await read(tableRel)
    await write(tableRel, table.replace('| 卷 | 卷名 |', '| 卷 |'))
    let r2 = await validateOutput({ root: out })
    assert.ok(r2.errors.some((e) => e.code === 'E_COLUMN'), '应有 E_COLUMN')
    await write(tableRel, table)

    // E_ROW_COUNT：逐章记录删一行
    const recordRel = '工作/逐章记录.md'
    const record = await read(recordRel)
    // 十二列：删除目标行同步带「章字数」格，与 makeFilledProduct 的行保持逐字一致。
    await write(recordRel, record.replace('| 5 | 第五章 归途 | 5 | 张三 | 车站 | 张三 | 归途 | 主线 | 收 F001 | 扬 | 危机 | 中 |\n', ''))
    let r3 = await validateOutput({ root: out })
    assert.ok(r3.errors.some((e) => e.code === 'E_ROW_COUNT'), '应有 E_ROW_COUNT')
    await write(recordRel, record)

    // E_CHARCOUNT：章字数被手改成非数字 / 与 manifest 不一致，两路都要报
    await write(recordRel, record.replace('| 1 | 第一章 相遇 | 14 |', '| 1 | 第一章 相遇 | 约一万字 |'))
    let rc1 = await validateOutput({ root: out })
    assert.ok(rc1.errors.some((e) => e.code === 'E_CHARCOUNT'), '章字数写成文字应报 E_CHARCOUNT')
    await write(recordRel, record.replace('| 1 | 第一章 相遇 | 14 |', '| 1 | 第一章 相遇 | 999 |'))
    let rc2 = await validateOutput({ root: out })
    assert.ok(rc2.errors.some((e) => e.code === 'E_CHARCOUNT'), '章字数与 manifest 不一致应报 E_CHARCOUNT')
    await write(recordRel, record)

    // E_FORESHADOW：编号跳号、非法状态、回收早于埋点
    // 十一列跟进（Q-23/Q-24 跟进）：追加行按新列序补类型/回收幕/重要度。
    const ledgerRel = '故事底本/故事剧情/伏笔台账.md'
    const ledger = await read(ledgerRel)
    await write(ledgerRel, ledger
      + '| F003 | 跳号 | 道具 | 第1章 | | | | | | 主线 | 已收 |\n'
      + '| F002 | 坏状态 | 道具 | 第2章 | | | | | | 主线 | 完成 |\n'
      + '| F003 | 早收 | 道具 | 第5章 | | 第1章 | | | 张三 | 主线 | 未收 |\n')
    let r4 = await validateOutput({ root: out })
    const fore = r4.errors.filter((e) => e.code === 'E_FORESHADOW')
    assert.ok(fore.length >= 3, `应有至少 3 处 E_FORESHADOW，实际 ${fore.length}`)
    await write(ledgerRel, ledger)

    // E_TREE_EXTRA：多余文件
    await write('故事底本/多余.md', '# 多余\n')
    let r5 = await validateOutput({ root: out })
    assert.ok(r5.errors.some((e) => e.code === 'E_TREE_EXTRA' && e.file === '故事底本/多余.md'), '应有 E_TREE_EXTRA')
    await rm(join(out, '故事底本', '多余.md'))

    // E_TREE_MISSING：缺固定文件
    const worldRel = '故事底本/全书设定/世界观.md'
    const world = await read(worldRel)
    await rm(join(out, worldRel))
    let r6 = await validateOutput({ root: out })
    assert.ok(r6.errors.some((e) => e.code === 'E_TREE_MISSING' && e.file === worldRel), '应有 E_TREE_MISSING')
    await write(worldRel, world)

    // E_SOURCE：结论缺出处
    await write(actRel, act + '\n- 没有出处的结论\n')
    let r7 = await validateOutput({ root: out })
    assert.ok(r7.errors.some((e) => e.code === 'E_SOURCE' && e.file === actRel), '应有 E_SOURCE')
    await write(actRel, act)

    // E_ACT_COVER：卷纲弧数与幕数不一致（弧号列跟进 Q-23/Q-24）
    const volRel = '故事底本/故事剧情/卷纲/卷01-全书.md'
    const vol = await read(volRel)
    await write(volRel, vol.replace('| A02 | 风波弧 | 3-5 | 案件弧 | 全 |', '| A02 | 风波弧 | 3-5 | 案件弧 | 全 |\n| A03 | 余波弧 | 5-5 | 案件弧 | 全 |'))
    let r8 = await validateOutput({ root: out })
    assert.ok(r8.errors.some((e) => e.code === 'E_ACT_COVER'), '应有 E_ACT_COVER')
    await write(volRel, vol)

    // 恢复后应再次全绿
    const final = await validateOutput({ root: out })
    assert.deepEqual(final.errors, [])
  })
})

test('出版书产物：幕纲数＝原文单元数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-pub-'))
  try {
    const unit = (n, name) => `第${n}幕 ${name}\n${'他说话了，声音很轻。'.repeat(2000)}\n`
    await writeFile(join(dir, '出版书.txt'), unit('一', '开端') + '\n' + unit('二', '转折') + '\n' + unit('三', '收束'), 'utf8')
    const r = await prepare({ input: join(dir, '出版书.txt') })
    const result = await validateOutput({ root: r.outDir, mode: 'progress' })
    assert.ok(result.ok)
    assert.equal(result.data.bookType, '出版')
    const acts = (await readdir(join(r.outDir, '故事底本', '故事剧情', '幕纲'))).filter((f) => f.endsWith('.md'))
    assert.equal(acts.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非产物目录报 E_MANIFEST', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-bad-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    const result = await validateOutput({ root: dir })
    assert.ok(!result.ok)
    assert.ok(result.errors.some((e) => e.code === 'E_MANIFEST'))
    assert.ok(!existsSync(join(dir, 'x')), '校验只读不写')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 产物增强（票C：Q-22 剧情线缺席警告，2026-10-23）----------

// 合成逐章记录行（十二列：加「章字数」，脚本填）：no 章的剧情线取 lines 数组、「、」连接；
// 钩型/爽点列与缺席检测无关，填合法枚举占位。
function lineRows(map, from = 1, to = 200) {
  const rows = []
  for (let no = from; no <= to; no++) {
    rows.push([String(no), `第${no}章`, '1200', '主角', '某地', '主角', `事件${no}`, (map[no] ?? ['主线']).join('、'), '', '扬', '悬念', '无'])
  }
  return rows
}

test('findLineGaps：某线出现 3 次后间隔 120 章命中（A-4）', () => {
  // 阈值取 contract 的 THRESHOLDS.剧情线缺席章数上限＝100（字面量硬编码，防漂移）。
  const rows = lineRows({ 10: ['主线', '支线·张荣水师'], 20: ['主线', '支线·张荣水师'], 30: ['主线', '支线·张荣水师'], 150: ['主线', '支线·张荣水师'] })
  const gaps = findLineGaps(rows, 100)
  assert.deepEqual(gaps, [{ 线名: '支线·张荣水师', 上次章号: 30, 缺席章数: 120 }], '第 30→150 章间隔 120>100 命中')
})

test('findLineGaps：主线每行出现不命中；不足 3 行的线不判缺席（A-4）', () => {
  const rows = lineRows({ 5: ['主线', '支线·两现'], 190: ['主线', '支线·两现'] })
  assert.deepEqual(findLineGaps(rows, 100), [], '每行出现的线无间隔；只出现 2 行的线（即使间隔 185 章）不进判定')
})

test('findLineGaps：待填与空单元格不算线名（A-4）', () => {
  // 十一列跟进（Q-23/Q-24 跟进）：行同步补钩型/爽点两格（空格不参与缺席检测）。
  const rows = [
    ['1', '第一章', '张三', '车站', '张三', '事件', '（待填）', '', '扬', '', ''],
    ['2', '第二章', '张三', '车站', '张三', '事件', '无', '', '扬', '', ''],
    ['3', '第三章', '张三', '车站', '张三', '事件', '（待填）', '', '扬', '', ''],
    ['200', '第四章', '张三', '车站', '张三', '事件', '（待填）', '', '扬', '', ''],
  ]
  assert.deepEqual(findLineGaps(rows, 100), [], '骨架态的待填/无/空格不产生缺席误报')
})

test('W_LINE_GAP：人工缺席数据在交付与进度两模式都报警告（A-4）', async () => {
  await withFilled(async (out) => {
    const recordRel = '工作/逐章记录.md'
    // 注入缺席数据：支线·李四出现 3 次（第 1/2/3 章）后第 104 章才再现（章号差 101>100）；
    // 主线每行出现，其最大间隔 100 恰不超过阈值，不告警——对照出警告只打缺席线。
    // 十一列跟进（Q-23/Q-24 跟进）：注入表同步补章末钩型/爽点标记两列（合法枚举）。
    // 十二列：再补「章字数」列（脚本填，此处填任意整数即可）。
    await writeFile(join(out, recordRel), [
      '# 逐章记录', '',
      '| 全局章号 | 标题（清洗后） | 章字数 | 视角人物 | 地点 | 出场人物 | 一句话事件 | 剧情线 | 伏笔埋/收 | 情绪 | 章末钩型 | 爽点标记 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 第一章 相遇 | 14 | 张三 | 车站 | 张三、李四 | 相遇 | 主线、支线·李四 | 埋 F001 | 扬 | 悬念 | 无 |',
      '| 2 | 第二章 同行 | 5 | 张三 | 路上 | 张三、李四 | 同行 | 主线、支线·李四 | | 扬 | 期待 | 小 |',
      '| 3 | 第三章 风波 | 5 | 张三 | 路上 | 张三、李四 | 风波 | 主线、支线·李四 | | 抑 | 钝收 | 无 |',
      '| 4 | 第四章 破局 | 4 | 张三 | 路上 | 张三、李四 | 破局 | 主线 | | 扬 | 反差 | 大 |',
      '| 104 | 第五章 归途 | 5 | 张三 | 车站 | 张三 | 归途 | 主线、支线·李四 | 收 F001 | 扬 | 危机 | 中 |',
      '',
    ].join('\n'), 'utf8')
    for (const mode of ['deliver', 'progress']) {
      const result = await validateOutput({ root: out, mode })
      const lineGaps = result.errors.filter((e) => e.code === 'W_LINE_GAP')
      assert.equal(lineGaps.length, 1, `${mode} 模式应恰有一条 W_LINE_GAP（主线不告警）`)
      assert.equal(lineGaps[0].file, '工作/逐章记录.md')
      assert.equal(lineGaps[0].severity, 'warning')
      assert.match(lineGaps[0].message, /剧情线 支线·李四 自第 3 章后已缺席 101 章/, `${mode} 模式警告文案`)
    }
    // 警告级不阻断：交付模式 ok 仍为 true，仅总判定降为「需修改」
    const deliver = await validateOutput({ root: out })
    assert.ok(deliver.ok, 'W_LINE_GAP 为警告级，不阻断')
    assert.equal(deliver.data.verdict, '需修改')
  })
})

// ---------- 策略空挂字段落地（票D：Q-23/Q-24，2026-10-23）----------

test('T10：情绪列纳入枚举校验（ENUMS.情绪 定义了却从没被用过）', async () => {
  await withFilled(async (out) => {
    const recordRel = '工作/逐章记录.md'
    const record = await readFile(join(out, recordRel), 'utf8')
    // 「上扬」不以任何合法值开头（合法值是 扬/抑/震荡），此前完全不报
    await writeFile(join(out, recordRel), record.replace('| 扬 | 悬念 |', '| 上扬 | 悬念 |'), 'utf8')
    const r = await validateOutput({ root: out })
    const hits = r.errors.filter((e) => e.code === 'E_ENUM')
    assert.equal(hits.length, 1, '情绪非法值应恰报一条')
    assert.match(hits[0].message, /第 1 行情绪「上扬」不在枚举内（扬、抑、震荡）/, '错误文案要列出合法取值')
    // 合法：枚举值开头＋补充说明（「震荡（先扬后抑）」）不报
    await writeFile(join(out, recordRel), record.replace('| 扬 | 悬念 |', '| 震荡（先扬后抑） | 悬念 |'), 'utf8')
    const r2 = await validateOutput({ root: out })
    assert.ok(!r2.errors.some((e) => e.code === 'E_ENUM'), '枚举开头的带说明取值不应误报')
  })
})

test('E_ENUM：逐章记录钩型非法值报错、枚举开头与待填不报（A-4）', async () => {
  await withFilled(async (out) => {
    const recordRel = '工作/逐章记录.md'
    const record = await readFile(join(out, recordRel), 'utf8')
    // 钩型非法值「大危机」（不以任何枚举值开头）
    await writeFile(join(out, recordRel), record.replace('| 悬念 | 无 |', '| 大危机 | 无 |'), 'utf8')
    let r1 = await validateOutput({ root: out })
    const enums = r1.errors.filter((e) => e.code === 'E_ENUM')
    assert.equal(enums.length, 1, '应恰有一条 E_ENUM')
    assert.match(enums[0].message, /第 1 行章末钩型「大危机」不在枚举内（危机、悬念、期待、反差、钝收）/, '错误文案含枚举清单')
    // 合法：枚举值开头＋补充说明不报
    await writeFile(join(out, recordRel), record.replace('| 悬念 | 无 |', '| 悬念（章末反问） | 无 |'), 'utf8')
    let r2 = await validateOutput({ root: out })
    assert.ok(!r2.errors.some((e) => e.code === 'E_ENUM'), '枚举开头的带说明取值不应误报')
    // 骨架态「（待填）」不报（清空该两格后注入）
    await writeFile(join(out, recordRel), record.replace('| 悬念 | 无 |', '| （待填） | （待填） |'), 'utf8')
    let r3 = await validateOutput({ root: out })
    assert.ok(!r3.errors.some((e) => e.code === 'E_ENUM'), '「（待填）」骨架态不报')
    await writeFile(join(out, recordRel), record)

    // 台账类型/重要度同规则：非法类型报错
    const ledgerRel = '故事底本/故事剧情/伏笔台账.md'
    const ledger = await readFile(join(out, ledgerRel), 'utf8')
    await writeFile(join(out, ledgerRel), ledger.replace('| 道具 |', '| 器物 |'), 'utf8')
    let r4 = await validateOutput({ root: out })
    const led = r4.errors.filter((e) => e.code === 'E_ENUM')
    assert.equal(led.length, 1)
    assert.match(led[0].message, /编号 F001 类型「器物」不在枚举内（道具、身份、情感、设定、事件）/)
    await writeFile(join(out, ledgerRel), ledger)
  })
})

test('W_ARC_REF：幕纲弧号在卷纲弧清单中不存在时命中、存在时不命中（A-4）', async () => {
  await withFilled(async (out) => {
    const actRel = '故事底本/故事剧情/幕纲/卷01-幕01-相遇弧.md'
    const act = await readFile(join(out, actRel), 'utf8')

    // 命中：幕01 引用 A99，卷01 弧清单只有 A01/A02
    await writeFile(join(out, actRel), act.replace('卷纲弧号 A01', '卷纲弧号 A99'), 'utf8')
    let r1 = await validateOutput({ root: out })
    const hit = r1.errors.filter((e) => e.code === 'W_ARC_REF')
    assert.equal(hit.length, 1, '应恰有一条 W_ARC_REF')
    assert.match(hit[0].message, /幕纲弧号 A99 在卷纲弧清单中不存在/, '外键缺失文案')
    assert.ok(r1.ok && r1.data.verdict === '需修改', '警告级不阻断')

    // 对应段无弧号也命中（缺弧号提示）
    await writeFile(join(out, actRel), act.replace('卷纲弧号 A01', '支撑卷纲的目标'), 'utf8')
    let r2 = await validateOutput({ root: out })
    assert.ok(r2.errors.some((e) => e.code === 'W_ARC_REF' && /缺弧号/.test(e.message)), '缺弧号应出 W_ARC_REF')

    // 不命中：恢复后零错误零警告
    await writeFile(join(out, actRel), act)
    const green = await validateOutput({ root: out })
    assert.deepEqual(green.errors, [], '弧号存在时不应有任何问题')
  })
})

// ---------- 真书实测缺陷回归（龙族1：13.2 万字出版书跑通时暴露） ----------

// 缺陷 1：集合目录与索引同时为空时「0 行 = 0 文件」自洽通过，整个集合零产出也判通过。
// 真书实测：5 张集合索引可以全是空表、实体卡一个不建，交付校验照样通过——「设定库没做」等于没做检查。
// 修法：每个集合至少要有一张卡；索引行数必须与卡片数相等（这条原本就有，缺的是「不许 0」）。
test('E_INDEX：集合整体为空（索引 0 行且无卡片）时报错', async () => {
  await withFilled(async (out) => {
    const idxRel = '故事底本/全书设定/势力与组织/索引.md'
    const cardRel = '故事底本/全书设定/势力与组织/门派/青云门.md'
    await writeFile(join(out, idxRel), tableFile('势力索引', '集合索引', []), 'utf8')
    await rm(join(out, cardRel))

    const r = await validateOutput({ root: out })
    assert.ok(
      r.errors.some((e) => e.code === 'E_INDEX' && e.file === idxRel && /空/.test(e.message)),
      '集合零产出必须报错，不能让「索引空 + 卡片空」互相抵账通过',
    )
    await writeFile(join(out, idxRel), tableFile('势力索引', '集合索引', [
      ['青云门', '门派', '主要', '第1章', '故事底本/全书设定/势力与组织/门派/青云门.md'],
    ]), 'utf8')
    await writeFile(join(out, cardRel), '# 青云门\n\n- 结构职能：青云门是门派（第 1 章）。\n', 'utf8')
  })
})

// 缺陷 2：模板里的段标题行写成「- 规则与边界：」（冒号后留空、子条目另起一行），
// 该标签不在 SOURCE_META_LABELS 白名单里，被当成「缺出处的结论」报 E_SOURCE。
// 真书实测：8 张概念卡全部命中，而它们其实每条子条目都带了章号。
test('E_SOURCE：值为空的「- 段标题：」行不应被判为缺出处的结论', async () => {
  await withFilled(async (out) => {
    const rel = '故事底本/全书设定/概念/事件/初遇.md'
    const card = [
      '# 初遇',
      '',
      '- 名称：初遇',
      '- 一句话定义：两人在车站第一次相遇。',
      '- 规则与边界：',
      '  - 只在车站发生（第 1 章）。',
      '  - 触发条件是李四主动搭话（第 1 章）。',
      '',
    ].join('\n')
    await writeFile(join(out, rel), card, 'utf8')
    const r = await validateOutput({ root: out })
    const hit = r.errors.filter((e) => e.code === 'E_SOURCE' && e.file === rel)
    assert.deepEqual(hit, [], '值为空的段标题行是结构，不是待出处的结论')
  })
})

// 缺陷 3：W_QUOTE 号称「按文件密度」，但分母 claims 只累计「-」开头的列表行。
// 把同一批结论改写成散文段落即可让分母归零、警告消失——门槛可被格式规避。
test('W_QUOTE：散文段落里的结论也进覆盖率分母（不能靠改写格式绕开）', async () => {
  await withFilled(async (out) => {
    const rel = '故事底本/全书设定/概念/事件/初遇.md'
    // 4 条结论，全部以散文段落写出、全部带章号、全部不带引句 → 覆盖率 0，应报 W_QUOTE。
    const prosy = [
      '# 初遇',
      '',
      '- 名称：初遇',
      '',
      '两人在车站第一次相遇，李四主动搭话（第 1 章）。',
      '',
      '这次相遇决定了后面所有同行（第 2 章）。',
      '',
      '王五在场但没有说话（第 3 章）。',
      '',
      '车站此后成为反复出现的地点（第 5 章）。',
      '',
    ].join('\n')
    await writeFile(join(out, rel), prosy, 'utf8')
    const r = await validateOutput({ root: out })
    assert.ok(
      r.errors.some((e) => e.code === 'W_QUOTE' && e.file === rel),
      '散文写法的引述型结论必须进分母，否则改格式就能抹掉警告',
    )
    // T1：同一批散文结论还要单独报一次 W_PROSE，让「这个文件主要靠散文承载结论」进交付报告。
    assert.ok(
      r.errors.some((e) => e.code === 'W_PROSE' && e.file === rel),
      '靠散文承载结论的文件须单独报警告，否则这部分内容在报告里看不见',
    )
  })
})

// ---------- v0.3.0 质量门（#11）----------

// T18b：data.errors 与 problems 必须说同一件事。
// 原先 progress 模式在返回前 `errors.length = 0` 清计数，problems 却原样返回，
// 于是汇总说「错误 0」、CLI 按 severity 逐条打印「错误 [E_INDEX]」——同一份结果两个说法。
for (const mode of ['deliver', 'progress']) {
  test(`T18b：${mode} 模式下 data.errors 等于 problems 里 error 的条数`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vo-count-'))
    try {
      const src = join(dir, '骨架书.txt')
      await writeFile(src, NOVEL, 'utf8')
      const r = await prepare({ input: src })
      const result = await validateOutput({ root: r.outDir, mode })
      const errorCount = result.errors.filter((e) => e.severity === 'error').length
      const warningCount = result.errors.filter((e) => e.severity === 'warning').length
      assert.equal(result.data.errors, errorCount, 'data.errors 必须等于 problems 里 error 的条数')
      assert.equal(result.data.warnings, warningCount, 'data.warnings 必须等于 problems 里 warning 的条数')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('T18b：骨架态空集合在进度模式降为 W_INDEX_EMPTY，交付模式仍是 E_INDEX', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-empty-'))
  try {
    const src = join(dir, '骨架书.txt')
    await writeFile(src, NOVEL, 'utf8')
    const r = await prepare({ input: src })
    const progress = await validateOutput({ root: r.outDir, mode: 'progress' })
    const deliver = await validateOutput({ root: r.outDir, mode: 'deliver' })
    assert.ok(
      !progress.errors.some((e) => e.code === 'E_INDEX'),
      '进度模式不该把「还没做」报成错误（它靠 severity 降级，不靠清计数）',
    )
    assert.ok(
      progress.errors.some((e) => e.code === 'W_INDEX_EMPTY' && e.severity === 'warning'),
      '进度模式要把空集合报成警告，让使用者知道还有哪些集合没做',
    )
    assert.ok(
      deliver.errors.some((e) => e.code === 'E_INDEX' && e.severity === 'error'),
      '交付模式空集合仍是错误，否则空产物也交得出去',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// T9：卡片字段存在性。此前 52 个卡片字段零校验——路径不被 productOf() 识别，
// 「有没有填」这件事根本不进账本，交出一张只有标题的空卡也能过。
test('T9：卡片缺字段标签或有标签无内容时报 E_CARD_FIELD', async () => {
  await withFilled(async (out) => {
    const rel = '故事底本/全书设定/势力与组织/门派/青云门.md'
    // 先留住夹具里那份填好的卡，后面两步都在它的基础上改一处。
    const full = await readFile(join(out, rel), 'utf8')
    assert.match(full, /- 层级结构：/, '夹具里的卡应是按模板填好的')

    // ① 只有标题没有字段 → 缺标签
    await writeFile(join(out, rel), '# 青云门\n\n一句话说完。\n', 'utf8')
    const r1 = await validateOutput({ root: out })
    assert.ok(
      r1.errors.some((e) => e.code === 'E_CARD_FIELD' && e.file === rel && /缺 \d+ 个字段标签/.test(e.message)),
      '只有标题的空卡必须报缺字段',
    )

    // ② 标签齐全但有一格空着 → 有标签无内容
    const holed = full.replace(/- 层级结构：[^\n]*/, '- 层级结构：')
    assert.notEqual(holed, full, '替换须真的把值清空')
    await writeFile(join(out, rel), holed, 'utf8')
    const r2 = await validateOutput({ root: out })
    assert.ok(
      r2.errors.some((e) => e.code === 'E_CARD_FIELD' && e.file === rel && /有标签无内容/.test(e.message)),
      '标签在但内容空着也要报，否则留空即可绕开',
    )

    // ③ 填「无（第 N 章）」是合法填写，不该报
    await writeFile(join(out, rel),
      full.replace(/- 层级结构：[^\n]*/, '- 层级结构：无（第 1 章：未提及层级）'), 'utf8')
    const r3 = await validateOutput({ root: out })
    assert.ok(
      !r3.errors.some((e) => e.code === 'E_CARD_FIELD' && e.file === rel),
      '「无」加注章是合法填写，不能被判为空',
    )

    // ④ 空值行的下一行不能被当成它的值（正则 `\s*` 会吃换行，曾把「- 层级结构：」判成已填）
    const nextLine = full.replace(/- 层级结构：[^\n]*/, '- 层级结构：\n- 状态变化：由盛转衰')
    assert.notEqual(nextLine, full)
    await writeFile(join(out, rel), nextLine, 'utf8')
    const r4 = await validateOutput({ root: out })
    assert.ok(
      r4.errors.some((e) => e.code === 'E_CARD_FIELD' && /有标签无内容/.test(e.message) && /层级结构/.test(e.message)),
      '空值行不得吞掉下一行当作自己的值',
    )
  })
})

test('T9：主角五文件不走卡片字段校验（人物卡模板明写「主角不用本卡」）', async () => {
  await withFilled(async (out) => {
    // 夹具里的主角五文件本来就只有一个段落，没有 17 个卡片字段；若误走卡片校验会误报。
    const r = await validateOutput({ root: out })
    const hits = r.errors.filter(
      (e) => e.code === 'E_CARD_FIELD' && e.file.includes('/人物/主角/'),
    )
    assert.deepEqual(hits, [], '主角五文件各有自己的段名契约，不该套人物卡字段模板')
  })
})

test('T14：产物契约版本与校验器不一致时给提示，但不改判定', async () => {
  await withFilled(async (out) => {
    const mf = join(out, '工作', 'manifest.json')
    const original = await readFile(mf, 'utf8')
    const { CONTRACT_VERSION } = await import('../skills/book-breakdown/scripts/contract.mjs')

    // ① 新版产物：版本一致，不报
    const cur = await validateOutput({ root: out })
    assert.ok(!cur.errors.some((e) => e.code === 'W_CONTRACT_VERSION'), '版本一致时不该报')

    // ② 旧版产物（无该字段）：报一条警告
    const old = JSON.parse(original)
    delete old.contractVersion
    await writeFile(mf, `${JSON.stringify(old, null, 2)}\n`, 'utf8')
    const r2 = await validateOutput({ root: out })
    const hits = r2.errors.filter((e) => e.code === 'W_CONTRACT_VERSION')
    assert.equal(hits.length, 1, '旧版产物须提示契约版本缺失')
    assert.equal(hits[0].severity, 'warning', '这是提示不是错误：旧产物的报错大多是真实缺陷')
    assert.match(hits[0].message, /未记录契约版本/)

    // ③ 更高版本：报提示
    const future = JSON.parse(original)
    future.contractVersion = '9.9.9'
    await writeFile(mf, `${JSON.stringify(future, null, 2)}\n`, 'utf8')
    const r3 = await validateOutput({ root: out })
    assert.ok(r3.errors.some((e) => e.code === 'W_CONTRACT_VERSION' && /9\.9\.9/.test(e.message)))

    // 恢复
    await writeFile(mf, original, 'utf8')
    const back = await validateOutput({ root: out })
    assert.ok(!back.errors.some((e) => e.code === 'W_CONTRACT_VERSION'))
    assert.ok(CONTRACT_VERSION)
  })
})
