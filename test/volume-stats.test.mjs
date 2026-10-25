// 卷级派生统计（C-01/C-02/C-03 派生）。
//
// 这三项原来都靠 agent 手算：每卷爽点章数、钩型分布、最大连续同型钩。
// 手算的问题不是慢，是**没有正确答案可对照**——数错了没人知道，产物里也看不出是数是猜。
// 而它们全是「逐章记录里现成的列 + 一次分组统计」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeVolumeStats, humanReport } from '../skills/book-breakdown/scripts/volume-stats.mjs'
import { COLUMNS } from '../skills/book-breakdown/scripts/contract.mjs'

// 造一行逐章记录。只填统计用得到的三列，其余留占位——统计不该关心它们。
function row(no, hook, sharp = '无', sharpType = '') {
  const cells = COLUMNS.逐章记录.map((c) => {
    if (c === '全局章号') return String(no)
    if (c === '章末钩型') return hook
    if (c === '爽点强度') return sharp
    if (c === '爽点类型') return sharpType
    return '（待填）'
  })
  return cells
}

const V1 = { no: 1, name: '第一卷', startCh: 1, endCh: 20 }
const V2 = { no: 2, name: '第二卷', startCh: 21, endCh: 30 }

test('C-01 派生：每卷爽点章数与中爽点间隔中位数', () => {
  // 卷1（1–20 章）爽点在 1、2、4、14 章 → 间隔 [1,2,10]
  // 卷2（21–30 章）爽点在 21、22、25 章 → 间隔 [1,3]
  //
  // **数据必须让中位数与均值不相等，才能测出「误用均值」**。
  // 两个间隔时永远测不出：偶数个的中位数定义就是 (a+b)/2，等于均值。
  // 所以卷1 特意给 3 个间隔：中位数 2，均值 (1+2+10)/3 = 4.33，两者可区分。
  // 卷2 只有 2 个间隔，中位数与均值都是 2——留着它证明「相等时也不该出错」。
  const rows = [
    row(1, '危机', '大'), row(2, '悬念', '中'), row(3, '期待'), row(4, '钝收', '小'),
    ...Array.from({ length: 9 }, (_, i) => row(5 + i, '悬念')),
    row(14, '危机', '中'),
    ...Array.from({ length: 6 }, (_, i) => row(15 + i, '期待')),
    row(21, '危机', '大'), row(22, '悬念', '中'),
    row(23, '期待'), row(24, '反差'),
    row(25, '钝收', '小'),
    ...Array.from({ length: 5 }, (_, i) => row(26 + i, '悬念')),
  ]
  const r = computeVolumeStats(rows, { volumes: [V1, V2] })
  assert.equal(r.perVolume[0].chapters, 20)
  assert.equal(r.perVolume[0].sharpChapters, 4, '卷1 在 1、2、4、14 章有爽点')
  assert.equal(r.perVolume[0].sharpGapMedian, 2, '卷1 间隔 [1,2,10] 中位数是 2；若误用均值会是 4.33')
  assert.equal(r.perVolume[1].sharpChapters, 3, '卷2 在 21、22、25 章有爽点')
  assert.equal(r.perVolume[1].sharpGapMedian, 2, '卷2 间隔 [1,3] 偶数个取中间两个的均值 2')
})

test('C-01 派生：只记到 1 个爽点章时中位数为 null，不是 0', () => {
  // 0 与「算不出来」是两件事。写成 0 会让人以为「间隔为零」，即章章有爽点。
  const rows = [row(1, '危机', '大'), row(2, '悬念'), row(3, '悬念')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 3 }] })
  assert.equal(r.perVolume[0].sharpChapters, 1)
  assert.equal(r.perVolume[0].sharpGapMedian, null, '一个爽点算不出间隔，必须是 null 而不是 0')
  assert.match(humanReport(r), /无（本卷只记到 1 个爽点章/, '报告里要写清为什么没有数')
})

test('C-02 派生：钩型分布按章数降序，占比按本卷章数算', () => {
  // 第 6 章没有钩型（只填了爽点），于是「钩型总数 5」≠「本卷章数 6」。
  // 第一版 5 章 5 个钩型，两个分母相同，占比分母改错也测不出来。
  const rows = [
    row(1, '危机'), row(2, '危机'), row(3, '危机'), row(4, '悬念'), row(5, '钝收'),
    row(6, '', '大'),
  ]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 6 }] })
  assert.equal(r.perVolume[0].chapters, 6, '本卷 6 章（含没填钩型的那章）')
  const dist = r.perVolume[0].hookDist
  assert.equal(dist[0].hook, '危机')
  assert.equal(dist[0].count, 3)
  assert.equal(dist[0].ratio, 3 / 6, '占比分母是本卷章数（6），不是钩型总数（5）')
  // 降序 + 同数按契约枚举顺序（危机→悬念→期待→反差→钝收），不依赖拼音序
  assert.deepEqual(dist.map((d) => d.hook), ['危机', '悬念', '钝收'], '降序排列')
})

test('C-02 派生：最大连续同型钩只在卷内数，不跨卷', () => {
  // 卷1 末章与卷2 首章都是「悬念」。跨卷连起来数会得到 2，
  // 但卷末与卷首同型是结构，不是拖——所以必须分段数。
  const rows = [
    row(1, '危机'), row(2, '危机'), row(3, '危机'), row(4, '悬念'), row(5, '悬念'),
    row(6, '悬念'), row(7, '期待'), row(8, '期待'),
  ]
  const vols = [{ no: 1, name: '一', startCh: 1, endCh: 5 }, { no: 2, name: '二', startCh: 6, endCh: 8 }]
  const r = computeVolumeStats(rows, { volumes: vols })
  assert.equal(r.perVolume[0].maxHookRun, 3, '卷1 最长是 3 章危机')
  assert.equal(r.perVolume[0].maxHookRunHook, '危机')
  assert.equal(r.perVolume[1].maxHookRun, 2, '卷2 最长是 2 章期待——不能把卷1 末尾的悬念接过来算 3')
  assert.equal(r.perVolume[1].maxHookRunHook, '期待')
})

test('C-02 派生：没有连续同型时 maxHookRun 为 1 且 hook 为 null', () => {
  const rows = [row(1, '危机'), row(2, '悬念'), row(3, '期待')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 3 }] })
  assert.equal(r.perVolume[0].maxHookRun, 1)
  assert.equal(r.perVolume[0].maxHookRunHook, null, '连 2 章都没有，不该点名任何钩型')
  assert.match(humanReport(r), /没有连续同型/)
})

test('C-03 派生：卷内爽点密度＝爽点章数／本卷章数', () => {
  const rows = [row(1, '危机', '大'), row(2, '悬念'), row(3, '期待', '小'), row(4, '钝收')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 4 }] })
  assert.match(humanReport(r), /爽点密度：50\.0%（2\/4）/, '密度必须写成百分比并给出分子分母')
})

test('枚举外的取值不计入统计，但要报出来（静默丢弃等于藏问题）', () => {
  // 「大爽点」「危机钩」是手写变体。丢弃它们是对的（契约里没有），
  // 但不说一声，用户只会看到「爽点章 1」而不知道为什么少了。
  const rows = [
    row(1, '危机', '大'), row(2, '危机钩', '大爽点'), row(3, '悬念', '中'),
  ]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 3 }] })
  assert.equal(r.perVolume[0].sharpChapters, 2, '合法的两个计入')
  assert.equal(r.offEnum.钩型.length, 1)
  assert.equal(r.offEnum.钩型[0].value, '危机钩')
  assert.equal(r.offEnum.爽点强度.length, 1)
  assert.equal(r.offEnum.爽点强度[0].value, '大爽点')
  const rep = humanReport(r)
  assert.match(rep, /不在枚举内、未计入统计/, '必须有一段说明')
  assert.match(rep, /第2章「危机钩」/, '要点名是第几章的哪个值')
  // 这一条断的是**报告文本**而不是 offEnum 数组：
  // 收集到了却不打印，用户照样看不见。只断言数组的话，把打印条件关掉也测不出来。
  assert.match(rep, /钩型：第2章「危机钩」/, '钩型这一类的说明行必须真的出现在报告里')
  assert.match(rep, /爽点强度：第2章「大爽点」/, '爽点强度那一类同理')
})

test('占位按字段判：钩型还是占位、爽点已填的章仍然参与密度（C-03 回归）', () => {
  // 原实现是 `hook === 占位 || sharp === 占位 → 整行跳过`。
  // agent 逐列填的时候，「爽点强度填了、章末钩型还没填」是常态，
  // 于是那一章被整行丢掉，密度分母漏算，而产物上看不出少了。
  const rows = [row(1, '（待填）', '大'), row(2, '（待填）', '无')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 2 }] })
  assert.equal(r.perVolume[0].chapters, 2, '两章都要进分母')
  assert.equal(r.perVolume[0].sharpDensity, 0.5, '1/2 有爽点')
  assert.equal(r.offEnum.钩型.length, 0, '占位不算非法取值')
})

test('占位按字段判：爽点还是占位、钩型已填的章也参与钩型统计', () => {
  const rows = [row(1, '危机', '（待填）'), row(2, '悬念', '（待填）')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 2 }] })
  assert.equal(r.perVolume[0].chapters, 2)
  assert.equal(r.perVolume[0].hookDist.length, 2, '两种钩型都要统计到')
  assert.equal(r.perVolume[0].sharpDensity, 0, '两章都没爽点 → 0，不是 null（分母存在）')
})

test('占位按字段判：三列全空才整行跳过（还没开始填的行）', () => {
  const rows = [row(1, '（待填）', '（待填）'), row(2, '危机', '大')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 2 }] })
  assert.equal(r.perVolume[0].chapters, 1, '全空的第 1 行不进统计')
})

test('占位行整行跳过：既不进统计也不报成非法取值', () => {
  // 骨架态每行都是（待填）。若把（待填）当非法取值报出来，新建的书一跑就是满屏错误。
  const rows = [row(1, '（待填）', '（待填）'), row(2, '危机', '大')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 2 }] })
  assert.equal(r.offEnum.钩型.length, 0, '占位符不是非法取值')
  assert.equal(r.offEnum.爽点强度.length, 0)
  assert.equal(r.perVolume[0].chapters, 1, '只有填过的那一章进统计')
})

test('没有卷信息时整本当一卷（单卷书与出版书都是这种形态）', () => {
  const rows = [row(1, '危机', '大'), row(2, '悬念', '大')]
  const r = computeVolumeStats(rows)
  assert.equal(r.perVolume.length, 1)
  assert.equal(r.perVolume[0].name, '全书')
  assert.equal(r.perVolume[0].chapters, 2)
})

test('爽点强度「无」不算爽点章', () => {
  const rows = [row(1, '危机', '无'), row(2, '悬念', '无'), row(3, '期待', '小')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 3 }] })
  assert.equal(r.perVolume[0].sharpChapters, 1, '只有「小」那章算')
})

test('全卷无爽点时报告写「没有记到」，不写 0%', () => {
  // 「密度 0%」读起来像「有数据且极低」；实际是「一个都没记」。
  const rows = [row(1, '钝收', '无'), row(2, '钝收', '无')]
  const r = computeVolumeStats(rows, { volumes: [{ no: 1, name: '卷', startCh: 1, endCh: 2 }] })
  const rep = humanReport(r)
  assert.match(rep, /没有记到爽点章/)
  assert.ok(!/爽点密度/.test(rep), '一个都没有时不报密度——0% 会被误读成「极低但仍有效」')
})

// ---------- CLI ----------

const HEADER = COLUMNS.逐章记录
function tableText(rows) {
  return [
    '# 逐章记录',
    '',
    `| ${HEADER.join(' | ')} |`,
    `| ${HEADER.map(() => '---').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
    '',
  ].join('\n')
}

test('CLI：读出逐章记录并打印人读报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vstats-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    await writeFile(join(dir, '工作', '逐章记录.md'), tableText([
      row(1, '危机', '大'), row(2, '悬念'), row(3, '期待', '中'),
    ]), 'utf8')
    await writeFile(join(dir, '工作', 'manifest.json'), JSON.stringify({
      volumes: [{ no: 1, name: '第一卷', startCh: 1, endCh: 3 }],
    }), 'utf8')
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('node', ['skills/book-breakdown/scripts/volume-stats.mjs', dir], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    })
    assert.match(out, /卷1（第一卷）：3 章，爽点章 2 章/)
    assert.match(out, /中爽点间隔中位数：2 章/)
    assert.match(out, /钩型分布：/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI：--json 输出可解析，字段齐', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vstats-json-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    await writeFile(join(dir, '工作', '逐章记录.md'), tableText([row(1, '危机', '大'), row(2, '危机')]), 'utf8')
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('node', ['skills/book-breakdown/scripts/volume-stats.mjs', dir, '--json'], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    })
    const parsed = JSON.parse(out)
    assert.equal(parsed.perVolume[0].sharpChapters, 1)
    assert.equal(parsed.perVolume[0].maxHookRun, 2)
    assert.ok(Array.isArray(parsed.perVolume[0].hookDist))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI：逐章记录缺失退出 1，表头不符退出 1（调用方要能区分「读不到」与「算完了」）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vstats-err-'))
  try {
    const { execFileSync } = await import('node:child_process')
    const run = (args) => {
      try { execFileSync('node', ['skills/book-breakdown/scripts/volume-stats.mjs', ...args], { cwd: join(import.meta.dirname, '..'), stdio: 'pipe' }); return 0 }
      catch (e) { return e.status }
    }
    assert.equal(run([dir]), 1, '没有逐章记录应退出 1')

    await mkdir(join(dir, '工作'), { recursive: true })
    await writeFile(join(dir, '工作', '逐章记录.md'), '# 逐章记录\n\n| 章号 | 钩型 |\n| --- | --- |\n| 1 | 危机 |\n', 'utf8')
    assert.equal(run([dir]), 1, '表头与契约不符应退出 1，不猜列序')
    assert.equal(run([]), 1, '缺参数应退出 1 并给用法')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
