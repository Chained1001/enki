// 快速模式对账（C-12、C-28）。
//
// 原先 04 的三项核对是纯心算：摘要行数＝章节数、要素首现章在区间内、各章字数之和＝总字数。
// 三项都是确定性算术，算错了没人知道，产物里也看不出是数是猜。
//
// 这里刻意不测「报告写得好看不好看」，只测「数字对不对、对不上时退出码非 0」——
// 对账表的价值全在后者：没有退出码的对账，agent 照样可以写完继续往下走。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReport, reconcile, humanTable, SUMMARY_MAX } from '../skills/book-breakdown/scripts/reconcile.mjs'
import { COLUMNS } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const EL = COLUMNS.报告_人物

// 造一份报告。summary 是 [序号, 标题, 摘要] 三元组数组。
function reportText({ 书名 = '测试书', 总字数 = null, 章节数 = null, summary = [], 人物 = [], 设定 = [], 情节线 = [], 技法 = [] } = {}) {
  const head = ['# 拆书报告', '', '- 书名：' + 书名]
  if (总字数 !== null) head.push('- 总字数：' + 总字数)
  if (章节数 !== null) head.push('- 章节数：' + 章节数)
  const rows = summary.map((s) => '| ' + s.join(' | ') + ' |')
  const el = (name, list) => [
    '### ' + name, '',
    '| ' + [name, EL[1], EL[2]].join(' | ') + ' |',
    '| --- | --- | --- |',
    ...list.map((r) => '| ' + r.join(' | ') + ' |'), '',
  ]
  return [
    ...head, '', '## 章节摘要', '', '| 序号 | 标题 | 摘要 |', '| --- | --- | --- |', ...rows, '',
    '## 要素', '', ...el('人物', 人物), ...el('设定', 设定), ...el('情节线', 情节线), ...el('技法', 技法),
  ].join('\n')
}

const CH = (n, chars = 100) => Array.from({ length: n }, (_, i) => ({ no: i + 1, title: '第' + (i + 1) + '章', chars }))

test('C-12：parseReport 取出摘要行与四张要素表', () => {
  const r = parseReport(reportText({
    summary: [[1, '第一章', '甲去了车站'], [2, '第二章', '乙走了']],
    人物: [['甲', '主角', '1']],
    设定: [['车站', '地点', '1']],
  }))
  assert.equal(r.summary.length, 2)
  assert.equal(r.summary[0].摘要, '甲去了车站')
  assert.equal(r.elements.人物.length, 1)
  assert.equal(r.elements.人物[0].首现, '1')
  assert.equal(r.elements.设定[0].名, '车站')
  assert.equal(r.elements.技法.length, 0, '空的要素表给空数组，不是 undefined')
})

test('C-12：摘要行数＝章节数，对得上时 ok', () => {
  const chapters = CH(3)
  const r = reconcile(parseReport(reportText({
    总字数: 300, 章节数: 3,
    summary: [[1, 'a', 'x'], [2, 'b', 'y'], [3, 'c', 'z']],
  })), chapters)
  assert.equal(r.ok, true)
  assert.equal(r.rows.find((x) => x.项 === '摘要行数').实际, '3')
})

test('C-12：摘要少一行时对不上（少一行就是少一章的摘要）', () => {
  const chapters = CH(3)
  const r = reconcile(parseReport(reportText({
    总字数: 300, summary: [[1, 'a', 'x'], [2, 'b', 'y']],
  })), chapters)
  assert.equal(r.ok, false)
  const row = r.rows.find((x) => x.项 === '摘要行数')
  assert.equal(row.期望, '3')
  assert.equal(row.实际, '2')
  assert.equal(row.结论, '对不上')
})

test('C-28：摘要超 60 字的行要数出来并点名（02 的判据此前无任何校验）', () => {
  const long = '字'.repeat(SUMMARY_MAX + 1)
  const chapters = CH(2)
  const r = reconcile(parseReport(reportText({
    总字数: 200, summary: [[1, 'a', long], [2, 'b', '短句']],
  })), chapters)
  const row = r.rows.find((x) => x.项 === '摘要超 ' + SUMMARY_MAX + ' 字行数')
  assert.ok(row, '对账表必须有这一行')
  assert.equal(row.实际, '1')
  assert.equal(row.结论, '对不上', '超长是对不上——判据写的是不超过 60 字')
  assert.match(row.note, /第1章/, '要点名是哪几章')
})

test('C-28：正好 60 字不算超（边界）', () => {
  const chapters = CH(1)
  const r = reconcile(parseReport(reportText({
    总字数: 100, summary: [[1, 'a', '字'.repeat(SUMMARY_MAX)]],
  })), chapters)
  assert.equal(r.rows.find((x) => x.项.startsWith('摘要超')).实际, '0', '60 字整不该算超')
})

test('C-28：无法摘要行数单独列一行，但不判失败', () => {
  // 02 允许写「无法摘要」并记原因，所以它不是错误。
  // 但也不是不记——写多了说明这本书的章节切分或原文有问题。
  const chapters = CH(2)
  const r = reconcile(parseReport(reportText({
    总字数: 200, summary: [[1, 'a', '无法摘要'], [2, 'b', '正常']],
  })), chapters)
  const row = r.rows.find((x) => x.项 === '无法摘要行数')
  assert.equal(row.实际, '1')
  assert.equal(r.ok, true, '有「无法摘要」不该让整份对账失败')
})

test('C-12：要素首现章越界时点名到具体条目', () => {
  const chapters = CH(3)
  const r = reconcile(parseReport(reportText({
    总字数: 300, summary: [[1, 'a', 'x'], [2, 'b', 'y'], [3, 'c', 'z']],
    人物: [['甲', '主角', '1'], ['乙', '配角', '99'], ['丙', '龙套', 'abc']],
  })), chapters)
  const row = r.rows.find((x) => x.项 === '要素首现章越界')
  assert.equal(row.实际, '2', '99 与 abc 都越界')
  assert.match(row.note, /乙/, '要点名条目')
  assert.equal(r.ok, false)
})

test('C-12：首现章 0 也算越界（章号从 1 起）', () => {
  const chapters = CH(3)
  const r = reconcile(parseReport(reportText({
    总字数: 300, summary: [[1, 'a', 'x'], [2, 'b', 'y'], [3, 'c', 'z']],
    人物: [['甲', '主角', '0']],
  })), chapters)
  assert.equal(r.rows.find((x) => x.项 === '要素首现章越界').实际, '1')
})

test('C-12：各章字数和与报告自报的总字数不符时报对不上', () => {
  const chapters = CH(3, 100) // 合计 300
  const r = reconcile(parseReport(reportText({
    总字数: 350, summary: [[1, 'a', 'x'], [2, 'b', 'y'], [3, 'c', 'z']],
  })), chapters)
  const row = r.rows.find((x) => x.项 === '各章字数和＝总字数')
  assert.equal(row.期望, '350')
  assert.equal(row.实际, '300')
  assert.equal(row.结论, '对不上')
})

test('C-12：报告没写总字数时明说缺失，不静默跳过', () => {
  // 静默跳过会让人以为「核过了」。没写就是没写，要说出来。
  const chapters = CH(2)
  const r = reconcile(parseReport(reportText({ summary: [[1, 'a', 'x'], [2, 'b', 'y']] })), chapters)
  const row = r.rows.find((x) => x.项 === '各章字数和＝总字数')
  assert.equal(row.结论, '对不上')
  assert.match(row.实际 + row.note, /未写总字数|缺失/)
  assert.equal(r.ok, false)
})

test('C-12：前言（第 0 章）不计入要写摘要的章节数', () => {
  // detectChapters 会给书名行记一个「第 0 章 前言」。它不是叙事章，不该要求摘要。
  const chapters = [{ no: 0, title: '前言', chars: 20 }, ...CH(2)]
  const r = reconcile(parseReport(reportText({
    总字数: 220, summary: [[1, 'a', 'x'], [2, 'b', 'y']],
  })), chapters)
  assert.equal(r.rows.find((x) => x.项 === '摘要行数').期望, '2', '期望是 2 个叙事章，不是 3')
  assert.equal(r.rows.find((x) => x.项 === '摘要行数').结论, '对得上')
})

test('humanTable 输出可直接贴进报告的 Markdown 表', () => {
  const chapters = CH(2)
  const r = reconcile(parseReport(reportText({
    总字数: 200, summary: [[1, 'a', 'x'], [2, 'b', 'y']],
  })), chapters)
  const t = humanTable(r)
  assert.match(t, /^\| 项 \| 期望 \| 实际 \| 结论 \|/)
  assert.match(t, /\| 摘要行数 \| 2 \| 2 \| 对得上 \|/)
  // 每行都要有四个格子，贴进表格才不会裂列
  for (const line of t.split('\n').slice(2)) {
    assert.equal((line.match(/\|/g) ?? []).length, 5, '列数不对：' + line)
  }
})

// ---------- CLI ----------

async function withBook(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rec-'))
  try {
    const src = join(dir, '书.txt')
    await writeFile(src, ['书名', '', '第1章 甲', '正文一。', '第2章 乙', '正文二。'].join('\n'), 'utf8')
    const { detectChapters } = await import('../skills/book-breakdown/scripts/prepare.mjs')
    const { readFileSync } = await import('node:fs')
    const chs = detectChapters(readFileSync(src, 'utf8')).filter((c) => !(c.no === 0 && c.title === '前言'))
    const total = chs.reduce((s, c) => s + c.chars, 0)
    return await fn({ dir, src, chs, total })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = (args) => {
  try {
    return { code: 0, out: execFileSync('node', ['skills/book-breakdown/scripts/reconcile.mjs', ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '' }
  }
}

test('CLI：全对时退出 0，打印对账表', async () => {
  await withBook(async ({ dir, src, chs, total }) => {
    const rep = join(dir, '报告.md')
    await writeFile(rep, reportText({ 总字数: total, summary: chs.map((c) => [c.no, c.title, '一句话摘要']) }), 'utf8')
    const r = run([rep, '--source', src])
    assert.equal(r.code, 0, '全对时退出码必须是 0：' + r.out)
    assert.match(r.out, /摘要行数/)
  })
})

test('CLI：对不上时退出 1（没有退出码的对账等于没核）', async () => {
  await withBook(async ({ dir, src }) => {
    const rep = join(dir, '报告.md')
    await writeFile(rep, reportText({ 总字数: 999, summary: [[1, 'a', 'x']] }), 'utf8')
    assert.equal(run([rep, '--source', src]).code, 1, '差值非 0 必须退出 1')
  })
})

test('CLI：缺 --source 退出 2（参数错，不是对账失败）', async () => {
  // 2 与 1 必须分开：前者是用法错，后者是真的对不上。
  await withBook(async ({ dir }) => {
    const rep = join(dir, '报告.md')
    await writeFile(rep, reportText({ summary: [] }), 'utf8')
    assert.equal(run([rep]).code, 2)
  })
})

test('CLI：--json 输出可解析，每条对账行四项齐全', async () => {
  await withBook(async ({ dir, src }) => {
    const rep = join(dir, '报告.md')
    await writeFile(rep, reportText({ 总字数: 999, summary: [[1, 'a', 'x']] }), 'utf8')
    let out = ''
    try {
      execFileSync('node', ['skills/book-breakdown/scripts/reconcile.mjs', rep, '--source', src, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    } catch (e) { out = e.stdout }
    const parsed = JSON.parse(out)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.rows.length >= 5, '五项都要在')
    for (const row of parsed.rows) {
      // 每条都要有这四项，缺一项贴进表格就少一格
      for (const k of ['项', '期望', '实际', '结论']) {
        assert.ok(k in row, '对账行缺字段「' + k + '」：' + JSON.stringify(row))
      }
    }
  })
})
