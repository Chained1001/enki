// 防的漂移：verify-quotes.mjs 的回源判定退化成「只看格式」，或三档计数与退出码脱节（技术文档 D-07）。
// 夹具一律最小化：manifest 只给 readManifest 要求的必填字段，原文只放被引用的句子，不复制真实语料。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyQuotes } from '../skills/book-breakdown/scripts/verify-quotes.mjs'
import { QUOTE_VERIFY } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scripts = join(here, '..', 'skills', 'book-breakdown', 'scripts')
const SCRIPT = join(scripts, 'verify-quotes.mjs')
const TMP_BASE = join(here, '.tmp')

// 章节正文：四章各一句可定位的原文，另留第二章的「长枪」句给章号不符用。
const CHAPTERS = [
  { no: 1, file: '0001-第一章 甲.txt', text: '第一章 甲\n张三走进车站，月台上空无一人。\n我们所做的事情，我们已经做了整整二十年。\n甲段正文在这里第一次出现。\n' },
  { no: 2, file: '0002-第二章 乙.txt', text: '第二章 乙\n李四把长枪当作冷兵器来用就好了！\n乙段内容写在第二章这一章里。\n' },
  { no: 3, file: '0003-第三章 丙.txt', text: '第三章 丙\n丙段内容出现在第三章的结尾处。\n' },
  { no: 12, file: '0012-第十二章 壬.txt', text: '第十二章 壬\n壬章正文里有一句话叫做风起于青萍之末。\n' },
]

// 最小合法 manifest：readManifest 硬性要求 chapterCount / volumes / chapters 三字段。
function manifestOf(chapters) {
  return {
    chapterCount: chapters.length,
    volumes: [],
    chapters: chapters.map((c) => ({ no: c.no, file: c.file, title: c.title ?? c.file.replace(/^\d+-/, '').replace(/\.txt$/, '') })),
  }
}

// 造一份产物：工作/manifest.json + 原文/章节/*.txt + 故事底本/全书设定/世界观.md。
async function makeProduct(lines, chapters = CHAPTERS) {
  mkdirSync(TMP_BASE, { recursive: true }) // 临时目录基座可能被别的测试清掉，用前重建
  const dir = await mkdtemp(join(TMP_BASE, 'vq-'))
  await mkdir(join(dir, '工作'), { recursive: true })
  await mkdir(join(dir, '原文', '章节'), { recursive: true })
  await mkdir(join(dir, '故事底本', '全书设定'), { recursive: true })
  await writeFile(join(dir, '工作', 'manifest.json'), JSON.stringify(manifestOf(chapters), null, 2), 'utf8')
  for (const c of chapters) await writeFile(join(dir, '原文', '章节', c.file), c.text, 'utf8')
  await writeFile(join(dir, '故事底本', '全书设定', '世界观.md'), `# 世界观\n\n${lines.join('\n')}\n`, 'utf8')
  return dir
}

// 子进程运行 CLI：stdout/stderr 用临时文件承接（受限沙箱里管道可能 EPERM），读完即删。
function runCli(args) {
  mkdirSync(TMP_BASE, { recursive: true })
  const dir = mkdtempSync(join(TMP_BASE, 'run-'))
  const outPath = join(dir, 'stdout.txt')
  const errPath = join(dir, 'stderr.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', outFd, errFd] })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  try {
    return { status: result.status, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- 1. 全部通过 ----------

test('全部通过的产物：退出码 0，--json 的 data.pass 等于引句数', async () => {
  const dir = await makeProduct([
    '- 初遇：走进车站，月台上空无一人（第1章「张三走进车站，月台上空无一人」）',
    '- 长枪：当作冷兵器来用（第2章「李四把长枪当作冷兵器来用就好了！」）',
  ])
  try {
    const r = runCli(['--json', dir])
    assert.equal(r.status, 0, `应退出 0，stderr：${r.stderr}`)
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.ok, true)
    assert.deepEqual(obj.errors, [])
    assert.equal(obj.data.total, 2, '两条引句都参与判定')
    assert.equal(obj.data.pass, 2, 'data.pass 应等于引句数')
    assert.equal(obj.data.wrongChapter, 0)
    assert.equal(obj.data.notFound, 0)
    assert.equal(obj.data.skippedTerms, 0)
    assert.deepEqual(obj.data.items, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 2. 章号不符 ----------

test('章号不符：引句取自第 2 章却标第 1 章 → 退出 1，bucket 为 wrong-chapter', async () => {
  const dir = await makeProduct([
    '- 长枪：当作冷兵器来用（第1章「李四把长枪当作冷兵器来用就好了！」）',
  ])
  try {
    const r = runCli(['--json', dir])
    assert.equal(r.status, 1, '存在章号不符应退出 1')
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.ok, false)
    assert.equal(obj.data.wrongChapter, 1)
    assert.equal(obj.data.notFound, 0, '引句在全书里存在，不应同时计入找不到')
    assert.equal(obj.data.items.length, 1)
    const item = obj.data.items[0]
    assert.equal(item.bucket, 'wrong-chapter')
    assert.deepEqual(item.chapters, [1])
    assert.equal(item.file, '故事底本/全书设定/世界观.md')
    assert.equal(item.line, 3, '世界观.md 第 3 行是第一个结论行')
    assert.equal(item.quote, '李四把长枪当作冷兵器来用就好了！')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('--max-findings 只截断 items，不截断计数', async () => {
  const dir = await makeProduct([
    '- 甲（第1章「这段话全书都没有出现过一字」）',
    '- 乙（第1章「这段也是凭空编出来的引句」）',
  ])
  try {
    const r = runCli(['--json', '--max-findings', '1', dir])
    assert.equal(r.status, 1)
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.data.notFound, 2, '计数是完整数')
    assert.equal(obj.data.items.length, 1, 'items 受 --max-findings 限制')
    assert.equal(obj.data.truncated, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 3. 全书找不到 ----------

test('全书找不到：引句在全书原文里不存在 → 退出 1，bucket 为 not-found', async () => {
  const dir = await makeProduct([
    '- 编排的句子（第1章「这句话全书原文里根本没有出现过」）',
  ])
  try {
    const r = runCli(['--json', dir])
    assert.equal(r.status, 1)
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.data.notFound, 1)
    assert.equal(obj.data.wrongChapter, 0)
    assert.equal(obj.data.items[0].bucket, 'not-found')
    assert.equal(obj.data.items[0].quote, '这句话全书原文里根本没有出现过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 4. 省略号跨段 ----------

test('省略号跨段：两段分别在第 1、第 3 章，声明第1章、第3章 → 通过', async () => {
  const dir = await makeProduct([
    '- 跨章对照（第1章、第3章「甲段正文……丙段内容」）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.ok, true, JSON.stringify(result.data.items))
    assert.equal(result.data.total, 1)
    assert.equal(result.data.pass, 1, '两个有效段都在声明章号的原文里，应通过')
    assert.equal(result.data.wrongChapter, 0)
    assert.equal(result.data.notFound, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('省略号跨段：段跨在未声明的章里 → 章号不符（不是找不到）', async () => {
  const dir = await makeProduct([
    '- 跨章对照（第1章「甲段正文……丙段内容」）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.wrongChapter, 1, '段在全书中都存在，只是有一段落在他章')
    assert.equal(result.data.notFound, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 5. 术语标注排除 ----------

test('术语标注排除：「社会与文化」无标点且 <10 字 → 计入 skippedTerms，不判失败', async () => {
  const dir = await makeProduct([
    '- 社会结构：见「社会与文化」，「地理图志」另有专章（第1章）',
  ])
  try {
    const r = runCli(['--json', dir])
    assert.equal(r.status, 0, '只有术语标注时不判失败')
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.ok, true)
    assert.equal(obj.data.skippedTerms, 2, '两个术语标注都跳过')
    assert.equal(obj.data.total, 0, '术语标注不参与三档判定')
    assert.equal(obj.data.pass, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 6. 标点差异容忍 ----------

test('标点差异容忍：原文有逗号、引句没有 → 通过', async () => {
  const dir = await makeProduct([
    '- 二十年（第1章「我们所做的事情我们已经做了整整二十年」）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.total, 1)
    assert.equal(result.data.pass, 1, '双向去标点后应命中')
    assert.equal(result.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 7. 参数错误与 --help ----------

test('未知参数退出码为 2，错误信息写明未知参数与修法', async () => {
  const dir = await makeProduct(['- 初遇（第1章「张三走进车站，月台上空无一人」）'])
  try {
    const r = runCli(['--bogus', dir])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /未知参数 --bogus/)
    assert.match(r.stderr, /用法/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('--help 退出码为 0 且输出含用法与三档说明', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法/)
  assert.match(r.stdout, /章号不符/)
  assert.match(r.stdout, /术语标注排除/)
})

// ---------- 8. 环境缺失 ----------

test('产物目录不存在 → 退出码 3，错误信息给出目录与修法', () => {
  const missing = join(TMP_BASE, 'vq-not-exist')
  const r = runCli([missing])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /产物目录不存在/)
})

test('缺工作/manifest.json → 退出码 3，errors 带 E_MANIFEST 且无字段不完整误报', async () => {
  mkdirSync(TMP_BASE, { recursive: true })
  const dir = await mkdtemp(join(TMP_BASE, 'vq-nomanifest-'))
  try {
    await mkdir(join(dir, '原文', '章节'), { recursive: true })
    const r = runCli(['--json', dir])
    assert.equal(r.status, 3)
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.ok, false)
    assert.equal(obj.errors[0].code, 'E_MANIFEST')
    assert.ok(obj.errors[0].file === '工作/manifest.json')
    assert.equal(obj.data.pass, 0, '计数应为数字 0，不是 undefined')
    assert.equal(obj.data.total, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 9. 中文数字章号 ----------

test('中文数字章号「第十二章」能正确映射到 manifest 的 no 12', async () => {
  const dir = await makeProduct([
    '- 风起（第十二章「壬章正文里有一句话叫做风起于青萍之末。」）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.total, 1)
    assert.equal(result.data.pass, 1, '中文数字章号须映射到 no=12，否则会判成找不到')
    assert.equal(result.ok, true)
    // 反向确认：标成不存在的第十一章就该是章号不符。
    const dir2 = await makeProduct([
      '- 风起（第十一章「壬章正文里有一句话叫做风起于青萍之末。」）',
    ])
    try {
      const wrong = await verifyQuotes({ root: dir2 })
      assert.equal(wrong.data.wrongChapter, 1, '第十一章映射为 11，该章无原文，引句在全书中存在')
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 坐标字段行的逐条判定（第 3 次打回的回归防护，三道门槛）----------

test('坐标字段 + 无标点：「幕号与幕名：…「白帝城 Bai Di Cheng」」跳过，skippedMeta 计 1，不进 total', async () => {
  // 真实产物里幕名只出现在章节标题与文件名，prepare 切章不写进正文，核验必然 100% 误报。
  const dir = await makeProduct([
    '- 幕号与幕名：幕 01，序章「白帝城 Bai Di Cheng」（对应全局第 1 章，1,452 字）。',
  ])
  try {
    const r = runCli(['--json', dir])
    assert.equal(r.status, 0, '只剩坐标字段行时不应判失败，stderr：' + r.stderr)
    const obj = JSON.parse(r.stdout)
    assert.equal(obj.data.skippedMeta, 1, '无标点的名称引号计 1 条')
    assert.equal(obj.data.total, 0, '坐标字段的名称引号不进 total')
    assert.equal(obj.data.notFound, 0, '不得把幕名当作找不到的引句')
    assert.equal(obj.data.skippedTerms, 0, '坐标字段引号不能记进 skippedTerms（语义不同）')
    assert.deepEqual(obj.data.items, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坐标字段 + 有标点 + 全书能找到 → 进 total 并判 pass（救回真引句）', async () => {
  // 「第五元素……纯净的精神元素」这类：字段是坐标字段，但引号确是真原文，必须救回来核验。
  // 夹具第 1 章正文里有「纯净的精神元素」与「第五元素」，省略号分段后两段都能找到。
  const chapters = CHAPTERS.map((c) =>
    c.no === 1 ? { ...c, text: c.text + '第五元素，纯净的精神元素，只有它能击毙龙王。\n' } : c,
  )
  const dir = await makeProduct([
    '- 名称：贤者之石（「第五元素……纯净的精神元素」，第1章）',
  ], chapters)
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.total, 1, '能找到的真引句必须进 total（不能被坐标字段规则吞掉）')
    assert.equal(result.data.pass, 1, '分段后两段都在第 1 章，应判通过')
    assert.equal(result.data.skippedMeta, 0, '能找到就不算坐标字段跳过')
    assert.equal(result.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坐标字段 + 有标点 + 全书找不到 → 进 skippedMeta、不进 total（幕名防护，最关键）', async () => {
  // 「哥哥—弟弟」含破折号，但正文里不存在。若只按「含标点就核验」会重新误报成 not-found。
  const dir = await makeProduct([
    '- 幕号与幕名：幕 08，第七幕「哥哥—弟弟」（对应全局第 1 章，21,267 字）。',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.total, 0, '含标点但全书中找不到 → 仍当名称放过，不进 total')
    assert.equal(result.data.skippedMeta, 1, '计入 skippedMeta')
    assert.equal(result.data.notFound, 0, '绝不能把这种幕名判成找不到')
    assert.equal(result.ok, true, '跳过即通过，不应让退出码变 1')
    assert.deepEqual(result.data.items, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('术语规则照旧管非坐标字段：「核心关系：某人（「最好配对」）」走 skippedTerms，不进 total', async () => {
  const dir = await makeProduct([
    '- 核心关系：诺诺（情侣，公开的「最好配对」）（第1章）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.total, 0, '短术语不参与三档判定')
    assert.equal(result.data.skippedTerms, 1, '「最好配对」五字无标点 → 术语规则跳过')
    assert.equal(result.data.skippedMeta, 0, '「核心关系」不是坐标字段，不能整行跳过')
    assert.equal(result.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非坐标字段的长引句必须照常核验：「说话风格与人设锚点」里的真引句不能被整行跳过', async () => {
  // 这是第 2 次打回的核心漏检：整行按 SOURCE_META_LABELS 跳过会把这类真引句一起漏掉。
  const dir = await makeProduct([
    '- 说话风格与人设锚点：皇帝式短句＋精英论宣言——「真正的精英，永远不会是大多数！」（第2章）',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.skippedMeta, 0, '「说话风格与人设锚点」不属坐标字段，不得整行跳过')
    assert.equal(result.data.total, 1, '该引句必须进入核验')
    // 夹具第 2 章正文里没有这句，所以判 not-found 才对——关键是被「判过」，而不是被跳过。
    assert.equal(result.data.notFound, 1, '没被跳过就会判找不到（夹具无此句），说明确实进入核验')
    assert.equal(result.ok, false)
    assert.equal(result.data.items[0].bucket, 'not-found')
    // 反向：把同一句放进第 2 章正文，就该通过——证明核验链路真的在比对原文。
    const hit = CHAPTERS.map((c) => (c.no === 2 ? { ...c, text: c.text + '真正的精英，永远不会是大多数！\n' } : c))
    const dir2 = await makeProduct([
      '- 说话风格与人设锚点：皇帝式短句＋精英论宣言——「真正的精英，永远不会是大多数！」（第2章）',
    ], hit)
    try {
      const ok = await verifyQuotes({ root: dir2 })
      assert.equal(ok.data.pass, 1, '原文存在该句时应通过')
      assert.equal(ok.data.total, 1)
      assert.equal(ok.ok, true)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 契约常量（D-01 单一机器源）----------

test('作者的话是合法引用来源：里面的原话不应被判「全书找不到」（Q-32）', async () => {
  // 真书实测盲区：prepare 把前言/后记归集到 原文/作者的话.md，它不在 manifest 章节清单里，
  // 旧版完全不读，作者原话一律被判找不到。长安的荔枝的「我本来只打算写四章」就是这么被误判的。
  const dir = await makeProduct([
    '- 作者自述：原文写「我本来只打算写四章。但她看完第一章 后，断言这个体量没六章不能尽兴」（第 1 章）',
  ])
  try {
    await mkdir(join(dir, '原文'), { recursive: true })
    await writeFile(join(dir, '原文', '作者的话.md'),
      '## 作者的话\n\n- 【第1章】我本来只打算写四章。但她看完第一章 后，断言这个体量没六章不能尽兴\n', 'utf8')
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.notFound, 0, '作者的话里的原话不应被判找不到')
    // 该句不在第 1 章正文里，只存在于作者的话，故判 wrong-chapter（引句真、但不在该章正文）——
    // 关键是它没有落在 not-found，说明作者的话确实参与了全量查找。
    assert.equal(result.data.wrongChapter, 1, '应判章号不符而非全书找不到')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('散文行引句进统计通道：能回源计入 pass，找不到列存疑但不阻断（Q-31）', async () => {
  // 真书实测盲区：旧版只扫「-」列表行，129 行散文里的 169 条引句从未被检查。
  // 但散文引号多为强调而非逐字引用，按列表行口径判失败会一次报出 8 条误报，
  // 故本通道只统计＋提示，不改 ok 与退出码。
  const dir = await makeProduct([
    '- 结论行：张三在此登场（第1章）',
    '',
    '这是一段散文，里面引了原文一句「我们所做的事情，我们已经做了整整二十年」（第1章）。',
    '',
    '这一段的自拟长句「谁都没想到事情最后会变成这个样子」，原文里并不存在（第1章）。',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.prose.total, 2, '两条散文引句都要进统计')
    assert.equal(result.data.prose.pass, 1, '能回源的那条计入 pass')
    assert.equal(result.data.prose.suspect, 1, '找不到的那条记为存疑')
    assert.equal(result.ok, true, '存疑是提示项，不得影响通过判定')
    assert.match(result.data.prose.items[0].quote, /谁都没想到事情最后会变成这个样子/, '存疑项要列出原文供人工核对')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('散文行没有章号时不进统计（无出处无法定位，交给 validate-output 的 E_SOURCE）', async () => {
  const dir = await makeProduct([
    '- 结论行：张三在此登场（第1章）',
    '',
    '这段散文有引句「我们所做的事情，我们已经做了整整二十年」但没有标章号。',
  ])
  try {
    const result = await verifyQuotes({ root: dir })
    assert.equal(result.data.prose.total, 0, '没有章号的散文行不归本脚本判')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('QUOTE_VERIFY 的取值锁死为实测口径，改动会被这条抓住', () => {
  // 期望值硬编码为字面量（评审 P21 的口径）：从契约自身推导期望＝漂移不可见。
  assert.equal(QUOTE_VERIFY.术语长度上限, 10)
  assert.equal(QUOTE_VERIFY.最短段长度, 4)
  assert.equal(QUOTE_VERIFY.术语排除标点, '，。！？；、…—')
  // 标点归一集合须覆盖两类字符：中文标点、英文标点；空白由 \s 覆盖（单独断言）。
  for (const ch of ['，', '。', '！', '？', '；', '：', '、', '「', '」', '『', '』', '“', '”', '‘', '’', '（', '）', '(', ')', '《', '》', '…', '—', '-', ',', '.', '!', '?', ';', ':', '"', "'"]) {
    assert.ok(QUOTE_VERIFY.标点归一.includes(ch), `标点归一须包含「${ch}」`)
  }
  assert.ok(QUOTE_VERIFY.标点归一.includes('\\s'), '标点归一须含 \\s 以删空白（含全角空格）')
  // 坐标字段整行跳过的集合锁死：只放名称/标题/编号类字段。
  // 不能改成引用 SOURCE_META_LABELS——那份白名单管 E_SOURCE，含「说话风格与人设锚点」「核心关系」
  // 等会带真引句的结论字段，混用会让核验面减半（真实产物实测 314 → 166）。
  const expected = [
    '幕号与幕名', '起止章', '卷号与卷名', '卷名来源', '弧名', '章数', '字数', '时段',
    '名称', '姓名', '主名', '别称', '别称与马甲', '标题', '对象', '对象A', '对象B', '定位',
    '判定', '指向',
  ]
  assert.deepEqual([...QUOTE_VERIFY.坐标字段].sort(), [...expected].sort())
  // 反例：会带真引句的结论字段绝不在坐标集合里。
  for (const label of ['说话风格与人设锚点', '核心关系', '关键章节链', '依据', '结构职能', '金句锚', '归属势力']) {
    assert.ok(!QUOTE_VERIFY.坐标字段.includes(label), `「${label}」不是坐标字段，不得整行跳过`)
  }
})

// 自清理：用例已各自删除临时产物；这里只试着移除空的基座目录，不递归删别人的夹具
// （--test-isolation=none 下各测试文件同进程，cli.test.mjs 也用 test/.tmp/）。
after(async () => {
  try {
    await rmdir(TMP_BASE)
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
})

// ---------- notFound 分流（产物实证 §9.2 第 8 条 / #26）----------
//
// 「全书找不到」原本是一个笼统的数，但「抄错了」和「编的」严重程度差一个量级：
// 前者是校对问题，后者是真实性问题。分不出来，报告就没法用。
//
// 夹具格式注意：引句必须写在**带章号的列表行**里（`- 结论：…（第 N 章「引句」）。`），
// 否则脚本按「没有章号的行不归我判」直接跳过，total=0、分流永远不触发——
// 一开始我把引句写成散文段，用例全绿但什么都没测到。

// 可还原：原文有这句，引句里漏了一个字。
// 4-gram 会因此掉一点分（0.89），LCS 仍满分 —— 两个指标一起判才判得准。
test('notFound 分流：原文有这句、引句漏字 → 判可还原', async () => {
  const dir = await makeProduct([
    '- 漏字那条：原文里确实有这句话（第 1 章「张三走进车站，月台上空无一人。」）。',
    '- 这条漏了一个字：张三走进车站，月台上空无人（第 2 章「张三走进车站，月台上空无人。」）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    assert.ok(r.data.total >= 2, `夹具里的引句要真进统计，否则这条用例什么都没测到（total=${r.data.total}）`)
    assert.equal(r.data.notFound, r.data.recoverable + r.data.unrecoverable, '两档之和必须等于 notFound')
    assert.equal(r.data.unrecoverable, 0, '漏一个字的引句该判可还原，不该判「编的」')
    assert.ok(r.data.recoverable >= 1, '至少那条漏字的要判可还原')
    // 还原到了哪一章也要说对，否则「可还原」只是个含糊的好消息
    const hit = r.data.items.find((x) => x.bucket === 'not-found' && x.restored)
    assert.equal(hit.restored.chapter, 1, '应还原到第 1 章——那句原文在那里')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 不可还原：全书没有相近的句子 —— 编的。
test('notFound 分流：全书没有相近句子 → 判不可还原', async () => {
  const dir = await makeProduct([
    '- 结论：这句是编的（第 1 章「紫气东来三万里，一剑光寒十九洲。」）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    assert.equal(r.data.total, 1, '这条必须真进统计')
    assert.equal(r.data.recoverable, 0, '全书没有相近句子时不能判可还原')
    assert.equal(r.data.unrecoverable, 1, '编造的引句必须判不可还原')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 两个阈值各自都要能改红用例 —— 只看一个指标会让另一类漏判。
// 这一条锁 LCS：引句中间漏了字，4-gram 掉到 1.0 以下但 LCS 仍高。
test('分流判据：LCS 与 4-gram 任一达标即算可还原（单看一个会漏判）', async () => {
  const dir = await makeProduct([
    // 漏了两个字，gram 重合率约 0.8，LCS 仍接近 1
    '- 漏两字：我们把事情做了整整二十年（第 1 章「我们把事情做了整整二十年。」）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    const item = r.data.items.find((x) => x.bucket === 'not-found')
    assert.ok(item, '这条应判 not-found（不是一字不差）')
    assert.ok(item.restored, 'LCS 高说明原文有这句，必须判可还原')
    assert.ok(item.restored.lcs >= QUOTE_VERIFY.notFound还原.LCS下限, 'LCS 应达到阈值')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 边界一：和某章共享一点字词、但整体完全是另一句话 —— 这仍是「编的」。
// 这条专门锁 LCS 阈值：若把阈值调到 0，任何有候选的引句都会变成「可还原」，
// 于是「编了个沾边的句子」就被美化成了「抄错几个字」。
test('分流边界：只沾几个字、整体不同 → 仍判不可还原', async () => {
  const dir = await makeProduct([
    // 与第 1 章的「张三走进车站，月台上空无一人。」只共享「张三走进」四个字
    '- 沾边的：张三走进了另一座城市的车站候车大厅（第 2 章「张三走进了另一座城市的车站候车大厅」）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    assert.equal(r.data.total, 1)
    assert.equal(r.data.recoverable, 0, '只共享几个字的句子不是「抄错」，不能判可还原')
    assert.equal(r.data.unrecoverable, 1, '这仍属于「全书没有这句」，应判不可还原')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 边界二：原文的句子被拆开重排（两处拼接、语序打乱）。
// 4-gram 全命中但 LCS 低——这条锁 4-gram 阈值：只看 LCS 会判成「编的」，
// 而它的每个片段都确实出自原文，该判可还原。
test('分流边界：原文片段重排 → 4-gram 达标即可判可还原', async () => {
  const dir = await makeProduct([
    // 第 1 章正文有「我们所做的事情，我们已经做了整整二十年。」
    // 引句把它前后半句对调：gram 基本全在，LCS 明显下降
    '- 重排的：我们已经做了整整二十年我们所做的事情（第 2 章「我们已经做了整整二十年我们所做的事情」）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    const item = r.data.items.find((x) => x.bucket === 'not-found')
    assert.ok(item, '这条应判 not-found')
    assert.ok(item.restored, '片段都出自原文，应判可还原——只看 LCS 会漏掉这一类')
    assert.ok(
      item.restored.gramRatio >= QUOTE_VERIFY.notFound还原.四字重合率下限,
      `4-gram 重合率应达标（实际 ${item.restored.gramRatio.toFixed(2)}）`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 边界三：章题是常用短词时，不能把别的章的普通引句吃掉。
// 这条锁「只与该行标注的章比」——若改成在全書所有章题里比，
// 「雪夜」这类短章题会把大量含这两个字的正常引句误跳过。
test('章题规则只在标注章内比：别的章的章题不吃正常引句', async () => {
  // 构造「会被误吃」的形状：第 2 章纯标题是「白帝城的雨夜」，
  // 第 1 章正文里有一句**恰好等于**这个字符串的话。
  // 规则若改成「在全书所有章题里比」，这条会被误判成「抄了第 2 章章名」而跳过。
  // 构造「必被误吃」的形状需要同时满足三个条件（我在这里连踩两次）：
  //   ① 引句**精确等于**第 2 章的纯标题 —— 否则全书比也不会命中；
  //   ② 该标题长于 QUOTE_VERIFY.术语长度上限（10 字）—— 否则先被术语规则拦下；
  //   ③ 该字符串确实出现在第 1 章正文里 —— 这样它才是一条「真引句」。
  const TITLE = '白帝城的雨夜与那盏未灭的灯'
  const chapters = [
    { no: 1, file: '0001-第一章 甲.txt', title: '第一章 甲', text: `第一章 甲\n他反复念着那七个字：${TITLE}。\n` },
    { no: 2, file: `0002-第二章 ${TITLE}.txt`, title: `第二章 ${TITLE}`, text: `第二章 ${TITLE}\n乙段内容写在第二章这一章里。\n` },
  ]
  const dir = await makeProduct([
    // 标的是第 1 章；引句精确等于第 2 章纯标题，但它确实在第 1 章正文里
    `- 结论：「${TITLE}」（第 1 章）。`,
  ], chapters)
  try {
    const r = await verifyQuotes({ root: dir })
    assert.equal(r.data.pass, 1, '第 1 章正文里的引句必须判通过，不能因为第 2 章标题同名就被跳过')
    assert.equal(r.data.skippedMeta, 0, '这条不该进跳过计数')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 去掉编号前缀后精确比：章题是「第三章 白帝城的雨夜」、产物引「白帝城的雨夜」，也该认出来。
test('章题比对会去掉「第N章」前缀', async () => {
  const chapters = [
    { no: 3, file: '0003-第三章 白帝城的雨夜.txt', title: '第三章 白帝城的雨夜', text: '第三章 白帝城的雨夜\n丙段内容出现在第三章的结尾处。\n' },
  ]
  const dir = await makeProduct([
    '- 本章名为「白帝城的雨夜」（第 3 章）。',
  ], chapters)
  try {
    const r = await verifyQuotes({ root: dir })
    assert.ok(r.data.skippedMeta >= 1, '章题带编号前缀时，去掉前缀后仍要认出纯标题')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 反过来：把带编号的完整章题当引句，也该认出来。
test('章题比对也认带编号的完整写法', async () => {
  const chapters = [
    { no: 3, file: '0003-第三章 白帝城的雨夜.txt', title: '第三章 白帝城的雨夜', text: '第三章 白帝城的雨夜\n丙段内容出现在第三章的结尾处。\n' },
  ]
  const dir = await makeProduct([
    '- 本章名为「第三章 白帝城的雨夜」（第 3 章）。',
  ], chapters)
  try {
    const r = await verifyQuotes({ root: dir })
    assert.ok(r.data.skippedMeta >= 1, '完整章题写法也应认出，不能只认纯标题')
    assert.equal(r.data.notFound, 0, '完整章题不该被判找不到')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 章题当引句：章名不在章节正文里，判 notFound 是纯误报。
test('章题抄成引句 → 跳过，不计入 notFound', async () => {
  // 章题要长于 QUOTE_VERIFY.最短段长度，否则先被术语规则拦下（那就测不到章题这条了）
  const chapters = [
    { no: 1, file: '0001-第一章 甲.txt', title: '第一章 甲', text: '第一章 甲\n甲段正文在这里第一次出现。\n' },
    { no: 3, file: '0003-第三章 白帝城的雨夜.txt', title: '第三章 白帝城的雨夜', text: '第三章 白帝城的雨夜\n丙段内容出现在第三章的结尾处。\n' },
  ]
  const dir = await makeProduct([
    // 产物里记章名时通常只写纯标题（不带「第三章」），这才是真实写法
    '- 本章名为「白帝城的雨夜」（第 3 章）。',
  ], chapters)
  try {
    const r = await verifyQuotes({ root: dir })
    assert.equal(r.data.notFound, 0, '章题不是正文引句，不该判找不到')
    assert.ok(r.data.skippedMeta >= 1, '应归入跳过而不是找不到')
    assert.equal(r.data.total, 0, '章题根本不该进统计')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 反例：正常引句不能被章题规则吃掉。
// 章题常是常用词，若在全书所有章题里比，正常短引句会被大量误跳过。
test('章题规则不吃正常引句：只与该行标注的章比', async () => {
  const dir = await makeProduct([
    '- 结论：「我们所做的事情，我们已经做了整整二十年。」（第 1 章）。',
  ])
  try {
    const r = await verifyQuotes({ root: dir })
    assert.equal(r.data.pass, 1, '真引句必须判通过，不能被章题规则跳过')
    assert.equal(r.data.skippedMeta, 0, '这条不该进跳过计数')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// humanReport 必须把两档分行打印，否则分流等于没做。
test('humanReport 把可还原与不可还原分行打印', async () => {
  const dir = await makeProduct([
    '- 结论：编的句子（第 1 章「紫气东来三万里，一剑光寒十九洲。」）。',
  ])
  try {
    const out = runCli([dir])
    assert.match(out.stdout, /可还原/, '报告里要有「可还原」这一行')
    assert.match(out.stdout, /不可还原/, '报告里要有「不可还原」这一行')
    assert.match(out.stdout, /校对问题/, '要说明可还原是校对问题，否则看报告的人不知道怎么处理')
    assert.match(out.stdout, /真实性/, '要说明不可还原是真实性问题')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
