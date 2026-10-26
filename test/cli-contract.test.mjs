// P2-3a：CLI 契约收口（规范 02「接口」）。
//
// 三条可观测契约：
//   ① --help 打印用法（stdout 含「用法」）并以 0 退出；
//   ② 未知参数打中文错误（stderr 含「未知参数」）并以 2 退出，不再静默忽略；
//   ③ 声明了 --json 的命令只输出一个对象，至少含 ok / errors / data 三键。
//
// 只列有 CLI 入口的脚本：contract.mjs 与 io.mjs 是被 import 的纯模块，参数在
// `node contract.mjs --bogus` 下压根没有被读取过（退出 0 是「没跑」，不是「契约通过」），
// 把它们写进契约测试只会制造假绿灯。validate-output.mjs 由 P2-3b 继续拆，但现有入口
// 已满足本契约，一并锁住，防止拆分时回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableColumns } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const SKILL = join(ROOT, 'skills', 'book-breakdown', 'scripts')
const REPO = join(ROOT, 'scripts')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解')

// 顺序即报告顺序：技能脚本在前，仓库级脚本在后。
const CLI = [
  ['cost', join(SKILL, 'cost.mjs')],
  ['entity-index', join(SKILL, 'entity-index.mjs')],
  ['merge-foreshadow', join(SKILL, 'merge-foreshadow.mjs')],
  ['prepare', join(SKILL, 'prepare.mjs')],
  ['progress', join(SKILL, 'progress.mjs')],
  ['quote-finder', join(SKILL, 'quote-finder.mjs')],
  ['reconcile', join(SKILL, 'reconcile.mjs')],
  ['reference-index', join(SKILL, 'reference-index.mjs')],
  ['validate-output', join(SKILL, 'validate-output.mjs')],
  ['verify-quotes', join(SKILL, 'verify-quotes.mjs')],
  ['volume-stats', join(SKILL, 'volume-stats.mjs')],
  ['write-rows', join(SKILL, 'write-rows.mjs')],
  ['docs-check', join(REPO, 'docs-check.mjs')],
  ['init-skill', join(REPO, 'init-skill.mjs')],
  ['install-hooks', join(REPO, 'install-hooks.mjs')],
  ['validate', join(REPO, 'validate.mjs')],
]

// 用 execFileSync(process.execPath, …) 而不是裸 'node'：测试进程与子进程必须是同一个运行时，
// 否则 PATH 上的 node 版本不同会把「Node 24 才有的行为」测成另一套结果。
function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    if (typeof error.status !== 'number') throw error
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

// 三键外壳的公共断言。ok 为 true 时 errors 必须为空；失败项若给出，须能指认原因。
// allowWarnings 给 validate-output：它在 ok=true 时把 warning 也放进了 errors 数组，
// 那是 P2-3b 要拆的旧形态，本测试只锁三键，不在这里替它改语义。
function assertEnvelope(result, name, { allowWarnings = false } = {}) {
  const obj = JSON.parse(result.stdout)
  assert.equal(typeof obj, 'object', `${name} --json 的 stdout 应是单个对象`)
  assert.ok(!Array.isArray(obj), `${name} --json 的 stdout 不应是数组`)
  for (const key of ['ok', 'errors', 'data']) {
    assert.ok(key in obj, `${name} --json 缺「${key}」键：${result.stdout.slice(0, 200)}`)
  }
  assert.ok(Array.isArray(obj.errors), `${name} --json 的 errors 应是数组`)
  if (obj.ok === true && !allowWarnings) assert.deepEqual(obj.errors, [], `${name} --json 成功时 errors 应为空`)
  for (const item of obj.errors) {
    assert.equal(typeof item.code, 'string', `${name} --json 的 errors 项缺 code`)
    assert.equal(typeof item.message, 'string', `${name} --json 的 errors 项缺 message`)
  }
  return obj
}

function makeTmp(tag) {
  return mkdtempSync(join(tmpdir(), `enki-cli-${tag}-`))
}

function writeManifest(dir) {
  mkdirSync(join(dir, '工作'), { recursive: true })
  writeFileSync(join(dir, '工作', 'manifest.json'), JSON.stringify({
    chapterCount: 1,
    volumes: [],
    chapters: [{ no: 1, title: '第一章', chars: 100, file: '0001-第一章.txt' }],
  }))
}

// 造一张一行的逐章记录：表头逐字取自 contract，避免测试自己维护另一份列名。
function writeChapterTable(dir) {
  const cols = tableColumns('逐章记录')
  const row = cols.map(() => '（待填）')
  const put = (name, value) => { row[cols.indexOf(name)] = value }
  put('全局章号', '1')
  put('标题（清洗后）', '第一章')
  put('章字数', '100')
  put('视角人物', '甲')
  put('地点', '车站')
  put('出场人物', '甲')
  put('一句话事件', '甲到站')
  put('剧情线', '主线')
  put('伏笔埋/收', '无')
  put('情绪', '扬')
  put('章末钩型', '危机')
  put('爽点强度', '大')
  put('爽点类型', '逆袭')
  put('故事内时间', '当日')
  put('章首句', '车站')
  const lines = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    `| ${row.join(' | ')} |`,
    '',
  ]
  mkdirSync(join(dir, '工作'), { recursive: true })
  writeFileSync(join(dir, '工作', '逐章记录.md'), lines.join('\n'), 'utf8')
}

// ---------- ① --help 退 0 且 stdout 含「用法」 ----------

for (const [name, script] of CLI) {
  test(`--help：${name} 退出 0 且 stdout 含「用法」`, () => {
    const r = run(script, ['--help'])
    assert.equal(r.status, 0, `${name} --help 应退出 0，实际 ${r.status}；stderr=${r.stderr}`)
    assert.match(r.stdout, /用法/, `${name} --help 的 stdout 应含「用法」，实际：${r.stdout.slice(0, 200)}`)
  })
}

// ---------- ② 未知参数退 2 且 stderr 含「未知参数」 ----------

for (const [name, script] of CLI) {
  test(`未知参数：${name} 退出 2 且 stderr 含「未知参数」`, () => {
    const r = run(script, ['--bogus'])
    assert.equal(r.status, 2, `${name} --bogus 应退出 2，实际 ${r.status}；stdout=${r.stdout}`)
    assert.match(r.stderr, /未知参数/, `${name} --bogus 的 stderr 应点名未知参数，实际：${r.stderr.slice(0, 200)}`)
  })
}

// ---------- ③ 声明 --json 的命令输出 { ok, errors, data } ----------

test('--json：cost 成功输出三键对象，data 保留原字段', () => {
  const dir = makeTmp('cost')
  try {
    writeManifest(dir)
    const r = run(join(SKILL, 'cost.mjs'), [dir, '--report', '--json'])
    assert.equal(r.status, 0, r.stderr)
    const obj = assertEnvelope(r, 'cost')
    assert.equal(obj.ok, true)
    assert.ok(obj.data.下界, 'data 应保留原「下界」字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：write-rows 业务失败也输出三键对象', () => {
  const dir = makeTmp('write-rows')
  try {
    const r = run(join(SKILL, 'write-rows.mjs'), [dir, '--rows', join(dir, 'rows.json'), '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'write-rows')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_FILE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：entity-index 成功输出三键对象，data 保留原 payload', () => {
  const dir = makeTmp('entity-index')
  try {
    writeChapterTable(dir)
    const r = run(join(SKILL, 'entity-index.mjs'), [dir, '--json'])
    assert.equal(r.status, 0, r.stderr)
    const obj = assertEnvelope(r, 'entity-index')
    assert.equal(obj.ok, true)
    assert.equal(obj.data.实体数, 2, 'data 里应保留原「实体数」字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：merge-foreshadow 业务失败输出三键对象', () => {
  const dir = makeTmp('merge-foreshadow')
  try {
    const r = run(join(SKILL, 'merge-foreshadow.mjs'), [dir, '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'merge-foreshadow')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_LEDGER')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：prepare 业务失败输出三键对象', () => {
  const dir = makeTmp('prepare')
  try {
    const r = run(join(SKILL, 'prepare.mjs'), [join(dir, '不存在.txt'), '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'prepare')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_INPUT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：progress 业务失败输出三键对象', () => {
  const dir = makeTmp('progress')
  try {
    const r = run(join(SKILL, 'progress.mjs'), [dir, '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'progress')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_MANIFEST')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：quote-finder 成功输出三键对象，data 保留原字段', () => {
  const r = run(join(SKILL, 'quote-finder.mjs'), [FIXTURE, '--entity', '李四', '--chapters', '1,2', '--json'])
  assert.equal(r.status, 0, r.stderr)
  const obj = assertEnvelope(r, 'quote-finder')
  assert.equal(obj.ok, true)
  assert.equal(obj.data.实体, '李四')
})

test('--json：reconcile 业务失败输出三键对象', () => {
  const dir = makeTmp('reconcile')
  try {
    const r = run(join(SKILL, 'reconcile.mjs'), [join(dir, '报告.md'), '--source', join(dir, '书.txt'), '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'reconcile')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_FILE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：validate-output 成功输出三键对象', () => {
  const r = run(join(SKILL, 'validate-output.mjs'), ['--json', '--mode', 'progress', FIXTURE])
  assert.equal(r.status, 0, r.stderr)
  const obj = assertEnvelope(r, 'validate-output', { allowWarnings: true })
  assert.equal(obj.ok, true)
})

test('--json：verify-quotes 业务失败输出三键对象', () => {
  const dir = makeTmp('verify-quotes')
  try {
    const r = run(join(SKILL, 'verify-quotes.mjs'), [dir, '--json'])
    assert.equal(r.status, 3, r.stderr)
    const obj = assertEnvelope(r, 'verify-quotes')
    assert.equal(obj.ok, false)
    assert.ok(obj.errors.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：volume-stats 成功输出三键对象，data 保留原 stats 字段', () => {
  const dir = makeTmp('volume-stats')
  try {
    writeChapterTable(dir)
    const r = run(join(SKILL, 'volume-stats.mjs'), [dir, '--json'])
    assert.equal(r.status, 0, r.stderr)
    const obj = assertEnvelope(r, 'volume-stats')
    assert.equal(obj.ok, true)
    assert.equal(obj.data.perVolume[0].sharpChapters, 1, 'data 里应保留原 perVolume 字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：init-skill 成功输出三键对象', () => {
  const dir = makeTmp('init-skill')
  try {
    const r = run(join(REPO, 'init-skill.mjs'), ['demo-skill', '--root', dir, '--dry-run', '--json'])
    assert.equal(r.status, 0, r.stderr)
    const obj = assertEnvelope(r, 'init-skill')
    assert.equal(obj.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：install-hooks 业务失败输出三键对象', () => {
  const dir = makeTmp('install-hooks')
  try {
    const r = run(join(REPO, 'install-hooks.mjs'), [dir, '--json'])
    assert.equal(r.status, 1, r.stderr)
    const obj = assertEnvelope(r, 'install-hooks')
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_HOOK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：validate 成功输出三键对象', () => {
  const r = run(join(REPO, 'validate.mjs'), ['--json', join(ROOT, 'test', 'fixtures', 'valid')])
  assert.equal(r.status, 0, r.stderr)
  const obj = assertEnvelope(r, 'validate')
  assert.equal(obj.ok, true)
})
