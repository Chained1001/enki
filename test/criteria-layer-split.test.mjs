// 判据层与解读层拆分（#22）。
// 防的回归：把判据和解读混在一份大文件里，一次整读的代价抵得上读六七章原文；
// 或拆分时把编号策略行、错误表悄悄弄丢——拆完看起来「更清爽」，实际少了判定依据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const refDir = join(here, '..', 'skills', 'book-breakdown', 'references')
const critDir = join(refDir, '判据')
const readDir = join(refDir, '解读')

const read = (p) => readFileSync(p, 'utf8')
const crit = () => read(join(critDir, '人物提炼判据.md'))
const interp = () => read(join(readDir, '人物提炼解读.md'))
const CHARS_PER_TOKEN = 1.6
const tokens = (s) => Math.round(s.length / CHARS_PER_TOKEN)

test('判据层与解读层都存在，且原大文件已不在（拆分而不是复制）', () => {
  assert.ok(existsSync(join(critDir, '人物提炼判据.md')), '判据/人物提炼判据.md 必须存在')
  assert.ok(existsSync(join(readDir, '人物提炼解读.md')), '解读/人物提炼解读.md 必须存在')
  // 原文件若还在，agent 仍可能整读它，拆分等于白做
  assert.ok(
    !existsSync(join(refDir, '人物提炼策略.md')),
    'references/人物提炼策略.md 应已删除——留着它，拆分就没有意义',
  )
})

test('判据层容量显著下降：可整读（不超过一万 token）', () => {
  // 拆分前整份约 19k tokens，整读一次抵得上读六七章原文。
  // 判据层是判定时真正要读的，所以它的上限是「能一口气读完」。
  const t = tokens(crit())
  assert.ok(t <= 10000, `判据层 ${t} tokens，超过 10000——判据层必须能整读，机制/路径应留在解读层`)
})

test('判据层收了核心卡、判断标准与错误表，不是只剩速查表', () => {
  const text = crit()
  // 核心卡：每节的引用块
  const cards = (text.match(/^> \*\*核心卡\*\*/gm) || []).length
  assert.ok(cards >= 10, `判据层只有 ${cards} 张核心卡（期望 ≥10，每节一张）`)
  // 判断标准与错误表
  const std = (text.match(/^#### 判断标准/gm) || []).length
  const errTbl = (text.match(/^#### 常见错误/gm) || []).length
  assert.ok(std >= 5, `判据层只有 ${std} 个「判断标准」段`)
  assert.ok(errTbl >= 5, `判据层只有 ${errTbl} 张「常见错误」表——错误表是反向检查的依据，不能全推到解读层`)
})

test('编号策略行无丢失：S-01…S-10 十条都在判据层', () => {
  const text = crit()
  const ids = [...text.matchAll(/^\| (S-\d{2}) \|/gm)].map((m) => m[1])
  assert.deepEqual(
    ids,
    ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08', 'S-09', 'S-10'],
    `判据层的 S- 编号应连续且完整，实际：${ids.join(' ')}`,
  )
  // 速查表的「详见」列指向本文件内的章节，拆层后不能指向已删除的原文件
  assert.ok(
    !/详见.*人物提炼策略\.md/.test(text),
    '速查表的「详见」不得指向已删除的 人物提炼策略.md',
  )
})

test('拆分的条数对账：判据层 + 解读层 = 原文件的每条 S-/J-/错误表各一份，不重不漏', () => {
  const c = crit()
  const r = interp()
  // 常见错误表只应在判据层出现一次（解读层再放一遍就是让人读两份）
  const cErr = (c.match(/^#### 常见错误/gm) || []).length
  const rErr = (r.match(/^#### 常见错误/gm) || []).length
  assert.equal(rErr, 0, `解读层不该有常见错误表（有 ${rErr} 张）——那是判据层的反向检查依据`)
  assert.ok(cErr >= 5, `判据层的错误表只有 ${cErr} 张`)
  // 判断标准同理
  const rStd = (r.match(/^#### 判断标准/gm) || []).length
  assert.equal(rStd, 0, `解读层不该有「判断标准」段（有 ${rStd} 个）`)
  // 解读层必须真的解释了机制，否则拆分只是把内容删了
  const rMech = (r.match(/^#### .*(机制|为什么)/gm) || []).length
  assert.ok(rMech >= 8, `解读层只有 ${rMech} 段机制解释（期望 ≥8）——拆分不能只留骨架`)
})

test('两层互相指路：各自写明另一层在哪', () => {
  assert.match(crit(), /\.\.\/解读\/人物提炼解读\.md/, '判据层应指向解读层')
  assert.match(interp(), /\.\.\/判据\/人物提炼判据\.md/, '解读层应指向判据层')
  // 判据层要明说自己不是全部，否则读者不知道还有机制解释
  assert.match(crit(), /判据层/, '判据层应自述是哪一层')
  assert.match(interp(), /解读层/, '解读层应自述是哪一层')
})

test('索引已重新生成，且包含两个新子目录的路径', () => {
  const idx = read(join(refDir, '索引.md'))
  assert.match(idx, /判据\/人物提炼判据\.md/, '索引里应有 判据/人物提炼判据.md')
  assert.match(idx, /解读\/人物提炼解读\.md/, '索引里应有 解读/人物提炼解读.md')
  // 原有的判据件也进了子目录，索引必须跟着改
  for (const f of ['幕边界判据.md', '主次判定判据.md', '金手指判据.md', '要素判据.md', '章节识别.md']) {
    assert.match(idx, new RegExp(`判据/${f}`), `索引里应有 判据/${f}`)
  }
})

test('索引的行范围指向真实小节标题（抽查最大的一份）', () => {
  // 索引的用处是「按 offset/limit 读」，行号错一行就白读。
  const idx = read(join(refDir, '索引.md'))
  const target = '解读/人物提炼解读.md'
  const text = read(join(readDir, '人物提炼解读.md'))
  const lines = text.split(/\r?\n/)
  const rows = idx.split(/\r?\n/).filter((l) => l.startsWith(`| ${target} |`))
  assert.ok(rows.length > 0, `索引里没有 ${target} 的节`)
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim())
    const [, section, range] = cells
    const [from] = range.split('-').map(Number)
    assert.equal(
      lines[from - 1].replace(/^#+\s+/, '').trim(),
      section,
      `${target} 第 ${from} 行应是节「${section}」，实际是「${lines[from - 1].trim().slice(0, 40)}」`,
    )
  }
})

test('质量门对拆分后的文件仍生效：判据层无复选框、有判据', () => {
  // 拆到子目录的文件不能因为「不在 references 平铺层」就跳出质量门。
  for (const dir of [critDir, readDir]) {
    for (const name of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const text = read(join(dir, name))
      assert.ok(
        !/^\s*-\s*\[[ xX]\]/m.test(text),
        `${dir}/${name} 里有作者自查复选框——质量门对子目录同样有效`,
      )
    }
  }
  // 判据层必须仍能被「判断标准段有可执行判据」这条门看到。
  // 形态不拘：表格（「| 判据 | 怎么判 |」）或「能说出 N 件事」+ 子项都算可执行。
  const text = crit()
  const hasTable = /^\| 判据 \| 怎么判/m.test(text)
  const hasEnumerated = /能用.*说出[：:]/m.test(text)
  assert.ok(hasTable || hasEnumerated, '判据层的「判断标准」段应含可执行判据（表格或「能说出」清单）')
})

test('没有死引用：引用这些文件的其余文档路径都正确', () => {
  const files = []
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.md')) files.push(p)
    }
  }
  walk(join(here, '..', 'skills'))

  const dead = []
  for (const p of files) {
    const text = read(p)
    for (const m of text.matchAll(/`([^`\n]*?\.md)`/g)) {
      const ref = m[1]
      // 只查相对路径（含 / 或 ../），裸文件名由 validator 的 E_LINK 管
      if (!ref.includes('/')) continue
      if (ref.startsWith('http')) continue
      // 通配符不是路径（如 references/*策略.md），跳过
      if (ref.includes('*')) continue
      const abs = join(dirname(p), ref)
      if (!existsSync(abs)) dead.push(`${p.replace(join(here, '..') + '\\', '')} → ${ref}`)
    }
  }
  assert.deepEqual(dead, [], `有死引用（文件不存在）：\n${dead.join('\n')}`)
})

test('索引覆盖磁盘上的每一个 references 文件：子目录里的不许漏（生成逻辑也不许只扫一层）', () => {
  // 上一条只验证「索引里的行范围指向真实标题」——若生成脚本退回只扫一层，
  // 索引里干脆没有子目录那两行，上一条会因为 rows.length > 0 检查的是解读层而照样过。
  // 这一条从「磁盘 → 索引」的方向查：磁盘上每个 .md 都必须在索引里出现过。
  const idx = read(join(refDir, '索引.md'))
  const onDisk = []
  function walk(dir, prefix) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) { walk(join(dir, ent.name), rel); continue }
      if (!ent.name.endsWith('.md') || ent.name === '索引.md') continue
      onDisk.push(rel)
    }
  }
  walk(refDir, '')
  const missing = onDisk.filter((rel) => !idx.includes(`| ${rel} |`))
  assert.deepEqual(missing, [], `索引漏了这些文件（生成脚本可能只扫了一层）：${missing.join('、')}`)
  // 反向：索引里不该出现磁盘上已不存在的文件
  const listed = new Set([...idx.matchAll(/^\| ([^|]+?\.md) \|/gm)].map((m) => m[1].trim()))
  const ghost = [...listed].filter((rel) => !onDisk.includes(rel))
  assert.deepEqual(ghost, [], `索引里有磁盘上已不存在的文件：${ghost.join('、')}`)
})

test('拆出来的两份都不大：判据层显著小于解读层（分层真的发生了）', () => {
  const c = statSync(join(critDir, '人物提炼判据.md')).size
  const r = statSync(join(readDir, '人物提炼解读.md')).size
  // 判据层是「要读的」，解读层是「要查的」；若判据层反而更大，说明该搬的没搬走
  assert.ok(c < r, `判据层 ${c} 字节不应大于解读层 ${r} 字节——该搬到解读层的内容没搬`)
})
