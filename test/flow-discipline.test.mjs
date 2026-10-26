// C-05（装置被写三遍）、C-07（幕判定要等全卷）、C-15（修复轮次不落盘）。
//
// 三条都是「流程纪律」，但落在不同层：
//   C-05 / C-07 纯文档约束，断言文档里写没写那条指令；
//   C-15 是脚本能力（progress --repair-round）+ 文档调用，两边都要断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const WF = join(ROOT, 'skills', 'book-breakdown', 'workflows')
const readWf = (name) => readFileSync(join(WF, name), 'utf8')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'products', '合成小书_拆解')

// ---------- C-05：装置只有一个定稿处 ----------

test('C-05：06 只写增量，不写全书大纲', () => {
  const t = readWf('06-口径锚定.md')
  assert.match(t, /工作\/增量\/阶段06-装置\.md/, '06 的初版要落到增量目录')
  assert.match(t, /不写全书大纲|写进增量片段/, '要明确不写全书大纲')
  // 反向：不能再让 06 直接「填写全书大纲的某段」
  assert.ok(!/按 `\.\.\/assets\/全书大纲模板\.md` 填写全书大纲的「核心冲突装置」段/.test(t),
    '06 不该再让 agent 直接填全书大纲')
})

test('C-05：07 回填写增量，两个分支都不改全书大纲', () => {
  const t = readWf('07-卷循环.md')
  assert.match(t, /阶段07-装置-卷N\.md/, '07 的回填要落到增量目录')
  assert.match(t, /不改全书大纲/, '要明确回填不改全书大纲')
  // 原来的写法是直接 --file 全文大纲为 filled，现在那一步只读状态
  assert.ok(!/--file 故事底本\/故事剧情\/全书大纲\.md:filled/.test(t),
    '07 不该再给全书大纲记 filled——定稿是 09 的事')
})

test('C-05：09 明写「一次性定稿」且是唯一写全书大纲装置段的地方', () => {
  const t = readWf('09-全书层.md')
  // 三条各自独立断言，不用 | 连。连写的话删掉其中一条仍能靠另一条通过——
  // 第一次变异（删「一次性定稿」）就是这么漏掉的：文档别处还有「唯一一段」。
  assert.match(t, /一次性定稿/, '要写明「一次性」——不是复核、不是再改一次')
  assert.match(t, /唯一/, '要写明它是唯一的那一段（防止别处再并出一版）')
  assert.match(t, /阶段06-装置/, '定稿要读 06 的初版增量')
  assert.match(t, /阶段07-装置/, '定稿要读 07 的回填增量')
})

test('C-05：三个阶段里只有 09 把全书大纲当写入目标', () => {
  // 判据是「谁是写入目标」，不是「哪行提到了全书大纲」。
  // 三种句子都要能分辨：
  //   06「装置初版写进增量片段，不写全书大纲」        —— 目标不是它
  //   07「回填写增量、不写全书大纲」                  —— 目标不是它
  //   09「核心冲突装置在这一步一次性定稿，合并成唯一一段写进全书大纲的『核心冲突装置』段」 —— 目标是它
  //
  // 前两版判据都没抓住这件事：一版只看「写进全书大纲」这几字，把 06/07 的正确写法
  // （「写进增量片段，不写全书大纲」）也判成违规；另一版加了否定词过滤，却因为
  // 09 的句子中间隔着冒号与增量路径而漏掉它，两个方向都错。
  const INSTRUCTION = /(写进|写入|填写|定稿)/g
  const TARGET_SELF = /写进(「)?(故事底本\/故事剧情\/)?全书大纲(」)?的?「?核心冲突装置」?段?|写入(「)?(故事底本\/故事剧情\/)?全书大纲(」)?/
  const withTarget = []
  for (const name of ['06-口径锚定.md', '07-卷循环.md', '09-全书层.md']) {
    const t = readWf(name)
    // 按句切：一句里同时有「写进/定稿」和「全书大纲的装置段」才算把全书大纲当目标。
    for (const sentence of t.split(/[。\n]/)) {
      if (!INSTRUCTION.test(sentence)) continue
      INSTRUCTION.lastIndex = 0
      if (/为什么|不该|不再|别/.test(sentence.slice(0, 6))) continue // 解释句
      // 否定形态：「不写全书大纲」「不改全书大纲」不算目标
      const hits = [...sentence.matchAll(new RegExp(TARGET_SELF.source, 'g'))]
      for (const h of hits) {
        const before = sentence.slice(Math.max(0, h.index - 8), h.index)
        if (/不写|别写|不要写|不改|不如/.test(before)) continue
        withTarget.push(name)
        break
      }
    }
  }
  assert.deepEqual([...new Set(withTarget)], ['09-全书层.md'],
    `只有 09 该把全书大纲当写入目标，实际：${[...new Set(withTarget)].join('、') || '无'}`)
})

// ---------- C-07：幕判定流式 ----------

test('C-07：07 明写「不等全卷」，且不再有「全卷批次完成后」', () => {
  const t = readWf('07-卷循环.md')
  assert.match(t, /不等全卷|流式/, '要写明幕判定是流式的')
  // 不能只说「别再说这四个字」：文档里会引用旧说法来解释为什么改（「『全卷批次完成后』
  // 还意味着要先攒完 45 万 token」），那是解释。判据是**不能再把它写成指令**，
  // 即不能出现「全卷批次完成后 + 做幕判定」这种祈使句形态。
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim()
    if (/^为什么|^不|还意味着|不该/.test(s)) continue
    assert.ok(!/全卷批次完成后[^。\n]{0,20}做幕判定|先[^。\n]{0,10}全卷批次完成[^。\n]{0,6}再判/.test(s),
      '不能把「全卷批次完成后」写成判幕的前置条件：' + s.slice(0, 60))
  }
  assert.match(t, /判幕要重读原文|立刻定这一幕/, '要给出替代做法，不能只是禁止')
})

test('C-07：07 给出幕判定的体量依据（20–40 章 / 为什么不能等）', () => {
  const t = readWf('07-卷循环.md')
  assert.match(t, /20[–-]40 章/, '要给流式判幕的窗口')
  assert.match(t, /token/, '要摆出为什么等全卷装不下（用 token 量级说话，不是「太长」）')
})

test('C-07：07 的分卷片段路径与契约一致（工作/ 顶层 + .md）', () => {
  const t = readWf('07-卷循环.md')
  const seg = t.slice(t.indexOf('多卷并行时'))
  assert.match(seg, /工作\/逐章记录-卷N\.md/, '逐章记录片段要在工作/ 顶层且带 .md')
  assert.match(seg, /工作\/伏笔台账-卷N\.md/, '伏笔台账片段要在工作/ 顶层且带 .md')
  assert.ok(!/工作\/增量\/(逐章记录|伏笔台账|别名)-卷N/.test(t), '分卷片段不该再写进 工作/增量/：merge-foreshadow 只认 工作/ 顶层')
})

test('C-07：卷纲弧数改卷末校验，不在填写时对', () => {
  const t = readWf('07-卷循环.md')
  assert.match(t, /弧数＝幕数|事件弧清单的行数不在填写时对/, '要写明弧数在卷末校验')
  assert.ok(!/事件弧清单的行数必须等于该卷幕数/.test(t), '原来那句「边写边对」要删掉')
})

// ---------- C-15：修复轮次落盘 ----------

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'repair-'))
  const out = join(dir, '书_拆解')
  try {
    await cp(FIXTURE, out, { recursive: true })
    return await fn(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = (args) => execFileSync('node', ['skills/book-breakdown/scripts/progress.mjs', ...args], { cwd: ROOT, encoding: 'utf8' })

test('C-15：--repair-round 写入 manifest.repairs', async () => {
  await withFixture(async (out) => {
    run([out, '--repair-round', '1:E_SOURCE 出处补齐'])
    const m = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.deepEqual(m.repairs, [{ round: 1, note: 'E_SOURCE 出处补齐' }])
  })
})

test('C-15：轮次累加到 3 轮，重跑不重置（这才是「三轮上限」）', async () => {
  await withFixture(async (out) => {
    run([out, '--repair-round', '1:第一轮'])
    run([out, '--repair-round', '2:第二轮'])
    run([out, '--repair-round', '3:第三轮'])
    const m = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.equal(m.repairs.length, 3, '三轮都要在')
    // 再跑一次读进度：轮次必须还在（此前它只活在对话里，重跑就没了）
    const shown = run([out])
    assert.match(shown, /修复轮次：3 轮/)
    assert.match(shown, /第3轮：第三轮/)
  })
})

test('C-15：同一轮重复登记是覆盖不是追加（否则轮次虚高、上限提前触发）', async () => {
  await withFixture(async (out) => {
    run([out, '--repair-round', '1:第一次的改法'])
    run([out, '--repair-round', '1:换了个改法'])
    const m = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.equal(m.repairs.length, 1, '同一轮只留一条')
    assert.equal(m.repairs[0].note, '换了个改法', '说明应更新为最新一次')
  })
})

test('C-15：轮次乱序登记时按轮次排序（读出来才是时间顺序）', async () => {
  await withFixture(async (out) => {
    run([out, '--repair-round', '2:第二轮'])
    run([out, '--repair-round', '1:第一轮'])
    const m = JSON.parse(await readFile(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.deepEqual(m.repairs.map((r) => r.round), [1, 2])
  })
})

test('C-15：非法取值报 E_ARGS 而不是静默丢弃', async () => {
  await withFixture(async (out) => {
    const bad = (v) => {
      try { run([out, '--repair-round', v]); return 0 } catch (e) { return e.status }
    }
    assert.equal(bad('abc'), 1, '没有冒号的取值要报错')
    assert.equal(bad('0:第零轮'), 1, '轮次必须从 1 起——0 轮提醒我们它在数数而不是在记事实')
    assert.equal(bad('1:'), 1, '说明不能为空：重跑时要靠它知道上一轮改了什么')
  })
})

test('C-15：10 的文档要求每轮登记，并说明为什么必须落盘', () => {
  const t = readWf('10-校验交付.md')
  assert.match(t, /--repair-round/, '10 要真的调用')
  assert.match(t, /三轮/, '要连回停止条件的三轮上限')
  // 「中断重跑就从头数」是这条的全部理由，必须单独在，不能靠「重跑」二字带过
  assert.match(t, /从头数|重新数|无限重置/, '要说明不落盘时轮次会被重置')
  assert.match(t, /改了什么|上一轮/, '要说明记的是「改了什么」而不只是计数')
})

// ---------- 阶段自检：每个阶段收口前都要跑一次 ----------
//
// 依据：首轮完整跑（《长安的荔枝》）三块并行填、最后统一校验，24 条错误全堆到末尾
// （4 个空集合、19 条缺出处、1 份产物整份没填）。没有一条是设计问题，
// 全是「当场能发现、但没人看」。分阶段跑的价值不是查得严，是把修复点挪回现场。
test('阶段自检：SKILL 定义一次，05–09 各自指向它，不各写一套', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'book-breakdown', 'SKILL.md'), 'utf8')
  assert.match(skill, /## 阶段自检/, 'SKILL 要有「阶段自检」一节，作为唯一正文')
  assert.match(skill, /--mode progress/, '要写清用的是进度模式')
  assert.match(skill, /错误（error）必须为 0|错误为 0/, '要写清通过线是错误为 0')
  for (const f of ['05-结构化初始化.md', '06-口径锚定.md', '07-卷循环.md', '08-设定库.md', '09-全书层.md']) {
    const t = readWf(f)
    assert.match(t, /阶段自检/, `${f} 要在收口前指向阶段自检`)
    // 指针式引用：正文只在 SKILL 写一遍，流程文件不复制命令细节
    assert.match(t, /\.\.\/SKILL\.md/, `${f} 应指向 SKILL.md 的那一节，而不是自己再写一套规则`)
  }
  // 10 是交付校验，不是阶段自检——它跑 deliver 模式，两者不能混成一句话。
  const t10 = readWf('10-校验交付.md')
  assert.ok(!/阶段自检/.test(t10), '10 不该出现「阶段自检」：它是 deliver 模式，与进度模式是两个用法')
})
