#!/usr/bin/env node
// 校验 AGENTS.md 的指针可解析，以及 GLOSSARY.md 的格式、长度与拼音序。只用 Node 内置模块。
// 用法：docs-check.mjs [--root <目录>] [--help]
// 退出码：0 通过，1 文档有问题，2 参数错误。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const USAGE = '用法：docs-check.mjs [--root <目录>] [--help]'
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DEFINITION = 60
const COLLATOR = new Intl.Collator('zh-u-co-pinyin', { usage: 'sort' })

// AGENTS.md 应向开发者指到的文件。标 heading 的还须在目标文件里有同名二级标题。
// 指针对不上时改 AGENTS.md 或补回目标，不要删这里的条目——删掉等于让这类检查静默失效。
export const AGENTS_POINTERS = [
  { path: 'README.md', heading: '技能列表' },
  { path: 'docs/规范/00-总则.md', heading: '按需查阅' },
  { path: 'docs/产品/PRD.md', heading: '产品流程' },
  { path: 'skills/book-breakdown/scripts/contract.mjs' },
  { path: 'GLOSSARY.md' },
  { path: 'docs/agents/issue-tracker.md' },
  { path: 'docs/agents/triage-labels.md' },
  { path: 'docs/agents/domain.md' },
  { path: 'docs/adr/README.md' },
  { path: 'test/realbook-scale.test.mjs' },
  { path: 'scripts/init-skill.mjs' },
  { path: 'docs/规范/04-提交与分支.md' },
  { path: 'docs/规范/来源.md' },
]

function isFile(path) {
  if (!existsSync(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hasHeading(text, heading) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .some((line) => line.trim() === `## ${heading}`)
}

// 指针的判定：AGENTS.md 里必须有反引号包起来的路径，目标文件必须存在，
// 标了节的指针还须在目标文件里找到「## 标题」。
export function checkAgents(root = DEFAULT_ROOT) {
  const issues = []
  const agentsPath = join(root, 'AGENTS.md')
  if (!isFile(agentsPath)) return [{ file: 'AGENTS.md', line: 1, message: '文件不存在' }]

  const lines = readFileSync(agentsPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const pointer of AGENTS_POINTERS) {
    const index = lines.findIndex((line) => line.includes(`\`${pointer.path}\``))
    if (index === -1) {
      issues.push({ file: 'AGENTS.md', line: 1, message: `未写指针：${pointer.path}` })
      continue
    }
    const line = index + 1
    const target = join(root, pointer.path)
    if (!isFile(target)) {
      issues.push({ file: 'AGENTS.md', line, message: `指针目标不存在：${pointer.path}` })
      continue
    }
    if (pointer.heading && !hasHeading(readFileSync(target, 'utf8'), pointer.heading)) {
      issues.push({
        file: 'AGENTS.md',
        line,
        message: `指针目标缺少节：${pointer.path} 中没有「## ${pointer.heading}」`,
      })
    }
  }
  return issues
}

// 只把「- 」开头的行当条目；标题、说明段落不参与格式判断，但也不给它们豁免错格式。
// 定义按码点计字，60 字为上限（含标点）。
export function checkGlossary(text) {
  const issues = []
  const entries = []
  const firstSeen = new Map()

  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1
      if (raw.trim() === '' || !raw.startsWith('- ')) return
      const match = /^- \*\*(.+?)\*\*：(.+)$/.exec(raw)
      if (!match) {
        issues.push({ file: 'GLOSSARY.md', line, message: '术语行格式应为 - **术语**：定义' })
        return
      }
      const term = match[1].trim()
      const definition = match[2].trim()
      if (!term || !definition) {
        issues.push({ file: 'GLOSSARY.md', line, message: '术语行格式应为 - **术语**：定义' })
        return
      }

      const length = [...definition].length
      if (length > MAX_DEFINITION) {
        issues.push({ file: 'GLOSSARY.md', line, message: `定义超过 ${MAX_DEFINITION} 字（${length} 字）：${term}` })
      }
      if (firstSeen.has(term)) {
        issues.push({ file: 'GLOSSARY.md', line, message: `术语重复：${term}（首次出现在第 ${firstSeen.get(term)} 行）` })
      } else {
        firstSeen.set(term, line)
      }
      entries.push({ term, line })
    })

  // 严格升序：逐对比，只报第一对逆序；重名已由上面的规则单独报，不在这里重复算。
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1]
    const current = entries[i]
    if (COLLATOR.compare(previous.term, current.term) > 0) {
      issues.push({
        file: 'GLOSSARY.md',
        line: current.line,
        message: `拼音序逆序：${previous.term}（第 ${previous.line} 行）应排在「${current.term}」之后`,
      })
      break
    }
  }
  return issues
}

export function checkDocs(root = DEFAULT_ROOT) {
  const issues = checkAgents(root)
  const glossaryPath = join(root, 'GLOSSARY.md')
  if (!isFile(glossaryPath)) {
    issues.push({ file: 'GLOSSARY.md', line: 1, message: '文件不存在' })
  } else {
    issues.push(...checkGlossary(readFileSync(glossaryPath, 'utf8')))
  }
  return issues
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('--root 缺少取值')
      options.root = resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数 ${arg}`)
    }
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const issues = checkDocs(options.root)
  if (issues.length === 0) {
    console.log('docs-check 通过')
    return 0
  }
  for (const issue of issues) console.log(`${issue.file}:${issue.line} ${issue.message}`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main()
}
