// 快速模式三步（01 切章 / 02 摘要 / 03 要素）的口径纪律。
//
// 这两条（C-22、C-23）约束的都是文档，但文档约束的是 agent 的行为，
// 所以测试要断的是「文档里写没写这条指令」，而不是「代码里有没有这个函数」。
//
// 断言写具体短语而不是关键词：关键词（如「脚本」）在很多段落都出现，
// 断了也说明不了这一步真的要求了这件事。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WF = join(here, '..', 'skills', 'book-breakdown', 'workflows')
const read = (name) => readFileSync(join(WF, name), 'utf8')

// ---------- C-23：切章口径唯一 ----------

test('C-23：01 要求先跑 prepare --dry-run 取章节列表，不自己切', () => {
  const text = read('01-切章.md')
  assert.match(text, /prepare\.mjs[^\n]*--dry-run/, '01 必须让 agent 先跑 prepare --dry-run')
  assert.match(text, /章节列表/, '要说明脚本给出的是章节列表（不只是章数）')
  assert.match(text, /唯一/, '要写明这是唯一口径，否则 agent 会以为只是「参考一下」')
})

test('C-23：01 明确规定退出 1 才退回手切，退出 2 是参数错', () => {
  const text = read('01-切章.md')
  // 这两个退出码含义不能混：把参数错当成「结构不支持」去手切，是最常见的误用
  assert.match(text, /退出[码 ]*1[^\n]{0,40}手切|退出 1 才退回手切/, '要说清退出 1 才是结构不支持')
  assert.match(text, /退出[码 ]*2[^\n]{0,30}参数错|退出码 2 是参数错/, '要说清退出 2 是参数错，不是改用手的理由')
})

test('C-23：01 不再把判据文档当作常规步骤（那是手切时才读的）', () => {
  const text = read('01-切章.md')
  // 参考表里的「读取时机」必须限定在手切场景；写成「第 2 步前」会让人觉得常规流程也要读判据
  const table = text.slice(text.indexOf('## 参考'))
  assert.match(table, /手切/, '参考表的读取时机要限定为「手切时」')
})

test('C-23：prepare --dry-run 真的返回章节列表（文档与实现对得上）', async () => {
  const { analyze, persist } = await import('../skills/book-breakdown/scripts/prepare.mjs')
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'c23-'))
  try {
    const src = join(dir, '书.txt')
    const body = Array.from({ length: 5 }, (_, i) => `第${i + 1}章 标题${i + 1}\n正文内容一二三四五六七八九十。`).join('\n')
    await writeFile(src, `书名\n\n${body}\n`, 'utf8')
    const r = await persist(await analyze({ input: src, out: join(dir, '产物') }), { dryRun: true })
    assert.equal(r.action, 'dry-run')
    assert.ok(Array.isArray(r.chapters), 'dry-run 必须返回 chapters 数组——文档让 agent 靠它取列表')
    assert.equal(r.chapters.length, r.chapterCount, 'chapters 长度要与 chapterCount 一致')
    assert.deepEqual(Object.keys(r.chapters[0]).sort(), ['chars', 'no', 'title'], '只给序号/标题/字数，不给正文')
    // 第 0 章是前言（书名行），这是契约里合法的编号，不是错。
    assert.equal(r.chapters[0].no, 0, '书名的前言行记为第 0 章')
    assert.equal(r.chapters[1].no, 1)
    assert.match(r.chapters[1].title, /标题1/, '标题要能认出来')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- C-22：三步共用一次通读 ----------

test('C-22：02 与 03 都写明与对方共用同一次通读', () => {
  for (const [name, other] of [['02-摘要.md', '03'], ['03-要素.md', '02']]) {
    const text = read(name)
    assert.match(text, new RegExp(`与 ${other}[^\\n]*共用同一次`), `${name} 要写明与 ${other} 共用一次通读`)
    assert.match(text, /一批/, `${name} 要给出分批口径，否则「一次通读」在长书上无法执行`)
  }
})

test('C-22：文档里不再出现「各自读一遍」的指令', () => {
  // 02 原先写「逐章读正文」，03 原先写「逐章抽取」，两句各自成立，合起来就是读两遍。
  const t02 = read('02-摘要.md')
  const t03 = read('03-要素.md')
  assert.ok(!/^1\. 逐章读正文/m.test(t02), '02 的第一步不该是「逐章读正文」——那会与 03 各读一遍')
  assert.ok(!/^1\. 按[^\n]*逐章抽取/m.test(t03), '03 的第一步不该是「逐章抽取」——同一件事要合并在一次读入里')
})

test('C-22：01 的 dry-run 不读正文（否则「合并读入」省不出东西）', () => {
  const text = read('01-切章.md')
  assert.match(text, /不落盘/, '01 要写明 dry-run 不落盘')
  // dry-run 若读全书正文，那 01 就已经读了一遍，02、03 合并也省不下
  assert.match(text, /不读正文|只打印/, '要说明 dry-run 只做切章判定，不把正文读进来')
})
