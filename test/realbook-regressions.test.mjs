// 实测《长安的荔枝》抓到的三个真缺陷（都是脚本与真实书稿对不上，而不是笔误）：
//   1) write-rows 拒绝章号 0，而 prepare 在有前言时把前言记为 0 → 前言那行永远写不进去；
//   2) 末章后跟一整段「文后说明」时，后记被算进末章正文（末章字数虚高、后记不进作者的话）；
//   3) W_QUOTE 按行报，真书 205 行缺引句在 49 个文件各报一次 → 全片报警、无辨别力（Q-30）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRows } from '../skills/book-breakdown/scripts/write-rows.mjs'
import { prepare } from '../skills/book-breakdown/scripts/prepare.mjs'
import { QUOTE_RULE } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tmpBase = join(here, '.tmp', 'realbook')
after(() => rmSync(tmpBase, { recursive: true, force: true }))

function tableWithZero() {
  return [
    '# 逐章记录',
    '',
    '| 全局章号 | 标题（清洗后） | 章字数 | 视角人物 | 地点 | 出场人物 | 一句话事件 | 剧情线 | 伏笔埋/收 | 情绪 | 章末钩型 | 爽点标记 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 0 | 前言 | 283 | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） |',
    '| 1 | 第一章 | 12427 | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） |',
  ]
}

const entry = (no) => ({
  章号: no,
  视角人物: '李善德',
  地点: '长安',
  出场人物: '李善德',
  一句话事件: '某事',
  剧情线: '主线',
  伏笔埋收: '无',
  情绪: '抑',
  章末钩型: '悬念',
  爽点标记: '无',
})

test('write-rows 接受章号 0（有前言的书，前言记为 0）', () => {
  const out = applyRows(tableWithZero(), [entry(0)], {})
  assert.match(out.lines.join('\n'), /\| 0 \| 前言 \| 283 \| 李善德 \|/)
  assert.equal(out.updated, 1)
})

test('write-rows 仍拒绝负数章号（错误带 E_CHAPTER 码）', () => {
  assert.throws(
    () => applyRows(tableWithZero(), [entry(-1)], {}),
    (e) => e.code === 'E_CHAPTER',
  )
})

test('write-rows：0 与 1 可同批写入，互不干扰', () => {
  const out = applyRows(tableWithZero(), [entry(0), entry(1)], {})
  assert.equal(out.updated, 2)
  const lines = out.lines.join('\n')
  assert.match(lines, /\| 0 \| 前言 \| 283 \| 李善德 \|/)
  assert.match(lines, /\| 1 \| 第一章 \| 12427 \| 李善德 \|/)
})

// 末章后跟「文后说明」：正文与作者的话必须分开。
const BOOK = [
  '第一章',
  '　　李善德走进车站，月台上空无一人。他算了算距离，一共五千四百四十七里。',
  '',
  '第二章',
  '　　荔枝一日色变，二日香变，三日味变。他决定去岭南试一试。',
  '',
  '第三章',
  '　　他到了广州，与胡商苏谅谈定四路试验。',
  '',
  '文后说明',
  '　　这篇文章的最早缘起，要追溯到我写《显微镜下的大明》时。',
  '　　周德文的故事让我想到基层办事员的处境，于是有了这本小说。',
]

test('末章后的「文后说明」不计入正文，且进入作者的话', async () => {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'afterword-'))
  const src = join(dir, '后记书.txt')
  writeFileSync(src, BOOK.join('\n'), 'utf8')
  try {
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    // 后记不得成为独立章节
    assert.equal(manifest.chapterCount, 3, '「文后说明」不应被算作一章')
    assert.ok(!manifest.chapters.some((c) => c.title === '文后说明'), '后记标题不得进章节表')
    // 末章字数不含后记（后记约 60 字，正文约 25 字）
    const last = manifest.chapters.at(-1)
    assert.ok(last.chars < 100, `末章字数不应包含后记，实际 ${last.chars}`)
    // 后记内容进作者的话
    const notes = readFileSync(join(r.outDir, '原文', '作者的话.md'), 'utf8')
    assert.match(notes, /显微镜下的大明/)
    assert.match(notes, /周德文/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// W_QUOTE 口径（Q-30）：剔除「不写引句的行」后按文件密度报，而不是逐行报。
test('引句口径把坐标行、否定式说明、分工说明排除在分母外', () => {
  // 坐标行：使用记录 / 揭示节奏的写法，本身无引句可言
  assert.ok(QUOTE_RULE.coordinate.test('第 1 章：金手指被授予（敕牒）'), '坐标行应被识别')
  assert.ok(QUOTE_RULE.coordinate.test('第6章：达到顶点后立即归零'))
  // 否定式：没有可引的原文
  assert.ok(QUOTE_RULE.negativeBare.test('无独立金句'), '裸否定应被识别')
  assert.ok(QUOTE_RULE.negativeValue.test('神态与动作锚：无（单章出场）'), '字段值为无应被识别')
  assert.ok(QUOTE_RULE.negativeValue.test('力量/成长坐标：无成长弧'), '无成长弧应被识别')
  // 分工说明：讲槽位归属，不是对本作的结论
  assert.ok(QUOTE_RULE.dutyNote.test('地理图志：行程天数归地理图志（分工说明，见第 4 章）'))
  // 反面：真正的引述型结论不得被误剔除
  assert.ok(!QUOTE_RULE.negativeBare.test('他的弱点是只敢说到界限为止'))
  assert.ok(!QUOTE_RULE.coordinate.test('卖符牒得九百九十六贯（第 2 章）'))
  assert.ok(!QUOTE_RULE.dutyNote.test('卖符牒得九百九十六贯（第 2 章）'))
})

test('引句阈值为「条目≥3 且覆盖率<50%」，避免短卡与误报', () => {
  assert.equal(QUOTE_RULE.minClaims, 3, '少于 3 条引述型条目的短卡不报')
  assert.equal(QUOTE_RULE.minCoverage, 0.5, '覆盖率门槛 50%')
  // 真书实测：按此口径 205 行警告收敛到 11 个文件
  assert.ok(QUOTE_RULE.coordinateSections.includes('揭示节奏'), '揭示节奏段整段不查引句')
  assert.ok(QUOTE_RULE.coordinateSections.includes('使用记录'), '使用记录段整段不查引句')
})
