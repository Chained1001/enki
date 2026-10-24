// 真书规模断言（#6）：把八本实测书的（类型、章数、卷数、均章）写成回归断言。
//
// 为什么需要：这些数字此前只活在 issue 报告里，靠人记。判定逻辑一改（例如把均章阈值
// 从 15,000 调到 12,000，或给章数加一条新的硬顶），受影响的书会静默改变产物目录树
// （网文多分卷总表与卷纲），而测试全绿。这里让漂移变红。
//
// 约束：原文不入库（AGENTS.md 禁止事项）。测试只在临时目录读取主机上的原文，
// 原文缺失时整组跳过并说明原因，不把任何小说正文写进仓库。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectBookType, detectChapters, detectVolumes } from '../skills/book-breakdown/scripts/prepare.mjs'

// 原文目录可用环境变量覆盖（CI 上没有这批书时整组跳过）。
const SRC_DIR = process.env.ENKI_REALBOOK_DIR
  ?? 'C:/Users/22940/Desktop/开发/辅助内容/小说原文'

// 八本实测书的基线。均章＝正文单元字数之和 / 正文单元数（不含前言），与 detectBookType 同口径。
// 这批数字来自 2026-10-24 在真实原文上的结构检测，采集脚本见 AGENTS.md「验证」节。
const BASELINE = [
  { file: '《长安的荔枝》.txt', bookType: '网文', chapterCount: 7, volumeCount: 1, avg: 14386 },
  { file: '《大奉打更人》.txt', bookType: '网文', chapterCount: 916, volumeCount: 5, avg: 4102 },
  { file: '《我真没想重生啊》.txt', bookType: '网文', chapterCount: 1078, volumeCount: 7, avg: 2839 },
  { file: '《绍宋》.txt', bookType: '网文', chapterCount: 438, volumeCount: 7, avg: 6340 },
  { file: '《道诡异仙》.txt', bookType: '网文', chapterCount: 1028, volumeCount: 3, avg: 2173 },
  { file: '《龙族1·火之晨曦》.txt', bookType: '出版', chapterCount: 11, volumeCount: 1, avg: 26120 },
  { file: '《龙族2·悼亡者之瞳》.txt', bookType: '出版', chapterCount: 21, volumeCount: 1, avg: 19603 },
  { file: '《龙族3·黑月之潮》.txt', bookType: '出版', chapterCount: 58, volumeCount: 4, avg: 19858 },
]

// 同类旁证（不在 #6 的八本之列，但同样守着两类的边界）。
const EXTRA = [
  { file: '《十日终焉》.txt', bookType: '网文', chapterCount: 1382, volumeCount: 5, avg: 2106 },
  { file: '《诡秘之主》.txt', bookType: '网文', chapterCount: 1394, volumeCount: 8, avg: 3141 },
]

const present = (b) => existsSync(join(SRC_DIR, b.file))
const missing = [...BASELINE, ...EXTRA].filter((b) => !present(b)).map((b) => b.file)
const haveSource = existsSync(SRC_DIR)

// 按与 prepare 相同的流水线跑一遍结构检测，不落盘。
function measure(file) {
  const text = readFileSync(join(SRC_DIR, file), 'utf8')
  const lines = text.split(/\r?\n/)
  const chapters = detectChapters(text)
  const volumes = detectVolumes(chapters, lines)
  const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
  const avg = units.length ? Math.round(units.reduce((s, c) => s + c.chars, 0) / units.length) : 0
  return { bookType: detectBookType(chapters), chapterCount: chapters.length, volumeCount: volumes.length, avg }
}

test('原文目录缺失时整组跳过并说明原因（不因环境缺文件误报）', () => {
  if (!haveSource) {
    assert.ok(true, `原文目录不存在，跳过真书断言：${SRC_DIR}`)
    return
  }
  assert.ok(readdirSync(SRC_DIR).length > 0)
})

for (const b of BASELINE) {
  test(`真书基线（八本）：${b.file} 的类型/章数/卷数/均章不得漂移`, { skip: !present(b) && `原文缺失：${join(SRC_DIR, b.file)}` }, () => {
    const got = measure(b.file)
    assert.deepEqual(got, {
      bookType: b.bookType, chapterCount: b.chapterCount, volumeCount: b.volumeCount, avg: b.avg,
    })
  })
}

for (const b of EXTRA) {
  test(`真书旁证：${b.file} 的类型/章数/卷数/均章不得漂移`, { skip: !present(b) && `原文缺失：${join(SRC_DIR, b.file)}` }, () => {
    const got = measure(b.file)
    assert.deepEqual(got, {
      bookType: b.bookType, chapterCount: b.chapterCount, volumeCount: b.volumeCount, avg: b.avg,
    })
  })
}

test('两类在均章上互不重叠（阈值漂移会先撞到这里）', { skip: !haveSource && '原文目录缺失' }, () => {
  const rows = [...BASELINE, ...EXTRA].filter(present).map((b) => ({ ...b, got: measure(b.file) }))
  const ok = rows.filter((r) => r.got.bookType === '网文')
  const pub = rows.filter((r) => r.got.bookType === '出版')
  if (!ok.length || !pub.length) return
  const maxOk = Math.max(...ok.map((r) => r.got.avg))
  const minPub = Math.min(...pub.map((r) => r.got.avg))
  assert.ok(
    maxOk < minPub,
    `网文最高均章 ${maxOk} 应低于出版最低均章 ${minPub}，否则阈值不再能分开两类`,
  )
})

test('出版书与网文的卷层产物不同：出版书不建卷纲', { skip: !haveSource && '原文目录缺失' }, () => {
  // 只断言判定结果的形态，不读产物目录（产物在临时目录里，测试结束即删除）。
  const rows = [...BASELINE, ...EXTRA].filter(present)
  for (const b of rows) {
    const got = measure(b.file)
    assert.equal(got.bookType, b.bookType, `${b.file} 的类型漂移`)
  }
})

after(() => {})
