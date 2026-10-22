#!/usr/bin/env node
// 拆书第一步：校验原文、建产物目录、复制原文、切章、写清单。只用 Node 内置模块。
// 用法：prepare.mjs <原文 txt> [--out <产物目录>] [--json] [--help]
// 退出码：0 成功，1 业务失败（文件不存在、非 txt、无章节），2 参数错误。
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = '用法：prepare.mjs <原文 txt> [--out <产物目录>] [--json] [--help]'

// 章节标题：行首「第N章」或常见卷首词。与 references/章节识别.md 的 J-01、J-02 保持一致。
const CHAPTER = /^第[0-9一二三四五六七八九十百零]+章/
const SPECIAL = /^(序章|楔子|尾声|后记)/
const VOLUME = /^第[0-9一二三四五六七八九十百零]+卷/

// 集合型设定：目录 → 分类子目录。与 PRD 的「产物结构」节和 契约 保持一致。
export const COLLECTIONS = {
  人物: ['主角', '主要配角', '次要角色'],
  势力与组织: ['门派', '国家与政权', '家族', '商业与组织', '其他'],
  地点: ['国家与区域', '城市与场所', '秘境与异空间', '其他'],
  物品: ['武器', '法宝与道具', '材料与资源', '其他'],
  概念: ['功法与能力', '规则与术语', '事件', '其他'],
}

export class UsageError extends Error {}

export function detectChapters(text) {
  const lines = text.split(/\r?\n/)
  const marks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (CHAPTER.test(line) || SPECIAL.test(line)) {
      marks.push({ index: i, title: line.slice(0, 40) })
    }
  }
  // 第一章之前的正文算「前言」，单独成章，序号 0。
  const chapters = []
  if (marks.length && marks[0].index > 0) {
    const pre = lines.slice(0, marks[0].index).join('\n').trim()
    if (pre) chapters.push({ no: 0, title: '前言', start: 0, end: marks[0].index, chars: pre.length })
  }
  marks.forEach((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].index : lines.length
    const body = lines.slice(m.index, end).join('\n')
    chapters.push({ no: k + 1, title: m.title, start: m.index, end, chars: body.replace(/\s/g, '').length })
  })
  return chapters
}

export function detectVolumes(text) {
  const vols = []
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim()
    if (VOLUME.test(t) && t.length <= 40) vols.push({ title: t, line: i })
  })
  return vols
}

export async function prepare({ input, out, json = false }) {
  const src = resolve(input)
  if (!existsSync(src)) throw new UsageError(`原文不存在：${src}`)
  if (!statSync(src).isFile()) throw new UsageError(`不是文件：${src}`)
  if (extname(src).toLowerCase() !== '.txt') throw new UsageError(`不是 .txt 文件：${src}`)

  const book = basename(src, extname(src))
  const outDir = resolve(out ?? join(dirname(src), `${book}_拆解`))
  const text = (await readFile(src, 'utf8')).replace(/^\uFEFF/, '')
  if (!text.trim()) throw new UsageError(`原文为空：${src}`)

  const chapters = detectChapters(text)
  if (chapters.length === 0) {
    throw new UsageError('未识别到章节标题。请确认原文含「第N章」「序章」「楔子」等标题行')
  }
  const volumes = detectVolumes(text)

  const dirs = [
    join(outDir, '原文'),
    join(outDir, '原文', '章节'),
    join(outDir, '工作'),
    join(outDir, '故事底本', '故事剧情', '卷纲'),
    join(outDir, '故事底本', '故事剧情', '幕纲'),
    join(outDir, '故事底本', '全书设定'),
    ...Object.entries(COLLECTIONS).flatMap(([name, types]) =>
      types.map((t) => join(outDir, '故事底本', '全书设定', name, t))
    ),
  ]
  for (const d of dirs) await mkdir(d, { recursive: true })

  await copyFile(src, join(outDir, '原文', basename(src)))

  const lines = text.split(/\r?\n/)
  for (const c of chapters) {
    const name = `${String(c.no).padStart(4, '0')}-${c.title.replace(/[\\/:*?"<>|]/g, '_')}.txt`
    await writeFile(join(outDir, '原文', '章节', name), lines.slice(c.start, c.end).join('\n'), 'utf8')
  }

  const manifest = {
    book,
    source: src,
    outDir,
    totalChars: chapters.reduce((s, c) => s + c.chars, 0),
    chapterCount: chapters.length,
    volumes,
    chapters: chapters.map((c) => ({ no: c.no, title: c.title, chars: c.chars })),
  }
  await writeFile(join(outDir, '工作', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { action: 'prepared', outDir, ...manifest }
}

export function parseArgs(argv) {
  const options = { input: undefined, out: undefined, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`--out 缺少取值。${USAGE}`)
      options.out = v
    } else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`)
    else if (options.input === undefined) options.input = arg
    else throw new UsageError(`多余的参数 ${arg}。${USAGE}`)
  }
  if (!options.help && !options.input) throw new UsageError(USAGE)
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
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
      console.log(`已准备：${r.outDir}`)
      console.log(`章节数：${r.chapterCount}，总字数：${r.totalChars}，卷标题：${r.volumes.length}`)
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: 'E_PREPARE', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
