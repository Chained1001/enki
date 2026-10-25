// C-14：引句批量定位（--grep-all）与 10 的分批裁决落盘。
//
// 这条改动的价值不在「能找到」，而在「子代理不再自己检索」。
// 所以测试的重点是：命中章号对不对、无命中要能区分、批量一次共用同一份全文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateQuotes } from '../skills/book-breakdown/scripts/quote-finder.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解')

const CH = [
  { no: 1, text: '张三走进车站，月台上空无一人。\n李四从长椅上抬起头：“这班车晚点了。”' },
  { no: 2, text: '李四递来一只旧木箱：“帮我看着，我去买票。”\n张三接过木箱。' },
  { no: 3, text: '队伍缓缓向前。张三攥着车票，掌心出了汗。' },
]

test('C-14：命中章号返回正确（这本书里找得到）', () => {
  const r = locateQuotes(CH, [{ 编号: 'n1', 引句: '张三走进车站，月台上空无一人' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].编号, 'n1')
  assert.equal(r[0].命中[0].章号, 1)
})

test('C-14：不同章的引句各归各章，不串味', () => {
  const r = locateQuotes(CH, [
    { 编号: 'a', 引句: '李四递来一只旧木箱' },
    { 编号: 'b', 引句: '张三攥着车票，掌心出了汗' },
  ])
  assert.equal(r[0].命中[0].章号, 2)
  assert.equal(r[1].命中[0].章号, 3)
})

test('C-14：全书没有的引句给空命中，不硬凑一章', () => {
  // 硬凑比空着更糟：子代理会拿一个错误的章号去判「同指」，然后按编造删除。
  const r = locateQuotes(CH, [{ 编号: 'x', 引句: '这本书里根本没有这一句完全无关的话' }])
  assert.deepEqual(r[0].命中, [])
})

test('C-14：标点差异不影响定位（引句照抄时容易漏标点）', () => {
  const r = locateQuotes(CH, [{ 编号: 'p', 引句: '张三走进车站 月台上空无一人' }])
  assert.equal(r[0].命中[0].章号, 1)
})

test('C-14：候选句要挑最像的那一句，不是该章第一句', () => {
  // 这一章的第一句刻意不含目标词——否则「取第一句」也能碰巧通过，
  // 变异测试第一次就是这么漏掉的：原夹具第 2 章只有两句，第一句恰好含「旧木箱」。
  const chapters = [
    { no: 1, text: '无关的开场白。\n另一句也无关。\n张三攥着车票，掌心出了汗。' },
  ]
  const r = locateQuotes(chapters, [{ 编号: 'n', 引句: '张三攥着车票，掌心出了汗' }])
  assert.match(r[0].命中[0].命中句, /掌心出了汗/, '要挑含目标词的那句')
  assert.ok(!/无关的开场白/.test(r[0].命中[0].命中句), '不能拿该章第一句充数')
})

test('C-14：太短的引句明确说明无法检索，不静默返回空', () => {
  // 「好」这种两字引句在全书有几千处，检索等于没检索。
  const r = locateQuotes(CH, [{ 编号: 's', 引句: '好' }])
  assert.deepEqual(r[0].命中, [])
  assert.match(r[0].说明 ?? '', /无法检索/)
})

test('C-14：minScore 调高后弱命中被滤掉（阈值真的在用）', () => {
  // 造一条只共享部分 4-gram 的引句：相似度中等。
  const loose = '张三走进车站 月台上一个人都没有啊'
  const low = locateQuotes(CH, [{ 编号: 'l', 引句: loose }], { minScore: 0 })
  assert.ok(low[0].命中.length > 0, '阈值 0 时应有候选')
  const high = locateQuotes(CH, [{ 编号: 'l', 引句: loose }], { minScore: 1 })
  assert.equal(high[0].命中.length, 0, '阈值 1 时应滤掉')
})

// ---------- CLI ----------

async function withBook(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ga-'))
  const out = join(dir, '书')
  try {
    await cp(FIXTURE, out, { recursive: true })
    return await fn({ dir, out })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = (args) => {
  try {
    return { code: 0, out: execFileSync('node', ['skills/book-breakdown/scripts/quote-finder.mjs', ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) { return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' } }
}

test('C-14：CLI --grep-all 读一批引句并打印命中章号', async () => {
  await withBook(async ({ dir, out }) => {
    const q = join(dir, 'q.json')
    await writeFile(q, JSON.stringify([
      { 编号: 'n1', 引句: '张三走进车站，月台上空无一人' },
      { 编号: 'n2', 引句: '李四递来一只旧木箱' },
    ]), 'utf8')
    const r = run([out, '--grep-all', q])
    assert.equal(r.code, 0)
    assert.match(r.out, /\[n1\] 第 1 章/)
    assert.match(r.out, /\[n2\] 第 2 章/)
  })
})

test('C-14：CLI 全无命中退出 1（调用方要能区分「没找到」与「没跑」）', async () => {
  await withBook(async ({ dir, out }) => {
    const q = join(dir, 'q.json')
    await writeFile(q, JSON.stringify([{ 编号: 'x', 引句: '这本书里根本没有这一句完全无关的话' }]), 'utf8')
    assert.equal(run([out, '--grep-all', q]).code, 1)
  })
})

test('C-14：CLI --grep-all 无命中时也要打印「无命中」，不能什么都不输出', async () => {
  await withBook(async ({ dir, out }) => {
    const q = join(dir, 'q.json')
    await writeFile(q, JSON.stringify([{ 编号: 'x', 引句: '这本书里根本没有这一句完全无关的话' }]), 'utf8')
    assert.match(run([out, '--grep-all', q]).out, /无命中/)
  })
})

test('C-14：CLI 引句文件格式错退出 2（参数错，不是找不到）', async () => {
  await withBook(async ({ dir, out }) => {
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{"不是":', 'utf8')
    assert.equal(run([out, '--grep-all', bad]).code, 2)
  })
})

test('C-14：CLI 空数组退出 2（不是 0 行成功）', async () => {
  await withBook(async ({ dir, out }) => {
    const empty = join(dir, 'e.json')
    await writeFile(empty, '[]', 'utf8')
    assert.equal(run([out, '--grep-all', empty]).code, 2)
  })
})

test('C-14：CLI --grep-all 不需要 --entity（路径不同）', async () => {
  await withBook(async ({ dir, out }) => {
    const q = join(dir, 'q.json')
    await writeFile(q, JSON.stringify([{ 编号: 'a', 引句: '张三走进车站，月台上空无一人' }]), 'utf8')
    assert.equal(run([out, '--grep-all', q]).code, 0, '--grep-all 不该因为缺 --entity 而退 2')
  })
})

test('C-14：CLI --min-score 越界退出 2', async () => {
  await withBook(async ({ dir, out }) => {
    const q = join(dir, 'q.json')
    await writeFile(q, JSON.stringify([{ 编号: 'a', 引句: '张三走进车站，月台上空无一人' }]), 'utf8')
    assert.equal(run([out, '--grep-all', q, '--min-score', '2']).code, 2)
  })
})

// ---------- 10 的文档：分批与落盘 ----------

test('C-14：10 写明每批 ≤20 条', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'workflows', '10-校验交付.md'), 'utf8')
  assert.match(t, /每批 *≤? *20 条|≤20 条/, '要把 not-found 分批，不能一次全给')
  assert.match(t, /grep-all/, '要用脚本先定位，别让子代理自己检索')
})

test('C-14：10 写明裁决由调用方追加落盘（子代理仍只读）', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'workflows', '10-校验交付.md'), 'utf8')
  assert.match(t, /工作\/增量\/裁决\.json/, '要点名落到哪个文件，只说「落盘」等于没说')
  assert.match(t, /追加/, '要写明追加写，否则每批覆盖前一批')
  assert.match(t, /每批/, '要写明每批写完就落，不是最后汇总')
  // 子代理只读这条不能被这次改动破坏
  assert.match(t, /子代理.*只读|仍然只读|子代理不改/, '落盘由主线程做，不能改成子代理写文件')
})

// ---------- C-29：08 的出场统计走脚本 ----------

test('C-29：08 写明出场统计一律取 entity-index --json，不自算', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'workflows', '08-设定库.md'), 'utf8')
  assert.match(t, /entity-index\.mjs --json/, '要点名取哪个命令的输出')
  assert.match(t, /不自己数|不自算|一律取/, '要明确禁止手算')
  // 反向：原来那句「从逐章记录统计…」是手算指令，必须消失
  assert.ok(!/从逐章记录统计出场/.test(t), '不该再让 agent 从逐章记录自己统计')
})

// 造一份最小的逐章记录：只填实体索引关心的三列，其余留占位。
async function buildMini(rows, volumes) {
  const { buildIndex } = await import('../skills/book-breakdown/scripts/entity-index.mjs')
  const { COLUMNS } = await import('../skills/book-breakdown/scripts/contract.mjs')
  const cols = COLUMNS.逐章记录
  const header = '| ' + cols.join(' | ') + ' |'
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |'
  const mk = (no, pov, place, cast, extra = {}) => {
    const cells = new Array(cols.length).fill('（待填）')
    cells[cols.indexOf('全局章号')] = String(no)
    cells[cols.indexOf('视角人物')] = pov
    cells[cols.indexOf('地点')] = place
    cells[cols.indexOf('出场人物')] = cast
    for (const [k, v] of Object.entries(extra)) cells[cols.indexOf(k)] = v
    return '| ' + cells.join(' | ') + ' |'
  }
  const lines = [header, sep, ...rows.map((r) => mk(...r))]
  return buildIndex(lines, { volumes })
}

test('C-29：脚本产出全局出场章数、分卷章数、视角章（文档与实现对得上）', async () => {
  const { index, volChapters } = await buildMini(
    [
      [1, '甲', '车站', '甲、乙'],
      [2, '乙', '车站', '甲、乙'],
      [3, '甲', '码头', '甲'],
    ],
    [{ no: 1, startCh: 1, endCh: 2 }, { no: 2, startCh: 3, endCh: 3 }],
  )
  const a = index.get('甲')
  assert.equal(a.章号.length, 3, '全局出场章数')
  assert.deepEqual(a.分卷章数, { 1: 2, 2: 1 }, '分卷口径：第1卷2章、第2卷1章')
  assert.deepEqual(a.视角章, [1, 3], '视角章：第1、3章')
  assert.deepEqual(volChapters, { 1: 2, 2: 1 }, '每卷章数（占比的分母）')
})

test('C-29：同一章里既是视角又是出场不重复计数（否则占比会超过 100%）', async () => {
  const { index } = await buildMini([[1, '甲', '车站', '甲']], [])
  assert.deepEqual(index.get('甲').分卷章数, { 1: 1 }, '同章只算一次')
  assert.equal(index.get('甲').章号.length, 1)
})

test('C-29：没有卷信息时整本当一卷（与 volume-stats 口径一致）', async () => {
  const { index, volChapters } = await buildMini(
    [[1, '甲', '车站', '甲'], [2, '甲', '车站', '甲']],
    [],
  )
  assert.deepEqual(index.get('甲').分卷章数, { 1: 2 })
  assert.deepEqual(volChapters, { 1: 2 })
})

test('C-29：--json 输出的「视角章占比」等于视角章/出场章', async () => {
  await withBook(async ({ out }) => {
    // 夹具的逐章记录是骨架，先把三列填上再跑
    const rec = join(out, '工作', '逐章记录.md')
    const raw = readFileSync(rec, 'utf8')
    const { COLUMNS } = await import('../skills/book-breakdown/scripts/contract.mjs')
    const cols = COLUMNS.逐章记录
    const lines = raw.split(/\r?\n/).map((line) => {
      const cells = line.split('|').slice(1, -1).map((s) => s.trim())
      if (cells.length !== cols.length) return line
      const no = Number(cells[0])
      if (!Number.isInteger(no)) return line
      cells[cols.indexOf('视角人物')] = '张三'
      cells[cols.indexOf('地点')] = '车站'
      cells[cols.indexOf('出场人物')] = '张三、李四'
      return '| ' + cells.join(' | ') + ' |'
    })
    await writeFile(rec, lines.join('\n'), 'utf8')

    const r = execFileSync('node', ['skills/book-breakdown/scripts/entity-index.mjs', out, '--json'], { cwd: ROOT, encoding: 'utf8' })
    const p = JSON.parse(r)
    const z = p.实体.find((e) => e.名称 === '张三')
    assert.ok(z, '张三应在索引里')
    assert.equal(z.视角章占比, 1, '张三每章都是视角人物')
    assert.ok('分卷章数' in z, '每个实体都带分卷口径')
  })
})
