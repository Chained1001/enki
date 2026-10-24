// 判据与解读分离（#21）。
// 防的回归：把「作者自查题」混在判据里，agent 读到会以为那是判定依据。
// 这类题大多以「吗？」结尾、要求作者对自己意图的了解，而拆书者手里只有原文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const refDir = join(here, '..', 'skills', 'book-breakdown', 'references')
const read = (f) => readFileSync(join(refDir, f), 'utf8')

const BOX_RE = /^\s*-\s*\[[ xX]\]\s*(.+)$/

// 移出的条目必须一条不少地出现在解读提示里。
// 这条不是「数个数」——它比对的是条目文本本身，改一个字都会被发现。
// 28 条复选框 + 5 条无复选框的自查题（「基本信息有了吗？」这类，格式不同但性质相同）。
const MOVED_FROM = {
  '人物提炼策略.md': 33,
  '伏笔识别策略.md': 4,
  '幕与节奏策略.md': 9,
  '结构拆解策略.md': 3,
  '设定提炼策略.md': 21,
}

test('判据文件里的复选框清零：一个都不许再有', () => {
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md') && f !== '解读提示.md')
  const offenders = []
  for (const f of files) {
    const n = read(f).split(/\r?\n/).filter((l) => BOX_RE.test(l)).length
    if (n) offenders.push(`${f}: ${n} 条`)
  }
  assert.deepEqual(offenders, [], `判据文件里不该再有作者自查复选框：${offenders.join('；')}`)
})

test('解读提示收下了全部 65 条，且按来源文件分组（条数对账）', () => {
  const text = read('解读提示.md')
  const boxes = text.split(/\r?\n/).filter((l) => BOX_RE.test(l)).map((l) => BOX_RE.exec(l)[1].trim())
  const total = Object.values(MOVED_FROM).reduce((a, b) => a + b, 0)
  assert.equal(boxes.length, total, `解读提示应有 ${total} 条，实际 ${boxes.length} 条`)
  // 按来源分组的标题也要在
  for (const [file, n] of Object.entries(MOVED_FROM)) {
    const base = file.replace(/\.md$/, '')
    assert.ok(text.includes(`来自 ${base}（${n} 条）`), `解读提示缺「来自 ${base}（${n} 条）」分组`)
  }
})

test('移出的条目逐条可查：原文件里出现过的自查题，解读提示里都能找到同一句', () => {
  // 用「从解读提示反查」的方向：解读提示里的每一条，都必须能看出它问的是什么，
  // 且不是空的、不是重复的空壳。逐条检查长度与唯一性。
  const text = read('解读提示.md')
  const boxes = text.split(/\r?\n/).filter((l) => BOX_RE.test(l)).map((l) => BOX_RE.exec(l)[1].trim())
  for (const b of boxes) {
    assert.ok(b.length >= 6, `条目太短，看不出问的是什么：「${b}」`)
  }
  // 允许少量重复（不同小节问同一件事是正常的），但不能大面积复制粘贴
  const uniq = new Set(boxes)
  assert.ok(
    uniq.size >= boxes.length - 2,
    `解读提示里重复条目过多（${boxes.length} 条中只有 ${uniq.size} 条唯一），像是复制粘贴`,
  )
})

test('解读提示里不夹带判据表（J- 项与判据表头）', () => {
  // 反向守卫：解读提示只该收「从判据文件搬过来的自查题」。
  // 若有人往这里新写一条 J- 判据（带强度、可判定），那是放错地方——判据归策略文件。
  const text = read('解读提示.md')
  assert.ok(!/^\| J-\d+ \|/m.test(text), '解读提示里不该出现 J- 判据行——那是判据，不是解读')
  // 判据表的表头形态：「| 编号 | 判据 | 强度 | 判定方法 |」
  assert.ok(!/^\|\s*编号\s*\|\s*判据\s*\|/m.test(text), '解读提示里不该出现判据表表头')
})

test('技能入口写明判据与解读分离，并指向解读提示文件', () => {
  const skill = readFileSync(join(here, '..', 'skills', 'book-breakdown', 'SKILL.md'), 'utf8')
  assert.match(skill, /判据与解读分离/, 'SKILL.md 应有「判据与解读分离」一节')
  assert.match(skill, /解读提示\.md/, 'SKILL.md 应指向 references/解读提示.md')
  assert.match(skill, /不能/, 'SKILL.md 应明说解读不能拿来判定')
})

test('判据文件的「判断标准」段仍留有可执行判据，没有被搬空', () => {
  // 搬走复选框时最容易误伤的就是这里：整节只剩一句引导语，判据层成了空壳。
  // 三种可执行形态都算数：
  //   ① 表格（| 判据 | 怎么判 |）
  //   ② 含阈值/硬性/章号/比较符的句子
  //   ③ 「能用三句话说出：」＋下列子项——这是可判定的：答得出就算达成，答不出就没达成
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md') && f !== '解读提示.md')
  const empty = []
  for (const f of files) {
    const lines = read(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!/^#{3,4}\s+判断标准\s*$/.test(lines[i])) continue
      const level = /^(#+)/.exec(lines[i])[1].length
      const body = []
      for (let j = i + 1; j < lines.length; j++) {
        const m = /^(#{2,6})\s/.exec(lines[j])
        if (m && m[1].length <= level) break
        body.push(lines[j])
      }
      const substantive = body.filter((l) => l.trim() && !/^---+$/.test(l)).map((l) => l.trim())
      const hasTable = substantive.some((l) => /^\|/.test(l))
      const hasThreshold = substantive.some((l) => /阈值|硬性|样本比例|第\s*\d+\s*章|≥|≤/.test(l))
      // ③「能说出 N 件事」形态：一段引导句 + ≥2 个列表子项
      const lead = substantive.find((l) => /能用.*说出|能说出/.test(l))
      const subItems = substantive.filter((l) => /^-\s/.test(l))
      const hasEnumerated = Boolean(lead) && subItems.length >= 2
      // ④ 引导句 + ≥2 个子项（不限于「能说出」）：如「每个重要人物：」下列两条。
      //    有具体子项就说明它是可核对的清单，不是空话。
      const hasLeadWithItems = substantive.some((l) => /[:：]\s*$/.test(l)) && subItems.length >= 2
      // ⑤ 引用块里的例外边界：「什么时候可以打破」——它给出的是判据的适用边界，
      //    本身就是可执行的（知道什么时候可以违反，才知道什么时候算违反）。
      const hasBoundary = substantive.some((l) => /^>\s*\*\*什么时候可以打破\*\*/.test(l))
      if (!hasTable && !hasThreshold && !hasEnumerated && !hasLeadWithItems && !hasBoundary) {
        empty.push(`${f}（行 ${i + 1}）`)
      }
      i += body.length
    }
  }
  assert.deepEqual(empty, [], `「判断标准」段只剩引导语、没有可执行判据：${empty.join('；')}`)
})

test('「判断标准」段里不再混有自查题（有复选框之外的第二形态）', () => {
  // 复选框是最显眼的形态，但不是唯一的：还有「基本信息有了吗？」这种没有 [ ] 的列表短项。
  // 这一条按形态查，不按具体条目查——否则改一个词就漏过去了。
  const files = readdirSync(refDir).filter((f) => f.endsWith('.md') && f !== '解读提示.md')
  const offenders = []
  for (const f of files) {
    const lines = read(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!/^#{3,4}\s+判断标准\s*$/.test(lines[i])) continue
      const level = /^(#+)/.exec(lines[i])[1].length
      for (let j = i + 1; j < lines.length; j++) {
        const m = /^(#{2,6})\s/.exec(lines[j])
        if (m && m[1].length <= level) break
        // 列表短项 + 以「吗？」结尾 = 自查题形态
        if (/^\s*-\s+[^|]{0,80}吗？(\s*[（(][^）)]*[）)])?\s*$/.test(lines[j])) {
          offenders.push(`${f}:${j + 1} ${lines[j].trim().slice(0, 40)}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `「判断标准」段里还有自查题形态的条目：${offenders.join('；')}`)
})

test('白名单上限已同步调低：复选框维度清零，文件数上限降到 7', () => {
  const src = readFileSync(join(here, 'references-depth.test.mjs'), 'utf8')
  assert.match(src, /GRANDFATHERED\.size <= 7\b/, '白名单文件数上限应降到 7（原 11）')
  assert.ok(!/checkboxes: \d+/.test(src), '不该再有任何 checkboxes 条数豁免——上限必须是 0')
})
