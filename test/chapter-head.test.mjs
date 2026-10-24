// #9：章头正则曾允许零个分隔符，把正文里的词内字当成章标记。
// 「第二回合，许流年挑选了「油门」。」→ 切成「第2回 / 合，许流年…」
// 实测三本书中招：《十日终焉》24 处、《绍宋》1 处、《我真没想重生啊》1 处。
// 最重的后果不是章数虚高，而是绍宋的卷05 被截成 9 章（其余卷 78–87 章），
// 整本 7 卷结构错位——结构错的产物，校验器仍会全绿，因为它只查内部一致性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectChapters } from '../skills/book-breakdown/scripts/prepare.mjs'

const heads = (text) => detectChapters(text).filter((c) => c.isHeading)

test('「第N回合」不被当成「第N回」章头（#9 实测：十日终焉 24 处、绍宋 1 处）', () => {
  const text = [
    '第一章 开场',
    '她第一个上前，果断拿下了「刹车」。',
    '第二回合，许流年挑选了「油门」。',
    '本以为地马会拿下「方向盘」，可对方却拿下了「车门」。',
    '第三章 收束',
    '正文。',
  ].join('\n')
  const got = heads(text).map((c) => c.rawNo)
  assert.deepEqual(got, [1, 3], '只该认出第 1、3 章；「第二回合」不是章')
})

test('「第一回合，…大败而归。」整句不被切章（#9 实测：绍宋）', () => {
  const text = [
    '第一章 甲',
    '正文。',
    '第一回合，李经、马伸连着南方道学一系大败而归。',
    '随后纸价真的变贵了。',
    '第二章 乙',
    '正文。',
  ].join('\n')
  assert.deepEqual(heads(text).map((c) => c.rawNo), [1, 2])
})

test('「第一节快下课…」不被当成「第1节」（#9 实测：我真没想重生啊）', () => {
  const text = [
    '第一章 甲',
    '正文。',
    '第一节快下课，陈汉升突然接到一个电话，他拿起来手机走出教室。',
    '第二章 乙',
    '正文。',
  ].join('\n')
  assert.deepEqual(heads(text).map((c) => c.rawNo), [1, 2])
})

test('合法章名一律保留：带问号、带感叹号、无空格、章回体', () => {
  const text = [
    '第32章 这是法器？',
    '正文。',
    '第65章 绝世天才？！',
    '正文。',
    '第五十八章表决',
    '正文。',
    '第三回 宴桃园豪杰三结义',
    '正文。',
    '第九节 收束',
    '正文。',
  ].join('\n')
  const got = heads(text)
  assert.equal(got.length, 5, `五个合法章头都该认出，实得 ${got.length}：${got.map((c) => c.title).join(' / ')}`)
  assert.deepEqual(got.map((c) => c.rawNo), [32, 65, 58, 3, 9])
})

test('「回合」里没有分隔符就不切，但有分隔符的「第N回 标题」照旧能认', () => {
  // 反向护栏：收紧不能把章回体小说打死。
  const t1 = '第一回合，这场比试结束了。'
  assert.equal(heads(`第一章 甲\n正文。\n${t1}\n第二章 乙\n正文。`).length, 2, '「第一回合，」不切')
  const t2 = '第一回 楔子\n正文。\n第二回 入城\n正文。'
  assert.equal(heads(t2).length, 2, '「第一回 楔子」要能认')
})

test('半角空格是有效分隔符（#9 根因：\\s 在模板字符串里退化成了字面量 s）', () => {
  // 这是 #9 的真根因，比「回合」更隐蔽：`[\s　：:]` 写进模板字符串后
  // `\s` 不是合法转义，会退化成字面量 s，正则实际变成 `[s　：:]`——
  // 半角空格从来就不是分隔符。当年靠「零分隔符」那条野路子蒙对了大多数书，
  // 却漏掉《龙族1》的「序 章 白帝城」（整篇序章被并进前言，11→12 章之差）。
  // 注意空格的位置：是「第32 章」这种「章」字之前的空格，不是「第 32 章」。
  const long = '他说话了，声音很轻。'.repeat(30)
  const text = `第32 章 半角空格\n${long}\n第33 章 再来\n${long}`
  const got = heads(text)
  assert.equal(got.length, 2, '「章」字前的半角空格必须算分隔符')
  assert.deepEqual(got.map((c) => c.rawNo), [32, 33])
  // 全角空格、冒号同样要过。
  for (const sep of ['　', '：', ':']) {
    assert.equal(heads(`第4${sep}章${sep}分隔测试\n${long}`).length, 1, `分隔符 ${JSON.stringify(sep)} 应被接受`)
  }
  // 「序 章 白帝城」是龙族1 的真实形态，这行必须能认出来。
  assert.equal(heads(`序 章 白帝城\n${long}\n第一幕 开端\n${long}`).length, 2, '「序 章」要被识别')
})
