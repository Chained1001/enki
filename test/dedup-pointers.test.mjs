// M-15：重复事实各留一处正文，其余改指针。
//
// 这条最容易写成「数出现次数」——但一个概念在「核心卡、判据表、模板取值、错法表」里
// 各出现一次是正常的，那不是重复事实，是同一事实的不同用途。
// 真正的重复是「同一段说明文字被抄了两遍」，所以判据要落在**句子层面**：
// 同一句定义式的话不得在文件里出现两次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const R = (n) => readFileSync(join(ROOT, 'skills', 'book-breakdown', 'references', n), 'utf8')

test('M-15：核心卡与其下正文不重复同一句话（摘要讲结论、正文讲怎么做）', () => {
  const t = R('设定提炼策略.md')
  // 这句曾在「核心卡」与「这一节要解决的底层意图」里各出现一次
  const sentence = '动笔前先定3-5条绝对不能打破的铁则，这就是世界观的宪法'
  const count = t.split(sentence).length - 1
  assert.ok(count <= 1, `同一句定义式出现在 ${count} 处，应只留核心卡一处`)
})

test('M-15：核心卡仍然保留铁则判据（去重不能把判据也删掉）', () => {
  const t = R('设定提炼策略.md')
  assert.match(t, /我定了3-5条绝对不能打破的铁则吗/, '§3.1 核心卡判据要还在')
})

test('M-15：§3.6 的判据改为指针，不重复 §3.1 的判据', () => {
  const t = R('设定提炼策略.md')
  assert.match(t, /判据见 §3\.1 核心卡|定铁则的判据见/, '§3.6 要指向 §3.1，而不是再问一遍同一句')
})

test('M-15：五拍、钝收、三幕这些概念的定义留在概念辞典，别处只给指针或判据', () => {
  const dict = R('拆书概念辞典.md')
  assert.match(dict, /\| K-08 \| 五拍 \|/, '五拍定义在 K-08')
  assert.match(dict, /\| K-12 \| 钝收 \|/, '钝收定义在 K-12')
  assert.match(dict, /\| K-01 \| 三幕结构 \|/, '三幕定义在 K-01')

  // 反方向：别处若整句重述定义，就会与辞典漂开。判据是「同一句定义式」不重复。
  const repeat = R('幕与节奏策略.md')
  assert.ok(!/五拍＝发现→筹备→反转→爆发→结算|五拍：发现→筹备→反转→爆发→结算/.test(repeat),
    '幕与节奏策略不该重复五拍的完整定义式，应指向 K-08')
})

test('M-15：去重之后交叉引用仍然有效（不能把指针指向一个已经删掉的东西）', () => {
  const t = R('幕与节奏策略.md')
  assert.match(t, /拆书概念辞典 K-08|概念辞典/, 'S-01 要仍指向概念辞典')
  // 被引用的键必须真的在辞典里
  const dict = R('拆书概念辞典.md')
  const cited = [...t.matchAll(/K-(\d{2})/g)].map((m) => m[1])
  for (const k of new Set(cited)) {
    assert.match(dict, new RegExp(`\\| K-${k} \\|`), `引用了 K-${k}，但辞典里没有这一条`)
  }
})
