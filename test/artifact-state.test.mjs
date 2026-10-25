// 产物文件状态纪律（C-20、C-24）。
//
// 这两条约束的是同一件事的两端：
//   prepare 建骨架时把每个文件记成 skeleton，此后必须有地方把它改成 filled。
//   没有这个入口时，manifest.files 必然过期——而流程里「回填前先看填没填」
//   「中断后这一幕写完没」都依赖它。
//
// 测试分两部分：脚本能力（progress 能读能写）与流程指令（文档真的调用了它）。
// 只测脚本不测文档，会出现「能力有了但没人用」——C-04 实现了 --file，
// 而 06/07 一次都没调用，就是这种状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const WF = join(ROOT, 'skills', 'book-breakdown', 'workflows')
const readWf = (name) => readFileSync(join(WF, name), 'utf8')

// ---------- 脚本能力 ----------

test('C-24：queryProgress 返回文件状态（否则流程只能自己去翻 manifest）', async () => {
  const { queryProgress } = await import('../skills/book-breakdown/scripts/progress.mjs')
  const r = queryProgress({
    book: '测试书',
    bookType: '网文',
    stages: [],
    batches: [],
    files: { '故事底本/故事剧情/全书大纲.md': 'skeleton', '故事底本/文风.md': 'filled' },
  })
  assert.ok(r.files, 'queryProgress 必须带 files')
  assert.equal(r.files['故事底本/故事剧情/全书大纲.md'], 'skeleton')
  assert.equal(r.files['故事底本/文风.md'], 'filled')
})

test('C-24：queryProgress 在 manifest 没有 files 键时给空对象，不抛', async () => {
  // 旧 manifest（0.2 时代）没有 files 键。这里崩了，读状态这件事就做不成。
  const { queryProgress } = await import('../skills/book-breakdown/scripts/progress.mjs')
  const r = queryProgress({ book: '老书', bookType: '网文', stages: [], batches: [] })
  assert.deepEqual(r.files, {})
})

test('C-24：--file-state 打印指定文件的状态，未登记时明说而不是留空', async () => {
  const { execFileSync } = await import('node:child_process')
  const fixture = join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解')
  const out = execFileSync('node', [
    'skills/book-breakdown/scripts/progress.mjs', fixture,
    '--file-state', '故事底本/故事剧情/全书大纲.md',
    '--file-state', '故事底本/不存在的文件.md',
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, /全书大纲\.md：skeleton/, '已登记的骨架文件应报 skeleton')
  assert.match(out, /不存在的文件\.md：未登记/, '未登记要明说，留空会让人以为状态是空字符串')
})

test('--file-state 反斜杠路径也认（Windows 用户会随手打反斜杠）', async () => {
  const { execFileSync } = await import('node:child_process')
  const fixture = join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解')
  const out = execFileSync('node', [
    'skills/book-breakdown/scripts/progress.mjs', fixture,
    '--file-state', '故事底本\\故事剧情\\全书大纲.md',
  ], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, /全书大纲\.md：skeleton/, '反斜杠要归一成正斜杠再查，否则 Windows 上永远查不到')
})

// ---------- 流程指令 ----------

test('C-24：06 结束时同时标阶段与全书大纲文件', () => {
  const text = readWf('06-口径锚定.md')
  assert.match(text, /--stage 3:done/, '阶段要标')
  assert.match(text, /--file 故事底本\/故事剧情\/全书大纲\.md:filled/, '文件状态也要标')
  // 只说「标阶段」会让人以为标完就够了——那正是原来的写法
  assert.match(text, /标阶段不等于标文件|两件事都要做/, '要写明这两件事不是一回事')
})

test('C-20：07 写幕纲/卷纲后标 filled', () => {
  const text = readWf('07-卷循环.md')
  assert.match(text, /幕纲\/[^\s:]*:filled|--file 故事底本\/故事剧情\/幕纲/, '幕纲成稿要标 filled')
  assert.match(text, /卷纲\/[^\s:]*:filled|卷纲\/卷01[^\s:]*:filled/, '卷纲成稿要标 filled')
})

test('C-24：07 回填装置段前先读状态（读的是 --file-state，不是猜）', () => {
  const text = readWf('07-卷循环.md')
  assert.match(text, /--file-state 故事底本\/故事剧情\/全书大纲\.md/, '要真的调用 --file-state')
  assert.ok(!/--show/.test(text), '不能写不存在的参数——文档里一个假参数，agent 就会照着跑到报错')
  // 两个分支都要在：骨架态可以直接覆盖，成稿态覆盖就是毁掉已有内容
  assert.match(text, /skeleton/, '要写 skeleton 分支怎么办')
  assert.match(text, /filled/, '要写 filled 分支怎么办')
})

test('文档里出现的 progress 参数都真实存在（防止再写假参数）', async () => {
  // --show 那种笔误不是个例：文档是 agent 唯一的执行依据，写一个不存在的参数
  // 会让它在实践中直接报错，然后自行发挥。这条把「文档提到的参数」与
  // 「解析器接受的参数」对齐。
  const { parseArgs } = await import('../skills/book-breakdown/scripts/progress.mjs')
  const known = new Set(['--batch-done', '--stage', '--file', '--file-state', '--resync-files', '--json', '--help'])
  for (const name of ['06-口径锚定.md', '07-卷循环.md']) {
    const text = readWf(name)
    const used = new Set()
    for (const m of text.matchAll(/progress\.mjs[^\n`]*/g)) {
      for (const a of m[0].matchAll(/(--[a-z-]+)/g)) used.add(a[1])
    }
    for (const a of used) {
      assert.ok(known.has(a), `${name} 用了不存在的 progress 参数 ${a}`)
    }
  }
  // 反向：确认解析器真的认 --file-state（文档与实现对得上）
  const opts = parseArgs(['某目录', '--file-state', 'a/b.md'])
  assert.deepEqual(opts.fileState, ['a/b.md'])
})
