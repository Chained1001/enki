// 防的漂移：判据写了数字而契约里没有对应的键（或反过来），以及「靠感觉」的判据退回主观。
// 背景：2026-10-25 审查实测——主次判定 J-01 写着「视角章占比 ≥15%」，contract.mjs 里没有这个键；
// 幕边界 J-05「主角缺席章聚集」零阈值（连续几章？占比多少？），等于不可判定。
// 本文件的用例把「判据里的数字必须能在契约里找到同值」这条锁住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { THRESHOLDS } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const refDir = join(here, '..', 'skills', 'book-breakdown', 'references')
const read = (f) => readFileSync(join(refDir, f), 'utf8')

test('主次判定 J-01 的 15% 阈值有契约键，且判据文本指向它', () => {
  assert.equal(THRESHOLDS.主角视角章占比, 0.15)
  const t = read('主次判定判据.md')
  assert.match(t, /视角章占比\s*≥15%/, 'J-01 的措辞应保留 15%')
  assert.match(t, /主角视角章占比/, '判据须点名契约里的键，否则读的人不知道去哪核对')
})

test('主次判定：J-09 已并入 J-01，不再有两条写同一件事', () => {
  const t = read('主次判定判据.md')
  assert.ok(!/^\|\s*J-09\s*\|/m.test(t), 'J-09 的短书规则应并入 J-01，不另立一行')
  assert.match(t, /短书（`chapterCount < 30`）/, '并入后短书规则仍须可见')
})

test('主次判定：判定顺序写在正文，且顺序与 C4 裁决一致（J-08 在 J-02/J-03 之后）', () => {
  const t = read('主次判定判据.md')
  const m = /判定顺序[^\n]*/.exec(t)
  assert.ok(m, '须有明确的判定顺序声明')
  const line = m[0]
  // C4 裁决：先 J-01 定主角，J-03/J-02 定配角，J-08 处理边缘带，最后 J-05 功能位修正
  const order = ['J-04', 'J-07', 'J-01', 'J-03', 'J-02', 'J-08', 'J-05']
  let last = -1
  for (const id of order) {
    const at = line.indexOf(id)
    assert.ok(at >= 0, `判定顺序须含 ${id}`)
    assert.ok(at > last, `判定顺序里 ${id} 的位置不对：应在前一条之后`)
    last = at
  }
})

test('主次判定 J-05 与 J-07 不再自标「主观判断」，各有可查锚点', () => {
  const t = read('主次判定判据.md')
  const j05 = /^\|\s*J-05\s*\|(.*)$/m.exec(t)
  const j07 = /^\|\s*J-07\s*\|(.*)$/m.exec(t)
  assert.ok(j05 && j07)
  assert.ok(!/主观判断/.test(j05[1]), 'J-05 应拆成两个可判子项，不再写「主观判断」')
  assert.ok(!/主观判断/.test(j07[1]), 'J-07 应给出「首现章区间不重叠＋身份字段不等」两条锚点')
  assert.match(j07[1], /身份字段/, 'J-07 的锚点须落成可比对的字段')
})

test('幕边界 J-05 有阈值常量，且常量值等于判据文本写的数', () => {
  assert.equal(THRESHOLDS.主角缺席聚集章数, 8)
  const t = read('幕边界判据.md')
  const row = /^\|\s*J-05\s*\|(.*)$/m.exec(t)
  assert.ok(row, 'J-05 行须存在')
  // 只看该行自身的强度列：必须写出具体数字，只写「聚集段」等于零阈值。
  const cells = row[1].split('|').map((c) => c.trim())
  const strength = cells[1] ?? ''
  assert.match(strength, /≥\s*8\s*章/, `J-05 的强度列须写明「≥8 章」，实际是「${strength}」`)
  assert.match(strength, /主角缺席聚集章数/, 'J-05 须点名契约键，否则读的人不知道去哪核对')
})

test('幕边界 J-02 的五拍各有锚点特征（不再靠「这一章属于哪一拍」的感觉）', () => {
  const t = read('幕边界判据.md')
  assert.match(t, /## 五拍锚点特征/, '须有五拍锚点表')
  for (const beat of ['发现', '筹备', '反转', '爆发', '结算']) {
    assert.match(t, new RegExp(`\\|\\s*${beat}\\s*\\|`), `五拍锚点表缺「${beat}」`)
  }
  assert.match(t, /行赏|封官|战后总结/, '结算拍的锚点须是具体的宣告类特征词')
})

test('章节识别 J-03 的长度与契约阈值一致，且区分「识别」与「存储」两个概念', () => {
  assert.equal(THRESHOLDS.标题行字符上限, 100)
  assert.equal(THRESHOLDS.标题存储字符上限, 40)
  const t = read('章节识别.md')
  assert.match(t, /不超过\s*100\s*字/, 'J-03 应写识别阈值 100，不是存储截断 40')
  assert.ok(!/不超过\s*40\s*字/.test(t), 'J-03 不应再写 40')
  assert.match(t, /存储截断/, '须说明 40 是存储截断，避免下次又混成一个数')
  assert.match(t, /标题行字符上限/, '须点名契约键')
})

test('逆用写作法（S-06）有降权句：自查题只可用于发现，不可用于判定', () => {
  const t = read('拆解总策略.md')
  const row = /^\|\s*S-06\s*\|(.*)$/m.exec(t)
  assert.ok(row, 'S-06 行须存在')
  assert.match(row[1], /只可用于发现问题/, 'S-06 须含降权句')
  assert.match(row[1], /不可用于判定结论/, '降权句须写清不能做什么，只写「可以做」等于没降权')
})

test('金手指 J-01 是记录句，不是必然句；J-04 有可查锚点', () => {
  const t = read('金手指判据.md')
  const j01 = /^\|\s*J-01\s*\|(.*)$/m.exec(t)
  assert.ok(j01)
  assert.ok(!/每本书必有金手指/.test(j01[1]), '「必有」不可证伪，须改成记录句')
  assert.match(j01[1], /章区间/, '判「无」时须写明核对过的章区间')
  const j04 = /^\|\s*J-04\s*\|(.*)$/m.exec(t)
  assert.match(j04[1], /前世|上一世/, 'J-04 须给「出现即入候选」的字样锚点')
})

test('金句锚（S-09）不再评价优劣，改为记录被重复引用的句子', () => {
  const t = read('人物提炼策略.md')
  const row = /^\|\s*S-09\s*\|(.*)$/m.exec(t)
  assert.ok(row)
  assert.match(row[1], /不评价优劣/, '须明写不评价')
  // 「优于」允许出现在「原判据说过 X 优于 Y，已删」这种引述+否定的语境里，
  // 不允许作为**现行要求**出现。判据是「动作列里有没有把它写成该做的事」：
  // 把引述部分（含「已删」「不是判定依据」「写作建议」的句子）剥掉后，不应再有「优于」。
  const action = row[1].split('|')[2] ?? ''
  const stripped = action
    .split(/[——。；]/)
    .filter((seg) => !/已删|不是判定依据|写作建议|原判据/.test(seg))
    .join('')
  assert.ok(!/优于/.test(stripped), `动作列里仍有评价性表述「优于」：${stripped.trim()}`)
})

test('幕与节奏 E-06 的依据只指向幕边界判据，不误指主次判定 J-05', () => {
  const t = read('幕与节奏策略.md')
  const line = /- E-06：([^\n]*)/.exec(t)
  assert.ok(line)
  assert.ok(!/主次判定判据 J-05\//.test(line[1]), 'E-06 曾误指主次判定 J-05，须删去')
  assert.match(line[1], /幕边界判据 J-05/, '应只留幕边界判据 J-05')
})
