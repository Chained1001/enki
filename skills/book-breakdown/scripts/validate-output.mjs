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
  COLLECTIONS, CONTRACT_VERSION, ENUMS, QUOTE_PATTERN, QUOTE_RULE, SECTIONS, SOURCE_META_LABELS, SOURCE_PATTERN, THRESHOLDS,
  VARIABLE_FILE_RULES, VOL_TABLE_PAIRS, productPlan, tableColumns,
} from './contract.mjs'

const PLACEHOLDER = '（待填）'
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

// 取某个段的正文（到下一个同级或更高级标题为止），并去掉引用块说明行。
// 段的标题级别因模板而异：金手指是二级（## 代价与限制），专题是三级（### 定义与范围），
// 所以按段名匹配任意级别（2-4 级），而不是写死 ###——写死 ## 时整段取不到，
// 上层的检查就静默失效（W_NO_COST 第一版正是这样一条永不触发的检查）。
function sectionBody(text, name) {
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
function lcsLen(a, b) {
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
function isPlaceholder(text) {
  return typeof text === 'string' && /待填/.test(text)
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
// 从幕纲「情绪基调与走向」段取出峰值强度注记（M-09）。
//
// 返回：
//   null                 —— 没写峰值，或写的「无」／占位符（不算错，也不算记了）
//   { value, ok: true }  —— 写了且在 ENUMS.峰值强度 内
//   { value, ok: false } —— 写了但不在枚举内（调用方报 E_ENUM）
//
// 为什么单独抽出来：内联在校验循环里时，测试只能断「源码提到过 ENUMS.峰值强度」，
// 而把判定换成写死的四个字后，上方错误信息里的 join(…) 仍然匹配——那种断言
// 断的是「有没有提到」，不是「还做不做这件事」（变异实测就是这么漏的）。
export function peakIntensityOf(toneText) {
  const m = /峰值\s*[：:]\s*([^\n；;，,）)]{0,24})/.exec(String(toneText ?? ''))
  if (!m) return null
  const raw = m[1].trim()
  // 占位符要先判：正则的字符类排掉了「）」，取值会被截成「（待填」，
  // 于是 val === '（待填）' 永远不成立，骨架态会被报成非法取值。
  if (!raw || raw.includes('待填')) return null
  const val = raw.replace(/[（(]\s*$/, '')
  if (!val || /^无/.test(val)) return null
  // 合法写法只有两种：整词（「燃」）或「枚举词＋括注」（「燃（对抗升级）」「喜/关系缓和」）。
  // 判据是「枚举词之后要么结束、要么紧接着一个分隔符」：
  // 用 includes 会放过「喜悦」「大爽点」；用 startsWith 会放过「喜悦」——两种都宁可放过，
  // 而这里要的是「写了别的词就报」，因为逐章记录的同名列是用 E_ENUM 严格拒的。
  const SEP = '（(／/、,，·—－-'
  const ok = ENUMS.峰值强度.some((e) => val === e || (val.startsWith(e) && SEP.includes(val[e.length])))
  return { value: val, ok }
}

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
function looksUnfilled(text, rel) {
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

// 卡片字段清单：每类卡必须出现且非空的字段标签。
// 放在模块顶层是为了能被测试 import——清单与模板脱节时（#20 把「原型词/功能位」拆成两行
// 却没同步这里）测试才抓得到；写在函数体里就永远只能靠夹具碰巧写对。
export const CARD_FIELDS = {
  人物: [
    '姓名（主名）', '别称与马甲', '归属势力', '力量/成长坐标', '首次出场章', '关键章节链',
    '核心关系', '说话风格与人设锚点', '体貌锚点', '衣着与装束', '神态与动作锚',
    '外在目标（要什么）', '内在缺口（缺什么）', '致命弱点（会毁在哪）',
    // 「原型词」与「功能位」在模板里是两行（#20 把原来合并的一行拆开了）：
    // 功能位是闭合枚举、必填；原型词自由填。这里必须按两行查——
    // 沿用旧的合并标签「原型词/功能位」会让每一张按模板填的卡都报「缺 1 个字段标签」。
    '原型词', '功能位',
    '结局状态与死亡/退场章', '金句锚',
  ],
  势力与组织: ['名称与俗称', '性质类型', '所在地/据点', '层级结构', '成员表', '势力关系', '与主角关系及演变', '首次出场章', '关键事件章', '状态变化', '结局'],
  地点: ['名称', '别名与真名揭示章', '所属区域', '功能与象征意义', '空间规则', '关联人物与势力', '首次出场章', '进入章', '状态轨迹'],
  物品: ['名称', '类别', '强度等级', '能力与代价', '获得章', '经手与流转链', '象征义', '结局'],
  概念: ['名称', '一句话定义', '首次系统阐释章', '规则细节', '上位/下位概念', '揭示节奏', '与主角的关系'],
}

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

  // 契约版本（T14）：产物记录它按哪版契约写成。
  // 只报提示、不改判定——旧产物的错误大多数是真错误（缺卡片字段、旧表头），
  // 把它们「按契约变更剔除」等于把真问题一并藏起来。这里给出线索，判定仍按当前契约。
  const contractVersionNote = (() => {
    const got = manifest.contractVersion
    if (got === CONTRACT_VERSION) return null
    if (!got) return `产物未记录契约版本（旧版 prepare 生成），按当前 ${CONTRACT_VERSION} 校验；报出的错误可能是契约变更所致，也可能是真缺陷，需逐条判断`
    return `产物按契约 ${got} 写成，校验器为 ${CONTRACT_VERSION}；差异需逐条判断是契约变更还是真缺陷`
  })()
  if (contractVersionNote) warn('W_CONTRACT_VERSION', '工作/manifest.json', contractVersionNote)

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
    // 骨架态判据是「正文里还有没有真实的（待填）占位」，不是「文件是否存在」（B-06）。
    // 文件存在但通篇占位＝还没做；文件不存在是另一类问题（E_FILES），不混进这个计数。
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
    // 金手指的代价写「无」时须附理由与章号（B-06）。
    // 为什么只警告：一本书真的可以无代价（少数设定如此），硬判错会把合法的书拦下。
    // 但「无」也不能白写——代价是金手指叙事张力的一半，绝大多数「无」是没找到，不是真没有。
    if (product === '金手指') {
      const body = sectionBody(text, '代价与限制')
      // 该段里出现了「无」这一结论
      if (body && (/^\s*[-*]?\s*无\s*[（(]?/m.test(body) || /无代价|无限制|没有代价/.test(body))) {
        // 「章号」二字本身就是模板允许的写法（模板里写「并注明依据章」），
        // 所以要认的是真的章号，或明写「章号」作指针，而不是段里随便出现这两个字。
        const hasChapter = /第\s*[0-9一二三四五六七八九十百零]+\s*章/.test(body)
        if (!hasChapter) {
          warn('W_NO_COST', rel, '「代价与限制」写「无」但没给依据章号。金手指无代价是少数情况，多数是没找到——补一句（第 N 章「原文」），或复核是否真的无代价')
        }
      }
    }
  }

  // 卡片字段存在性（T9）：52 个卡片字段此前零校验——路径不被 productOf() 识别，
  // 于是能不能写空话只影响 E_SOURCE，不影响「这一格有没有填」。
  // 只查存在性与非空，不查出处的质量、不判内容好坏（那是 W_QUOTE 与人工抽读的事）。
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

  // 报告的要素四表（C-25）。
  //
  // 这四张表在一个文件的四个三级小节里，走不了上面「文件名→表名」的一对一映射，所以单独查。
  // 四张表原先完全没有表头契约：E_COLUMN 管不到，模板里写错一列没人知道。
  //
  // 只查含这四个三级标题的文件：快速模式未指定输出路径时只写对话不落文件，报告文件名也由用户定，
  // 所以按内容认而不写死路径。
  //
  // 不做「骨架态跳过」：骨架的报告表头就是模板表头，本来就和契约一致，跳过与否结果相同——
  // 那是走不到的死代码。写了也只会在变异测试里暴露「删掉也不报」，等于没有。
  {
    const REPORT_SECTIONS = [['人物', '报告_人物'], ['设定', '报告_设定'], ['情节线', '报告_情节线'], ['技法', '报告_技法']]
    for (const { rel, full } of actual) {
      if (!rel.endsWith('.md')) continue
      const text = texts.get(rel) ?? await readFile(full, 'utf8')
      if (!/^###\s+人物\s*$/m.test(text)) continue
      for (const [name, key] of REPORT_SECTIONS) {
        const body = sectionBody(text, name)
        const expected = tableColumns(key)
        if (body === null) { fail('E_COLUMN', rel, `要素表缺小节「### ${name}」`); continue }
        const tbl = firstTable(body)
        if (!tbl) fail('E_COLUMN', rel, `「${name}」要素表缺表格（期望表头：${expected.join('、')}）`)
        else if (tbl.header.join('|') !== expected.join('|')) fail('E_COLUMN', rel, `「${name}」要素表表头与契约不一致。期望「${expected.join('、')}」，实际「${tbl.header.join('、')}」`)
      }
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
    // 取值枚举（Q-23/A-09）：情绪、章末钩型、爽点强度、爽点类型；「（待填）」骨架态与空格不报，合法＝以枚举值开头。
    // 「情绪」此前漏在校验之外（ENUMS.情绪 定义了却没人用），填任意词都不会变红。
    for (const [name, values] of [['情绪', ENUMS.情绪], ['章末钩型', ENUMS.钩型], ['爽点强度', ENUMS.爽点强度], ['爽点类型', ENUMS.爽点类型]]) {
      const idx = recordCols.indexOf(name)
      if (idx < 0) continue
      // 爽点类型是条件必填：强度为「无」时这一格本来就是空的，不是缺失。
      const strengthIdx = recordCols.indexOf('爽点强度')
      rows.forEach((r, i) => {
        const cell = String(r[idx] ?? '').trim()
        if (!cell || cell.includes('待填')) {
          if (name === '爽点类型' && strengthIdx >= 0 && String(r[strengthIdx] ?? '').trim() !== '无' && cell === '') {
            const strength = String(r[strengthIdx] ?? '').trim()
            if (strength && !strength.includes('待填')) {
              warn('W_SHARP_TYPE', '工作/逐章记录.md', `第 ${i + 1} 行爽点强度为「${strength}」但没填爽点类型（只有强度为「无」时才可空）`)
            }
          }
          return
        }
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

        // 幕末衔接（T17）：相邻两幕的「出口情绪」与下一幕「入幕情绪」是同一取值、且两幕都没写承接理由时提示。
        // 只警告不改判定——情绪走势合理与否要看剧情，脚本只能发现「该说明的没说」。
        // 不报「扬→抑」这类落差：落差是正常写法，正是幕与幕之间该有的东西。
        // 同值接续也常常是对的（一场大战拆成两幕，情绪当然连得住），所以判定要留出口：
        // 任一幕的「情绪基调与走向」段里写了承接类说明，即视为已交代，不再提示。
        const ACT_SEAM_NOTE = /承接|衔接|接上|延续|落差|转折|未收|延续至|直接切|硬切|同值|连场/
        const actTone = []
        for (const actRel of volActFiles) {
          const actText = texts.get(actRel) ?? await readFile(join(root, actRel), 'utf8')
          const tone = sectionText(actText, '情绪基调与走向')
          if (!tone) continue
          const spanLine = /起止章[：:]\s*([^\n]*)/.exec(actText)?.[1] ?? ''
          const start = Number((/\d+/.exec(spanLine) ?? [])[0] ?? NaN)
          // 三锚点里只取「入幕」「出口」；峰值不参与衔接比对
          const pick = (label) => {
            const m = new RegExp(`${label}\\s*[：:]?\\s*([^\\n；;，,）)]{0,24})`).exec(tone)
            if (!m) return null
            return ENUMS.情绪.find((e) => m[1].includes(e)) ?? null
          }
          actTone.push({ rel: actRel, start: Number.isFinite(start) ? start : null, enter: pick('入幕'), exit: pick('出口'), tone })

          // 峰值强度取值（M-09）：这一段允许写「峰值：燃」这类注记，取自 ENUMS.峰值强度。
          // 解析与判定在 peakIntensityOf（纯函数，可单测）。
          const peak = peakIntensityOf(tone)
          if (peak && !peak.ok) {
            fail('E_ENUM', actRel, `峰值强度「${peak.value}」不在枚举内：${ENUMS.峰值强度.join('／')}。峰值是独立字段，不与情绪基调（${ENUMS.情绪.join('／')}）做映射`)
          }
        }
        // 有起止章的按章号排；没有的保持文件名序（「卷NN-幕NN-」本身自带顺序）
        actTone.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
        for (let i = 0; i + 1 < actTone.length; i += 1) {
          const cur = actTone[i]
          const next = actTone[i + 1]
          if (!cur.exit || !next.enter || cur.exit !== next.enter) continue
          if (ACT_SEAM_NOTE.test(cur.tone) || ACT_SEAM_NOTE.test(next.tone)) continue
          warn('W_ACT_HOOK', next.rel, `上一幕出口情绪与这一幕入幕情绪同为「${cur.exit}」，两幕之间既无情绪落差也没写承接说明；补一句承接理由，或复核其中一处取值`)
        }
      }
    }
    // 结构对账（T2）：三处写着同一件事，写岔了没人拦。逐项都只查「能对上」的部分，
    // 对不上的地方一律报出三处各自的值，让人能直接看出是哪一处写错了。
    {
      // ① 同一弧名在卷纲与幕纲里的起止章必须相等。
      //    卷纲「事件弧清单」有「弧名」「起止章」两列；幕纲文件名带弧名、正文有「起止章：」行。
      const normSpan = (s) => {
        const m = /(\d+)\s*[-–—~至]\s*(\d+)/.exec(String(s ?? ''))
        return m ? `${Number(m[1])}-${Number(m[2])}` : null
      }
      // 幕纲：按文件名里的弧名归到（卷, 弧名）→ {rel, span}
      const actSpans = new Map()
      for (const actRel of actFiles) {
        const name = actRel.split('/').pop().replace(/\.md$/, '')
        const volNo = /^卷(\d+)-/.exec(name)?.[1]
        const arcName = /^卷\d+-幕\d+-(.+)$/.exec(name)?.[1]
        if (!volNo || !arcName) continue
        const actText = texts.get(actRel) ?? await readFile(join(root, actRel), 'utf8')
        const span = normSpan(/起止章[：:]\s*([^\n]*)/.exec(actText)?.[1])
        if (!span) continue
        actSpans.set(`${Number(volNo)}|${arcName}`, { rel: actRel, span })
      }
      for (const v of manifest.volumes ?? []) {
        const volRel = `故事底本/故事剧情/卷纲/卷${String(v.no).padStart(2, '0')}-`
        const volFile = actual.find((f) => f.rel.startsWith(volRel))
        if (!volFile) continue
        const volText = texts.get(volFile.rel) ?? await readFile(volFile.full, 'utf8')
        const table = arcTable(volText)
        if (!table) continue
        const iName = table.header.indexOf('弧名')
        const iSpan = table.header.indexOf('起止章')
        if (iName === -1 || iSpan === -1) continue
        for (const r of table.rows) {
          const arcName = String(r[iName] ?? '').trim()
          const volSpan = normSpan(r[iSpan])
          if (!arcName || !volSpan) continue
          const act = actSpans.get(`${v.no}|${arcName}`)
          if (!act) continue
          if (act.span !== volSpan) {
            fail('E_ARC_SPAN', volFile.rel, `弧「${arcName}」起止章在卷纲写 ${volSpan}，在幕纲（${act.rel.split('/').pop()}）写 ${act.span}，两处应相等`)
          }
        }
      }

      // ② 伏笔编号引用不得悬空。台账「编号」列是唯一权威，别处的 F\d-\d{2} 必须能在台账里找到。
      const ledgerRel = actual.find((f) => f.rel.endsWith('伏笔台账.md'))?.rel
      if (ledgerRel) {
        const ledgerText = texts.get(ledgerRel) ?? await readFile(join(root, ledgerRel), 'utf8')
        const known = new Set()
        for (const line of ledgerText.split(/\r?\n/)) {
          const cells = parseRow(line)
          if (!cells) continue
          const m = /\b(F\d{1,2}-\d{2})\b/.exec(cells[0] ?? '')
          if (m) known.add(m[1])
        }
        // 只有台账里确实登记过编号时才检查，否则整本书的引用都会被判悬空（台账还没开始记）
        if (known.size) {
          for (const { rel, full } of actual) {
            if (!rel.startsWith('故事底本/') || !rel.endsWith('.md')) continue
            if (rel === ledgerRel) continue
            const text = texts.get(rel) ?? await readFile(full, 'utf8')
            const dangling = new Set()
            for (const m of text.matchAll(/\b(F\d{1,2}-\d{2})\b/g)) {
              if (!known.has(m[1])) dangling.add(m[1])
            }
            if (dangling.size) {
              fail('E_FORESHADOW_REF', rel, `引用了伏笔台账里不存在的编号：${[...dangling].join('、')}（台账共登记 ${known.size} 条）`)
            }
          }
        }
      }

      // ③ 人物卡「首次出场章」与别名词典同主名的「首次出现章」必须一致，且卡主名须在词典主名列里。
      // 注意：上面的 texts 只装了契约计划内的文件与卷纲/幕纲，别名词典与人物卡都不在其中，
      // 所以这里一律从 full 读，不能走 texts——走了会静默跳过，检查等于不存在（开发中踩过一次）。
      const dictFile = actual.find((f) => f.rel.endsWith('别名词典.md'))
      const cardFiles = actual.filter((f) => /人物\/(主角|主要配角|次要角色)\//.test(f.rel) && f.rel.endsWith('.md'))
      if (dictFile && cardFiles.length) {
        const dictText = await readFile(dictFile.full, 'utf8')
        const dictFirst = new Map() // 主名 → 首个「首次出现章」数字
        const colIdx = { main: 0, first: -1 }
        for (const line of dictText.split(/\r?\n/)) {
          const cells = parseRow(line)
          if (!cells) continue
          if (colIdx.first === -1) {
            const f = cells.indexOf('首次出现章')
            if (f !== -1) { colIdx.first = f; colIdx.main = cells.findIndex((c) => c === '主名') === -1 ? 0 : cells.findIndex((c) => c === '主名'); continue }
          }
          const main = String(cells[colIdx.main] ?? '').trim()
          if (!main || /^-+$/.test(main) || main === '主名') continue
          if (dictFirst.has(main)) continue
          const first = Number((/\d+/.exec(String(cells[colIdx.first] ?? '')) ?? [])[0] ?? NaN)
          if (Number.isFinite(first)) dictFirst.set(main, first)
        }
        if (dictFirst.size) {
          for (const { rel, full } of cardFiles) {
            const text = await readFile(full, 'utf8')
            // 逐行找，不用带 ^ 的多行正则：^ 在没有 m 标志时只匹配全文开头，
            // 而卡片第一行是「# 标题」，于是永远匹配不上（开发中踩过一次，闸门静默失效）。
            const fieldOf = (label) => {
              const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(`- ${label}`))
              return line ? line.replace(/^[^：:]*[：:]\s*/, '').trim() : null
            }
            const main = fieldOf('姓名（主名）')
            if (!main || main === '（待填）') continue
            if (!dictFirst.has(main)) {
              warn('W_FIRST_SEEN', rel, `卡片主名「${main}」不在别名词典主名列中，首现章无法对账`)
              continue
            }
            const cardFirst = Number((/\d+/.exec(fieldOf('首次出场章') ?? '') ?? [])[0] ?? NaN)
            if (Number.isFinite(cardFirst) && cardFirst !== dictFirst.get(main)) {
              warn('W_FIRST_SEEN', rel, `「${main}」首次出场章卡片写 ${cardFirst}，别名词典写 ${dictFirst.get(main)}，应对齐`)
            }
          }
        }
      }

      // ④ 对应层产物已存在，文件里却仍标「未拆／待 0X」——状态没跟上。
      const volFiles = actual.filter((f) => /^故事底本\/故事剧情\/卷纲\//.test(f.rel))
      const STALE_VOL = /第\s*0?\d+\s*卷.{0,6}(未拆|待拆|尚未)|卷纲.{0,4}(未拆|待拆)/
      if (volFiles.length > 0) {
        for (const { rel, full } of actual) {
          if (!rel.startsWith('故事底本/全书设定/') && !rel.endsWith('全书大纲.md')) continue
          if (!rel.endsWith('.md')) continue
          const text = texts.get(rel) ?? await readFile(full, 'utf8')
          const m = STALE_VOL.exec(text)
          if (m) {
            warn('W_STALE_MARK', rel, `文件里仍标着「${m[0].slice(0, 24)}」，但卷纲已有 ${volFiles.length} 份，状态说明未更新`)
          }
        }
      }
    }
  } else {
    // 出版书：卷层与网文同形，只是幕的口径不同——幕＝原文单元，不是事件弧。
    // 因此这里不查「弧数＝幕数」（出版书不拆事件弧，那个等式没有意义），
    // 而查「全部幕纲份数＝原文单元数」，并且逐卷核幕纲确实挂在所属卷下。
    const units = (manifest.chapters ?? []).filter((c) => !(c.no === 0 && c.title === '前言')).length
    // 逐卷先算一遍，缺哪一卷要能指出来——只说「总数不对」等于让人自己数。
    const emptyVols = (manifest.volumes ?? []).filter((v) => {
      const prefix = `故事底本/故事剧情/幕纲/卷${String(v.no).padStart(2, '0')}-`
      return actFiles.filter((f) => f.startsWith(prefix)).length === 0
    })
    // 缺口信息只报一次：总数对不上时并进 E_ACTS 的消息里，不另开一条。
    // 两条消息说同一件事（实测全删时 E_ACTS 与逐卷各报一遍）会让报告更难读，也没多一个信息。
    const where = emptyVols.length && emptyVols.length < (manifest.volumes ?? []).length
      ? `；其中${emptyVols.map((v) => `卷${v.no}（${v.name}）`).join('、')}一份都没有`
      : ''
    if (actFiles.length !== units) {
      fail('E_ACTS', '故事底本/故事剧情/幕纲/', `出版书幕纲 ${actFiles.length} 份，应为 ${units} 份（＝原文单元数）${where}`)
    }
    for (const v of manifest.volumes ?? []) {
      const volRel = `故事底本/故事剧情/卷纲/卷${String(v.no).padStart(2, '0')}-`
      const volFile = actual.find((f) => f.rel.startsWith(volRel))
      if (!volFile) {
        pending('E_VOLUME_MISSING', 'W_VOLUME_MISSING', '故事底本/故事剧情/卷纲/', `出版书卷${v.no}（${v.name}）没有卷纲文件`)
        continue
      }
      // 总数对得上却有卷为空（另一卷多出来），这时 E_ACTS 不响，得逐卷报。
      if (actFiles.length === units && emptyVols.some((e) => e.no === v.no)) {
        const prefix = `故事底本/故事剧情/幕纲/卷${String(v.no).padStart(2, '0')}-`
        pending('E_VOLUME_MISSING', 'W_VOLUME_MISSING', prefix, `出版书卷${v.no}（${v.name}）没有幕纲文件（应按原文单元逐份生成）`)
      }
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
      let weak = 0
      let proseClaims = 0
      let proseQuoted = 0
      let proseWithoutSource = 0
      let section = ''
      const samples = []
      const weakSamples = []
      const noSrcSamples = []
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
          // 两类散文分开算，都不许静默 continue（#24）。
          // 判据是「这一行是不是在讲本作的一句话结论」，不是「有没有写章号」——
          // 后者正是可被规避的那个维度：写了章号会掉覆盖率，不写就满绿。
          if (QUOTE_RULE.叙述型散文.test(t)) continue
          if ([...t.replace(/[\s\p{P}]/gu, '')].length < QUOTE_RULE.散文最短结论长度) continue
          if (QUOTE_RULE.coordinateSections.includes(section)) continue
          claims += 1
          proseClaims += 1
          if (QUOTE_PATTERN.test(t)) {
            quoted += 1
            proseQuoted += 1
          } else if (SOURCE_PATTERN.test(t)) {
            // 带章号却没人话引句：和「-」列表行同罪，进分母且算缺
            missing += 1
            if (samples.length < 3) samples.push(t.slice(0, 40))
          } else {
            // 不带章号的散文结论：以前整行跳过，于是「把结论写成散文」能绕开分母。
            // 现在照样进分母（已在上面 +1），并单独计数——它缺的是出处，不是引句，
            // 所以不并进 missing（那是 E_SOURCE 的口径），由 W_PROSE_NOSRC 汇总报。
            proseWithoutSource += 1
            if (noSrcSamples.length < 3) noSrcSamples.push(t.slice(0, 40))
          }
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
        const hasQuote = QUOTE_PATTERN.test(t)
        if (hasQuote) {
          quoted += 1
          // T18：引句不可替代性。深度闸门不用「有没有带章号」（那是 E_SOURCE 的事），
          // 而用「换个书名这句话还成立吗」——引句里没有任何具体名词（人名、地名、器物、数字）时，
          // 它证明不了你读过这一本，只是一句放之四海皆可的抒情。
          // 只警告：很多好引句确实靠语气取胜，脚本判不了那种；这里只把「明显可替换」的挑出来。
          // 关键：只对**引号内**的文字判，不能对整行判——整行含「第 1 章」，
          // 而「一」是中文数字，会让每一行都判成「具体」，闸门等于失效。
          const inner = (QUOTE_PATTERN.exec(t) ?? [''])[0].slice(1, -1)
          if (inner && !QUOTE_RULE.concrete.test(inner)) {
            weak += 1
            if (weakSamples.length < 3) weakSamples.push(inner.slice(0, 40))
          }
        }
      }
      if (missing) fail('E_SOURCE', rel, `${missing} 条结论缺「第 N 章」出处。示例：${samples.join('；')}`)
      if (weak) {
        warn('W_QUOTE_WEAK', rel, `${weak} 条引句里没有具体名词（人名／地名／器物／数字），换个书名照样成立，证明不了读过这本。示例：${weakSamples.join('；')}`)
      }
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
      // #24：不带章号的散文结论。以前这类行整行 continue，既不进分母也不报任何事——
      // 于是「把结论写成散文且不写章号」是唯一一种能让内容从账本里彻底消失的写法。
      // 现在它进分母（所以 W_PROSE 的百分比会掉，这是预期结果），并在这里点名。
      // 只警告不阻断：散文是合法写法，缺章号也常见于「概括整卷走向」这类确实不落在单章的话。
      if (proseWithoutSource) {
        warn('W_PROSE_NOSRC', rel, `${proseWithoutSource} 条散文结论没写「第 N 章」出处，无法回原文核对，也不计入引句核验。示例：${noSrcSamples.join('；')}`)
      }
    }
  }

  // 分卷总表 ↔ 卷纲一致性（C-19）。
  //
  // 总表的叙述列是「从卷纲压缩来的」，但压缩和照抄在产物上长得一样。真书实测：
  // 「一句话钩子」与卷纲同段逐字相同——说明「压缩」实为复制。更糟的是卷纲改了总表没跟上，
  // 总表就静默过期（实测同一段弧在两个文件里写了两个章号区间）。
  //
  // 只用「照抄」这一个方向报警：重合高说明这一格是把卷纲整段搬过来，没有压缩。
  //
  // 不判「重合低＝过期」。压缩本来就该只留关键词：卷纲写「压力源是公司倒闭带来的恐惧」，
  // 总表压成「公司」是正确写法，字面重合接近 0。拿低重合当过期会把这个工具最该鼓励的
  // 谨慎写法全部误报——第一版就是这么写的，fixture 里四个正常列全被报了出来。
  // 过期有别的证据可查（卷纲的弧章号区间 vs 总表起止章，已有 E_ARC_SPAN），不靠「这格和那段不像」。
  if (mode === 'deliver') {
    const tableRel = '故事底本/故事剧情/分卷总表.md'
    const tableFile = actual.find((f) => f.rel === tableRel)
    const volRelFiles = actual.filter((f) => /^故事底本\/故事剧情\/卷纲\/.+\.md$/.test(f.rel))
    if (tableFile && volRelFiles.length) {
      const tableText = await readFile(tableFile.full, 'utf8')
      {
        const tbl = firstTable(tableText)
        if (tbl?.header?.length) {
          const idxOf = (name) => tbl.header.findIndex((c) => c.trim() === name)
          const volNoCol = idxOf('卷')
          const volNameCol = idxOf('卷名')
          // 卷号 → 该卷卷纲的正文（按文件名里的「卷NN」对）
          const volTextByNo = new Map()
          for (const vf of volRelFiles) {
            const m = /卷(\d{1,2})/.exec(vf.rel.split('/').pop())
            if (!m) continue
            volTextByNo.set(String(Number(m[1])), await readFile(vf.full, 'utf8'))
          }
          for (const row of tbl.rows) {
            const rawNo = String(row[volNoCol] ?? '').trim()
            if (!rawNo || /^-+$/.test(rawNo)) continue
            const no = String(Number((/(\d+)/.exec(rawNo) ?? [])[1] ?? NaN))
            const volText = volTextByNo.get(no)
            if (!volText) continue
            const where = `卷${no}${volNameCol >= 0 ? `（${String(row[volNameCol] ?? '').trim()}）` : ''}`
            for (const [tableCol, volSection] of VOL_TABLE_PAIRS) {
              const ci = idxOf(tableCol)
              if (ci < 0) continue
              const cell = String(row[ci] ?? '').trim()
              const body = sectionBody(volText, volSection)
              if (body === null) continue // 该卷纲没这一段：段名缺失另有 E_SECTION 管，这里不重复报
              // 任一侧还是占位就跳过比对。两侧都占位时反向重合是 100%，一份骨架会被报成
              // 「照抄卷纲」——prepare 建完骨架正是这个状态，会立刻对每本书报一堆假告警。
              //
              // 合成一处判据而不是「格子一处、段一处」：分写时格子那条永远先触发，
              // 段那条成了走不到的死代码，变异测不出它，删掉也测不出——那种保护等于没有。
              // 用子串匹配而不是全等，是因为「待填」「(待填)」这些手写变体都会出现。
              if (isPlaceholder(cell) || isPlaceholder(body)) continue
              const bodyFlat = body.replace(/[\s\p{P}]/gu, '')
              const cellFlat = cell.replace(/[\s\p{P}]/gu, '')
              if (!bodyFlat || !cellFlat) continue
              // 判据只有一条：**这一格把卷纲那段保留了多少**（段的字有多少按顺序出现在格里）。
              //
              // 两个方向都试过，都不是它：
              //   ① 正向（格子的字有多少来自该段）对短关键词恒为 1——把段压成「公司」两字，
              //      「公司」当然在段里，100%。于是所有写得好的压缩全被判成照抄。
              //   ② 双向取 min 相当于要求两串长度也接近，会把「整段搬来再补几句评语」漏掉：
              //      段 10 字、格子 43 字，min 只剩 23%，可那一段明明一个字没省。
              //
              // 反向单看才是对的：「没压缩」的准确含义就是「段的字基本都在」。
              // 加了多少自己的话不影响这个判断——一个字没省下就叫没压缩。
              // 真压缩必然丢掉大半内容，反向重合自然掉下去。
              const ratio = lcsLen(cellFlat, bodyFlat) / bodyFlat.length
              if (ratio >= THRESHOLDS.总表照抄重合度) {
                warn('W_TABLE_STALE', tableRel,
                  `${where}的「${tableCol}」把卷纲「${volSection}」整段的字保留了 ${Math.round(ratio * 100)}%，是照抄不是压缩；总表这一列等于白填`)
              }
            }
          }
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
  // 状态两套账（B-06）：manifest.files 的状态是 prepare 时写死的，之后没人更新，
  // 于是「填满的文件仍标 skeleton」或「骨架被标成 done」这类漂移一直是静默的。
  // 这里拿磁盘内容（正文还有没有占位）与 manifest 的标签对一遍，只告警不改判定：
  // 标签错了不影响产物本身，但它会让 cost.mjs 按状态过滤时漏算（见 cost.mjs 的注释）。
  // 旧产物没有 manifest.files 时跳过，不当作缺陷。
  {
    const declared = manifest.files ?? {}
    const known = new Set(['done', 'filled', 'skeleton', 'validated', 'pending'])
    let drift = 0
    for (const [rel, label] of Object.entries(declared)) {
      if (rel.startsWith('原文/')) continue // 原文是复制来的，不做占位判定
      if (!known.has(label)) continue
      if (rel === '工作/manifest.json') continue
      const entry = actual.find((f) => f.rel === rel)
      if (!entry) continue // 文件缺失另有检查，不在这里报
      const text = await readFile(entry.full, 'utf8')
      const reallySkeleton = looksUnfilled(text, rel)
      const saysSkeleton = label === 'skeleton' || label === 'pending'
      if (reallySkeleton !== saysSkeleton) {
        drift += 1
        if (drift <= 5) {
          warn('W_STATE_DRIFT', rel, saysSkeleton
            ? `manifest 记「${label}」，但文件里已无「（待填）」占位，状态未更新`
            : `manifest 记「${label}」，但文件里仍有「（待填）」占位，状态标早了`)
        }
      }
    }
    if (drift > 5) warn('W_STATE_DRIFT', '工作/manifest.json', `另有 ${drift - 5} 个文件状态与内容不符，未逐条列出`)
  }

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
