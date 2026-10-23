// 成本计量（M-06）：记录真实用量，并用确定性下界交叉核对。
// 防的回归：
//   1) 计量被删掉——没有数就无法回答「这本书花了多少」；
//   2) 只记不核——允许上报一个低于「读一遍全书」的数字而不报警；
//   3) 累加/覆盖语义弄反——重跑一个阶段时把两次用量叠成两倍。
//
// 凡需要写盘的操作一律在临时副本上做，绝不改仓库里的夹具。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { lowerBound, mergeCost, parseAmount } from '../skills/book-breakdown/scripts/cost.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SCRIPT = join(root, 'skills', 'book-breakdown', 'scripts', 'cost.mjs')
const fixture = join(root, 'test', 'fixtures', 'products', '合成小书_拆解')

const tmpBase = join(here, '.tmp', 'cost')
after(() => rmSync(tmpBase, { recursive: true, force: true }))

function runScript(args) {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'run-'))
  const outFd = openSync(join(dir, 'o.txt'), 'w')
  const errFd = openSync(join(dir, 'e.txt'), 'w')
  let r
  try {
    r = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', outFd, errFd] })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(join(dir, 'o.txt'), 'utf8')
  const stderr = readFileSync(join(dir, 'e.txt'), 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { status: r.status, stdout, stderr }
}

// 造一份可写的产物副本（测完即删）。
function makeProduct() {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'prod-'))
  cpSync(fixture, dir, { recursive: true })
  return dir
}

test('parseAmount 认纯数字与 k/m 后缀，拒绝非法串', () => {
  assert.equal(parseAmount('37500'), 37500)
  assert.equal(parseAmount('37k'), 37000)
  assert.equal(parseAmount('1.2m'), 1_200_000)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('abc'), null)
  assert.equal(parseAmount('-5'), null)
})

test('mergeCost：record 累加、set 覆盖，total 始终等于各阶段之和', () => {
  let c = mergeCost(undefined, { stage: 4, input: 100, output: 10, mode: 'record' })
  c = mergeCost(c, { stage: 4, input: 200, output: 20, mode: 'record' })
  assert.deepEqual({ in: c.stages['4'].in, out: c.stages['4'].out, calls: c.stages['4'].calls }, { in: 300, out: 30, calls: 2 })
  c = mergeCost(c, { stage: 4, input: 500, output: 50, mode: 'set' })
  assert.equal(c.stages['4'].in, 500, 'set 应覆盖而非累加')
  assert.equal(c.stages['4'].calls, 1)
  c = mergeCost(c, { stage: 5, input: 40, output: 4, mode: 'record' })
  const sum = Object.values(c.stages).reduce((a, s) => a + s.in, 0)
  assert.equal(c.total.in, sum, 'total 必须等于各阶段之和')
})

test('lowerBound：阶段 4 输入下界＝全书字符数折算，输出下界按非原文产物字符数', () => {
  const lb = lowerBound({ totalChars: 1600 }, 3200)
  assert.equal(lb.阶段4输入下界, 1000)
  assert.equal(lb.输出下界, 2000)
})

test('CLI：未记录时 --check 退出 1（无计量即不通过，符合 M-06）', () => {
  const dir = makeProduct()
  try {
    const r = runScript([dir, '--check'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /E_COST_MISSING/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：记录后 --report 出表，--check 退出 0', () => {
  const dir = makeProduct()
  try {
    const r0 = runScript([dir, '--record', '--stage', '4', '--in', '1000', '--out', '100'])
    assert.equal(r0.status, 0, r0.stderr)
    const r1 = runScript([dir, '--report'])
    assert.equal(r1.status, 0, r1.stderr)
    assert.match(r1.stdout, /阶段用量/)
    assert.match(r1.stdout, /卷循环/)
    const r2 = runScript([dir, '--check'])
    assert.equal(r2.status, 0, '有计量时 --check 应通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：上报值低于确定性下界时给 W_COST_UNDER 警告', () => {
  const dir = makeProduct()
  try {
    // fixture 全书 233 字 → 阶段 4 下界 146；报 10 必然低于下界
    runScript([dir, '--set', '--stage', '4', '--in', '10', '--out', '1'])
    const r = runScript([dir, '--report'])
    assert.match(r.stdout, /W_COST_UNDER/)
    assert.match(r.stdout, /读一遍不可能更少/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：缺参、非法 stage、非法数量都退出 2（参数错）', () => {
  const dir = makeProduct()
  try {
    assert.equal(runScript([]).status, 2)
    assert.equal(runScript([dir, '--record', '--stage', '9', '--in', '1']).status, 2)
    assert.equal(runScript([dir, '--record', '--stage', '4', '--in', 'abc']).status, 2)
    assert.equal(runScript([dir, '--record', '--stage', '4']).status, 2, '--in 与 --out 都缺应报参数错')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：--json 报告可解析且带下界与警告字段', () => {
  const dir = makeProduct()
  try {
    runScript([dir, '--set', '--stage', '4', '--in', '10', '--out', '1'])
    const r = runScript([dir, '--report', '--json'])
    const obj = JSON.parse(r.stdout)
    assert.ok(obj.ok)
    assert.ok(obj.下界.阶段4输入下界 > 0)
    assert.ok(Array.isArray(obj.警告))
    assert.ok(obj.警告.some((w) => w.startsWith('W_COST_UNDER')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI：记录只写 manifest 的 cost 键，不新增产物文件（工作/ 仍只有三个）', () => {
  const dir = makeProduct()
  try {
    runScript([dir, '--record', '--stage', '4', '--in', '1000', '--out', '100'])
    const manifestText = readFileSync(join(dir, '工作', 'manifest.json'), 'utf8')
    assert.match(manifestText, /"cost"/)
    // 工作/ 目录内容不变：manifest.json、别名词典.md、逐章记录.md
    const workFiles = readdirSync(join(dir, '工作')).sort()
    assert.deepEqual(workFiles, ['manifest.json', '别名词典.md', '逐章记录.md'].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
