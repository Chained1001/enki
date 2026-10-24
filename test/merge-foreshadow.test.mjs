// 伏笔台账的增量合并与统一重编号（B-05）。
// 防的回归：
//   1) 编号靠 agent 手排 → 撞车、跳号；
//   2) 重编号后不改正引用 → 卷纲/幕纲里的「埋 F012」变成悬空；
//   3) 合并不幂等 → 同一批增量跑两次条目翻倍；
//   4) 增量目录不被契约接受 → 产出被报「不属于产物契约的文件」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { mergeForeshadow, mergeRows, rewriteRefs, rowFingerprint, splitTable } from '../skills/book-breakdown/scripts/merge-foreshadow.mjs'
import { COLUMNS, productPlan } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'skills', 'book-breakdown', 'scripts', 'merge-foreshadow.mjs')

const HEADER = `| ${COLUMNS.伏笔台账.join(' | ')} |`
const SEP = `| ${COLUMNS.伏笔台账.map(() => '---').join(' | ')} |`

// 一行台账：编号, 描述, 类型, 埋点章, 强化章, 回收章, 回收幕, 跨度, 涉及实体, 重要度, 状态
const row = (id, desc, type = '道具', bury = '第2章', extra = {}) => {
  const cells = [id, desc, type, bury, extra.强化 ?? '', extra.回收 ?? '', extra.回收幕 ?? '', '', '张三', extra.重要度 ?? '主线', extra.状态 ?? '未收']
  return `| ${cells.join(' | ')} |`
}

function makeBook(dir, ledgerRows, incFiles = {}) {
  const ledgerPath = join(dir, '故事底本', '故事剧情', '伏笔台账.md')
  mkdirSync(dirname(ledgerPath), { recursive: true })
  mkdirSync(join(dir, '工作'), { recursive: true })
  writeFileSync(ledgerPath, `# 伏笔台账\n\n${HEADER}\n${SEP}\n${ledgerRows.join('\n')}\n`, 'utf8')
  for (const [name, rows] of Object.entries(incFiles)) {
    writeFileSync(join(dir, name), `# 伏笔台账（分卷增量）\n\n${HEADER}\n${SEP}\n${rows.join('\n')}\n`, 'utf8')
  }
  return ledgerPath
}

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------- 纯函数 ----------

test('rowFingerprint 不含编号：同一件事换个编号仍是同一行', () => {
  const a = ['F001', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收']
  const b = ['F007', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收']
  assert.equal(rowFingerprint(a), rowFingerprint(b))
})

test('mergeRows：按先主后增重编号，乱编号也被排成连续', () => {
  const master = [
    ['F007', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收'],
    ['F003', '旧伤', '身份', '第5章', '', '', '', '', '李四', '支线', '未收'],
  ]
  const inc = [
    ['F003', '新谜面', '事件', '第9章', '', '', '', '', '王五', '主线', '未收'],
  ]
  const { rows, remap, added } = mergeRows(master, inc)
  assert.deepEqual(rows.map((r) => r[0]), ['F001', 'F002', 'F003'], '应连续重编号')
  assert.equal(added, 1)
  // 只有主台账的旧编号进映射：7→1、3→2。增量那条的 F003 不进——
  // 它和主台账的 F003 撞号，拿它建映射会把引用指错地方。
  assert.deepEqual([...remap.entries()].sort((a, b) => a[0] - b[0]), [[3, 2], [7, 1]])
  // 内容顺序不变：主台账在前
  assert.equal(rows[0][1], '信物')
  assert.equal(rows[2][1], '新谜面')
})

test('mergeRows：增量行自己的编号不参与映射（它和主台账撞号也不能劫持引用）', () => {
  // 主台账两行，增量写了个 F001 想指自己——若增量编号进映射，
  // 卷纲里引用主台账 F001 的地方就会被改到增量那条上。
  const master = [
    ['F001', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收'],
    ['F002', '旧伤', '身份', '第5章', '', '', '', '', '李四', '支线', '未收'],
  ]
  const inc = [['F001', '新谜面', '事件', '第9章', '', '', '', '', '王五', '主线', '未收']]
  const { rows, remap } = mergeRows(master, inc)
  assert.deepEqual(rows.map((r) => r[0]), ['F001', 'F002', 'F003'])
  assert.equal(remap.get(1), 1, '主台账 F001 仍指向 F001，没被增量占走')
  assert.equal(remap.get(2), 2)
})

test('mergeRows：增量的新编号绝不进映射（用不撞号的编号验，撞号那版掩盖了问题）', () => {
  // 主台账只有 F001；增量自己写了 F050（不与主台账撞号）。
  // 若增量编号进了映射，remap 就会多出 50→2，产物里所有 F050 都会被批量改写成 F002——
  // 那是最坏的一种错：agent 随手写的号变成了引用目标。
  const master = [['F001', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收']]
  const inc = [['F050', '新谜面', '事件', '第9章', '', '', '', '', '王五', '主线', '未收']]
  const { remap } = mergeRows(master, inc)
  assert.deepEqual([...remap.keys()], [1], `增量编号不该进映射，实际映射键：${[...remap.keys()].join(',')}`)
  assert.equal(remap.has(50), false, 'F050 是增量自己写的号，不能成为映射源')
})

test('mergeRows：同一批增量合并两次不产生重复条目（幂等）', () => {
  const master = [['F001', '信物', '道具', '第2章', '', '', '', '', '张三', '主线', '未收']]
  const inc = [['', '新谜面', '事件', '第9章', '', '', '', '', '王五', '主线', '未收']]
  const first = mergeRows(master, inc)
  assert.equal(first.rows.length, 2)
  // 第二次：把第一次的结果当主台账，增量还是同一批
  const second = mergeRows(first.rows, inc)
  assert.equal(second.rows.length, 2, '重复的增量行应被跳过')
  assert.equal(second.dupSkipped, 1)
  assert.equal(second.added, 0)
})

test('rewriteRefs：改编号、不动别的、报告悬空', () => {
  const remap = new Map([[7, 1], [3, 2]])
  const r = rewriteRefs('埋 F007，收 F003；另见 F099。', remap)
  assert.equal(r.text, '埋 F001，收 F002；另见 F099。')
  assert.equal(r.changed, 2)
  assert.deepEqual(r.dangling, ['F099'], '台账里没有的编号要报悬空')
})

test('rewriteRefs：不误伤更长的编号与嵌入在词里的字母数字', () => {
  const remap = new Map([[1, 2]])
  // F010 不是 F01，不能被当成 F01+0 改；GARBAGE1F001 里嵌着的也不是引用
  assert.equal(rewriteRefs('F010 与 GARBAGE1F001', remap).text, 'F010 与 GARBAGE1F001')
  assert.equal(rewriteRefs('见 F001。', remap).text, '见 F002。')
})

test('splitTable：能找到表头并区分数据行与分隔行', () => {
  const text = `# 标题\n\n说明文字。\n\n${HEADER}\n${SEP}\n${row('F001', '信物')}\n`
  const p = splitTable(text)
  assert.ok(p)
  assert.deepEqual(p.header, COLUMNS.伏笔台账)
  assert.equal(p.rows.length, 1)
})

// ---------- 端到端 ----------

test('合并增量并重编号，全产物引用同步改写，无悬空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    makeBook(
      dir,
      [row('F007', '信物'), row('F003', '旧伤', '身份', '第5章')],
      { '工作/伏笔台账-卷1.md': [row('F003', '新谜面', '事件', '第9章')] },
    )
    // 卷纲与幕纲里写了旧编号
    const wfDir = join(dir, '故事底本', '故事剧情', '卷纲')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(join(wfDir, '卷01-全书.md'), '# 卷纲\n\n- 伏笔：埋 F007，回收 F003\n', 'utf8')
    const actDir = join(dir, '故事底本', '故事剧情', '幕纲')
    mkdirSync(actDir, { recursive: true })
    writeFileSync(join(actDir, '幕01-开局.md'), '# 幕纲\n\n- 埋 F003（新谜面）\n', 'utf8')

    const r = await mergeForeshadow({ root: dir })
    assert.equal(r.before, 2)
    assert.equal(r.after, 3, '两行主台账 + 一行增量')
    assert.equal(r.added, 1)
    // 主台账连续
    const ledger = readFileSync(join(dir, '故事底本', '故事剧情', '伏笔台账.md'), 'utf8')
    const ids = [...ledger.matchAll(/^\| (F\d+) \|/gm)].map((m) => m[1])
    assert.deepEqual(ids, ['F001', 'F002', 'F003'], `主台账编号应连续，实际 ${ids.join(',')}`)
    // 卷纲里 F007→F001（信物）、F003→F002（旧伤）
    const juan = readFileSync(join(wfDir, '卷01-全书.md'), 'utf8')
    assert.match(juan, /埋 F001，回收 F002/, `卷纲引用应改写，实际：${juan}`)
    // 幕纲里的 F003 也按主台账映射成 F002。增量那条（新谜面）自己的编号不进映射，
    // 所以它拿到的是新编号 F003，但没有任何引用指向它——这是有意的：
    // 增量编号是 agent 手排的，不可信，引用只认主台账。若日后要指新伏笔，
    // 应在合并后按新编号补引用，而不是让合并去猜。
    const mu = readFileSync(join(actDir, '幕01-开局.md'), 'utf8')
    assert.match(mu, /埋 F002（新谜面）/, `幕纲引用应按主台账改写，实际：${mu}`)
    assert.deepEqual(r.refs.dangling, [], '不该有悬空引用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('合并是幂等的：连跑两次条目与编号都不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    makeBook(dir, [row('F001', '信物')], { '工作/伏笔台账-卷1.md': [row('', '新谜面', '事件', '第9章')] })
    const first = await mergeForeshadow({ root: dir })
    const ledger1 = readFileSync(join(dir, '故事底本', '故事剧情', '伏笔台账.md'), 'utf8')
    const second = await mergeForeshadow({ root: dir })
    const ledger2 = readFileSync(join(dir, '故事底本', '故事剧情', '伏笔台账.md'), 'utf8')
    assert.equal(first.after, 2)
    assert.equal(second.after, 2, '第二次不该新增行')
    assert.equal(second.added, 0)
    assert.equal(second.dupSkipped, 1, '重复的增量行应被识别并跳过')
    assert.equal(ledger2, ledger1, '第二次合并不该改动台账文本')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('悬空引用被报告出来（台账里根本没有的编号）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    makeBook(dir, [row('F001', '信物')])
    const juanDir = join(dir, '故事底本', '故事剧情', '卷纲')
    mkdirSync(juanDir, { recursive: true })
    writeFileSync(join(juanDir, '卷01-全书.md'), '# 卷纲\n\n- 伏笔：埋 F099\n', 'utf8')
    const r = await mergeForeshadow({ root: dir })
    assert.deepEqual(r.refs.dangling, ['F099'], 'F099 不在台账里，应报悬空')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--dry-run 只报告不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    makeBook(dir, [row('F007', '信物')], { '工作/伏笔台账-卷1.md': [row('', '新谜面', '事件', '第9章')] })
    const ledgerPath = join(dir, '故事底本', '故事剧情', '伏笔台账.md')
    const before = readFileSync(ledgerPath, 'utf8')
    const r = await mergeForeshadow({ root: dir, dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.after, 2, '预演也要算出结果')
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '预演不得改文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 契约 ----------

test('契约白名单接受 工作/伏笔台账-卷N.md 与 工作/逐章记录-卷N.md', async () => {
  const { VARIABLE_FILE_RULES } = await import('../skills/book-breakdown/scripts/contract.mjs')
  const ok = ['工作/伏笔台账-卷1.md', '工作/伏笔台账-卷12.md', '工作/逐章记录-卷3.md']
  for (const rel of ok) {
    assert.ok(VARIABLE_FILE_RULES.some((re) => re.test(rel)), `${rel} 应被契约接受`)
  }
  const bad = ['工作/伏笔台账.md', '工作/伏笔台账-卷100.md', '工作/伏笔台账-x.md']
  for (const rel of bad) {
    assert.ok(!VARIABLE_FILE_RULES.some((re) => re.test(rel)), `${rel} 不该被契约接受`)
  }
  // productPlan 不把增量文件列成固定产物：它是「按卷可增删」的可变文件，
  // 列进固定产物会让每本书都必须存在 卷1..卷N 的增量。
  const plan = productPlan({ bookType: '网文' })
  const allFiles = [...(plan.files ?? []).map((f) => (typeof f === 'string' ? f : f.path ?? f.file ?? '')), ...(plan.dirs ?? [])]
  assert.ok(!allFiles.some((p) => String(p).includes('伏笔台账-卷')), '增量文件不该进固定产物清单')
})

// ---------- CLI ----------

function runScript(args) {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-cli-'))
  try {
    const outPath = join(dir, 'o.txt')
    const errPath = join(dir, 'e.txt')
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    // 直接取 spawnSync 的 stdout（本用例不需要文件描述符承接，与 cli.test.mjs 的沙箱约束不同）
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI：--json 输出可解析，成功时不报错', () => {
  withDir((dir) => {
    makeBook(dir, [row('F001', '信物')], { '工作/伏笔台账-卷1.md': [row('', '新谜面', '事件', '第9章')] })
    const r = runScript([dir, '--json'])
    assert.equal(r.status, 0, r.stderr)
    const obj = JSON.parse(r.stdout)
    assert.ok(obj.ok)
    assert.equal(obj.data.after, 2)
  })
})

test('CLI：缺产物目录参数退出 2；台账不存在退出 1', () => {
  const noArgs = runScript([])
  assert.equal(noArgs.status, 2, '缺参数应退出 2')
  withDir((dir) => {
    const r = runScript([dir])
    assert.equal(r.status, 1, '没有台账是业务失败 1')
    assert.match(r.stderr, /伏笔台账/)
  })
})

test('表头与契约不符时报 E_HEADER，不猜列序（猜错会把描述写进类型列）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    mkdirSync(join(dir, '故事底本', '故事剧情'), { recursive: true })
    mkdirSync(join(dir, '工作'), { recursive: true })
    // 少一列的表头
    const badHeader = `| ${COLUMNS.伏笔台账.slice(0, 8).join(' | ')} |`
    writeFileSync(
      join(dir, '故事底本', '故事剧情', '伏笔台账.md'),
      `# 伏笔台账\n\n${badHeader}\n| ${COLUMNS.伏笔台账.slice(0, 8).map(() => '---').join(' | ')} |\n| F001 | 信物 | 道具 | 第2章 | | | | |\n`,
      'utf8',
    )
    await assert.rejects(
      () => mergeForeshadow({ root: dir }),
      (e) => {
        assert.equal(e.code, 'E_HEADER')
        assert.match(e.message, new RegExp(`应为 ${COLUMNS.伏笔台账.length} 列`))
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('增量文件表头不符时也报 E_HEADER，点名是哪个文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreshadow-'))
  try {
    makeBook(dir, [row('F001', '信物')])
    const badHeader = `| ${COLUMNS.伏笔台账.slice(0, 5).join(' | ')} |`
    writeFileSync(
      join(dir, '工作', '伏笔台账-卷1.md'),
      `# 增量\n\n${badHeader}\n| ${COLUMNS.伏笔台账.slice(0, 5).map(() => '---').join(' | ')} |\n`,
      'utf8',
    )
    await assert.rejects(
      () => mergeForeshadow({ root: dir }),
      (e) => {
        assert.equal(e.code, 'E_HEADER')
        assert.match(e.message, /伏笔台账-卷1\.md/, '错误消息要点名是哪个增量文件')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
