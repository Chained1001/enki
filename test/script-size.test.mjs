// 脚本规模闸（docs/规范/02-脚本与测试.md）：「单个脚本超过 1000 行或 50 个函数时，按职责拆分」。
// 数行用 readFileSync(...).split(/\r?\n/).length，不 spawn wc：Windows 没有 wc，测试也不该为此起子进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(here, '..', 'skills', 'book-breakdown', 'scripts')
const MAX_LINES = 1000

function lineCount(file) {
  return readFileSync(join(SCRIPTS, file), 'utf8').split(/\r?\n/).length
}

test('validate-output.mjs 少于 1000 行（超了按职责拆到 scripts/validate/）', () => {
  const lines = lineCount('validate-output.mjs')
  assert.ok(lines < MAX_LINES, `validate-output.mjs 现有 ${lines} 行，应 < ${MAX_LINES}：把纯函数/常量继续拆到 scripts/validate/`)
})

test('prepare.mjs 少于 1000 行（防止它继续长）', () => {
  const lines = lineCount('prepare.mjs')
  assert.ok(lines < MAX_LINES, `prepare.mjs 现有 ${lines} 行，应 < ${MAX_LINES}：超出前按职责拆分`)
})
