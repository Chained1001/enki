// 产物校验的文本与文件原语：遍历、Markdown 标题与表格解析、段落切分、序列相似度、骨架判定。
// 这里只读文件、只做纯计算；判定、错误码与报告顺序留在 validate-output.mjs 的主流程。
import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

export async function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else out.push({ rel: full.slice(base.length + 1).split(sep).join('/'), full })
  }
  return out
}

export function headings(text) {
  const list = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (m) list.push(m[1])
  }
  return list
}

// 取某个段的正文（到下一个同级或更高级标题为止），并去掉引用块说明行。
// 段的标题级别因模板而异：金手指是二级（## 代价与限制），专题是三级（### 定义与范围），
// 所以按段名匹配任意级别（2-4 级），而不是写死 ###——写死 ## 时整段取不到，
// 上层的检查就静默失效（W_NO_COST 第一版正是这样一条永不触发的检查）。
export function sectionBody(text, name) {
  const lines = text.split(/\r?\n/)
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const head = lines.findIndex((l) => new RegExp(`^(#{2,4})\\s+${esc}\\s*$`).test(l))
  if (head < 0) return null
  const level = /^(#{2,4})/.exec(lines[head])[1].length
  const out = []
  for (let i = head + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i])
    if (m && m[1].length <= level) break
    if (/^>/.test(lines[i])) continue
    out.push(lines[i])
  }
  return out.join('\n')
}

// 最长公共子序列长度。总表↔卷纲的重合度要用它而不是集合交集：
// 集合会把「用词相同但说的不是一回事」也算成高重合，而 LCS 要求字按顺序对得上。
// 长度规模是「一格 vs 一段」（几百字），一维滚动数组足够。
export function lcsLen(a, b) {
  const x = [...a]
  const y = [...b]
  if (!x.length || !y.length) return 0
  let prev = new Uint32Array(y.length + 1)
  let cur = new Uint32Array(y.length + 1)
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const t2 = prev
    prev = cur
    cur = t2
    cur.fill(0)
  }
  return prev[y.length]
}

// 占位判定：模板写的是「（待填）」，但手写会出「待填」「(待填)」「待填 」等变体，
// 全等匹配会漏掉这些，而漏掉的后果是「两侧都占位 → 反向重合 100% → 报成照抄」。
export function isPlaceholder(text) {
  return typeof text === 'string' && /待填/.test(text)
}

// 第一个 Markdown 表：表头列 + 数据行。
export function firstTable(text) {
  const lines = text.split(/\r?\n/)
  let header = null
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const cells = parseRow(lines[i])
    if (!cells) continue
    if (header === null) {
      if (parseRow(lines[i + 1])?.every((c) => /^[-: ]*$/.test(c))) header = cells
      continue
    }
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue
    rows.push(cells)
  }
  return header ? { header, rows } : null
}

// 表行解析：按未转义的竖线切列，单元格内 `\|` 是合法字面量（生成侧 buildArtifacts 的转义约定）。
export function parseRow(line) {
  const t = line?.trim() ?? ''
  if (!t.startsWith('|') || !t.endsWith('|')) return null
  const cells = t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  if (cells.length < 2) return null
  return cells
}

// 骨架态判定：正文里是否还存在「还没填」的证据。
// 两件事要一起看，只看一件会误判：
//   1）散文/列表骨架——正文含「（待填）」占位（引用块里的说明行不算，那是在解释占位）；
//   2）表格骨架——表头齐了但一行数据都没有。空的 Markdown 表格本来就没有「（待填）」字样，
//      只按占位判会把它当成「已填」，于是满屏都是「状态未更新」的假告警（实测 6 条）。
export function looksUnfilled(text, rel) {
  const body = text.replace(/^>.*$/gm, '')
  if (body.includes('（待填）')) return true
  if (!rel.endsWith('.md')) return false
  const table = firstTable(body)
  // 只对「整份文件就是一张表」的产物这么判（索引、台账、词典、关系表）：
  // 有标题段落的文件里，表格为空不等于文件没写。
  if (!table) return false
  const headings = [...body.matchAll(/^## /gm)].length
  if (headings > 0) return false
  return table.rows.length === 0
}

export function topicVerdict(text) {
  const m = /-\s*判定：(.+)/.exec(text)
  return m ? m[1].trim() : null
}

export function countFiles(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).length
}

// 卷纲「事件弧清单」段的表格（Q-24）：段内第一个表；无表返回 null。
export function arcTable(volText) {
  const lines = volText.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^#{2,3}\s+事件弧清单/.test(l))
  if (idx === -1) return null
  let header = null
  const rows = []
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s+/.test(lines[i])) break
    const cells = parseRow(lines[i])
    if (!cells) continue
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue
    if (header === null) { header = cells; continue }
    rows.push(cells)
  }
  return header ? { header, rows } : null
}

// 段内文本（Q-24）：`## 段名` 到下一个同级标题之间的行；段不存在返回空串。
export function sectionText(text, name) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${name}\\s*$`).test(l))
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s+/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

export function arcRows(volText) {
  if (!/^#{2,3}\s+事件弧清单/m.test(volText)) return null // 段缺＝不判（与既有 E_ACT_COVER 语义一致）
  return arcTable(volText)?.rows.length ?? 0
}
