// 防的漂移：CHANGELOG 的版本段日期写错、Unreleased 混进日期、条目逐字重复、新条目带句号。
// 05-版本与发版只把规则写在文档里，没有门禁就全靠自觉；历史段（0.2.x／0.3.0）不追改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const changelogPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')
const lines = readFileSync(changelogPath, 'utf8').split(/\r?\n/)

const VERSION_HEAD = /^## \[(\d+\.\d+\.\d+)\] - (.+)$/
const UNRELEASED_HEAD = /^## \[Unreleased\]\s*$/

function sections() {
  const out = []
  let current = null
  for (const line of lines) {
    const version = VERSION_HEAD.exec(line)
    if (version) {
      current = { version: version[1], date: version[2].trim(), entries: [], headings: [] }
      out.push(current)
      continue
    }
    if (UNRELEASED_HEAD.test(line)) {
      current = { version: 'Unreleased', date: null, entries: [], headings: [] }
      out.push(current)
      continue
    }
    if (/^## /.test(line)) {
      current = null
      continue
    }
    if (current && /^### /.test(line)) {
      current.headings.push(line.trim())
      continue
    }
    if (current && line.startsWith('- ')) current.entries.push(line)
  }
  return out
}

function isValidDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

test('[Unreleased] 段存在', () => {
  assert.ok(sections().some((s) => s.version === 'Unreleased'), 'CHANGELOG 缺少 ## [Unreleased] 段')
})

test('[Unreleased] 不带日期', () => {
  const heads = lines.filter((line) => /^## \[Unreleased\]/.test(line))
  assert.ok(heads.length > 0, 'CHANGELOG 缺少 ## [Unreleased] 段')
  for (const head of heads) assert.equal(head, '## [Unreleased]', `[Unreleased] 不得带日期：${head}`)
})

test('每个版本段的日期格式合法', () => {
  const list = sections().filter((s) => s.version !== 'Unreleased')
  assert.ok(list.length > 0, 'CHANGELOG 没有任何版本段')
  for (const s of list) {
    assert.ok(isValidDate(s.date), `[${s.version}] 的日期「${s.date}」不是合法的 YYYY-MM-DD`)
  }
})

test('每个版本段内没有逐字重复的顶层条目', () => {
  for (const s of sections()) {
    const seen = new Set()
    for (const entry of s.entries) {
      assert.ok(!seen.has(entry), `[${s.version}] 段有逐字重复的条目：${entry.slice(0, 50)}`)
      seen.add(entry)
    }
  }
})

// 05 规定分类小节按 Added/Changed/… 只出现一次；两段 Changed 会让「破坏性变更在最前」和
// 「Added 在前」同时被违反，也让读者不知道两类改动的边界。
// 只查 [Unreleased] 与最新版本：0.2.x 是规则收紧前的历史段，不追改（同「不追改历史句号」）。
test('当前版本段（Unreleased 与最新版本）内分类小节不重复', () => {
  const list = sections()
  const newest = list.find((s) => s.version !== 'Unreleased')
  assert.ok(newest, 'CHANGELOG 没有任何版本段')
  for (const s of list) {
    if (s.version !== 'Unreleased' && s.version !== newest.version) continue
    const seen = new Set()
    for (const h of s.headings) {
      assert.ok(!seen.has(h), `[${s.version}] 段重复分类小节：${h}`)
      seen.add(h)
    }
  }
})

test('[Unreleased] 的条目不以句号结尾', () => {
  const unreleased = sections().find((s) => s.version === 'Unreleased')
  assert.ok(unreleased, 'CHANGELOG 缺少 ## [Unreleased] 段')
  for (const entry of unreleased.entries) {
    assert.ok(!entry.endsWith('。'), `[Unreleased] 的条目不得以句号结尾：${entry.slice(0, 50)}`)
  }
})
