// 防的漂移：错误码表与脚本实际报码脱节，或项目专属码漂回通用规范 02。
// 两张表各管一层：docs/规范/02 只收通用码（CLI、frontmatter、技能结构等），
// docs/技术/错误码.md 收 book-breakdown 的产物校验码。两表不重复登记。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const STANDARD = join(root, 'docs', '规范', '02-脚本、测试与提交.md')
const PROJECT = join(root, 'docs', '技术', '错误码.md')

// 表里有、但当前脚本确实不报的码。每条写明为什么可以不在用（而不是忘了补脚本或忘了删行）。
// 新增条目必须同时满足：码在两张表之一、理由可核查。
const GENERIC_UNEMITTED = new Map([
  ['E_SYNC_GAP', 'check-projects.mjs 是仅基座脚本、本仓库未收录，该码在基座才会触发'],
])

function rel(file) {
  return relative(root, file).split('\\').join('/')
}

function tableCodes(file) {
  assert.ok(existsSync(file), `错误码表不存在：${rel(file)}`)
  const rows = []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    const match = /^\|\s*`([EW]_[A-Z0-9_]+)`\s*\|/.exec(line)
    if (match) rows.push({ code: match[1], file, line: i + 1 })
  })
  return rows
}

// 去掉注释但保留字符串内容与原位置（换行不动），避免把注释里举例的码算成脚本在报。
function stripComments(src) {
  const out = src.split('')
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (src[k] !== '\n') out[k] = ' '
  }
  const skipLineComment = () => {
    const from = i
    while (i < src.length && src[i] !== '\n') i += 1
    blank(from, i)
  }
  const skipBlockComment = () => {
    const from = i
    i += 2
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
    i = Math.min(src.length, i + 2)
    blank(from, i)
  }
  function string(q) {
    i += 1
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        i += 2
        code(true)
        if (src[i] === '}') i += 1
        continue
      }
      if (c === q) { i += 1; return }
      i += 1
    }
  }
  function code(endOnBrace) {
    let depth = 0
    while (i < src.length) {
      const c = src[i]
      if (c === '/' && src[i + 1] === '/') { skipLineComment(); continue }
      if (c === '/' && src[i + 1] === '*') { skipBlockComment(); continue }
      if (c === "'" || c === '"' || c === '`') { string(c); continue }
      if (c === '{') { depth += 1; i += 1; continue }
      if (c === '}') {
        if (endOnBrace && depth === 0) return
        depth -= 1
        i += 1
        continue
      }
      i += 1
    }
  }
  code(false)
  return out.join('')
}

// 脚本报码的两种写法：'E_X' / code: 'E_X'，以及消息前缀 `E_X：...`。
function codesInScript(file) {
  const src = readFileSync(file, 'utf8')
  const clean = stripComments(src)
  const found = []
  for (const re of [/(['"`])([EW]_[A-Z0-9_]+)\1/g, /(?<![A-Za-z0-9_])([EW]_[A-Z0-9_]+)(?=\s*[：:])/g]) {
    for (const match of clean.matchAll(re)) {
      const code = match[2] ?? match[1]
      const line = clean.slice(0, match.index).split('\n').length
      found.push({ code, file, line })
    }
  }
  return found
}

const repoScriptFiles = readdirSync(join(root, 'scripts'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => join(root, 'scripts', name))
const skillScriptFiles = readdirSync(join(root, 'skills', 'book-breakdown', 'scripts'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => join(root, 'skills', 'book-breakdown', 'scripts', name))

const emitted = new Map() // code -> Set(相对路径)
const repoCodes = new Set()
const skillCodes = new Set()
for (const file of repoScriptFiles) {
  for (const { code } of codesInScript(file)) {
    if (!emitted.has(code)) emitted.set(code, new Set())
    emitted.get(code).add(rel(file))
    repoCodes.add(code)
  }
}
for (const file of skillScriptFiles) {
  for (const { code } of codesInScript(file)) {
    if (!emitted.has(code)) emitted.set(code, new Set())
    emitted.get(code).add(rel(file))
    skillCodes.add(code)
  }
}

const standardRows = tableCodes(STANDARD)
const projectRows = tableCodes(PROJECT)
const standardCodes = new Set(standardRows.map((row) => row.code))
const projectCodes = new Set(projectRows.map((row) => row.code))
const union = new Set([...standardCodes, ...projectCodes])

const show = (items) => items.join('；')

test('两张错误码表各自无重复，且同一码不跨表登记', () => {
  const dupStandard = standardRows
    .filter((row, i) => standardRows.findIndex((x) => x.code === row.code) !== i)
    .map((row) => `${row.code}（${rel(row.file)}:${row.line}）`)
  assert.deepEqual(dupStandard, [], `02 表内重复码：${show(dupStandard)}`)

  const dupProject = projectRows
    .filter((row, i) => projectRows.findIndex((x) => x.code === row.code) !== i)
    .map((row) => `${row.code}（${rel(row.file)}:${row.line}）`)
  assert.deepEqual(dupProject, [], `docs/技术/错误码.md 表内重复码：${show(dupProject)}`)

  const both = [...union].filter((code) => standardCodes.has(code) && projectCodes.has(code))
  assert.deepEqual(both, [], `同一码同时写进两张表：${show(both)}`)
})

test('脚本在报的每个码都写进了两张表之一', () => {
  const missing = [...emitted]
    .filter(([code]) => !union.has(code))
    .map(([code, files]) => `${code}（${[...files].join('、')}）`)
  assert.deepEqual(missing, [], `脚本在报、两张表都查不到的码：${show(missing)}`)
})

test('表里的每个码都有脚本在用，或在 GENERIC_UNEMITTED 里写明理由', () => {
  const violations = [...standardRows, ...projectRows]
    .filter((row) => !emitted.has(row.code) && !GENERIC_UNEMITTED.has(row.code))
    .map((row) => `${row.code}（${rel(row.file)}:${row.line}）`)
  assert.deepEqual(violations, [], `表里有、脚本没在报、也不在允许清单的码：${show(violations)}`)

  const stale = [...GENERIC_UNEMITTED.keys()].filter((code) => !union.has(code))
  assert.deepEqual(stale, [], `GENERIC_UNEMITTED 里的码已不在任何表：${show(stale)}`)

  const noReason = [...GENERIC_UNEMITTED].filter(([, reason]) => !String(reason ?? '').trim()).map(([code]) => code)
  assert.deepEqual(noReason, [], `GENERIC_UNEMITTED 缺理由：${show(noReason)}`)
})

test('技能脚本独有的码只写在项目表，仓库级脚本的码只写在通用表', () => {
  const misplaced = []
  for (const code of skillCodes) {
    if (repoCodes.has(code)) continue // 两层共用的通用码（如 E_ARGS）归 02
    if (standardCodes.has(code)) misplaced.push(`${code} 只在技能脚本报，却写在 ${rel(STANDARD)}`)
    if (!projectCodes.has(code)) misplaced.push(`${code} 只在技能脚本报，却没写进 ${rel(PROJECT)}`)
  }
  for (const code of repoCodes) {
    if (!standardCodes.has(code)) misplaced.push(`${code} 由仓库级脚本报，却没写进 ${rel(STANDARD)}`)
  }
  assert.deepEqual(misplaced, [], `错误码分层放错：${show(misplaced)}`)
})

test('P1-5 的三处修复不回退：E_ARGS 在 02、E_SOURCE 在项目表、README 索引改名', () => {
  assert.ok(standardCodes.has('E_ARGS'), `${rel(STANDARD)} 缺 E_ARGS（命令行参数不合法）`)
  assert.ok(!standardCodes.has('E_SOURCE'), `${rel(STANDARD)} 不应再登记项目码 E_SOURCE`)
  assert.ok(projectCodes.has('E_SOURCE'), `${rel(PROJECT)} 缺 E_SOURCE 定义`)
  assert.ok(standardCodes.has('E_README_INDEX'), `${rel(STANDARD)} 缺 E_README_INDEX（原 README 索引码）`)
  assert.ok(projectCodes.has('E_INDEX'), `${rel(PROJECT)} 缺集合索引码 E_INDEX`)
})
