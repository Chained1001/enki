// 文档里写的过程路径，必须是契约（VARIABLE_FILE_RULES）接受的路径。
//
// 反例：06 曾写「工作/增量/装置-初版.md」，跑完必报 E_TREE_EXTRA；
// 07 曾把伏笔片段写成「工作/增量/伏笔台账-卷N」，而 merge-foreshadow 只认
// 「工作/伏笔台账-卷N.md」——脚本静默找不到增量，比报错更难查。
//
// 这个测试只做一件事：把文档当输入，把契约当判据。它不判断「哪个阶段该写哪个路径」
// （那是 flow-discipline.test.mjs 的事），只判断「写出来的路径，校验器认不认」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productPlan, VARIABLE_FILE_RULES } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const WF = join(ROOT, 'skills', 'book-breakdown', 'workflows')
const PRD = join(ROOT, 'docs', '产品', 'PRD.md')
const FIXED = new Set(productPlan().files)

// 文档用 N / NN 表示占位，契约用 \d；比较前先物化成一个具体值。
// 顺序不能反：先 NN 再 N，否则 NN 会被拆成「N1」。
const materialize = (p) => p.replace(/NN/g, '01').replace(/N/g, '1')

// 路径在文档里有三种写法：反引号、直角引号「」、裸写；mermaid 里还可能用 <br/> 连写。
// 统一按「工作/ 开头 + 非空白/非引号/非尖括号」抓取，再去掉句读、跳过目录（以 / 结尾）。
const processPaths = (text) =>
  [...text.matchAll(/(工作\/[^\s`」<>]+)/g)]
    .map((m) => m[1].replace(/[。，、；：]+$/, ''))
    .filter((p) => !p.endsWith('/'))

const accepts = (p) => FIXED.has(p) || VARIABLE_FILE_RULES.some((r) => r.test(materialize(p)))

const rejects = (text, label) => {
  const paths = processPaths(text)
  assert.ok(paths.length > 0, `${label} 至少要写一个过程路径，否则这条检查是空的`)
  return paths.filter((p) => !accepts(p))
}

for (const name of ['06-口径锚定.md', '07-卷循环.md', '08-设定库.md', '09-全书层.md', '10-校验交付.md']) {
  test(`${name} 里的每个过程路径都通过契约`, () => {
    const rejected = rejects(readFileSync(join(WF, name), 'utf8'), name)
    assert.deepEqual(rejected, [], `${name} 写了契约拒绝的路径：${rejected.join('、')}`)
  })
}

test('PRD 里的每个过程路径都通过契约', () => {
  const rejected = rejects(readFileSync(PRD, 'utf8'), 'PRD')
  assert.deepEqual(rejected, [], `PRD 写了契约拒绝的路径：${rejected.join('、')}`)
})

// 交付目录里的模板也会被 agent 照抄，不能只扫 workflows。
test('assets/ 与 SKILL.md 里的过程路径（若有）都通过契约', () => {
  const files = [
    ...readdirSync(join(ROOT, 'skills', 'book-breakdown', 'assets'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => join(ROOT, 'skills', 'book-breakdown', 'assets', n)),
    join(ROOT, 'skills', 'book-breakdown', 'SKILL.md'),
  ]
  for (const file of files) {
    const paths = processPaths(readFileSync(file, 'utf8'))
    if (paths.length === 0) continue
    const rejected = paths.filter((p) => !accepts(p))
    assert.deepEqual(rejected, [], `${file} 写了契约拒绝的路径：${rejected.join('、')}`)
  }
})

// 07:107 曾整段论证「统一到工作/增量/」，与 105 的「工作/ 顶层」正面冲突。
test('07 不再把分卷片段写进 工作/增量/', () => {
  const t = readFileSync(join(WF, '07-卷循环.md'), 'utf8')
  assert.ok(!/工作\/增量\/(逐章记录|伏笔台账|别名)-卷N/.test(t), '分卷片段不能写成 工作/增量/')
  assert.ok(!/统一到「工作\/增量\/」/.test(t), '解释段不能还在论证「统一到 工作/增量/」')
})

// 白名单一旦被放宽（比如 /^工作\//），上面的正向测试仍会绿；这组反例是闸门。
test('旧路径必须被契约拒绝（防止白名单放宽）', () => {
  const legacy = [
    '工作/增量/装置-初版.md',
    '工作/增量/装置-回填-卷1.md',
    '工作/增量/逐章记录-卷1.md',
    '工作/伏笔台账-卷1',
    '工作/别名词典',
  ]
  for (const p of legacy) assert.equal(accepts(p), false, `${p} 不该被接受`)
})

// 只断言「所有路径都过契约」不够：把关键路径删掉，测试仍会绿。
test('关键路径在各文档里在场', () => {
  const wf = (n) => processPaths(readFileSync(join(WF, n), 'utf8'))
  assert.ok(wf('08-设定库.md').includes('工作/别名词典.md'), '08 要写 工作/别名词典.md')
  assert.ok(wf('10-校验交付.md').includes('工作/增量/裁决.json'), '10 要写 工作/增量/裁决.json')
  const prd = processPaths(readFileSync(PRD, 'utf8'))
  assert.ok(prd.includes('工作/伏笔台账-卷1.md'), 'PRD 的 mermaid 要写 工作/伏笔台账-卷1.md')
  assert.ok(prd.includes('工作/逐章记录-卷N.md'), 'PRD 的阶段 4 要写 工作/逐章记录-卷N.md')
})

// assets 扫描在「无路径」时 continue，删掉唯一一条路径仍会绿；这条钉住它。
test('人物索引模板引用的别名词典路径带 .md', () => {
  const t = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'assets', '人物索引模板.md'), 'utf8')
  assert.match(t, /工作\/别名词典\.md/)
})
