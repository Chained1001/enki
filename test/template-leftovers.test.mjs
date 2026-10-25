// 模板系列三条遗留项（A-09 / B-07 / R-05）。
//
// 这三条是核查账里唯一还挂着的模板项，但账只写了「未落地 3」没写是哪 3 条。
// 逐条核实后确认就是这三条；测试把「要做到什么」钉住，免得下次又变成「看不见的 3」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const A = (n) => readFileSync(join(ROOT, 'skills', 'book-breakdown', 'assets', n), 'utf8')

test('A-09：文风模板有「商业外证」，且写明查不到时写什么', () => {
  const t = A('文风模板.md')
  assert.match(t, /##\s+商业外证/, '要有这一节')
  // 关键不是「有这一节」，而是「为空时写什么」——留空与没查在产物上一样
  assert.match(t, /无（本书无公开数据）/, '要给空值写法')
  assert.match(t, /来源/, '每条数据要带来源')
})

test('A-09：明写「留空与没查分不清」（这才是这条要防的事）', () => {
  const t = A('文风模板.md')
  assert.match(t, /留空|没查/, '要说明为什么不允许留空')
})

test('B-07：别名词典模板注明说明段不参与段名校验', () => {
  const t = A('别名词典模板.md')
  assert.match(t, /说明段不参与段名校验/, '要明写在文件头')
})

test('R-05：人物卡模板有「前四卷补全」回填结构', () => {
  const t = A('人物卡模板.md')
  assert.match(t, /前四卷补全/, '要有这一节')
  assert.match(t, /初始/, '要有初始列')
  assert.match(t, /变化/, '要有变化列')
  // 回填的判据是「只补变化的部分」，否则整卡重写等于把前四卷的活重做一遍
  assert.match(t, /只补/, '要写明只补变化的部分')
})

test('R-05：写明「不要把整本书读完再写卡」（回填的意义在这）', () => {
  const t = A('人物卡模板.md')
  assert.match(t, /不要把整本书读完|不要.*读完再写/, '要禁止全读后再写卡')
})

test('模板系列：核查账里 25 条都能找到证据（不留「看不见的 3」）', () => {
  // 这条是元测试：它不检查某个具体功能，而是检查「账本有没有和磁盘对上」。
  // 上一轮的教训就是账写「未落地 3」却不写是哪 3，于是没人能知道该做什么。
  const t = readFileSync(join(ROOT, 'docs', '研究', '改造清单落实核查.md'), 'utf8')
  const row = /\| 模板 A\/B\/C \| (\d+) \| (\d+) \| \*\*(\d+)\*\* \|/.exec(t)
  assert.ok(row, '账本要有模板系列这一行')
  const [, total, done, left] = row.map(Number)
  assert.equal(total, 25, '模板报告实有 25 条（A10 B7 C3 R5），不是 20')
  assert.equal(total - done, left, '未落地数要等于总数减已落地')
})
