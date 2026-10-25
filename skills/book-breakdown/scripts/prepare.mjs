#!/usr/bin/env node
// 拆书预处理与初始化（PRD「产品流程」节阶段 2）：校验原文、编码检测、宽正则切章、全局重编号、
// 六类噪音剥离、作者的话归集、三级分卷检测、出版书判定、建目录树、骨架落位、定量指纹、manifest 状态块。
// 段名、列名、阈值、目录契约唯一来源是 contract.mjs（技术文档 D-01）。
// 评审 P25：prepare() 拆为导出的 analyze()（纯计算，可读文件不落盘）＋persist()（落盘），对外签名与返回不变。
// 用法：prepare.mjs <原文 txt> [--out <产物目录>] [--force --i-know] [--dry-run] [--json] [--help]
// 退出码：0 成功，1 业务失败，2 参数错误。写文件：先写临时文件再重命名；已存在的产物目录默认续跑，--force --i-know 归档后重建（D-18）。
// --force 单用会报参数错并列出「会丢多少个已填文件」与归档路径（B-07）：归档不是删除，但人要重做一遍。
import { existsSync, statSync, renameSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IoError, readManifest, writeFileAtomic } from './io.mjs'
import {
  COLLECTIONS, COLUMNS, CONTRACT_VERSION, EMOTION_TAG_WORDS, ENUMS, FATIGUE_WORDS, PROTAGONIST_FILES, SCENE_MARKERS, SECTIONS, STAGES, THRESHOLDS, TOPICS,
  mdSkeleton, outlineSkeleton, productPlan, styleSkeleton, tableColumns, tableSkeleton, topicSkeleton,
} from './contract.mjs'

const USAGE = '用法：prepare.mjs <原文 txt> [--out <产物目录>] [--force --i-know] [--dry-run] [--json] [--help]'

// ---------- 中文数字 ----------

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function cnToInt(text) {
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let current = 0
  for (const ch of text) {
    const d = CN_DIGITS[ch]
    if (d !== undefined) {
      current = d
      continue
    }
    if (ch === '十') { total += (current || 1) * 10; current = 0; continue }
    if (ch === '百') { total += (current || 1) * 100; current = 0; continue }
    if (ch === '千') { total += (current || 1) * 1000; current = 0; continue }
    if (ch === '万') { total = (total + current || 1) * 10000; current = 0; continue }
    return null
  }
  return total + current
}

// ---------- 章节识别（宽正则，龙族边界抽查验证的形态集）----------

const NUM = '[0-9一二三四五六七八九十百千万零两]+'
// 章头识别（#9 修了两个叠加的缺陷）。
//
// 缺陷一：`[\s　：:]` 写在**模板字符串**里时，`\s` 不是合法转义，退化成字面量 s——
//   它实际是 `[s　：:]`，半角空格从来就不是分隔符。所以「第32 章 标题」这种
//   半角空格版式一直识别不出来，只能靠「零分隔符」那条路蒙对。现在改用 String.raw 锁死转义。
//
// 缺陷二：分隔符是 `*`（零或多个），配上缺陷一，等于任何「第N章/回/节」前缀都算章头，
//   于是正文里的词被切断：《十日终焉》「第二回合，许流年挑选了「油门」。」被切成
//   「第2回 / 合，许流年…」24 处，《绍宋》1 处，《我真没想重生啊》「第一节快下课…」1 处。
//   最重的后果不是章数虚高，而是绍宋的卷05 被截成 9 章（其余卷 78–87 章），7 卷结构整体错位。
//
// 修法：「章/幕」保持宽松（真网文大量写作「第32章标题」零分隔，如《道诡异仙》
//   「第八百七十章」），但「回/节」必须带分隔符或行尾——八本实测书里「回」从没当过章标记，
//   出现的全是「回合」。这样收窄不会打死章回体（「第三回 宴桃园」照旧识别）。
const CHAPTER_HEAD = new RegExp(String.raw`^(?:第${NUM}[\s　：:]*(?:章|幕)`
  + String.raw`|第${NUM}[\s　：]*(?:节|回)(?=[\s　：:]|$)`
  + String.raw`|序[\s　]*章|序言|引子|楔子|尾声|终章|番外篇?|后记)`)
const TITLE_SUFFIX = /（[^）]*(?:求|票|打赏|感谢|白银盟|盟主|加更|首订)[^）]*）/g

// 目录页检测（评审 P2）：≥3 个逐行紧邻的标题行（真章节之间必有正文行隔开），整块跳过。
function dropTocMarks(lines, marks) {
  const kept = []
  let i = 0
  while (i < marks.length) {
    let j = i
    while (j + 1 < marks.length && marks[j + 1].index - marks[j].index === 1) j++ // 目录页：标题逐行紧邻；真章节之间必有正文行
    if (j - i + 1 >= 3) {
      let looksLikeToc = true
      for (let k = marks[i].index + 1; k < marks[j].index; k++) {
        const s = lines[k]?.trim() ?? ''
        if (s && [...s].length > 2 && !CHAPTER_HEAD.test(s)) { looksLikeToc = false; break }
      }
      if (looksLikeToc) { i = j + 1; continue }
    }
    kept.push(marks[i])
    i++
  }
  return kept
}

// 单行噪音分类：返回 null 表示保留，否则返回剥离类别（六类，F-17）。
// 评审 P1 修复：全部锚定行首＋限行长＋整行模板，杜绝正文子串误伤。
export function classifyNoise(line) {
  const t = line.trim()
  if (!t) return null
  const len = [...t].length
  const AD = /(?:www\.|https?:\/\/|[a-z0-9]\.(?:com|net|cc|org)|换源|追更地址|本书来自)/i
  const DONE = /^[（(]?(?:本章完|本章未完|未完待续|待续)[）)]?[!！]?$/
  const NEXT = /^(?:下一更|更新时间|(?:今晚|明天|今天|下午|晚上)[^。！？]{0,15}更|\d{1,2}点[^。！？]{0,10}更)[!！。]?$/
  const PS = /^(?:各位书友|书友们|PS[:：]|ps[:：])/
  const BEG = /^求[了点么]?.{0,4}(?:月票|推荐票|订阅|收藏|鲜花|评价票)/
  const THANKS = /^感谢[^。]{0,30}(?:打赏|盟主|白银盟)/
  const LEAVE = /^(?:请假条?|抱歉今天|请假一天|今天有事)[^。！？]{0,20}[。！?]?$/
  const NOTICE = /^(?:【公告】|新书推荐|QQ群[:：]?\d)/
  const STRUCT = /^(?:完本感言|完结感言|上架感言|新书《|第[一二三四五六七八九十百千\d]+[部卷]总结|本卷总结|卷末总结|关于本[卷部][：:])/
  if (len <= 120 && AD.test(t)) return '广告水印'
  if (DONE.test(t)) return '本章完标记'
  if (len <= 40 && NEXT.test(t)) return '更新预告'
  if (STRUCT.test(t) || (len >= 40 && /^(?:总结|感言|关于本)/.test(t))) return '结构附注'
  if (len <= 80 && PS.test(t)) return '作者话'
  if (len <= 60 && BEG.test(t)) return '作者话'
  if (len <= 60 && THANKS.test(t)) return '作者话'
  if (len <= 40 && LEAVE.test(t)) return '作者话'
  if (NOTICE.test(t)) return '番外公告'
  return null
}

function cleanTitle(line) {
  return line.replace(TITLE_SUFFIX, '').trim().slice(0, THRESHOLDS.标题存储字符上限)
}

// 切章：宽正则 + 标题噪音阈值 + 章内噪音剥离 + 全局编号。返回章数组（含清洗后正文与被剥离的附注）。
export function detectChapters(text) {
  const lines = text.split(/\r?\n/)
  let marks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (CHAPTER_HEAD.test(line) && [...line].length <= THRESHOLDS.标题行字符上限) {
      marks.push({ index: i, title: cleanTitle(line), raw: line })
    }
  }
  marks = dropTocMarks(lines, marks)
  const chapters = []
  if (marks.length && marks[0].index > 0) {
    const pre = lines.slice(0, marks[0].index).join('\n').trim()
    if (pre) chapters.push({ no: 0, title: '前言', rawNo: null, start: 0, end: marks[0].index, isHeading: false })
  }
  marks.forEach((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].index : lines.length
    const noMatch = new RegExp(`^第(${NUM})`).exec(m.raw)
    chapters.push({
      no: chapters.length,
      title: m.title,
      rawNo: noMatch ? cnToInt(noMatch[1]) : null,
      start: m.index,
      end,
      isHeading: true,
    })
  })

  // 后记块切分（实测《长安的荔枝》抓到的形态）：末章正文后跟一整段「文后说明」，
  // 它不是章节（不该进章节表、也不该把末章字数抬高），而是作者的话。
  // 处理：章内遇到后记标题行，其后所有行一律归入作者的话，不再计入正文。
  const AFTERWORD_HEAD = /^[（(]?(?:文后说明|后记|作者附记|创作谈|附录说明)[）)]?$/

  // 章内噪音剥离：正文、附注、字数（按去空白字符计）；乱码行（替换符/mojibake 对）直接丢弃计数。
  for (const c of chapters) {
    const kept = []
    const notes = []
    c.garbled = 0
    let afterwordFrom = -1
    for (let i = c.start; i < c.end; i++) {
      const line = lines[i]
      if (i === c.start && c.isHeading) continue // 标题行不进正文
      if (afterwordFrom < 0 && AFTERWORD_HEAD.test(line.trim())) {
        afterwordFrom = i
        c.afterwordLines = c.end - i
      }
      if (afterwordFrom >= 0) { (c.afterword ??= []).push(line.trim()); continue }
      const kind = classifyNoise(line)
      if (kind === '广告水印' || kind === '本章完标记' || kind === '更新预告' || kind === '番外公告') continue
      if (kind === '作者话' || kind === '结构附注') { notes.push(line.trim()); continue }
      if (/[\uFFFD]/.test(line) || /Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]/.test(line)) { c.garbled++; continue }
      kept.push(line)
    }
    c.text = kept.join('\n').trim()
    c.notes = notes
    c.chars = c.text.replace(/\s/g, '').length
  }

  // 超长章标记（spike 卡壳 2：末章混入完本感言/番外/附录时 chars 异常，供批处理预警）。
  const units = chapters.filter((c) => c.isHeading)
  const avg = units.reduce((s, c) => s + c.chars, 0) / (units.length || 1)
  const longThreshold = Math.max(30000, avg * 8)
  for (const c of chapters) if (c.chars > longThreshold) c.outlier = true

  // 短章合并（D-13）：按合并前的正文章数判断；合并后跌破护栏则回退（评审 P9）。
  const headingBefore = chapters.filter((c) => c.isHeading).length
  if (headingBefore >= THRESHOLDS.合并短章最少章节数) {
    const merged = [chapters[0]]
    for (let i = 1; i < chapters.length; i++) {
      const prev = merged.at(-1)
      const cur = chapters[i]
      if (cur.chars < THRESHOLDS.短章字符下限) {
        prev.text += `\n${cur.title}\n${cur.text}`
        prev.notes.push(...cur.notes)
        prev.chars += cur.chars + cur.title.replace(/\s/g, '').length
      } else {
        merged.push(cur)
      }
    }
    renumber(merged)
    if (merged.filter((c) => c.isHeading).length >= THRESHOLDS.最少章节数) return merged
  }
  renumber(chapters)
  return chapters
}

// 全局章号：有前言时前言为 0、正文从 1 起；无前言时正文从 1 起（PRD 命名节）。
function renumber(chapters) {
  const offset = chapters[0]?.title === '前言' ? 0 : 1
  chapters.forEach((c, i) => { c.no = i + offset })
  return chapters
}

// ---------- 分卷三级检测（D-04）与出版书判定（D-09）----------

const VOLUME_HEAD = new RegExp(`^第${NUM}卷`)
const VOLUME_TAIL = new RegExp(`^[（(]?(?:第${NUM}卷|本卷)[）)]?(?:完|终)[）)]?[!！]?$|^本卷终[!！]?$`)

// 分卷一级信号（D-04）：区分「卷首锚点」与「卷末总结行」。
// 绍宋形态：「第二卷总结 兼致歉信」这类行匹配「第N卷」但语义是卷末总结，起点会错一整卷——
// 含总结/感言/致歉等词的行按卷尾信号处理（该章之后切卷），其余按卷首锚点。
const VOLUME_SUMMARY = /总结|感言|致歉|感谢|记录|说明|活动|公告|完本/

function anchorVolumes(chapters, lines) {
  const startNames = new Map()
  const cuts = new Set()
  const anchorCuts = new Set()
  let summaryCuts = 0
  // 评审 P3：正文「第一卷的书页已经泛黄。」会误命中——要求锚点行到下一章标题行之间
  // 没有实质正文（只允许空行或 ≤5 字的零碎行），即锚点独占过渡带。
  const sortedStarts = chapters.map((c) => c.start).sort((a, b) => a - b)
  const standaloneInGap = (lineIdx) => {
    const next = sortedStarts.find((s) => s > lineIdx)
    if (next === undefined) return [...(lines[lineIdx] ?? '')].length <= THRESHOLDS.卷标题字符上限
    for (let k = lineIdx + 1; k < next; k++) {
      const s = (lines[k] ?? '').trim()
      if (s && [...s].length > 1) return false
    }
    return true
  }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!VOLUME_HEAD.test(t) || [...t].length > THRESHOLDS.卷标题字符上限 || !standaloneInGap(i)) continue
    if (VOLUME_SUMMARY.test(t.replace(VOLUME_HEAD, ''))) {
      const owner = chapters.filter((c) => c.start <= i && i < c.end)[0]
      if (owner && owner.no + 1 <= chapters.at(-1).no) { cuts.add(owner.no + 1); summaryCuts++ }
    } else {
      const startCh = chapters.find((c) => c.start > i)
      if (startCh && startCh.no > 1 && startCh.no <= chapters.at(-1).no) { cuts.add(startCh.no); anchorCuts.add(startCh.no) }
      if (startCh) startNames.set(startCh.no, t.replace(new RegExp(`^第${NUM}卷[\\s　]*`), '').trim() || t)
    }
  }
  // 章号重启信号并入（D-04 修正：有锚点也不丢重启证据——绍宋实证作者口径卷界可落在锚点之间）。
  let hasRestart = false
  for (let i = 1; i < chapters.length; i++) {
    const c = chapters[i]
    const prev = chapters[i - 1]
    if (c.rawNo === 1 && prev.rawNo !== null && prev.rawNo > 1) {
      if (c.no > 1 && c.no <= chapters.at(-1).no) { cuts.add(c.no); hasRestart = true }
    }
  }
  if (!cuts.size) return null
  const basis = [
    anchorCuts.size || summaryCuts ? '卷标记行' : null,
    hasRestart ? '章号重启' : null,
  ].filter(Boolean).join('＋') || '卷标记行'
  const points = [chapters[0].no, ...[...cuts].sort((a, b) => a - b)]
  const vols = []
  for (let k = 0; k < points.length; k++) {
    const startCh = points[k]
    const endCh = (points[k + 1] ?? chapters.at(-1).no + 1) - 1
    if (endCh < startCh) continue
    // 锚点名取「落在本卷区间内」的卷首锚点（前言在卷一时，锚点章号晚于卷起点）。
    const name = [...startNames.entries()].find(([no]) => no >= startCh && no <= endCh)?.[1]
      ?? `卷${String(vols.length + 1).padStart(2, '0')}`
    vols.push({ no: vols.length + 1, name, startCh, endCh, basis })
  }
  return vols.length ? vols : null
}

function restartVolumes(chapters) {
  const boundaries = []
  for (let i = 1; i < chapters.length; i++) {
    const c = chapters[i]
    const prev = chapters[i - 1]
    if (c.rawNo === 1 && prev.rawNo !== null && prev.rawNo > 1) boundaries.push(c.no)
  }
  if (!boundaries.length) return null
  const starts = [chapters[0].no, ...boundaries]
  return starts.map((start, k) => ({
    no: k + 1,
    name: `第${k + 1}部`,
    startCh: start,
    endCh: (starts[k + 1] ?? chapters.at(-1).no + 1) - 1,
    basis: '章号重启',
  }))
}

function tailVolumes(chapters, lines) {
  const ends = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!VOLUME_TAIL.test(t)) continue
    const owner = chapters.filter((c) => c.start <= i && i < c.end)[0]
    if (owner && owner.no > 0) ends.push(owner.no)
  }
  if (!ends.length) return null
  const uniq = [...new Set(ends)]
  const starts = [chapters[0].no, ...uniq.map((e) => e + 1)]
  return starts.map((start, k) => ({
    no: k + 1,
    name: `卷${String(k + 1).padStart(2, '0')}`,
    startCh: start,
    endCh: (starts[k + 1] ?? chapters.at(-1).no + 1) - 1,
    basis: '卷完尾标记',
  }))
}

export function detectVolumes(chapters, lines) {
  const fixed = fixVolumes(anchorVolumes(chapters, lines) ?? restartVolumes(chapters) ?? tailVolumes(chapters, lines), chapters)
  return fixed
}

// 区间不倒挂保障（评审 P3/P22）：卷尾标记落在末章时尾段 startCh 会大于 endCh（如 [4,3]），
// 过滤掉空区间并重排卷号，保证产物里每个卷 endCh≥startCh。
function fixVolumes(vols, chapters) {
  if (!vols) return [{ no: 1, name: '全书', startCh: chapters[0].no, endCh: chapters.at(-1).no, basis: '无卷信号' }]
  return vols
    .map((v, k) => ({ ...v, startCh: k === 0 ? chapters[0].no : v.startCh, endCh: Math.min(v.endCh, chapters.at(-1).no) }))
    .filter((v) => v.endCh >= v.startCh)
    .map((v, k) => ({ ...v, no: k + 1 }))
}

// 出版 vs 网文（F-18）。判据只看均章字数：八本实测书里均章是唯一能把两类
// 干净分开的一维（网文 2,171–14,386，出版 19,517–23,900，间隙 14,386→19,517
// 宽过阈值 15,000）。此处曾经是「章数 < 30 且 均章 > 15,000」的双条件，
// 章数一票否决把《龙族3·黑月之潮》（58 章、均章 19,517）判成网文，
// 而它和同套的龙族 1/2 是同一版式——三册跑出两种产物目录树
// （网文多分卷总表与卷纲），对照验收时对不上。
// 章数只保留一个防极端硬顶：均章达标但章数离谱（千章书）仍按网文。
export function detectBookType(chapters) {
  const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
  if (units.length === 0) return '网文'
  const avg = units.reduce((s, c) => s + c.chars, 0) / units.length
  if (avg <= THRESHOLDS.出版书均章字数下限) return '网文'
  if (units.length >= THRESHOLDS.出版书章数硬顶) return '网文'
  return '出版'
}

// ---------- 定量指纹（F-21，脚本生成；七项＝五项＋场景切换密度＋情绪标签词密度，Q-22）----------

function splitSentences(text) {
  return text.split(/[。！？!?…]+/).map((s) => s.trim()).filter(Boolean)
}

// 场景切换：行首命中任一 SCENE_MARKERS 记一次（行级布尔，同行多标记不重复计数）。
function countSceneSwitches(text) {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t && SCENE_MARKERS.some((m) => t.startsWith(m))) n++
  }
  return n
}

function countWords(text, words) {
  return words.reduce((s, w) => s + (text.split(w).length - 1), 0)
}

export function fingerprint(chapters) {
  const full = chapters.map((c) => c.text).join('\n')
  const chars = full.replace(/\s/g, '').length || 1
  const sentences = splitSentences(full)
  const quoted = full.match(/[“「『][^”」』]*[”」』]/g) ?? []
  const fatigue = countWords(full, FATIGUE_WORDS)
  const scenes = countSceneSwitches(full)
  const emotionTags = countWords(full, EMOTION_TAG_WORDS)
  const base = {
    句均长: +(sentences.reduce((s, x) => s + [...x].length, 0) / (sentences.length || 1)).toFixed(1),
    短句比: +((sentences.filter((s) => [...s].length < 15).length / (sentences.length || 1)) * 100).toFixed(1),
    对话占比: +(([...quoted.join('')].length / chars) * 100).toFixed(1),
    了密度: +((full.split('了').length - 1) / chars * 1000).toFixed(1),
    疲劳词密度: +(fatigue / chars * 1000).toFixed(1),
    场景切换密度: +(scenes / chars * 10000).toFixed(1),
    情绪标签词密度: +(emotionTags / chars * 10000).toFixed(1),
  }
  const perChapter = chapters.filter((c) => c.no > 0).map((c) => {
    const s = splitSentences(c.text)
    const q = c.text.match(/[“「『][^”」』]*[”」』]/g) ?? []
    const n = c.text.replace(/\s/g, '').length || 1
    return {
      ch: c.no,
      句均长: +(s.reduce((t, x) => t + [...x].length, 0) / (s.length || 1)).toFixed(1),
      短句比: +((s.filter((x) => [...x].length < 15).length / (s.length || 1)) * 100).toFixed(1),
      对话占比: +(([...q.join('')].length / n) * 100).toFixed(1),
      场景切换密度: +(countSceneSwitches(c.text) / n * 10000).toFixed(1),
      情绪标签词密度: +(countWords(c.text, EMOTION_TAG_WORDS) / n * 10000).toFixed(1),
    }
  })
  // 偏离判定：某章该项偏离全书均值 ≥2σ 才列出（A-07）。
  // 不能取固定 top-N：一本全书很均匀的书，top-3 只是「相对不那么均匀」的三个，
  // 读者看不出差别，而结论却写着「这几章偏离」——这是把噪音说成信号。
  // 3 章以内算不出有意义的标准差，整段标「样本不足」不出结论。
  const THRESHOLD_SIGMA = 2
  const MIN_CHAPTERS_FOR_SIGMA = 3
  const deviating = {}
  for (const key of ['句均长', '短句比', '对话占比', '场景切换密度', '情绪标签词密度']) {
    const mean = base[key]
    const vals = perChapter.map((x) => x[key])
    if (perChapter.length < MIN_CHAPTERS_FOR_SIGMA) {
      // 样本不足：不判偏离，把「算不出来」这件事写出来，而不是给一个假结论。
      deviating[key] = [`样本不足（${perChapter.length} 章，不判偏离）`]
      continue
    }
    const variance = vals.reduce((t, v) => t + (v - mean) ** 2, 0) / vals.length
    const sigma = Math.sqrt(variance)
    // σ=0（所有章等长）时任何非零偏差都是「相对」的，不构成偏离。
    if (!(sigma > 0)) {
      deviating[key] = ['全书各章该指标一致，无偏离章']
      continue
    }
    const hits = perChapter
      .map((x) => ({ ...x, z: Math.abs(x[key] - mean) / sigma }))
      .filter((x) => x.z >= THRESHOLD_SIGMA)
      .sort((a, b) => b.z - a.z)
    // 上限只为防刷屏（长书真可能几十章偏离），按 z 值从大到小取前 5，
    // 并在文本里写明「另有 N 章」——不静默截断。
    const LIMIT = 5
    const shown = hits.slice(0, LIMIT).map((x) => `第${x.ch}章（${x[key]}，${x.z.toFixed(1)}σ）`)
    if (hits.length > LIMIT) shown.push(`另有 ${hits.length - LIMIT} 章同样偏离，未列出`)
    deviating[key] = shown.length ? shown : ['无偏离章（均在 2σ 以内）']
  }
  return { base, deviating, hasQuote: quoted.length > 0 }
}

function fingerprintText(fp) {
  const lines = [
    `- 句均长：${fp.base.句均长} 字/句`,
    `- 短句比：${fp.base.短句比}%（<15 字）`,
    `- 对话占比：${fp.base.对话占比}%`,
    `- 了密度：${fp.base.了密度} 个/千字`,
    `- 疲劳词密度：${fp.base.疲劳词密度} 个/千字`,
    `- 场景切换密度：${fp.base.场景切换密度} 个/万字`,
    `- 情绪标签词密度：${fp.base.情绪标签词密度} 个/万字`,
  ]
  for (const [key, chs] of Object.entries(fp.deviating)) lines.push(`- ${key}偏离章：${chs.join('、')}`)
  if (!fp.hasQuote) lines.push('- 注：全文未检出引号，对话占比不可信（文本质量受限，F-21）')
  return lines.join('\n')
}

// ---------- 作者的话归集（F-22）----------

// 结构信号判定（Q-25）：只有卷末总结/完本感言/结构预告才归集，例行附注（求票/打赏/请假）丢弃计数。
const STRUCTURE_NOTE = /总结|感言|完本|大结局|完结|结局|部名|卷名|预告|伏笔|大纲|结构|节奏|剧情|新书|续集|第二部|下一本/
const ROUTINE_NOTE = /^求|^感谢|^请假|^抱歉|^大家|^各位书友|^PS/

export function isStructureNote(text) {
  const len = [...text].length
  // 长附注块（≥40 字）大概率是总结/感言——例行附注通常是一行短句
  if (len >= 40) return true
  return STRUCTURE_NOTE.test(text) && !ROUTINE_NOTE.test(text)
}

function bucketNote(text) {
  if (/完本|大结局|完结|结局|感谢.*陪伴/.test(text)) return '人物结局交代'
  if (/新书|续集|第二部|下一本|番外预告/.test(text)) return '续作接口'
  if (/伏笔|大纲|存稿|更新|写作|写法|请假|感言/.test(text)) return '方法论'
  return '结构自述'
}

function authorNotesText(notes) {
  const buckets = Object.fromEntries(SECTIONS.作者的话.map((s) => [s, []]))
  const kept = []
  let droppedCount = 0
  for (const n of notes) {
    // 后记块整块已由标题行确认，直接保留——否则短段落会被单行规则误判丢弃。
    if (n.afterword || isStructureNote(n.text)) kept.push(n)
    else droppedCount++
  }
  for (const n of kept) buckets[bucketNote(n.text)].push(`- ${n.ch === '附录' ? '【附录】' : `【第${n.ch}章】`}${n.text}`)
  const parts = [`# 作者自述\n`]
  for (const s of SECTIONS.作者的话) {
    parts.push(`## ${s}\n`, buckets[s].length ? buckets[s].join('\n') : '无', '')
  }
  if (droppedCount) parts.push(`\n> 例行附注（求票/打赏/请假等）${droppedCount} 条已按 Q-25 丢弃，仅计数。\n`)
  return { text: parts.join('\n'), droppedCount }
}

// ---------- 骨架落位（D-16）----------

function planBatches(chapters, volumes) {
  const batches = []
  for (const v of volumes) {
    // 前言不占批位（#4 实测）：第 0 章是题记/献词，不是正文，但它挂着章号，
    // 若照常计入就会顶掉一个名额——龙族2 正文正好 20 章（单批上限 20），
    // 被前言挤成 [0-19] + [20-20]，凭空多出一批只装 1 章的工作量。
    // 判据与骨架/标题计数处保持一致（no===0 且 title==='前言'），不新造字段。
    const units = chapters
      .filter((c) => c.no >= v.startCh && c.no <= v.endCh)
      .filter((c) => !(c.no === 0 && c.title === '前言'))
    // 按字数切批（#7 实测）：原先只按章数每 20 章一刀，遇到章长悬殊的书会切出
    // 极不均衡的批——龙族3 批4-1 是 20 章 42.1 万字、批4-2 只有 3 章 7.1 万字，
    // 批间差 5.9 倍。单批的上下文成本由字数决定，所以要让每个切分点落在字数均衡处。
    //
    // 做法（批数守恒的最小改动）：批数仍完全由章数上限决定（每批 ≤20 章，PRD F-13/A-13），
    // 于是批数与原来一模一样，不会多花会话。然后在这 k 个切分点里，按章数上限允许的
    // 范围内，把每个切分点挪到「累计字数最接近理想等分点」的章号上。
    // 每批仍严格 ≤20 章，且批数不变——这两条是硬约束，其余只是把刀口对准字数。
    if (!units.length) continue
    const list = units.map((c) => c.no)
    const chars = units.map((c) => c.chars ?? 0)
    const total = chars.reduce((s, n) => s + n, 0)
    const k = Math.max(1, Math.ceil(list.length / THRESHOLDS.单批章数上限))
    const cap = THRESHOLDS.单批章数上限

    // 前缀和，便于 O(1) 取区间字数。
    const pre = [0]
    for (const n of chars) pre.push(pre.at(-1) + n)

    // 逐批确定终点：从当前位置起，在 [最大可行, 章数上限] 之间挑一个终点，
    // 使「本批累计字数最接近 total/k」。下界保证剩余章仍装得进剩余批数。
    let i = 0
    for (let b = 0; b < k && i < list.length; b++) {
      const batchesLeft = k - b
      const lo = Math.max(i + 1, list.length - (batchesLeft - 1) * cap)
      const hi = Math.min(i + cap, list.length - (batchesLeft - 1))
      const ideal = (total * (b + 1)) / k
      let best = lo
      let bestErr = Infinity
      for (let e = lo; e <= hi; e++) {
        const err = Math.abs(pre[e] - ideal)
        if (err < bestErr) { bestErr = err; best = e }
      }
      if (best <= i) best = Math.min(i + 1, list.length)
      batches.push({
        volumeNo: v.no,
        batch: batches.filter((x) => x.volumeNo === v.no).length + 1,
        startCh: list[i],
        endCh: list[best - 1],
        chars: pre[best] - pre[i],
        status: 'pending',
      })
      i = best
    }
  }
  return batches
}

function chapterFileName(c) {
  const safe = c.title.replace(/[\\/:*?"<>|]/g, '_')
  return `${String(c.no).padStart(4, '0')}-${safe}.txt`
}

function volumeFileName(v) {
  const safe = v.name.replace(/[\\/:*?"<>|]/g, '_')
  return `卷${String(v.no).padStart(2, '0')}-${safe}.md`
}

// 生成全部待写文件：相对路径 → 内容。
// 两类书都建卷纲与分卷总表；区别只在幕怎么落：
//   网文——幕＝卷内事件弧，卷纲由拆解者按事件弧填，幕纲由卷循环逐幕生成；
//   出版书——幕＝原文单元，卷纲由脚本按原文单元的章节区间预置，幕纲一份对应一个原文单元。
export function buildArtifacts({ book, sourceName, chapters, volumes, bookType, fp, notes }) {
  const plan = productPlan({ bookType })
  const files = new Map()
  // 表格单元格转义（评审 P4/P22）：标题等自由文本含竖线会使 Markdown 表行裂列，写表前转义为 \|。
  const esc = (v) => String(v).replace(/\|/g, '\\|')

  for (const t of TOPICS) files.set(`故事底本/全书设定/专题/${t}.md`, topicSkeleton(t))
  // 全书大纲骨架（Q-24）：四块，第一块「故事设计」段内七项引导。
  files.set('故事底本/故事剧情/全书大纲.md', outlineSkeleton())
  files.set('故事底本/故事剧情/伏笔台账.md', tableSkeleton('伏笔台账', tableColumns('伏笔台账')))
  files.set('故事底本/故事剧情/开篇三章.md', mdSkeleton('开篇三章', SECTIONS.开篇三章))
  files.set('故事底本/全书设定/世界观.md', mdSkeleton('世界观', SECTIONS.世界观))
  files.set('故事底本/全书设定/金手指.md', mdSkeleton('金手指', SECTIONS.金手指, '- 金手指名称：（待填）\n'))
  files.set('故事底本/文风.md', styleSkeleton(fingerprintText(fp)))
  const authorResult = authorNotesText(notes)
  files.set('原文/作者的话.md', authorResult.text)
  files.set('工作/别名词典.md', tableSkeleton('别名词典', tableColumns('别名词典')))
  // 逐章记录十三列（Q-22 剧情线插「一句话事件」后；Q-23 再加章末钩型/爽点强度；A-09 补「爽点类型」；
  // 后加「章字数」——该列由本脚本直接写入已知的 chars，不留待填，避免 agent 重复计算）。
  files.set('工作/逐章记录.md', tableSkeleton('逐章记录', tableColumns('逐章记录'),
    chapters.map((c) => [String(c.no), esc(c.title), String(c.chars), '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）', '（待填）'])))
  for (const [name, types] of Object.entries(COLLECTIONS)) {
    files.set(`故事底本/全书设定/${name}/索引.md`, tableSkeleton(`${name}索引`,
      tableColumns(name === '人物' ? '人物索引' : '集合索引')))
  }
  files.set('故事底本/全书设定/人物/人物关系.md', tableSkeleton('人物关系', tableColumns('人物关系')))

  // 卷层：两类书都建。网文卷纲的「事件弧清单」由拆解者填（脚本给不出事件弧）；
  // 出版书卷纲的幕清单可以由脚本预置——幕＝原文单元，章节区间在切章时已确定，
  // 这里只是把它写下来，不涉及判断。
  files.set('故事底本/故事剧情/分卷总表.md', tableSkeleton('分卷总表', tableColumns('分卷总表')))
  for (const v of volumes) files.set(`故事底本/故事剧情/卷纲/${volumeFileName(v)}`, mdSkeleton(`卷纲 ${v.name}`, SECTIONS.卷纲))

  if (bookType === '出版') {
    // 出版书：幕＝原文单元。幕纲文件名带所属卷号，与网文的「幕纲/卷NN-幕NN-名称.md」同形，
    // 这样校验器不必为两类书写两套树形判断。
    const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
    units.forEach((c, k) => {
      const safe = c.title.replace(/[\\/:*?"<>|]/g, '_')
      const vol = volumes.find((v) => c.no >= v.startCh && c.no <= v.endCh) ?? volumes[0]
      const volNo = String(vol?.no ?? 1).padStart(2, '0')
      files.set(
        `故事底本/故事剧情/幕纲/卷${volNo}-幕${String(k + 1).padStart(2, '0')}-${safe}.md`,
        mdSkeleton(`幕纲 ${c.title}`, SECTIONS.幕纲),
      )
    })
  }
  return { plan, files }
}

// 附录切分（spike 卡壳 2：末章混入完本感言/读者同人/附录时污染统计）。
// 仅当「全书完」标记落在最后一章且该章是超长异常章时截断——正常规模正文后的
// 作者番外章（如「番外篇」独立成章）不受影响。
const APPENDIX_MARKER = /^[（(]?全书完[）)]?[!！]?$/

export function splitAppendix(chapters) {
  const last = chapters.at(-1)
  if (!last || !last.isHeading) return null
  // 均值剔除候选章自身，否则异常章会把自己的阈值抬高（自我抵消）。
  const others = chapters.filter((c) => c.isHeading && c !== last)
  const avg = others.reduce((s, c) => s + c.chars, 0) / (others.length || 1)
  if (last.chars <= Math.max(30000, avg * 8)) return null
  const lines = last.text.split(/\r?\n/)
  const idx = lines.findIndex((l) => APPENDIX_MARKER.test(l.trim()))
  if (idx === -1) return null
  const appendixLines = lines.slice(idx)
  const notes = []
  for (const line of appendixLines) {
    if (classifyNoise(line) === '作者话' || classifyNoise(line) === '结构附注') notes.push(line.trim())
  }
  // 标记前的正文中还属「作者话」的行数——章内清洗按行序入 notes，超出此数的属于附录区。
  let preNotes = 0
  for (const line of lines.slice(0, idx)) {
    if (classifyNoise(line) === '作者话' || classifyNoise(line) === '结构附注') preNotes++
  }
  last.text = lines.slice(0, idx).join('\n').trim()
  last.chars = last.text.replace(/\s/g, '').length
  delete last.outlier
  return {
    lines: appendixLines,
    notes,
    preNotes,
    chars: appendixLines.join('').replace(/\s/g, '').length,
  }
}

// ---------- 主流程 ----------

export class UsageError extends Error {
  constructor(message, code = 'E_PREPARE') { super(message); this.code = code }
}

async function atomicWrite(file, content) {
  await writeFileAtomic(file, content) // 评审 P8：fsync＋失败清理临时文件，见 io.mjs
}

function decodeSource(buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  return { text, encoding: 'utf-8' }
}

async function decodeInput(buffer, src) {
  try {
    return decodeSource(buffer)
  } catch {
    try {
      const text = new TextDecoder('gbk', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
      return { text, encoding: 'gbk' }
    } catch {
      throw new UsageError(`无法识别原文编码（既非 UTF-8 也非 GBK）：${src}。请先转为 UTF-8 再试`, 'E_ENCODING')
    }
  }
}

// 量一遍「重建会丢掉多少活」（B-07）：--force 会归档整个产物目录并重建，
// 归档不等于删除，但人要接着在新目录里重做——真正丢的是已填的内容与已花的会话。
// 判据直接复用 progress.mjs 的 detectFileState（含「空表格算骨架」）：
// 自己再写一遍必然走样，实测漏了空表格就会把十几个空索引数成「已填」。
export async function countFilledArtifacts(outDir) {
  const { detectFileState } = await import('./progress.mjs')
  const filled = []
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (rel === '原文') continue // 原文是复制的，重建会重新生成，不算「活」
        await walk(join(dir, e.name), rel)
      } else if (e.name.endsWith('.md')) {
        let text
        try { text = await readFile(join(dir, e.name), 'utf8') } catch { continue }
        if (detectFileState(text, rel) === 'filled') filled.push(rel)
      }
    }
  }
  await walk(outDir, '')
  return filled
}

async function archiveOld(outDir) {
  const parent = dirname(outDir)
  const base = basename(outDir)
  const entries = new Set(await readdir(parent))
  let k = 1
  while (entries.has(`${base}_旧${k}`)) k++
  const target = join(parent, `${base}_旧${k}`)
  renameSync(outDir, target)
  return target
}

// 纯计算段（评审 P25 拆分）：输入校验、解码、切章/分卷/附录检测、骨架与 manifest 组装。
// 可读文件（readFile/stat/exists），但不含任何 mkdir/write/copy——落盘副作用全部在 persist()。
export async function analyze({ input, out }) {
  const src = resolve(input)
  if (!existsSync(src)) throw new UsageError(`原文不存在：${src}`, 'E_INPUT')
  if (!statSync(src).isFile()) throw new UsageError(`不是文件：${src}`, 'E_INPUT')
  if (extname(src).toLowerCase() !== '.txt') throw new UsageError(`不是 .txt 文件：${src}`, 'E_INPUT')

  const book = basename(src, extname(src))
  const outDir = resolve(out ?? join(dirname(src), `${book}_拆解`))
  const buffer = await readFile(src)
  if (buffer.length === 0) throw new UsageError(`原文为空：${src}`, 'E_INPUT')
  const { text, encoding } = await decodeInput(buffer, src)

  const chapters = detectChapters(text)
  const headingCount = chapters.filter((c) => !(c.no === 0 && c.title === '前言')).length
  if (headingCount === 0) {
    throw new UsageError('未识别到章节标题。请确认原文含「第N章/幕/节/回」「序章」「楔子」等标题行', 'E_CHAPTER')
  }
  if (headingCount < THRESHOLDS.最少章节数) {
    throw new UsageError(`章节数少于 ${THRESHOLDS.最少章节数}（识别到 ${headingCount} 章）。疑似不支持的文本结构，停止不猜`, 'E_CHAPTER')
  }

  const lines = text.split(/\r?\n/)
  const bookType = detectBookType(chapters)
  const appendix = splitAppendix(chapters)
  if (appendix) {
    // 末章附注中属于附录区的部分（行序在标记之后）重标为附录。
    const last = chapters.at(-1)
    const moved = last.notes.splice(appendix.preNotes)
    for (const t of moved) appendix.notes.push(t)
  }
  const volumes = detectVolumes(chapters, lines)
  const fp = fingerprint(chapters)
  const notes = chapters.flatMap((c) => [
    ...c.notes.map((t) => ({ ch: c.no, text: t })),
    // 后记块：整块已由标题行确认，直接纳入，不再按单行规则筛（否则短段落会被丢弃）。
    ...(c.afterword ?? []).filter(Boolean).map((t) => ({ ch: c.no, text: t, afterword: true })),
  ])
  if (appendix) for (const t of appendix.notes) notes.push({ ch: '附录', text: t })
  const { plan, files } = buildArtifacts({ book, chapters, volumes, bookType, fp, notes })
  const batches = planBatches(chapters, volumes)

  // 评审 P10：输入落在某个既有产物的 原文/ 子树内会在其下自我嵌套——向上找含 manifest 的祖先判定。
  {
    let cur = dirname(src)
    for (;;) {
      if (existsSync(join(cur, '工作', 'manifest.json')) && (src === join(cur, '原文', basename(src)) || src.startsWith(join(cur, '原文') + sep))) {
        throw new UsageError(`输入文件在既有产物目录的 原文/ 内（${relative(cur, src)}），拒绝自我嵌套。请把源文件放到产物目录外`, 'E_INPUT_IN_OUTPUT')
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }

  const manifest = {
    book,
    bookType,
    // 产物自证按哪版契约写成（T14）。0.3.0 起卡片字段与散文引句都进校验，
    // 旧版产物在新版校验器下的差异需要能区分「产物写错了」与「契约变了」。
    contractVersion: CONTRACT_VERSION,
    // 生成时间（B-06）：旧产物只有 outDir 与 source，看不出「什么时候拆的」。
    // 时间取本机时钟，只作记录，不参与任何判定。
    generatedAt: new Date().toISOString(),
    source: { path: src, bytes: buffer.length, encoding, sha256: createHash('sha256').update(buffer).digest('hex') },
    outDir,
    // 总量口径（B-06）：光有 totalChars 这个数看不出它到底数了什么——
    // 是原文全文，还是含附录、含前言、含噪音行？写清楚，别人才能核对。
    totalChars: chapters.reduce((s, c) => s + c.chars, 0),
    totalCharsNote: '原文正文单元的字数之和：含前言（no=0，若存在），不含附录（单列在 appendix.chars）、不含已剥离的噪音行与作者的话',
    chapterCount: chapters.length,
    volumeCount: volumes.length,
    volumes,
    ...(appendix ? { appendix: { file: '原文/附录.txt', chars: appendix.chars } } : {}),
    noise: { garbledLines: chapters.reduce((s, c) => s + (c.garbled ?? 0), 0) },
    chapters: chapters.map((c) => ({
      no: c.no, rawNo: c.rawNo, title: c.title, chars: c.chars, file: chapterFileName(c),
      ...(c.outlier ? { outlier: true } : {}),
    })),
    batches,
    stages: STAGES.map((s) => ({ ...s, status: s.id <= 2 ? 'done' : 'pending' })),
    files: {},
  }

  return { src, outDir, book, bookType, encoding, appendix, chapters, volumes, batches, plan, files, manifest }
}

// 落盘段（评审 P25 拆分）：校验产物目录、--force 归档、续跑对账、写章节/骨架/manifest。
export async function persist(analysis, { force = false, iKnow = false, dryRun = false } = {}) {
  const { src, outDir, book, bookType, encoding, appendix, chapters, volumes, batches, plan, files, manifest } = analysis

  // 产物目录已存在：--force 归档重建；否则有 manifest 走续跑对账，无 manifest 拒绝。
  let archived = null
  if (existsSync(outDir)) {
    if (force) {
      // 二次确认（B-07）：--force 一句话就把整份产物归档重建，此前没有任何阻力。
      // 归档不是删除，但人要接着在新目录里把内容重做一遍——真正丢的是已填的内容。
      // 先把「会丢多少」数出来给他看，加 --i-know 才算确认过。
      if (!iKnow) {
        const filled = await countFilledArtifacts(outDir)
        const parent = dirname(outDir)
        const base = basename(outDir)
        const entries = new Set(existsSync(parent) ? await readdir(parent) : [])
        let k = 1
        while (entries.has(`${base}_旧${k}`)) k += 1
        const willArchiveTo = join(parent, `${base}_旧${k}`)
        throw new UsageError(
          `--force 会归档整个产物目录后重建，${filled.length} 个已填文件需要重做：`
          + `${filled.slice(0, 5).join('、')}${filled.length > 5 ? ` 等 ${filled.length} 个` : ''}。`
          + `归档到：${willArchiveTo}。确认要重建请加 --i-know`,
          'E_FORCE_CONFIRM',
        )
      }
      archived = await archiveOld(outDir)
    } else if (!existsSync(join(outDir, '工作', 'manifest.json'))) {
      throw new UsageError(`产物目录已存在且无 manifest：${outDir}。请换 --out，或用 --force --i-know 归档后重建`, 'E_EXISTS')
    }
  }
  const resume = !force && archived === null && existsSync(join(outDir, '工作', 'manifest.json'))
  if (resume) {
    const old = await readManifest(outDir) // 评审 P5：损坏的 manifest 报 E_MANIFEST，不抛裸 SyntaxError
    if (old.source?.sha256 && old.source.sha256 !== manifest.source.sha256) {
      throw new UsageError('源文件已变更，与 manifest 记录不一致。请用 --force 重拆（旧目录会归档）', 'E_SOURCE_CHANGED')
    }
  }

  if (dryRun) {
    return {
      action: 'dry-run', outDir, book, bookType, encoding, chapterCount: chapters.length,
      // totalChars 必须一起返回：CLI 摘要会打印它，缺了就印出空值（实测《长安的荔枝》--dry-run 时空着）
      totalChars: chapters.reduce((n, c) => n + (c.chars ?? 0), 0),
      volumeCount: volumes.length, volumes, batchCount: batches.length, archived,
      dirs: plan.dirs.length, files: files.size + chapters.length + 1,
      // 章节列表（C-23）：快速模式要「以脚本的切章口径为准」，就得能拿到这份列表。
      // 只给序号与标题、不带正文：正文在源文件里，agent 按页读，不需要脚本再复制一遍
      // （带正文会把整本书从 stdout 灌一遍，还逼调用方处理编码）。
      chapters: chapters.map((c) => ({ no: c.no, title: c.title, chars: c.chars })),
    }
  }

  // 全部计算完成且通过护栏后才落盘（失败不建目录，A-01/A-17）。
  for (const d of ['原文/章节', ...plan.dirs]) await mkdir(join(outDir, d), { recursive: true })
  await copyFile(src, join(outDir, '原文', basename(src)))
  manifest.files[`原文/${basename(src)}`] = 'done'

  for (const c of chapters) {
    const name = chapterFileName(c)
    const file = join(outDir, '原文', '章节', name)
    if (!resume || !existsSync(file)) await atomicWrite(file, `${c.text}\n`)
    manifest.files[`原文/章节/${name}`] = 'done'
  }

  if (appendix) {
    const file = join(outDir, '原文', '附录.txt')
    if (!resume || !existsSync(file)) await atomicWrite(file, appendix.lines.join('\n'))
    manifest.files['原文/附录.txt'] = 'done'
  }

  for (const [rel, content] of files) {
    const file = join(outDir, rel)
    if (resume && existsSync(file)) continue
    await atomicWrite(file, content)
    manifest.files[rel] = rel === '原文/作者的话.md' ? 'filled' : 'skeleton'
  }

  if (resume) {
    const old = await readManifest(outDir)
    manifest.files = { ...old.files, ...manifest.files }
    manifest.batches = old.batches?.length === batches.length ? old.batches : batches
    manifest.stages = old.stages ?? manifest.stages
  }
  await atomicWrite(join(outDir, '工作', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  manifest.files['工作/manifest.json'] = 'done'

  return {
    action: resume ? 'resumed' : 'prepared',
    outDir, book, bookType, encoding, archived,
    chapterCount: manifest.chapterCount, totalChars: manifest.totalChars,
    volumes, batches: batches.length,
  }
}

// 薄壳（评审 P25）：analyze→persist，对外签名与返回值字段与拆分前完全一致。
export async function prepare(opts) {
  return persist(await analyze(opts), opts)
}

export function parseArgs(argv) {
  const options = { input: undefined, out: undefined, force: false, iKnow: false, dryRun: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`--out 缺少取值。${USAGE}`, 'E_ARGS')
      options.out = v
    } else if (arg === '--force') options.force = true
    else if (arg === '--i-know') options.iKnow = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`, 'E_ARGS')
    else if (options.input === undefined) options.input = arg
    else throw new UsageError(`多余的参数 ${arg}。${USAGE}`, 'E_ARGS')
  }
  // --i-know 单用没有意义：它是给 --force 的确认，不是独立动作。
  if (options.iKnow && !options.force) {
    throw new UsageError('--i-know 只能与 --force 同用（它是重建的二次确认，不是独立动作）', 'E_ARGS')
  }
  if (!options.help && !options.input) throw new UsageError(USAGE, 'E_ARGS')
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
  try {
    const r = await prepare(options)
    if (options.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: r }, null, 2))
    } else {
      console.log(`${r.action === 'resumed' ? '已续跑' : '已准备'}：${r.outDir}${r.archived ? `（旧产物归档为 ${r.archived}）` : ''}`)
      console.log(`类型：${r.bookType}，章节数：${r.chapterCount}，卷数：${r.volumeCount ?? r.volumes?.length}，总字数：${r.totalChars ?? ''}`)
      // 成本预估（Q-22）：批数即按卷处理的会话单位。dry-run 返回 batchCount，落盘返回 batches（计数）。
      const batchCount = r.batches ?? r.batchCount ?? 0
      console.log(`规模预告：${r.chapterCount} 章 / ${batchCount} 批（每批 ≤20 章；批数即按卷处理的会话单位，全书投入≈${batchCount} 个批次）`)
      // 章节列表（C-23）：快速模式拿这份列表当唯一口径，不再自己手切。
      // 只印标题不印正文——正文在源文件里，需要时按章号去读。
      if (r.chapters?.length) {
        console.log(`章节列表（${r.chapters.length} 章）：`)
        for (const c of r.chapters) console.log(`  ${c.no}. ${c.title}（${c.chars} 字）`)
      }
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_PREPARE', file: error.file ?? '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
