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
import { buildIndex, sampleChapters, splitEntities } from '../skills/book-breakdown/scripts/entity-index.mjs'
import { applyRows } from '../skills/book-breakdown/scripts/write-rows.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SCRIPTS = join(root, 'skills', 'book-breakdown', 'scripts')

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
  '| 全局章号 | 标题（清洗后） | 章字数 | 视角人物 | 地点 | 出场人物 | 一句话事件 | 剧情线 | 伏笔埋/收 | 情绪 | 章末钩型 | 爽点标记 |'
const SEP = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'

// 造一张 n 章的表，行内全为占位符（模拟 prepare 刚跑完的骨架）。
function table(n, filled = {}) {
  const lines = ['# 逐章记录', '', '> 骨架文件：段名与表头不可改；逐段替换占位后再交付。', '', HEADER, SEP]
  for (let i = 1; i <= n; i += 1) {
    const f = filled[i]
    const cells = f
      ? [String(i), `第${i}章 标题`, String(1000 + i), ...f]
      : [String(i), `第${i}章 标题`, String(1000 + i), '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）']
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
  爽点标记: '小',
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

test('entity-index：采样最多 4 章且必含首现与末次（卡片取证不读全部出场章）', () => {
  const many = Array.from({ length: 600 }, (_, i) => i + 1)
  const s = sampleChapters(many)
  assert.equal(s.length, 4, '600 章出场也只采 4 章')
  assert.equal(s[0], 1, '必须含首现章')
  assert.equal(s[s.length - 1], 600, '必须含末次章')
  // 少于阈值时全给
  assert.deepEqual(sampleChapters([5, 9]), [5, 9])
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
