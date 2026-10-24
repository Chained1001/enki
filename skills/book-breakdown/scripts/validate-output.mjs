#!/usr/bin/env node
// 产物校验（PRD「产品流程」节阶段 7）：树契约、段名、表头、幕覆盖、台账、行数、出处、索引对账。
// 两级输出（D-15）：错误阻断（退出 1），警告放行；--mode progress 输出四态与完成度，总判定「进行中」。
// 段名、列名、目录契约唯一来源是 contract.mjs（技术文档 D-01）。
// 用法：validate-output.mjs <产物目录> [--mode deliver|progress] [--json] [--help]
// 退出码：0 通过或需修改或进行中，1 校验失败，2 参数错误。只读不写。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { IoError, readManifest } from './io.mjs'
import { pathToFileURL } from 'node:url'
import {
  COLLECTIONS, ENUMS, QUOTE_PATTERN, QUOTE_RULE, SECTIONS, SOURCE_META_LABELS, SOURCE_PATTERN, THRESHOLDS,
  VARIABLE_FILE_RULES, productPlan, tableColumns,
} from './contract.mjs'

const USAGE = '用法：validate-output.mjs <产物目录> [--mode deliver|progress] [--json] [--help]'

// ---------- 工具 ----------

async function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else out.push({ rel: full.slice(base.length + 1).split(sep).join('/'), full })
  }
  return out
}

function headings(text) {
  const list = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (m) list.push(m[1])
  }
  return list
}

// 第一个 Markdown 表：表头列 + 数据行。
function firstTable(text) {
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

function topicVerdict(text) {
  const m = /-\s*判定：(.+)/.exec(text)
  return m ? m[1].trim() : null
}

// 剧情线缺席检测（Q-22，纯函数）：chapterRows 为逐章记录的表格数据行（parseRow 解析后的单元格数组）。
// 对在 ≥3 行出现过的每个线名（一章多线以「、」分隔），若相邻两次出现间隔 > threshold 章（按全局章号差），
// 返回 {线名, 上次章号, 缺席章数}；缺席章数＝两次出现的全局章号差。
export function findLineGaps(chapterRows, threshold) {
  const cols = tableColumns('逐章记录')
  const noIdx = cols.indexOf('全局章号')
  const lineIdx = cols.indexOf('剧情线')
  const seen = new Map() // 线名 → 出现章号（升序）
  for (const row of chapterRows) {
    const no = Number(/(\d+)/.exec(String(row?.[noIdx] ?? ''))?.[1] ?? NaN)
    if (!Number.isFinite(no)) continue
    const cell = String(row?.[lineIdx] ?? '').trim()
    if (!cell || cell.includes('待填') || cell === '无') continue
    for (const name of cell.split('、').map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(name)) seen.set(name, [])
      seen.get(name).push(no)
    }
  }
  const gaps = []
  for (const [name, nos] of seen) {
    if (nos.length < 3) continue // 出现不足 3 行的线不判缺席
    nos.sort((a, b) => a - b)
    for (let i = 1; i < nos.length; i++) {
      const absent = nos[i] - nos[i - 1]
      if (absent > threshold) gaps.push({ 线名: name, 上次章号: nos[i - 1], 缺席章数: absent })
    }
  }
  return gaps.sort((a, b) => a.上次章号 - b.上次章号)
}

// ---------- 主流程 ----------

export async function validateOutput({ root, mode = 'deliver' }) {
  root = resolve(root)
  const problems = []
  const fail = (code, file, message) => problems.push({ severity: 'error', code, file, message })
  const warn = (code, file, message) => problems.push({ severity: 'warning', code, file, message })
  // 未完成 vs 做错了：前者是「这一块还没填」，后者是「填了但不符合契约」。
  // 进度模式下未完成只提示（用带 _EMPTY/_UNFILLED 的警告码，降为警告），做错了照旧报错。
  // 早先用「errors.length = 0」在返回前清计数，导致 data.errors 说 0、problems 里却有 error，
  // 同一份结果两个说法（CLI 按 severity 逐条打印，使用者看到满屏「错误」却被告知「错误 0」）。
  const pending = (code, warnCode, file, message) =>
    (mode === 'progress' ? warn(warnCode, file, message) : fail(code, file, message))

  let manifest
  try {
    manifest = await readManifest(root)
  } catch (error) {
    fail(error.code ?? 'E_MANIFEST', '工作/manifest.json', error.message)
    return { ok: false, errors: problems, data: { verdict: '不通过', mode } }
  }
  const bookType = manifest.bookType ?? '网文'
  const plan = productPlan({ bookType })

  const actual = (await walkFiles(root)).filter((f) => !f.rel.endsWith('.tmp'))
  const rels = new Set(actual.map((f) => f.rel))

  // 树：缺文件 / 多文件
  for (const rel of plan.files) {
    if (!rels.has(rel)) fail('E_TREE_MISSING', rel, '缺少契约固定文件')
  }
  const sourceName = manifest.source?.path ? manifest.source.path.split(/[\\/]/).at(-1) : null
  for (const { rel } of actual) {
    const ok =
      plan.files.includes(rel) ||
      VARIABLE_FILE_RULES.some((r) => r.test(rel)) ||
      (sourceName && rel === `原文/${sourceName}`)
    if (!ok) fail('E_TREE_EXTRA', rel, '不属于产物契约的文件，目录外文件一律不属于产物')
  }

  // 固定 Markdown 产物：段名、专题判定、待填状态
  const productOf = (rel) => {
    if (rel === '故事底本/故事剧情/全书大纲.md') return '全书大纲'
    if (rel === '故事底本/故事剧情/开篇三章.md') return '开篇三章'
    if (rel === '故事底本/全书设定/世界观.md') return '世界观'
    if (rel === '故事底本/全书设定/金手指.md') return '金手指'
    if (rel === '故事底本/文风.md') return '文风'
    if (rel === '原文/作者的话.md') return '作者的话'
    if (rel.startsWith('故事底本/故事剧情/卷纲/')) return '卷纲'
    if (rel.startsWith('故事底本/故事剧情/幕纲/')) return '幕纲'
    if (rel.startsWith('故事底本/全书设定/专题/')) return '专题'
    return null
  }

  const texts = new Map()
  for (const rel of plan.files) {
    if (!rel.endsWith('.md') || !rels.has(rel)) continue
    texts.set(rel, await readFile(join(root, rel), 'utf8'))
  }
  // 按卷生成的可变产物（卷纲/幕纲）同样受段名契约约束。
  for (const { rel, full } of actual) {
    if (texts.has(rel)) continue
    if (/^故事底本\/故事剧情\/(卷纲|幕纲)\//.test(rel) && rel.endsWith('.md')) {
      texts.set(rel, await readFile(full, 'utf8'))
    }
  }
  const state = { skeleton: 0, filled: 0 }
  for (const [rel, text] of texts) {
    const product = productOf(rel)
    // 骨架说明行（引用块）里提到占位字样不算未填。
    const body = text.replace(/^>.*$/gm, '')
    const isSkeleton = body.includes('（待填）')
    isSkeleton ? state.skeleton++ : state.filled++
    if (isSkeleton && mode === 'deliver') fail('E_UNFILLED', rel, '仍含「（待填）」占位，未填写完成')
    if (!product) continue
    const found = headings(text)
    let required = SECTIONS[product]
    if (product === '专题') {
      const verdict = topicVerdict(text)
      if (!verdict || verdict.includes('待填')) {
        if (mode === 'deliver') fail('E_TOPIC', rel, '缺少「涉及判定」结论（涉及/弱涉及/本题材不涉及）')
        required = ['涉及判定']
      } else if (!/^(涉及|弱涉及|本题材不涉及)/.test(verdict)) {
        fail('E_TOPIC', rel, `判定取值「${verdict.slice(0, 30)}」未以合法枚举开头（涉及/弱涉及/本题材不涉及），说明请写在依据行`)
        required = ['涉及判定']
      } else {
        if (verdict === '本题材不涉及' && !/-\s*指向：\S+/.test(text)) warn('W_TOPIC', rel, '「本题材不涉及」未写承接槽位（指向）')
        required = verdict === '涉及' || verdict === '弱涉及' ? required : ['涉及判定']
      }
    }
    for (const s of required) {
      if (!found.includes(s)) fail('E_SECTION', rel, `缺少段名「${s}」`)
    }
  }

  // 卡片字段存在性（T9）：52 个卡片字段此前零校验——路径不被 productOf() 识别，
  // 于是能不能写空话只影响 E_SOURCE，不影响「这一格有没有填」。
  // 只查存在性与非空，不查出处的质量、不判内容好坏（那是 W_QUOTE 与人工抽读的事）。
  const CARD_FIELDS = {
    人物: [
      '姓名（主名）', '别称与马甲', '归属势力', '力量/成长坐标', '首次出场章', '关键章节链',
      '核心关系', '说话风格与人设锚点', '体貌锚点', '衣着与装束', '神态与动作锚',
      '外在目标（要什么）', '内在缺口（缺什么）', '致命弱点（会毁在哪）', '原型词/功能位',
      '结局状态与死亡/退场章', '金句锚',
    ],
    势力与组织: ['名称与俗称', '性质类型', '所在地/据点', '层级结构', '成员表', '势力关系', '与主角关系及演变', '首次出场章', '关键事件章', '状态变化', '结局'],
    地点: ['名称', '别名与真名揭示章', '所属区域', '功能与象征意义', '空间规则', '关联人物与势力', '首次出场章', '进入章', '状态轨迹'],
    物品: ['名称', '类别', '强度等级', '能力与代价', '获得章', '经手与流转链', '象征义', '结局'],
    概念: ['名称', '一句话定义', '首次系统阐释章', '规则细节', '上位/下位概念', '揭示节奏', '与主角的关系'],
  }
  for (const { rel, full } of actual) {
    const m = /^故事底本\/全书设定\/(人物|势力与组织|地点|物品|概念)\//.exec(rel)
    if (!m || !rel.endsWith('.md')) continue
    if (rel.endsWith('索引.md') || rel.endsWith('人物关系.md')) continue
    // 主角的五份文件各有自己的段名契约，不走卡片字段校验（人物卡模板明写「主角不用本卡」）。
    if (/^故事底本\/全书设定\/人物\/主角\//.test(rel)) continue
    const kind = m[1]
    const labels = CARD_FIELDS[kind]
    if (!labels) continue
    const text = texts.get(rel) ?? await readFile(full, 'utf8')
    if (text.includes('（待填）')) continue
    const missing = []
    const empty = []
    for (const label of labels) {
      // 标签匹配放宽模板的三种常见写法：括号修饰、斜杠并称、章后缀。
      // 注意 `\s*` 会吃掉换行，「- 层级结构：」空值行就会把下一行当成自己的值，
      // 于是「有标签无内容」被误判为「已填」。改用 [ \t]* 只吃同行空白。
      const esc = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      const re = new RegExp(`^-[ \\t]*${esc}(?:章)?(?:[（(][^）)]*[）)])?[ \\t]*[：:][ \\t]*([^\\n]*)$`, 'm')
      const hit = re.exec(text)
      if (!hit) { missing.push(label); continue }
      const value = hit[1].trim()
      // 空值与被模板原样保留的提示词都不算填。
      if (!value || value.startsWith('（') || value === '无内容') empty.push(label)
    }
    if (missing.length) {
      fail('E_CARD_FIELD', rel, `缺 ${missing.length} 个字段标签（${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' 等' : ''}），照模板补齐`)
    }
    if (empty.length) {
      fail('E_CARD_FIELD', rel, `${empty.length} 个字段有标签无内容（${empty.slice(0, 4).join('、')}${empty.length > 4 ? ' 等' : ''}）；填「无（第 N 章）」也不要留空`)
    }
  }

  // 表头与表体
  const tableOf = (rel) => {
    if (rel === '故事底本/故事剧情/分卷总表.md') return '分卷总表'
    if (rel === '工作/逐章记录.md') return '逐章记录'
    if (rel === '故事底本/故事剧情/伏笔台账.md') return '伏笔台账'
    if (rel === '工作/别名词典.md') return '别名词典'
    if (rel === '故事底本/全书设定/人物/人物关系.md') return '人物关系'
    return null
  }
  const tables = new Map()
  for (const rel of texts.keys()) {
    const t = tableOf(rel)
    if (!t) continue
    const table = firstTable(texts.get(rel) ?? '')
    tables.set(t, { rel, table })
    const expected = tableColumns(t)
    if (!table) fail('E_COLUMN', rel, `缺少表格（期望表头：${expected.join('、')}）`)
    else if (table.header.join('|') !== expected.join('|')) {
      fail('E_COLUMN', rel, `表头与契约不一致。期望「${expected.join('、')}」，实际「${table.header.join('、')}」`)
    }
  }

  // 逐章记录行数＝章节数（A-13）
  const rows = tables.get('逐章记录')?.table?.rows ?? []
  if (tables.get('逐章记录')?.table) {
    const recordCols = tableColumns('逐章记录')
    if (rows.length !== manifest.chapterCount) {
      fail('E_ROW_COUNT', '工作/逐章记录.md', `数据行 ${rows.length} 行，应为 ${manifest.chapterCount} 行（＝章节数）`)
    }
    rows.forEach((r, i) => { if (r.length !== recordCols.length) fail('E_COLUMN', '工作/逐章记录.md', `第 ${i + 1} 行列数 ${r.length}，应为 ${recordCols.length} 列（单元格含 | 会裂列，生成侧已转义）`) })
    // 章字数必须是正整数，且应与 manifest 的 chars 一致（脚本填，防止被改成 agent 估算值）。
    const charsIdx = recordCols.indexOf('章字数')
    if (charsIdx >= 0) {
      rows.forEach((r, i) => {
        const cell = String(r[charsIdx] ?? '').trim()
        if (!cell || cell.includes('待填')) return
        if (!/^\d+$/.test(cell)) {
          fail('E_CHARCOUNT', '工作/逐章记录.md', `第 ${i + 1} 行章字数「${cell.slice(0, 20)}」不是正整数（该列由脚本填，不填估算值）`)
          return
        }
        const expect = manifest.chapters?.[i]?.chars
        if (typeof expect === 'number' && Number(cell) !== expect) {
          fail('E_CHARCOUNT', '工作/逐章记录.md', `第 ${i + 1} 行章字数 ${cell} 与 manifest 的 ${expect} 不一致（该列由脚本填，勿手改）`)
        }
      })
    }
    // 取值枚举（Q-23）：情绪、章末钩型与爽点标记；「（待填）」骨架态与空格不报，合法＝以枚举值开头。
    // 「情绪」此前漏在校验之外（ENUMS.情绪 定义了却没人用），填任意词都不会变红。
    for (const [name, values] of [['情绪', ENUMS.情绪], ['章末钩型', ENUMS.钩型], ['爽点标记', ENUMS.爽点标记]]) {
      const idx = recordCols.indexOf(name)
      if (idx < 0) continue
      rows.forEach((r, i) => {
        const cell = String(r[idx] ?? '').trim()
        if (!cell || cell.includes('待填')) return
        if (!values.some((v) => cell.startsWith(v))) {
          fail('E_ENUM', '工作/逐章记录.md', `第 ${i + 1} 行${name}「${cell.slice(0, 20)}」不在枚举内（${values.join('、')}）`)
        }
      })
    }
  }

  // 剧情线缺席（Q-22）：警告级不阻断，进度/交付两模式都报（警告两模式均不清除）。
  for (const g of findLineGaps(rows, THRESHOLDS.剧情线缺席章数上限)) {
    warn('W_LINE_GAP', '工作/逐章记录.md', `剧情线 ${g.线名} 自第 ${g.上次章号} 章后已缺席 ${g.缺席章数} 章`)
  }

  // 伏笔台账：编号、类型、重要度、状态、回收≥埋点（A-19；Q-23 十一列）
  const ledgerCols = tableColumns('伏笔台账')
  const colOf = (name) => ledgerCols.indexOf(name)
  const foreshadows = tables.get('伏笔台账')?.table?.rows ?? []
  foreshadows.forEach((r, i) => {
    const m = /^F(\d+)$/.exec(r[0] ?? '')
    if (!m) { fail('E_FORESHADOW', '故事底本/故事剧情/伏笔台账.md', `第 ${i + 1} 行编号「${r[0]}」应为 F001 起的连续编号`); return }
    if (Number(m[1]) !== i + 1) fail('E_FORESHADOW', '故事底本/故事剧情/伏笔台账.md', `编号 ${r[0]} 不连续，应为 F${String(i + 1).padStart(3, '0')}`)
    // 取值枚举（Q-23）：类型与重要度；「（待填）」骨架态与空格不报，合法＝以枚举值开头。
    for (const [name, idx, values] of [
      ['类型', colOf('类型'), ENUMS.伏笔类型],
      ['重要度', colOf('重要度'), ENUMS.伏笔重要度],
    ]) {
      const cell = String(r[idx] ?? '').trim()
      if (!cell || cell.includes('待填')) continue
      if (!values.some((v) => cell.startsWith(v))) {
        fail('E_ENUM', '故事底本/故事剧情/伏笔台账.md', `编号 ${r[0]} ${name}「${cell.slice(0, 20)}」不在枚举内（${values.join('、')}）`)
      }
    }
    if (!/^(未收|半收|已收|续作预留)/.test(r[colOf('状态')] ?? '')) fail('E_FORESHADOW', '故事底本/故事剧情/伏笔台账.md', `编号 ${r[0]} 状态「${(r[colOf('状态')] ?? '').slice(0, 20)}」未以合法枚举开头（未收/半收/已收/续作预留）`)
    const plant = Number(/(\d+)/.exec(r[colOf('埋点章')] ?? '')?.[1] ?? NaN)
    const pick = Number(/(\d+)/.exec(r[colOf('回收/引爆章')] ?? '')?.[1] ?? NaN)
    if (!Number.isNaN(plant) && !Number.isNaN(pick) && r[colOf('回收/引爆章')] && pick < plant) {
      fail('E_FORESHADOW', '故事底本/故事剧情/伏笔台账.md', `编号 ${r[0]} 回收章 ${r[colOf('回收/引爆章')]} 早于埋点章 ${r[colOf('埋点章')]}`)
    }
  })

  // 索引对账与人物结构（A-09/A-15）
  const indexInfo = {}
  for (const [name, types] of Object.entries(COLLECTIONS)) {
    const rel = `故事底本/全书设定/${name}/索引.md`
    const text = texts.get(rel)
    const table = firstTable(text ?? '')
    const expected = tableColumns(name === '人物' ? '人物索引' : '集合索引')
    if (text && !table) fail('E_COLUMN', rel, `缺少表格（期望表头：${expected.join('、')}）`)
    else if (table && table.header.join('|') !== expected.join('|')) {
      fail('E_COLUMN', rel, `表头与契约不一致。期望「${expected.join('、')}」，实际「${table.header.join('、')}」`)
    }
    // 统计条目文件
    const base = join(root, '故事底本', '全书设定', name)
    let count = 0
    if (name === '人物') {
      const protagonistDir = join(base, '主角')
      if (existsSync(protagonistDir)) {
        for (const d of readdirSync(protagonistDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          count++
          for (const f of ['人物卡', '成长轨迹', '身份与马甲', '目标与动机链', '关系与阵营']) {
            if (!existsSync(join(protagonistDir, d.name, `${f}.md`))) {
              fail('E_INDEX', `故事底本/全书设定/人物/主角/${d.name}/${f}.md`, '主角文件夹缺五文件之一')
            }
          }
        }
      }
      count += countFiles(join(base, '主要配角')) + countFiles(join(base, '次要角色'))
    } else {
      count = types.reduce((s, t) => s + countFiles(join(base, t)), 0)
    }
    const rowsN = table?.rows.length ?? 0
    indexInfo[name] = { rows: table?.rows ?? [], count, files: count }
    // 集合零产出必须报：卡片数与索引行数都为 0 时「相等」是空转，等于「设定库这一块没做」也能过交付。
    // 真书实测：5 张集合索引全空、实体卡一个不建，交付校验照样通过。
    // 但「这一块还没做」与「填错了」不是一回事：进度模式下它是未完成，降为警告（W_INDEX_EMPTY）。
    if (count === 0 && rowsN === 0) {
      pending('E_INDEX', 'W_INDEX_EMPTY', rel, `集合「${name}」为空：索引 0 行且没有任何条目卡，至少建一张卡并登记一行`)
    } else if (table && rowsN !== count) {
      fail('E_INDEX', rel, `索引 ${rowsN} 行，条目文件 ${count} 个，应为相等（主角一行计一文件夹）`)
    }
    for (const r of table?.rows ?? []) {
      const p = r.at(-1) ?? ''
      if (!p || p.includes('待填')) continue
      const asRoot = join(root, p)
      const asCollection = join(root, '故事底本', '全书设定', name, p)
      const abs = existsSync(asRoot) ? asRoot : (existsSync(asCollection) ? asCollection : null)
      if (!abs) {
        fail('E_INDEX', rel, `索引路径不存在：${p}`)
        continue
      }
      if (abs === asCollection && asRoot !== asCollection) {
        warn('W_INDEX', rel, `条目「${r[0]}」路径「${p}」应为产物根相对路径（本次按集合相对路径容错通过）`)
      }
      if (name !== '人物') {
        const relPath = relative(root, abs).split(sep).join('/')
        if (!types.some((t) => relPath.includes(`/${name}/${t}/`))) {
          warn('W_INDEX', rel, `条目「${r[0]}」路径不在其类型子目录下：${p}`)
        }
      }
    }
  }
  const relation = firstTable(texts.get('故事底本/全书设定/人物/人物关系.md') ?? '')
  if (relation) {
    const names = new Set((indexInfo.人物?.rows ?? []).map((r) => r[0]))
    for (const r of relation.rows) {
      for (const side of [r[0], r[2]]) {
        if (side && !side.includes('待填') && !names.has(side)) {
          fail('E_INDEX', '故事底本/全书设定/人物/人物关系.md', `关系表端点「${side}」不在人物索引中`)
        }
      }
    }
  }

  // 幕覆盖（A-08/Q-17）＋ 弧号外键（Q-24，警告级）
  const actFiles = actual.filter((f) => /^故事底本\/故事剧情\/幕纲\//.test(f.rel)).map((f) => f.rel)
  if (bookType === '网文') {
    for (const v of manifest.volumes ?? []) {
      const prefix = `故事底本/故事剧情/幕纲/卷${String(v.no).padStart(2, '0')}-`
      const volActFiles = actFiles.filter((f) => f.startsWith(prefix))
      const n = volActFiles.length
      if (n === 0) {
        if (mode === 'deliver') fail('E_ACTS', '故事底本/故事剧情/幕纲/', `卷${v.no} 没有幕纲文件`)
        else warn('W_ACTS', '故事底本/故事剧情/幕纲/', `卷${v.no} 尚无幕纲文件（进行中）`)
      } else if (n < ENUMS.每卷幕数[0] || n > ENUMS.每卷幕数[1]) {
        warn('W_ACTS', '故事底本/故事剧情/幕纲/', `卷${v.no} 幕数 ${n} 超出常见区间 2-6，请记例外说明`)
      }
      const volRel = `故事底本/故事剧情/卷纲/卷${String(v.no).padStart(2, '0')}-`
      const volFile = actual.find((f) => f.rel.startsWith(volRel))
      if (volFile) {
        const text = await readFile(volFile.full, 'utf8')
        const arcs = arcRows(text)
        if (arcs !== null && arcs !== n) {
          fail('E_ACT_COVER', volFile.rel, `卷纲事件弧 ${arcs} 条，幕纲 ${n} 份，应为相等`)
        }
        // 弧号外键（Q-24）：与 E_ACT_COVER 并存——E_ACT_COVER 查数量，W_ARC_REF 查外键，不互斥。
        const volArcs = new Set()
        const table = arcTable(text)
        let arcCol = -1
        if (table) {
          arcCol = table.header.indexOf('弧号')
          if (arcCol === -1) {
            warn('W_ARC_REF', volFile.rel, '卷纲「事件弧清单」缺「弧号」列（A01 起连续），幕纲弧号无法对账')
          } else {
            for (const r of table.rows) {
              const am = /(A\d{2,})/.exec(String(r[arcCol] ?? ''))
              if (am) volArcs.add(am[1])
            }
          }
        }
        // 幕纲「与卷纲的对应」段应含弧号，且弧号存在于所属卷纲的弧清单。
        for (const actRel of volActFiles) {
          const actText = texts.get(actRel) ?? await readFile(join(root, actRel), 'utf8')
          const seg = sectionText(actText, '与卷纲的对应')
          const refs = [...new Set(seg.match(/A\d{2}/g) ?? [])]
          if (!refs.length) warn('W_ARC_REF', actRel, '幕纲「与卷纲的对应」段缺弧号（应填卷纲弧号，如 A02）')
          for (const a of refs) {
            if (arcCol !== -1 && !volArcs.has(a)) warn('W_ARC_REF', actRel, `幕纲弧号 ${a} 在卷纲弧清单中不存在`)
          }
        }
      }
    }
  } else {
    const units = (manifest.chapters ?? []).filter((c) => !(c.no === 0 && c.title === '前言')).length
    if (actFiles.length !== units) {
      fail('E_ACTS', '故事底本/故事剧情/幕纲/', `出版书幕纲 ${actFiles.length} 份，应为 ${units} 份（＝原文单元数）`)
    }
  }

  // 出处（A-14）：只查条目行（列表项）。错误＝缺章号，警告＝引句密度不足。仅交付模式且已填写的文件。
  // 表格行不查：弧清单/索引等表格自带章号列，另由人工抽查（A-19）兜底。
  // 引句按文件密度报（Q-30）：真书实测按行报会在 49 个文件各报一次，等于全片报警、无辨别力。
  // 坐标行、否定式说明、分工说明与坐标段（揭示节奏/使用记录等）不进分母，见 contract.mjs 的 QUOTE_RULE。
  if (mode === 'deliver') {
    const excluded = ['索引.md', '人物关系.md', '伏笔台账.md', '文风.md', '作者的话.md', '分卷总表.md']
    for (const { rel, full } of actual) {
      if (!rel.startsWith('故事底本/') || !rel.endsWith('.md')) continue
      if (excluded.some((x) => rel.endsWith(x) || rel.includes(`/${x}`))) continue
      const text = await readFile(full, 'utf8')
      if (text.includes('（待填）')) continue
      if (rel.startsWith('故事底本/全书设定/专题/') && topicVerdict(text) === '本题材不涉及') continue
      let missing = 0
      let claims = 0
      let quoted = 0
      let proseClaims = 0
      let proseQuoted = 0
      let section = ''
      const samples = []
      for (const line of text.split(/\r?\n/)) {
        const h = /^#{2,3}\s+(.+?)\s*$/.exec(line.trim())
        if (h) { section = h[1]; continue }
        const t = line.trim()
        // 散文段落也是结论的常见写法（Q-30 跟进）：原文里「把结论写成散文」能绕开覆盖率分母。
        // 但散文里混着两类东西，不能一视同仁：
        //   ① 引述型结论（「血统等级是总纲…」）——该配原文引句，进分母；
        //   ② 叙述型摘要（编号事件链「1. 芝加哥火车站…」、幕定位/幕目标这类概述）——本身就是缩写，
        //      要求每条嵌原文引句只会逼出凑数的硬引，不进分母（真书实测：幕02 有 12 条编号事件链，
        //      若全进分母会把覆盖率从 42% 压低到 26%，而问题并不在这些行）。
        if (!t.startsWith('-')) {
          if (!t || t.startsWith('>') || t.startsWith('|') || t.startsWith('#')) continue
          if (!SOURCE_PATTERN.test(t)) continue
          if (QUOTE_RULE.叙述型散文.test(t)) continue
          if ([...t.replace(/[\s\p{P}]/gu, '')].length < QUOTE_RULE.散文最短结论长度) continue
          if (QUOTE_RULE.coordinateSections.includes(section)) continue
          claims += 1
          proseClaims += 1
          if (QUOTE_PATTERN.test(t)) { quoted += 1; proseQuoted += 1 }
          continue
        }
        const body = t.replace(/^-\s*/, '').trim()
        if (!body || body === '无' || body === '（待填）') continue
        // 元行（判定的结论与指向、模板字段标签行）不是待出处的结论；依据行自带出处照常检查。
        if (/^(判定|指向|金手指名称)：/.test(body) || SOURCE_META_LABELS.test(body)) continue
        // 值为空的段标题行（「- 规则与边界：」冒号后留空、子条目另起一行）是结构不是结论。
        // 真书实测：概念卡用这个写法，标签不在白名单里，8 张卡全被判缺出处，而子条目其实逐条带了章号。
        if (/^[^：:]{1,20}[：:]\s*$/.test(body)) continue
        if (/^(名称|姓名|别称|类别|类型|性质|归属|层级|据点|位置|编号|原型词|功能位|主名|实体类型|立场|首次出场|结局|定位|所属区域|一句话世界|一句话定义|对象|对象A|对象B|幕号与幕名|起止章|卷号与卷名|卷名来源|弧名|时段|章数|字数)：/.test(body)) continue
        if (!SOURCE_PATTERN.test(t)) { missing++; if (samples.length < 3) samples.push(body.slice(0, 40)); continue }
        // 不该有引句的行：不进口径，既不进分母也不报缺
        if (QUOTE_RULE.negativeBare.test(body) || QUOTE_RULE.negativeValue.test(body)) continue
        if (QUOTE_RULE.coordinate.test(body)) continue
        if (QUOTE_RULE.coordinateSections.includes(section)) continue
        if (QUOTE_RULE.dutyNote.test(body)) continue
        if (QUOTE_RULE.enumeration(body)) continue
        claims += 1
        if (QUOTE_PATTERN.test(t)) quoted += 1
      }
      if (missing) fail('E_SOURCE', rel, `${missing} 条结论缺「第 N 章」出处。示例：${samples.join('；')}`)
      if (claims >= QUOTE_RULE.minClaims) {
        const coverage = quoted / claims
        if (coverage < QUOTE_RULE.minCoverage) {
          warn('W_QUOTE', rel, `${claims} 条引述型结论中仅 ${quoted} 条带原文引句（${Math.round(coverage * 100)}% < ${Math.round(QUOTE_RULE.minCoverage * 100)}%），抽读时核对`)
        }
      }
      // T1：散文件（结论以段落而非「-」列表写出）单独报一次，让这部分内容可统计。
      // 目的不是判它差——散文本身是合法写法——而是让「哪几个文件主要靠散文撑起来」在交付报告里看得见。
      // 只报一句、按文件汇总，不逐行刷屏：真书实测逐行报会在 49 个文件各报一次，等于全片报警。
      if (proseClaims >= QUOTE_RULE.minClaims) {
        const proseCoverage = proseQuoted / proseClaims
        if (proseCoverage < QUOTE_RULE.minCoverage) {
          warn('W_PROSE', rel, `${proseClaims} 条散文结论中仅 ${proseQuoted} 条嵌原文引句（${Math.round(proseCoverage * 100)}%），该文件主要靠散文承载结论，抽读时优先看`)
        }
      }
    }
  }

  const errors = problems.filter((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning')
  // 进度模式「不阻断」：产物结构有效（有 manifest）就退 0，未完成项已在上游降为警告。
  // 这里不再清 errors —— data.errors 必须永远等于 problems 里 severity=error 的条数。
  const structural = errors.some((e) => e.code === 'E_MANIFEST')
  const batchDone = (manifest.batches ?? []).filter((b) => b.status === 'done').length
  const batchTotal = (manifest.batches ?? []).length
  let verdict
  if (mode === 'progress') verdict = '进行中'
  else if (errors.length) verdict = '不通过'
  else if (warnings.length) verdict = '需修改'
  else verdict = '通过'
  return {
    ok: mode === 'progress' ? !structural : errors.length === 0,
    errors: problems,
    data: {
      verdict, mode, bookType,
      files: { ...state, total: state.skeleton + state.filled },
      batches: { done: batchDone, total: batchTotal },
      errors: errors.length,
      warnings: warnings.length,
    },
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).length
}

// 卷纲「事件弧清单」段的表格（Q-24）：段内第一个表；无表返回 null。
function arcTable(volText) {
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

function arcRows(volText) {
  if (!/^#{2,3}\s+事件弧清单/m.test(volText)) return null // 段缺＝不判（与既有 E_ACT_COVER 语义一致）
  return arcTable(volText)?.rows.length ?? 0
}


export function parseArgs(argv) {
  const options = { root: undefined, mode: 'deliver', json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--mode') {
      const v = argv[++i]
      if (v !== 'deliver' && v !== 'progress') throw new Error(`--mode 只接受 deliver 或 progress。${USAGE}`)
      options.mode = v
    } else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}。${USAGE}`)
    else if (options.root === undefined) options.root = arg
    else throw new Error(`多余的参数 ${arg}。${USAGE}`)
  }
  if (!options.help && !options.root) throw new Error(USAGE)
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_ARGS', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  const root = resolve(options.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`产物目录不存在：${root}`)
    process.exitCode = 2
    return
  }
  const result = await validateOutput({ root, mode: options.mode })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const e of result.errors) {
      const tag = e.severity === 'warning' ? '警告' : '错误'
      console.error(`${tag} [${e.code}] ${e.file}: ${e.message}`)
    }
    const d = result.data
    console.log(`总判定：${d.verdict}（错误 ${d.errors}，警告 ${d.warnings}${modeLabel(options.mode)}）`)
    if (options.mode === 'progress') {
      console.log(`完成度：文件已填 ${d.files.filled}/${d.files.total}，批次 ${d.batches.done}/${d.batches.total}`)
    }
  }
  if (!result.ok) process.exitCode = 1
}

function modeLabel(mode) {
  return mode === 'progress' ? '，进度模式不阻断' : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
