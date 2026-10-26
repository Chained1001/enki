// C-03：分卷总表的「爽点密度」列，以及把密度写回总表的 --write-total。
//
// 这一列的价值是「这一卷节奏闷不闷」的唯一可复核指标。所以测试的重点不是
// 「算得对」，而是三件容易错的事：
//   ① 算不出时必须是「（待填）」，不能是 0%——0% 表示「一个爽点都没有」；
//   ② 只改密度那一格，其余列不能被抹掉；
//   ③ 表头对不上时要拒写，不能猜列序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVolumeStats, writeTotalTable, pct } from '../skills/book-breakdown/scripts/volume-stats.mjs'
import { COLUMNS, tableColumns } from '../skills/book-breakdown/scripts/contract.mjs'
import { parseRow } from '../skills/book-breakdown/scripts/validate-output.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const COLS = tableColumns('分卷总表')
const I = (name) => COLS.indexOf(name)
const P = '（待填）'

// 造一行逐章记录：只填本测试关心的四列
function row(no, hook, sharp) {
  const cells = new Array(tableColumns('逐章记录').length).fill(P)
  cells[tableColumns('逐章记录').indexOf('全局章号')] = String(no)
  cells[tableColumns('逐章记录').indexOf('章末钩型')] = hook
  cells[tableColumns('逐章记录').indexOf('爽点强度')] = sharp
  return cells
}

function tableText(rows) {
  const head = '| ' + COLS.join(' | ') + ' |'
  const sep = '| ' + COLS.map(() => '---').join(' | ') + ' |'
  const body = rows.map((r) => '| ' + r.join(' | ') + ' |')
  return ['# 分卷总表', '', head, sep, ...body].join('\n')
}

function totalRow(vol, extra = {}, density = '') {
  const cells = new Array(COLS.length).fill(P)
  cells[I('卷')] = String(vol)
  cells[I('爽点密度')] = density
  for (const [k, v] of Object.entries(extra)) cells[I(k)] = v
  return cells
}

test('C-03：契约里「爽点密度」紧跟「字数与均章长」', () => {
  assert.equal(COLS[I('爽点密度') - 1], '字数与均章长', '密度要跟在体量数字后面')
  assert.equal(COLS.length, 16, '插入后 16 列')
})

test('C-03：perVolume 给 sharpDensity 字段（--json 可见，不只在报告字符串里）', () => {
  const stats = computeVolumeStats(
    [row(1, '危机', '中'), row(2, '悬念', '无'), row(3, '期待', '大'), row(4, '反差', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 4 }] },
  )
  // 4 章里 2 章有爽点 → 0.5
  assert.equal(stats.perVolume[0].sharpDensity, 0.5)
})

test('C-03：密度只算「非无」的章（小/中/大都算一次投放）', () => {
  const stats = computeVolumeStats(
    [row(1, '危机', '小'), row(2, '危机', '中'), row(3, '危机', '大'), row(4, '危机', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 4 }] },
  )
  assert.equal(stats.perVolume[0].sharpDensity, 0.75, '3/4')
})

test('C-03：本卷没记到任何章时密度是 null，不是 0', () => {
  // 0 表示「这一卷一个爽点都没有」；null 表示「没数」。两者必须分得开，
  // 否则骨架态会被当成「这一卷很闷」，而它其实只是还没填。
  const stats = computeVolumeStats([row(1, '危机', '中')], { volumes: [{ no: 1, startCh: 5, endCh: 9 }] })
  assert.equal(stats.perVolume[0].sharpDensity, null)
})

test('C-03：全卷都「无」时密度是 0，与 null 区分', () => {
  const stats = computeVolumeStats(
    [row(1, '钝收', '无'), row(2, '钝收', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 2 }] },
  )
  assert.equal(stats.perVolume[0].sharpDensity, 0, '真的一章都没有 → 0（有意义的值）')
})

test('C-03：pct 保留一位小数，null 给空串', () => {
  assert.equal(pct(0.5), '50.0')
  assert.equal(pct(0.1234), '12.3')
  assert.equal(pct(0), '0.0')
  assert.equal(pct(null), '', 'null 不写 0.0——写 0 就等于把它当成了「一个爽点都没有」')
})

// ---------- writeTotalTable ----------

test('C-03：writeTotalTable 只改密度那一格，其余列原样保留', () => {
  // 这条是写入器最容易犯的错：整行重写会把 agent 已填的叙述列抹掉。
  const text = tableText([totalRow(1, { 一句话钩子: '相遇钩', 核心压力源: '关系困局' }, '')])
  const stats = computeVolumeStats(
    [row(1, '危机', '中'), row(2, '危机', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 2 }] },
  )
  const r = writeTotalTable(text, stats)
  const line = r.text.split('\n').find((l) => l.startsWith('| 1 '))
  const cells = parseRow(line)
  assert.equal(cells[I('爽点密度')], '50.0')
  assert.equal(cells[I('一句话钩子')], '相遇钩', '叙述列必须还在')
  assert.equal(cells[I('核心压力源')], '关系困局')
  assert.equal(r.changed, 1)
})

test('C-03：逐章记录还是骨架的卷写「（待填）」，不写 0.0', () => {
  const text = tableText([totalRow(1, {}, '')])
  // 该卷区间里没有任何逐章记录行 → density null
  const stats = computeVolumeStats([], { volumes: [{ no: 1, startCh: 1, endCh: 10 }] })
  const r = writeTotalTable(text, stats)
  const cells = parseRow(r.text.split('\n').find((l) => l.startsWith('| 1 ')))
  assert.equal(cells[I('爽点密度')], '（待填）', '没数就写待填，不能写 0.0')
})

test('C-03：已是正确值时不重复改动（changed 为 0）', () => {
  const text = tableText([totalRow(1, {}, '50.0')])
  const stats = computeVolumeStats(
    [row(1, '危机', '中'), row(2, '危机', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 2 }] },
  )
  const r = writeTotalTable(text, stats)
  assert.equal(r.changed, 0, '值一样就不该算改动（否则 mtime 会变，分不出「改过」与「跑过」）')
})

test('C-03：表里没有的卷不新增行（总表一行一卷，行由 09 建）', () => {
  const text = tableText([totalRow(1, {}, '')])
  const stats = computeVolumeStats(
    [row(1, '危机', '中'), row(2, '危机', '中'), row(3, '危机', '中')],
    { volumes: [{ no: 1, startCh: 1, endCh: 1 }, { no: 2, startCh: 2, endCh: 3 }] },
  )
  const r = writeTotalTable(text, stats)
  const rows = r.text.split('\n').filter((l) => parseRow(l))
  // 表头 + 分隔 + 1 行数据
  assert.equal(rows.length, 3, '不能因为统计里有第 2 卷就多写一行')
})

test('C-03：「卷」列写 01 也能对上（总表习惯带前导零）', () => {
  const text = tableText([totalRow('01', {}, '')])
  const stats = computeVolumeStats(
    [row(1, '危机', '中'), row(2, '危机', '无')],
    { volumes: [{ no: 1, startCh: 1, endCh: 2 }] },
  )
  const r = writeTotalTable(text, stats)
  assert.equal(r.changed, 1, '01 与 1 要认成同一卷')
})

test('C-03：表头对不上时 headerSeen 为 false（不猜列序）', () => {
  const bad = ['# 分卷总表', '', '| 卷 | 别的列 |', '|---|---|', '| 1 | x |'].join('\n')
  const stats = computeVolumeStats([], { volumes: [] })
  assert.equal(writeTotalTable(bad, stats).headerSeen, false)
})

// ---------- CLI ----------

async function withBook(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  const out = join(dir, '书_拆解')
  try {
    await cp(join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解'), out, { recursive: true })
    return await fn({ dir, out })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = (args) => {
  try {
    return { code: 0, out: execFileSync('node', ['skills/book-breakdown/scripts/volume-stats.mjs', ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) { return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') } }
}

// 夹具的总表是骨架态（只有表头）——保持这样，测试自己补一行数据。
async function addTotalRow(out) {
  const rel = join(out, '故事底本', '故事剧情', '分卷总表.md')
  const raw = await readFile(rel, 'utf8')
  const lines = raw.split(/\r?\n/)
  const hi = lines.findIndex((l) => l.startsWith('| 卷 |'))
  const cells = new Array(COLS.length).fill('（待填）')
  cells[I('卷')] = '1'
  cells[I('卷名')] = '全书'
  cells[I('起止章')] = '1-5'
  cells[I('章数')] = '5'
  lines.splice(hi + 2, 0, '| ' + cells.join(' | ') + ' |')
  await (await import('node:fs/promises')).writeFile(rel, lines.join('\n'), 'utf8')
}

// 把夹具的逐章记录填上爽点强度，让密度算得出来
async function fillSharp(out) {
  const rel = join(out, '工作', '逐章记录.md')
  const raw = await readFile(rel, 'utf8')
  const T = tableColumns('逐章记录')
  const iNo = T.indexOf('全局章号')
  const iSharp = T.indexOf('爽点强度')
  const lines = raw.split(/\r?\n/).map((line) => {
    const cells = parseRow(line)
    if (!cells || cells.length !== T.length) return line
    const no = Number(cells[iNo])
    if (!Number.isInteger(no)) return line
    cells[iSharp] = no === 1 ? '中' : '无'
    return '| ' + cells.join(' | ') + ' |'
  })
  await (await import('node:fs/promises')).writeFile(rel, lines.join('\n'), 'utf8')
}

test('C-03：CLI --write-total 把密度写进总表', async () => {
  await withBook(async ({ out }) => {
    await addTotalRow(out)
    await fillSharp(out)
    const r = run([out, '--write-total'])
    assert.equal(r.code, 0, r.out)
    const total = await readFile(join(out, '故事底本', '故事剧情', '分卷总表.md'), 'utf8')
    const dataLine = total.split('\n').find((l) => parseRow(l) && /^\| *0?1 *\|/.test(l))
    // 夹具的逐章记录有 5 章，只有第 1 章有爽点 → 20.0%
    assert.match(dataLine, /20\.0/, `应写入 20.0，实际行：${dataLine}`)
  })
})

test('C-03：CLI --dry-run 不落盘', async () => {
  await withBook(async ({ out }) => {
    await addTotalRow(out)
    await fillSharp(out)
    const rel = join(out, '故事底本', '故事剧情', '分卷总表.md')
    const before = await readFile(rel, 'utf8')
    const r = run([out, '--write-total', '--dry-run'])
    assert.equal(r.code, 0)
    assert.match(r.out, /会改 1 处/, '要报告会改几处')
    assert.equal(await readFile(rel, 'utf8'), before, 'dry-run 不许落盘')
  })
})

test('C-03：CLI 表头不符时退出 1 且不落盘（猜列序会把密度写进别的列）', async () => {
  // 纯函数层有 headerSeen 测试，但「CLI 拿到 false 之后真的不写」是另一件事：
  // 变异把 `if (!result.headerSeen)` 改成 `if (false)` 时，只有这条能拦住。
  await withBook(async ({ out }) => {
    const rel = join(out, '故事底本', '故事剧情', '分卷总表.md')
    // 换成一份列名对不上的表头
    const broken = ['# 分卷总表', '', '| 卷 | 别的列 | 再一列 |', '|---|---|---|', '| 1 | x | y |'].join('\n')
    await (await import('node:fs/promises')).writeFile(rel, broken, 'utf8')
    await fillSharp(out)

    const r = run([out, '--write-total'])
    assert.equal(r.code, 1, '表头不符要退 1，不能静默照写')
    assert.match(r.out, /E_HEADER/, '要报 E_HEADER')
    assert.equal(await readFile(rel, 'utf8'), broken, '拒写时一个字都不许改')
  })
})

test('C-03：CLI 缺分卷总表退出 1（读不到 ≠ 算完了）', async () => {
  await withBook(async ({ out }) => {
    await rm(join(out, '故事底本', '故事剧情', '分卷总表.md'))
    assert.equal(run([out, '--write-total']).code, 1)
  })
})

test('C-03：CLI --help 列出 --write-total', async () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /--write-total/)
})

// ---------- 09 的文档：先脚本后人工 ----------

test('C-03：09 让 agent 先跑 --write-total，再填叙述列', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'workflows', '09-全书层.md'), 'utf8')
  assert.match(t, /--write-total/, '要点名这个命令')
  assert.match(t, /不要手算|不要动/, '要禁止手算这一列')
  // 反向：原来的「按契约 15 列」必须消失
  assert.ok(!/按契约 15 列/.test(t), '列数已变 16，文档要跟上')
})

// ---------- M-09 映射表 ----------

test('M-09：幕纲模板有四行映射，且写明「是解释不是判据」', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'assets', '幕纲模板.md'), 'utf8')
  for (const v of ['爽', '燃', '虐', '喜']) {
    assert.match(t, new RegExp(`\\| ${v} \\|`), `映射表要有「${v}」这一行`)
  }
  assert.match(t, /是解释，不是判据|解释.*不是判据/, '要写明这四行不承担判定')
})

test('M-09：映射表把四个峰值各挂到情绪三值上（C6 要的可反查）', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'assets', '幕纲模板.md'), 'utf8')
  const expect = { 爽: '扬', 燃: '扬', 虐: '抑', 喜: '震荡' }
  for (const [peak, tone] of Object.entries(expect)) {
    const line = t.split('\n').find((l) => l.startsWith(`| ${peak} |`))
    assert.ok(line, `找不到「${peak}」行`)
    assert.ok(line.includes(tone), `「${peak}」应对应「${tone}」，实际行：${line}`)
  }
})

test('M-09：峰值匹配拒绝「喜悦」「大爽点」这类变体', async () => {
  const { peakIntensityOf } = await import('../skills/book-breakdown/scripts/validate-output.mjs')
  // includes 会把这两个放过（'喜悦'.includes('喜')、'大爽点'.includes('大') 都为真）；
  // startsWith 会放过「喜悦」。所以必须要求枚举词后紧跟分隔符。
  assert.equal(peakIntensityOf('峰值：喜悦').ok, false, '「喜悦」不是峰值取值')
  assert.equal(peakIntensityOf('峰值：大爽点').ok, false)
  assert.equal(peakIntensityOf('峰值：中等').ok, false)
  // 合法写法要仍然通过
  assert.equal(peakIntensityOf('峰值：燃').ok, true)
  assert.equal(peakIntensityOf('峰值：燃（对抗升级）').ok, true, '枚举词＋括注是合法写法')
  assert.equal(peakIntensityOf('峰值：喜/关系缓和').ok, true)
})
