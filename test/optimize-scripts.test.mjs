// 成本优化的两个脚本：write-rows（避免读整表）与 entity-index（零 token 建实体索引）。
// 这两条测试防的是「优化被悄悄改回去」——若有人把 write-rows 换成读整表，
// 或把 entity-index 的采样取消，性能会退回优化前而不易察觉。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex, SAMPLE_TIERS, sampleChapters, splitEntities } from '../skills/book-breakdown/scripts/entity-index.mjs'
import { applyRows } from '../skills/book-breakdown/scripts/write-rows.mjs'
import { THRESHOLDS } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SCRIPTS = join(root, 'skills', 'book-breakdown', 'scripts')
const SCRIPT = join(SCRIPTS, 'entity-index.mjs')

// 受限沙箱禁止子进程经管道输出（EPERM），改用文件描述符承接；与 cli.test.mjs 同法（评审 P19）。
const tmpBase = join(here, '.tmp', 'opt')
function runScript(script, args) {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'run-'))
  const outPath = join(dir, 'stdout.txt')
  const errPath = join(dir, 'stderr.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [script, ...args], { stdio: ['ignore', outFd, errFd] })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, stdout, stderr }
}

// 跑完清掉承接 stdout 的临时目录（约定：test/.tmp/ 自清）。
after(() => rmSync(tmpBase, { recursive: true, force: true }))

const HEADER =
  '| 全局章号 | 标题（清洗后） | 章字数 | 视角人物 | 地点 | 出场人物 | 一句话事件 | 剧情线 | 伏笔埋/收 | 情绪 | 章末钩型 | 爽点强度 | 爽点类型 | 故事内时间 | 章首句 |'
const SEP = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'

// 造一张 n 章的表，行内全为占位符（模拟 prepare 刚跑完的骨架）。
function table(n, filled = {}) {
  const lines = ['# 逐章记录', '', '> 骨架文件：段名与表头不可改；逐段替换占位后再交付。', '', HEADER, SEP]
  for (let i = 1; i <= n; i += 1) {
    const f = filled[i]
    const cells = f
      ? [String(i), `第${i}章 标题`, String(1000 + i), ...f]
      : [String(i), `第${i}章 标题`, String(1000 + i), '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）']
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines
}

const goodRow = (no, extra = {}) => ({
  章号: no,
  视角人物: '甲',
  地点: '车站',
  出场人物: '甲、乙',
  一句话事件: '甲到了车站',
  剧情线: '主线',
  伏笔埋收: '埋：车票',
  情绪: '扬',
  章末钩型: '悬念',
  爽点强度: '小',
  爽点类型: '逆袭',
  故事内时间: '第一日',
  章首句: '雨打在车窗上。',
  ...extra,
})

test('write-rows：只改目标章的行，标题与章字数（脚本列）不被碰', () => {
  const lines = table(5)
  const { lines: out, updated } = applyRows(lines, [goodRow(3)])
  assert.equal(updated, 1)
  // 第 3 章行被填
  const row3 = out.find((l) => l.startsWith('| 3 |'))
  assert.match(row3, /车站/)
  assert.match(row3, /甲到了车站/)
  // 章字数仍是脚本写的值（1003），未被覆盖
  assert.match(row3, /\| 1003 \|/)
  // 标题未变
  assert.match(row3, /第3章 标题/)
  // 其他行原样
  assert.equal(out.find((l) => l.startsWith('| 1 |')), lines.find((l) => l.startsWith('| 1 |')))
  assert.equal(out.find((l) => l.startsWith('| 4 |')), lines.find((l) => l.startsWith('| 4 |')))
})

test('write-rows：幂等——同一批再写一次不发生改动', () => {
  const lines = table(3)
  const first = applyRows(lines, [goodRow(2)])
  const second = applyRows(first.lines, [goodRow(2)])
  assert.equal(second.updated, 0, '第二次应为 0 行改动（幂等）')
  assert.deepEqual(second.lines, first.lines)
})

test('write-rows：未知章号报 E_CHAPTER', () => {
  const lines = table(3)
  assert.throws(() => applyRows(lines, [goodRow(9)]), (e) => e.code === 'E_CHAPTER')
})

test('write-rows：缺字段报 E_FIELD，--partial 时放行并保留原值', () => {
  const lines = table(2, { 1: ['甲', '车站', '甲', '事', '主线', '埋：x', '扬', '悬念', '小'] })
  const partial = { 章号: 1, 一句话事件: '改后的事件' }
  assert.throws(() => applyRows(lines, [partial]), (e) => e.code === 'E_FIELD')
  const { lines: out, updated } = applyRows(lines, [partial], { partial: true })
  assert.equal(updated, 1)
  const row = out.find((l) => l.startsWith('| 1 |'))
  assert.match(row, /改后的事件/)
  assert.match(row, /车站/, '未提交的字段应保留原值')
})

test('write-rows：占位符「（待填）」不算填写，报 E_FIELD', () => {
  const lines = table(2)
  assert.throws(() => applyRows(lines, [goodRow(1, { 地点: '（待填）' })]), (e) => e.code === 'E_FIELD')
})

// T13：有前言的书，prepare 把前言记为第 0 章，模板明写「非叙事行情绪可空」。
// 原先 9 个字段一律必填，导致第 0 章那一行照模板填一定报 E_FIELD——20 份模板里唯一「照填必报错」的一处。
test('write-rows：第 0 章（前言）情绪可空，其余字段仍必填', () => {
  const lines = table(2)
  // 造一行第 0 章（table() 从 1 起，这里手工插到表头分隔行之后，即索引 6）
  const withCh0 = [...lines]
  withCh0.splice(6, 0, '| 0 | 前言 | 500 | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） | （待填） |')
  const noEmotion = goodRow(0)
  delete noEmotion.情绪
  const { updated } = applyRows(withCh0, [noEmotion])
  assert.equal(updated, 1, '前言那行不该因情绪为空被拒')
  // 但第 0 章的其它字段照旧必填
  const noPlace = goodRow(0)
  delete noPlace.地点
  assert.throws(
    () => applyRows(withCh0, [noPlace]),
    (e) => e.code === 'E_FIELD',
    '只放行情绪，其余八列仍须填写',
  )
  // 正文章（≥1）的情绪仍然必填
  const bodyNoEmotion = goodRow(1)
  delete bodyNoEmotion.情绪
  assert.throws(
    () => applyRows(lines, [bodyNoEmotion]),
    (e) => e.code === 'E_FIELD',
    '正文章的情绪不能空着',
  )
})

test('write-rows：枚举值非法报 E_ENUM，并列全枚举', () => {
  const lines = table(2)
  assert.throws(
    () => applyRows(lines, [goodRow(1, { 章末钩型: '大危机' })]),
    (e) => e.code === 'E_ENUM' && /危机.*悬念.*期待.*反差.*钝收/.test(e.message),
  )
  assert.throws(() => applyRows(lines, [goodRow(1, { 情绪: '高潮' })]), (e) => e.code === 'E_ENUM')
})

test('write-rows：值含竖线或换行报 E_FIELD（会撑裂表格）', () => {
  const lines = table(2)
  assert.throws(() => applyRows(lines, [goodRow(1, { 一句话事件: 'a|b' })]), (e) => e.code === 'E_FIELD')
  assert.throws(() => applyRows(lines, [goodRow(1, { 一句话事件: 'a\nb' })]), (e) => e.code === 'E_FIELD')
})

test('write-rows：输入里章号重复报 E_DUP', () => {
  const lines = table(3)
  assert.throws(() => applyRows(lines, [goodRow(1), goodRow(1)]), (e) => e.code === 'E_DUP')
})

test('write-rows：表头与契约不符时报 E_HEADER，不猜列序', () => {
  const lines = ['| 章号 | 标题 |', '| --- | --- |', '| 1 | x |']
  assert.throws(() => applyRows(lines, [goodRow(1)]), (e) => e.code === 'E_HEADER')
})

test('entity-index：拆分出场人物，去「多视角」外壳', () => {
  assert.deepEqual(splitEntities('甲、乙'), ['甲', '乙'])
  assert.deepEqual(splitEntities('多视角（甲／乙）'), ['甲', '乙'])
  assert.deepEqual(splitEntities('（待填）'), [])
  assert.deepEqual(splitEntities(''), [])
})

test('entity-index：空值记号不进索引（龙族3 实测）', () => {
  // 龙族3 章 0 是题记：视角写「（无人称叙述）」、地点写「无」。
  // 旧实现只过滤「（待填）」，这两格被当成实体进索引——多出两个只出现 1 章的假实体
  // （「（无人称叙述）」进了人物表、「无」进了地点表），与龙族2 的「（提及）」同类。
  assert.deepEqual(splitEntities('无'), [], '单字「无」不是地点')
  assert.deepEqual(splitEntities('（无）'), [])
  assert.deepEqual(splitEntities('（无人称叙述）'), [], '括号说明不是人物')
  assert.deepEqual(splitEntities('（提及）'), [])
  assert.deepEqual(splitEntities('—'), [])
  assert.deepEqual(splitEntities('（全知视角）'), [])
  // 反例：带顿号的括号内容是真枚举，不能当说明吞掉
  assert.deepEqual(splitEntities('（甲、乙）'), ['（甲、乙）'], '含分隔符的括号是真名字，整体保留')
  // 反例：正常故事人物不受影响
  assert.deepEqual(splitEntities('雷娜塔、零号'), ['雷娜塔', '零号'])
})

test('entity-index：括号内的分隔符不切分（真书实测的路线写法）', () => {
  // 《长安的荔枝》第 2 章地点写「长安至广州（灞桥、商州道、…、广州）」，
  // 是一条路线的括注。旧实现把括号内顿号也当分隔符，切出
  // 「长安至广州（灞桥」与「广州）」两个假实体，地名索引因此多出 4 行脏数据。
  const route = '长安至广州（灞桥、商州道、鄱阳湖、梅关、广州）'
  assert.deepEqual(splitEntities(route), [route], '括号内整体保留，不拆')
  assert.deepEqual(splitEntities('甲（乙、丙）、丁'), ['甲（乙、丙）', '丁'], '括号外仍要拆')
  assert.deepEqual(splitEntities('大庾岭天开路、长安招福寺'), ['大庾岭天开路', '长安招福寺'])
})

test('entity-index：首现章/末次章/类型正确，占位行不参与索引', () => {
  const lines = table(4, {
    1: ['甲', '车站', '甲、乙', '事1', '主线', '无', '扬', '悬念', '小'],
    3: ['乙', '码头', '乙', '事3', '主线', '无', '抑', '期待', '无'],
  })
  const { index, pending } = buildIndex(lines)
  assert.equal(pending, 2, '第 2、4 章未填，应计入 pending')
  const jia = index.get('甲')
  assert.equal(jia.首现章, 1)
  assert.deepEqual(jia.章号, [1])
  const yi = index.get('乙')
  assert.deepEqual(yi.章号, [1, 3], '乙在第 1、3 章都出现')
  assert.equal(yi.首现章, 1)
  assert.equal(yi.末次章, 3)
  assert.equal(index.get('码头').类型, '地点')
})

// C-13：默认上限从 4 改成 6，与 08-设定库「主角 ≤6 章」的承诺对齐。
// 旧用例断言的是 4（脚本自己的旧默认），不是任何文档承诺的数——改的是口径，不是为了让测试变绿。
test('entity-index：采样默认 6 章且必含首现与末次（与 08 表「主角 ≤6 章」一致）', () => {
  const many = Array.from({ length: 600 }, (_, i) => i + 1)
  const s = sampleChapters(many)
  assert.equal(s.length, 6, '600 章出场也只采 6 章')
  assert.equal(s[0], 1, '必须含首现章')
  assert.equal(s[s.length - 1], 600, '必须含末次章')
  // 少于阈值时全给
  assert.deepEqual(sampleChapters([5, 9]), [5, 9])
})

test('entity-index：三档取证上限都来自 contract，档位名可覆盖', () => {
  // 08 表三档：主角 ≤6、次要角色 ≤2、集合条目 ≤3
  assert.equal(SAMPLE_TIERS.主角, 6)
  assert.equal(SAMPLE_TIERS.次要角色, 2)
  assert.equal(SAMPLE_TIERS.集合条目, 3)
  for (const [tier, cap] of Object.entries(SAMPLE_TIERS)) {
    assert.equal(THRESHOLDS[`取证章数_${tier}`], cap, `${tier} 档必须直接引用 contract 的键`)
    assert.equal(sampleChapters([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cap).length, cap, `${tier} 档应采 ${cap} 章`)
  }
})

test('entity-index：--sample 传非法档位退出 2，传整数可用', () => {
  const bad = runScript(SCRIPT, ['.', '--sample', '路人甲'])
  assert.equal(bad.status, 2, `非法档位应退出 2，实际 ${bad.status}`)
  assert.match(bad.stderr, /--sample/)
  // 整数 3 合法（不是非法档位那条路）：走到「逐章记录不可读」才是业务失败 1
  const ok = runScript(SCRIPT, ['.', '--sample', '3'])
  assert.equal(ok.status, 1, '合法取值应越过参数检查，进到读文件那步')
})

test('CLI：write-rows --dry-run 不落盘，正式跑才写；entity-index --entity 给出章号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    const recPath = join(dir, '工作', '逐章记录.md')
    await writeFile(recPath, `${table(2).join('\n')}\n`, 'utf8')
    const rowsPath = join(dir, 'rows.json')
    await writeFile(rowsPath, JSON.stringify([goodRow(1)]), 'utf8')

    const before = await readFile(recPath, 'utf8')
    const dry = runScript(join(SCRIPTS, 'write-rows.mjs'), [dir, '--rows', rowsPath, '--dry-run', '--json'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(await readFile(recPath, 'utf8'), before, '--dry-run 不得改文件')
    assert.match(dry.stdout, /"updated":1/)

    const real = runScript(join(SCRIPTS, 'write-rows.mjs'), [dir, '--rows', rowsPath, '--json'])
    assert.equal(real.status, 0, real.stderr)
    assert.match(real.stdout, /"updated":1/)
    assert.match(await readFile(recPath, 'utf8'), /甲到了车站/)

    const idx = runScript(join(SCRIPTS, 'entity-index.mjs'), [dir, '--entity', '甲'])
    assert.equal(idx.status, 0, idx.stderr)
    assert.match(idx.stdout, /出现 1 章/)
    assert.match(idx.stdout, /建议取证章/)

    const missing = runScript(join(SCRIPTS, 'entity-index.mjs'), [dir, '--entity', '王五'])
    assert.equal(missing.status, 1, '查不到的实体应退出 1')

    const noArgs = runScript(join(SCRIPTS, 'write-rows.mjs'), [])
    assert.equal(noArgs.status, 2, '缺参数应退出 2（参数错，非业务失败）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- C-26：--dry-run 一次报全部错误，不是首错即停 ----------
//
// 一批 20 章里错 10 处，首错即停意味着改一条跑一次、跑 10 轮；
// 每轮还要重读整表——正是这个脚本存在的理由（读表成本占输入 71%）。
// 预演路径本来就是「跑一遍看有没有问题」，只报第一条等于没起到预演的作用。

test('C-26：--dry-run 一次收集全部错误，不是首错即停', () => {
  const lines = table(3)
  const rows = [
    goodRow(1),
    { ...goodRow(2), 章末钩型: '不存在的钩型' }, // E_ENUM
    { ...goodRow(3), 一句话事件: '带|竖线的值' }, // E_FIELD
  ]
  const r = applyRows(lines, rows, { collectAll: true })
  assert.equal(r.updated, 0, '有错时整体放弃，不能返回半个结果')
  assert.equal(r.errors.length, 2, `该报 2 处错，实际 ${r.errors.length}：${r.errors.map((e) => e.code).join('、')}`)
  assert.deepEqual(r.errors.map((e) => e.code).sort(), ['E_ENUM', 'E_FIELD'], '两类错都要报，不能只报第一类')
  assert.ok(
    r.errors.every((e) => /第 [23] 章/.test(e.message)),
    '每条错都要点名是第几章，否则人还得自己找',
  )
})

test('C-26：默认仍首错即停（单条写入用不着收集）', () => {
  const lines = table(3)
  const rows = [
    { ...goodRow(2), 章末钩型: '不存在的钩型' },
    { ...goodRow(3), 一句话事件: '带|竖线的值' },
  ]
  assert.throws(
    () => applyRows(lines, rows),
    (e) => e.code === 'E_ENUM',
    '默认模式应首错即停，抛第一条错的码',
  )
})

test('C-26：同一章的多处错要全报，不能只报该章第一条', () => {
  const lines = table(2)
  const rows = [
    {
      ...goodRow(1),
      章末钩型: '不存在的钩型', // E_ENUM
      爽点强度: '不存在', // E_ENUM
      一句话事件: '带|竖线', // E_FIELD
    },
  ]
  const r = applyRows(lines, rows, { collectAll: true })
  assert.equal(r.errors.length, 3, `同一章的 3 处错都要报，实际 ${r.errors.length}`)
})

test('C-26：章号本身非法/不存在时，不再对那一章做字段检查（避免刷同一件事的变体）', () => {
  const lines = table(2)
  const rows = [
    { ...goodRow(1), 章号: -5 }, // 章号非法：不该再报「缺字段」
    { ...goodRow(99) }, // 表里没有第 99 章：同上
  ]
  const r = applyRows(lines, rows, { collectAll: true })
  assert.deepEqual(r.errors.map((e) => e.code), ['E_CHAPTER', 'E_CHAPTER'], '每章只报一条章号错，不带出一串字段错')
})

test('C-26：CLI --dry-run 报全部错误且退出 1、不写盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-c26-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    const recPath = join(dir, '工作', '逐章记录.md')
    await writeFile(recPath, `${table(3).join('\n')}\n`, 'utf8')
    const before = await readFile(recPath, 'utf8')
    const rowsPath = join(dir, 'rows.json')
    await writeFile(rowsPath, JSON.stringify([
      { ...goodRow(2), 章末钩型: '不存在的钩型' },
      { ...goodRow(3), 一句话事件: '带|竖线的值' },
    ]), 'utf8')

    const dry = runScript(join(SCRIPTS, 'write-rows.mjs'), [dir, '--rows', rowsPath, '--dry-run'])
    assert.equal(dry.status, 1, '有错应退出 1')
    assert.match(dry.stderr, /2 处问题/, `该报 2 处，实际输出：${dry.stderr}`)
    assert.match(dry.stderr, /E_ENUM/)
    assert.match(dry.stderr, /E_FIELD/)
    assert.equal(await readFile(recPath, 'utf8'), before, '有错时不写盘')

    const dryJson = runScript(join(SCRIPTS, 'write-rows.mjs'), [dir, '--rows', rowsPath, '--dry-run', '--json'])
    assert.equal(dryJson.status, 1)
    const parsed = JSON.parse(dryJson.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.count, 2, '--json 也要给出全部错误，不能只给第一条')
    assert.ok(Array.isArray(parsed.errors) && parsed.errors.length === 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// C-12：首现章只能由脚本给。此前 agent 自己数，实测把 197 写成 239——
// 因为出场章不连续，肉眼数「第几行」会偏移。这里造一本「首现在第 7 章、中间断档」的书，
// 脚本的答案必须与逐章记录里真正第一次出现的那一行一致。
test('entity-index：首现章取脚本输出，断档出场也不会数错（C-12 实测：239 实为 197）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opt-'))
  try {
    await mkdir(join(dir, '工作'), { recursive: true })
    // 主角「甲」只在第 7、8、19、40 章出场；其余章视角是「乙」。
    const appear = new Set([7, 8, 19, 40])
    const filled = {}
    for (const no of appear) filled[no] = ['甲', '车站', '甲、乙', '事', '主线', '无', '扬', '悬念', '小']
    for (let no = 1; no <= 60; no += 1) {
      if (!filled[no]) filled[no] = ['乙', '码头', '乙', '事', '主线', '无', '抑', '期待', '无']
    }
    await writeFile(join(dir, '工作', '逐章记录.md'), `${table(60, filled).join('\n')}\n`, 'utf8')

    const r = runScript(SCRIPT, [dir, '--json'])
    assert.equal(r.status, 0, r.stderr)
    const payload = JSON.parse(r.stdout)
    const jia = payload.实体.find((e) => e.名称 === '甲')
    assert.equal(jia.首现章, 7, `首现章应为 7，实际 ${jia.首现章}`)
    assert.equal(jia.末次章, 40)
    assert.deepEqual(jia.章号, [7, 8, 19, 40], '出场章应按章号升序且不重复')
    // 采样上限随 --sample 变，默认 6（这里只 4 个出场章，全给）
    assert.equal(payload.采样上限, 6)
    assert.deepEqual(jia.建议取证章, [7, 8, 19, 40], '出场章少于上限时全给')

    // 次要角色档位：上限 2，必须仍含首现与末次
    const r2 = runScript(SCRIPT, [dir, '--json', '--sample', '次要角色'])
    assert.equal(r2.status, 0, r2.stderr)
    const jia2 = JSON.parse(r2.stdout).实体.find((e) => e.名称 === '甲')
    assert.equal(jia2.建议取证章.length, 2, '次要角色档只采 2 章')
    assert.equal(jia2.建议取证章[0], 7, '采样必须含首现章')
    assert.equal(jia2.建议取证章[1], 40, '采样必须含末次章')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
