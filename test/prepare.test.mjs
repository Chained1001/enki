// 防的漂移：prepare.mjs 的切章、噪音剥离、分卷、骨架落位与 PRD/产品流程契约脱节。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cnToInt, detectChapters, detectVolumes, fingerprint, prepare } from '../skills/book-breakdown/scripts/prepare.mjs'

const SAMPLE = `前言部分，交代背景。

第一章 开始

张三走进车站，雨很大。

第二章 相遇

他遇见了李四。

第三章 离开

张三坐上火车。`

async function withDir(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
  try {
    await run({ dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeSample(dir, name, text) {
  const src = join(dir, name)
  await writeFile(src, text, 'utf8')
  return src
}

test('detectChapters 识别前言与三章', () => {
  const chapters = detectChapters(SAMPLE)
  assert.equal(chapters.length, 4)
  assert.equal(chapters[0].title, '前言')
  assert.equal(chapters[1].title, '第一章 开始')
  assert.equal(chapters[3].title, '第三章 离开')
})

test('prepare 建立产物树、复制原文、切章、写清单', async () => {
  await withDir('prepare', async ({ dir }) => {
    const src = await writeSample(dir, '测试书.txt', SAMPLE)
    const r = await prepare({ input: src })
    assert.equal(r.book, '测试书')
    assert.equal(r.chapterCount, 4)
    assert.equal(r.outDir, join(dir, '测试书_拆解'))

    assert.ok(existsSync(join(r.outDir, '原文', '测试书.txt')), '应复制原文')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '卷纲')), '应有卷纲目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '幕纲')), '应有幕纲目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定')), '应有设定目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '人物', '主角')), '应有主角目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '人物', '主要配角')), '应有主要配角目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '人物', '次要角色')), '应有次要角色目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '势力与组织', '门派')), '应有门派目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '地点', '其他')), '应有地点其他目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '物品', '武器')), '应有武器目录')
    assert.ok(existsSync(join(r.outDir, '故事底本', '全书设定', '概念', '事件')), '应有事件目录')

    const chapterFiles = await readdir(join(r.outDir, '原文', '章节'))
    assert.equal(chapterFiles.length, 4)

    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.chapterCount, 4)
    assert.equal(manifest.chapters[1].title, '第一章 开始')
  })
})

test('没有章节标题时明确失败', async () => {
  await withDir('prepare-bad', async ({ dir }) => {
    const src = await writeSample(dir, '无章节.txt', '这是一段没有标题的文字。')
    await assert.rejects(() => prepare({ input: src }), /未识别到章节标题/)
  })
})

test('非 txt 文件被拒绝', async () => {
  await withDir('prepare-ext', async ({ dir }) => {
    const src = await writeSample(dir, 'a.md', 'x')
    await assert.rejects(() => prepare({ input: src }), /不是 \.txt 文件/)
  })
})

test('章节数少于 3 触发护栏', async () => {
  await withDir('prepare-few', async ({ dir }) => {
    const src = await writeSample(dir, '两章.txt', '第一章 一\n正文\n\n第二章 二\n正文\n')
    await assert.rejects(() => prepare({ input: src }), /章节数少于 3/)
    assert.ok(!existsSync(join(dir, '两章_拆解')), '护栏失败不得建目录')
  })
})

test('噪音剥离：广告、本章完、更新预告不进正文；作者话归集；标题后缀剥离', async () => {
  const text = [
    '第一章 开始（求月票）',
    '正文甲。',
    'www.example.com 换源阅读',
    '（本章完）',
    '求月票！',
    '',
    '第二章 相遇',
    '正文乙。',
    '感谢老板打赏白银盟！',
    '',
    '第三章 结束',
    '正文丙。',
  ].join('\n')
  const chapters = detectChapters(text)
  assert.equal(chapters.length, 3)
  assert.equal(chapters[0].title, '第一章 开始')
  assert.ok(chapters[0].text.includes('正文甲'))
  assert.ok(!chapters[0].text.includes('example.com'))
  assert.ok(!chapters[0].text.includes('本章完'))
  assert.deepEqual(chapters[0].notes, ['求月票！'])
  assert.deepEqual(chapters[1].notes, ['感谢老板打赏白银盟！'])

  await withDir('prepare-noise', async ({ dir }) => {
    const src = await writeSample(dir, '噪音书.txt', text)
    const r = await prepare({ input: src })
    const notes = readFileSync(join(r.outDir, '原文', '作者的话.md'), 'utf8')
    assert.ok(!notes.includes('求月票') || notes.includes('已按 Q-25 丢弃'), '例行附注不再归集正文条目（Q-25 收窄跟进）')
    assert.ok(notes.includes('丢弃'), '例行附注有丢弃计数')
    const body = readFileSync(join(r.outDir, '原文', '章节', '0001-第一章 开始.txt'), 'utf8')
    assert.ok(!body.includes('example.com') && !body.includes('本章完'))
  })
})

test('无附注时作者的话记「无」', async () => {
  await withDir('prepare-nonotes', async ({ dir }) => {
    const src = await writeSample(dir, '净书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const notes = readFileSync(join(r.outDir, '原文', '作者的话.md'), 'utf8')
    assert.ok(notes.includes('## 结构自述') && notes.includes('无'))
  })
})

test('章号重启检测分卷（诡秘形态）', async () => {
  const text = [
    '第一章 一', '正文一', '', '第二章 二', '正文二', '', '第三章 三', '正文三', '',
    '第四章 四', '正文四', '', '第五章 五', '正文五', '',
    '第一章 六', '正文六', '', '第二章 七', '正文七', '', '第三章 八', '正文八', '',
  ].join('\n')
  await withDir('prepare-restart', async ({ dir }) => {
    const src = await writeSample(dir, '重启书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.volumes.length, 2)
    assert.equal(manifest.volumes[0].basis, '章号重启')
    assert.equal(manifest.volumes[1].startCh, 6, '第二部从全局第 6 章起')
    assert.equal(manifest.chapters[5].no, 6, '重启章全局编号连续')
  })
})

test('「第X卷」行为权威锚点（大奉形态）', async () => {
  const text = [
    '第一卷 风起', '', '第一章 一', '正文一', '', '第二章 二', '正文二', '', '第三章 三', '正文三', '',
    '第688章 半卷地图的假标记不是卷', '正文', '',
    '第二卷 潮落', '', '第四章 四', '正文四', '', '第五章 五', '正文五', '',
  ].join('\n')
  await withDir('prepare-anchor', async ({ dir }) => {
    const src = await writeSample(dir, '卷标书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.volumes.length, 2)
    assert.equal(manifest.volumes[0].name, '风起')
    assert.equal(manifest.volumes[1].name, '潮落')
    assert.equal(manifest.volumes[0].basis, '卷标记行')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '卷纲', '卷01-风起.md')))
  })
})

test('「(第N卷完)」尾标记回推分卷（道诡形态）', async () => {
  const text = [
    '第一章 一', '正文一', '', '第二章 二', '正文二', '(第一卷完)', '',
    '第三章 三', '正文三', '', '第四章 四', '正文四', '(第二卷完)', '',
    '第五章 五', '正文五', '',
  ].join('\n')
  await withDir('prepare-tail', async ({ dir }) => {
    const src = await writeSample(dir, '尾标书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.volumes.length, 3)
    assert.equal(manifest.volumes[0].basis, '卷完尾标记')
    assert.equal(manifest.volumes[1].startCh, 3)
  })
})

test('锚点存在时章号重启信号并入卷界（绍宋口径差回归）', () => {
  const text = [
    '第一卷', '',
    '第一章 一', '正文', '', '第二章 二', '正文', '', '第三章 三', '正文', '本卷完', '',
    '第一章 四', '正文', '', '第二章 五', '正文', '',
    '第二卷总结 兼致歉信', '',
    '第三章 六', '正文', '',
  ].join('\n')
  const chapters = detectChapters(text)
  const vols = detectVolumes(chapters, text.split(/\r?\n/))
  assert.equal(vols.length, 3, '重启点 87 式切界并入：0-3 / 4-5 / 6-6')
  assert.deepEqual(vols.map((v) => [v.startCh, v.endCh]), [[0, 3], [4, 5], [6, 6]])
  assert.equal(vols[0].name, '第一卷')
  assert.equal(vols[0].basis, '卷标记行＋章号重启')
})

test('卷末总结行作卷界而非卷首（绍宋形态）', async () => {
  const text = [
    '第一卷', '',
    '第一章 一', '正文一', '', '第二章 二', '正文二', '', '第三章 三', '正文三', '',
    '第二卷总结 兼致歉信', '',
    '第四章 四', '正文四', '', '第五章 五', '正文五', '',
    '第三卷总结兼感谢', '',
    '第六章 六', '正文六', '',
  ].join('\n')
  const chapters = detectChapters(text)
  const vols = detectVolumes(chapters, text.split(/\r?\n/))
  assert.equal(vols.length, 3, '三段卷界：总结行之后切卷')
  assert.deepEqual(vols.map((v) => [v.startCh, v.endCh]), [[0, 3], [4, 5], [6, 6]], '前言归卷一')
  assert.equal(vols[0].name, '第一卷')
  assert.ok(vols.every((v) => v.endCh >= v.startCh), '不得出现倒挂区间')
})

test('出版书建卷层，幕＝原文单元（#12 行为变更：原先不建卷纲）', async () => {
  const unit = (n, name) => `第${n}幕 ${name}\n${'他说话了，声音很轻。'.repeat(2000)}\n`
  const text = unit('一', '开端') + '\n' + unit('二', '转折') + '\n' + unit('三', '收束')
  await withDir('prepare-pub', async ({ dir }) => {
    const src = await writeSample(dir, '出版书.txt', text)
    const r = await prepare({ input: src })
    assert.equal(r.bookType, '出版')
    // 卷是结构单位，出版书也有卷（实测龙族3 检出 4 卷、龙族1/2 单卷「全书」）。
    // 原先这两条断言的是「出版书不建分卷总表／不建卷纲」，那是被 bookType 分支砍掉的行为，已改。
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '分卷总表.md')), '出版书也建分卷总表')
    assert.ok(existsSync(join(r.outDir, '故事底本', '故事剧情', '卷纲')), '出版书也建卷纲目录')
    const volFiles = (await readdir(join(r.outDir, '故事底本', '故事剧情', '卷纲'))).filter((f) => f.endsWith('.md'))
    assert.equal(volFiles.length, r.volumes.length, '每卷一份卷纲')
    // 幕纲＝原文单元，且文件名带所属卷号（与网文同形，校验器不必分两套树形判断）
    const acts = (await readdir(join(r.outDir, '故事底本', '故事剧情', '幕纲'))).filter((f) => f.endsWith('.md'))
    assert.equal(acts.length, 3, '出版书幕纲＝原文单元数')
    assert.ok(acts.every((f) => /^卷\d{2}-幕\d{2}-/.test(f)), `幕纲文件名须为「卷NN-幕NN-名称.md」，实际：${acts.join('、')}`)
  })
})

test('骨架落位齐全且逐章记录行数＝章节数', async () => {
  await withDir('prepare-skel', async ({ dir }) => {
    const src = await writeSample(dir, '骨架书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const out = r.outDir
    for (const rel of [
      '故事底本/故事剧情/全书大纲.md', '故事底本/故事剧情/分卷总表.md',
      '故事底本/故事剧情/伏笔台账.md', '故事底本/故事剧情/开篇三章.md',
      '故事底本/全书设定/世界观.md', '故事底本/全书设定/金手指.md',
      '故事底本/文风.md', '工作/别名词典.md',
      '故事底本/全书设定/专题/力量体系.md', '故事底本/全书设定/专题/时代参照层.md',
      '故事底本/全书设定/人物/索引.md', '故事底本/全书设定/人物/人物关系.md',
      '故事底本/故事剧情/卷纲/卷01-全书.md',
    ]) {
      assert.ok(existsSync(join(out, rel)), `缺骨架文件 ${rel}`)
    }
    const goldfinger = readFileSync(join(out, '故事底本', '全书设定', '金手指.md'), 'utf8')
    for (const section of ['类型', '迭代与成长链', '与剧情耦合']) assert.ok(goldfinger.includes(`## ${section}`))
    const style = readFileSync(join(out, '故事底本', '文风.md'), 'utf8')
    assert.ok(style.includes('## 定量指纹') && style.includes('句均长'), '定量指纹应由脚本生成')
    const topic = readFileSync(join(out, '故事底本', '全书设定', '专题', '力量体系.md'), 'utf8')
    assert.ok(topic.includes('## 涉及判定') && topic.includes('判定：'))

    const record = readFileSync(join(out, '工作', '逐章记录.md'), 'utf8')
    const rows = record.split(/\r?\n/).filter((l) => l.startsWith('|')).length - 2
    assert.equal(rows, 4, '逐章记录行数＝章节数（含前言）')

    const manifest = JSON.parse(readFileSync(join(out, '工作', 'manifest.json'), 'utf8'))
    assert.ok(manifest.batches.length >= 1)
    for (const b of manifest.batches) assert.ok(b.endCh - b.startCh + 1 <= 20, '单批不超过 20 章')
    assert.equal(manifest.stages[2].status, 'done')
    assert.equal(manifest.stages[3].status, 'pending')
    assert.equal(manifest.files['原文/作者的话.md'], 'filled')
    assert.equal(manifest.files['故事底本/全书设定/金手指.md'], 'skeleton')
  })
})

test('dry-run 不落盘', async () => {
  await withDir('prepare-dry', async ({ dir }) => {
    const src = await writeSample(dir, '干跑书.txt', SAMPLE)
    const r = await prepare({ input: src, dryRun: true })
    assert.equal(r.action, 'dry-run')
    assert.equal(r.chapterCount, 4)
    assert.ok(!existsSync(join(dir, '干跑书_拆解')), 'dry-run 不得建目录')
  })
})

test('dry-run 也返回 totalChars（CLI 摘要要打印它，缺了就印空）', async () => {
  await withDir('prepare-dry-total', async ({ dir }) => {
    const src = await writeSample(dir, '干跑书.txt', SAMPLE)
    const dry = await prepare({ input: src, dryRun: true })
    assert.equal(typeof dry.totalChars, 'number', 'dry-run 必须给 totalChars')
    assert.ok(dry.totalChars > 0)
    // 与正式运行的结果一致：不能只在落盘路径算字数
    const real = await prepare({ input: src })
    assert.equal(dry.totalChars, real.totalChars, 'dry-run 与正式运行的 totalChars 必须相等')
  })
})

test('重入：不覆盖已有文件，源变更被拒，--force 归档重建', async () => {
  await withDir('prepare-resume', async ({ dir }) => {
    const src = await writeSample(dir, '续跑书.txt', SAMPLE)
    const first = await prepare({ input: src })
    const marker = join(first.outDir, '故事底本', '文风.md')
    await writeFile(marker, readFileSync(marker, 'utf8') + '\n<!-- 人工标记 -->\n', 'utf8')

    const again = await prepare({ input: src })
    assert.equal(again.action, 'resumed')
    assert.ok(readFileSync(marker, 'utf8').includes('人工标记'), '续跑不得覆盖已有产物')

    const changed = await writeSample(dir, '续跑书.txt', `${SAMPLE}\n\n第四章 新\n正文\n`)
    await assert.rejects(() => prepare({ input: changed }), /源文件已变更/)

    // --force 需要 --i-know 才算确认（B-07）：单用会报错并写明会丢多少、归档到哪
    await assert.rejects(
      () => prepare({ input: changed, force: true }),
      (e) => {
        assert.equal(e.code, 'E_FORCE_CONFIRM')
        assert.match(e.message, /已填文件需要重做/, '消息要说清会丢多少')
        assert.match(e.message, /归档到：/, '消息要给归档路径')
        assert.match(e.message, /--i-know/, '消息要给出确认方式')
        return true
      },
    )

    const forced = await prepare({ input: changed, force: true, iKnow: true })
    assert.ok(forced.archived && forced.archived.includes('_旧1'), 'force 应归档旧目录')
    assert.ok(existsSync(forced.archived), '归档目录应存在')
    assert.equal(forced.action, 'prepared')
  })
})

test('GBK 原文自动转码', { skip: !hasGbk() && '运行时 ICU 不含 GBK 解码器' }, async () => {
  await withDir('prepare-gbk', async ({ dir }) => {
    // 「第一章 甲\n内容测试。」等三章的 GBK 字节（第=B5DA，一=D2BB，章=D5C2）。
    const gbkBytes = [
      [0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xBC, 0xD7], [0x0A], [0xC4, 0xDA, 0xC8, 0xDD, 0xB2, 0xE2, 0xCA, 0xD4, 0xA1, 0xA3], [0x0A, 0x0A],
      [0xB5, 0xDA, 0xB6, 0xFE, 0xD5, 0xC2, 0x20, 0xD2, 0xD2], [0x0A], [0xC4, 0xDA, 0xC8, 0xDD, 0xB2, 0xE2, 0xCA, 0xD4, 0xA1, 0xA3], [0x0A, 0x0A],
      [0xB5, 0xDA, 0xC8, 0xFD, 0xD5, 0xC2, 0x20, 0xB1, 0xFB], [0x0A], [0xC4, 0xDA, 0xC8, 0xDD, 0xB2, 0xE2, 0xCA, 0xD4, 0xA1, 0xA3], [0x0A],
    ].flat()
    const src = join(dir, '古书.txt')
    await writeFile(src, Buffer.from(gbkBytes))
    const r = await prepare({ input: src })
    assert.equal(r.encoding, 'gbk')
    const body = readFileSync(join(r.outDir, '原文', '章节', '0001-第一章 甲.txt'), 'utf8')
    assert.ok(body.includes('内容测试'), '章节文件应为 UTF-8 可读')
  })
})

test('无法识别的编码明确失败', async () => {
  await withDir('prepare-badenc', async ({ dir }) => {
    const src = join(dir, '乱码.txt')
    await writeFile(src, Buffer.from([0xFF, 0xFE, 0x81, 0x40, 0x0A, 0xD2, 0xBB, 0x0A]))
    await assert.rejects(() => prepare({ input: src }), /无法识别原文编码/)
  })
})

test('末章超长且含「全书完」时切附录，正常番外不受影响', async () => {
  // 附录垃圾必须是不可分类的同人正文——可分类的感言行在清洗阶段就进了作者的话，撑不起超长章。
  const junk = `${'赵玖坐在明道宫中批阅奏折，宫外落雨。\n'.repeat(4000)}感谢老板打赏！\n`
  const bigEnding = `第三章 终\n${'决战落幕。'.repeat(200)}\n（全书完）\n${junk}读者同人选编。\n`
  const text = `第一章 一\n正文一\n\n第二章 二\n正文二\n\n${bigEnding}`
  await withDir('prepare-appx', async ({ dir }) => {
    const src = await writeSample(dir, '附录书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.ok(manifest.appendix, '应记附录')
    assert.ok(existsSync(join(r.outDir, '原文', '附录.txt')), '应写附录文件')
    assert.ok(manifest.chapters.at(-1).chars < 2000, '末章字数应回落到正文量级')
    const notes = readFileSync(join(r.outDir, '原文', '作者的话.md'), 'utf8')
    assert.ok(notes.includes('丢弃'), '附录区例行附注同样丢弃计数（Q-25 收窄跟进）')
    assert.ok(!manifest.chapters.at(-1).outlier, '截断后不再标异常章')
  })

  const normal = '第一章 一\n正文一\n\n第二章 二\n正文二\n\n番外篇 彩蛋\n正文三\n（全书完）\n'
  await withDir('prepare-noappx', async ({ dir }) => {
    const src = await writeSample(dir, '番外书.txt', normal)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.ok(!manifest.appendix, '正常规模的番外与全书完不切附录')
  })
})

test('乱码行被丢弃并计数', async () => {
  const text = '第一章 一\n正常行。\n\uFFFD\uFFFD乱码行\nÃ©Ã¨双重编码\n更多正文。\n\n第二章 二\n正文\n\n第三章 三\n正文\n'
  await withDir('prepare-garble', async ({ dir }) => {
    const src = await writeSample(dir, '乱码书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.noise.garbledLines, 2)
    const body = readFileSync(join(r.outDir, '原文', '章节', '0001-第一章 一.txt'), 'utf8')
    assert.ok(body.includes('正常行') && !body.includes('\uFFFD'), '乱码不进正文')
  })
})

test('金手指骨架含名称字段、文风骨架段序与模板一致', async () => {
  await withDir('prepare-skel2', async ({ dir }) => {
    const src = await writeSample(dir, '骨架二.txt', SAMPLE)
    const r = await prepare({ input: src })
    const goldfinger = readFileSync(join(r.outDir, '故事底本', '全书设定', '金手指.md'), 'utf8')
    assert.ok(goldfinger.includes('- 金手指名称：（待填）'), '金手指骨架应有名称字段')
    const style = readFileSync(join(r.outDir, '故事底本', '文风.md'), 'utf8')
    assert.ok(style.indexOf('## 定量指纹') < style.indexOf('## 原文样本'), '定量指纹应在原文样本之前')
  })
})


test('评审修复回归：正文噪音不误伤（P1）', () => {
  const text = ['第一章 一', '他笑了笑说，明天会更好的。', '大家好，我叫张三。', '求月票。', '', '第二章 二', '正文。', '', '第三章 三', '正文。'].join('\n')
  const c = detectChapters(text)
  assert.ok(c[0].text.includes('明天会更好的') && c[0].text.includes('我叫张三'), '正文句不被误剥')
  assert.equal(c[0].notes.length, 1, '仅真正的求月票行入附注')
})

test('评审修复回归：目录页跳过（P2）', () => {
  const heads = Array.from({ length: 5 }, (_, i) => `第${'一二三四五'[i]}章 标题${'一二三四五'[i]}`).join('\n')
  const text = `${heads}\n\n第一章 标题一\n真实正文。\n\n第二章 标题二\n正文。`
  const c = detectChapters(text)
  assert.equal(c.filter((x) => x.isHeading).length, 2, '目录页 5 行不计章')
})

test('评审修复回归：无分隔章头可识别（P2）', () => {
  const c = detectChapters(['第一章开始', '正文甲', '', '第二章结束', '正文乙', '', '第三章再会', '正文丙'].join('\n'))
  assert.equal(c.length, 3)
  assert.equal(c[0].title, '第一章开始')
})

test('评审修复回归：正文卷名不误切卷（P3）', () => {
  const text = ['第一章 一', '第一卷的书页已经泛黄。', '正文。', '', '第二章 二', '正文', '', '第三章 三', '正文'].join('\n')
  const vols = detectVolumes(detectChapters(text), text.split('\n'))
  assert.equal(vols.length, 1, '正文中以「第一卷」开头的句子不是卷锚')
})

test('评审修复回归：短章合并不吞护栏（P9）', async () => {
  await withDir('prepare-p9', async ({ dir }) => {
    const lines = ['第一章 一', '正文。', '']
    for (let i = 2; i <= 22; i++) lines.push(`第${i}章 章${i}`, '短。', '')
    const src = await writeSample(dir, '短章书.txt', lines.join('\n'))
    const r = await prepare({ input: src })
    assert.ok(r.chapterCount >= 3, '合并回退后正文章数不低于护栏')
  })
})

test('评审修复回归：manifest 损坏报 E_MANIFEST 而非裸 SyntaxError（P5）', async () => {
  await withDir('prepare-p5', async ({ dir }) => {
    const src = await writeSample(dir, '坏账本.txt', SAMPLE)
    const r = await prepare({ input: src })
    await writeFile(join(r.outDir, '工作', 'manifest.json'), '{ 截断', 'utf8')
    await assert.rejects(() => prepare({ input: src }), /manifest 损坏/)
  })
})

test('评审修复回归：输入在产物内拒绝自我嵌套（P10）', async () => {
  await withDir('prepare-p10', async ({ dir }) => {
    const src = await writeSample(dir, '嵌套书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const inner = join(r.outDir, '原文', '嵌套书.txt')
    await assert.rejects(() => prepare({ input: inner }), /自我嵌套/)
  })
})

// ---------- 评审遗留覆盖（票A：P22 清单，2026-10-23）----------

test('cnToInt 边界：第十/第一百零三/两千零一/非法输入返回 null（A-4）', () => {
  assert.equal(cnToInt('十'), 10)
  assert.equal(cnToInt('一百零三'), 103)
  assert.equal(cnToInt('两千零一'), 2001)
  assert.equal(cnToInt('2077'), 2077)
  assert.equal(cnToInt('第'), null)
  assert.equal(cnToInt('三十分之一'), null)
  const text = ['第十章 十', '正文', '', '第一百零三章 百三', '正文', '', '第两千零一章 两千一', '正文'].join('\n')
  const c = detectChapters(text)
  assert.deepEqual(c.map((x) => x.rawNo), [10, 103, 2001], '章标题序号按中文数字解析')
})

test('重复章标题：同号同名目录页紧邻成块时不双计（A-4）', () => {
  const toc = ['第一章 一', '第二章 二', '第三章 三'].join('\n')
  const text = `${toc}\n\n第一章 一\n正文一。\n\n第二章 二\n正文二。\n\n第三章 三\n正文三。`
  const c = detectChapters(text)
  assert.equal(c.filter((x) => x.isHeading).length, 3, '目录页同号同名条目整块跳过，正文章数不翻倍')
  assert.deepEqual(c.map((x) => x.title), ['前言', '第一章 一', '第二章 二', '第三章 三'], '目录行并入前言，不双计')
  assert.ok(!c[0].isHeading, '前言不是正文章')
})

test('卷区间不倒挂：卷尾标记落在末章时不得出现 endCh<startCh（A-4）', () => {
  const text = [
    '第一章 一', '正文一', '', '第二章 二', '正文二', '(第一卷完)', '',
    '第三章 三', '正文三', '(第二卷完)', '',
  ].join('\n')
  const chapters = detectChapters(text)
  const vols = detectVolumes(chapters, text.split(/\r?\n/))
  assert.ok(vols.length >= 1)
  assert.ok(vols.every((v) => v.endCh >= v.startCh), '不得出现倒挂区间')
  assert.equal(vols.at(-1).endCh, chapters.at(-1).no, '末卷覆盖到末章')
})

test('标题含竖线的章：产物表行不裂列、文件名净化（A-4）', async () => {
  const text = ['第一章 左|右', '正文一', '', '第二章 二', '正文二', '', '第三章 三', '正文三'].join('\n')
  await withDir('prepare-pipe', async ({ dir }) => {
    const src = await writeSample(dir, '竖线书.txt', text)
    const r = await prepare({ input: src })
    assert.equal(r.chapterCount, 3)

    const record = readFileSync(join(r.outDir, '工作', '逐章记录.md'), 'utf8')
    const row = record.split(/\r?\n/).find((l) => l.includes('左') && l.includes('右'))
    assert.ok(row, '逐章记录应含该章行')
    assert.ok(row.includes('左\\|右'), '标题中的竖线应转义')
    // 列数演进：9 列→11 列（Q-23/Q-24）→12 列（章字数）→13 列（A-09 加爽点类型），首尾竖线共 15 段。
    assert.equal(row.replace(/\\\|/g, '0').split('|').length, 15, '13 列不裂列（首尾竖线共 15 段）')

    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.chapters[0].title, '第一章 左|右', 'manifest 保留原始标题')
    assert.ok(existsSync(join(r.outDir, '原文', '章节', '0001-第一章 左_右.txt')), '章节文件名净化竖线')
  })
})

test('UTF-8 BOM 原文可处理：BOM 不进正文（A-4）', async () => {
  await withDir('prepare-bom', async ({ dir }) => {
    const src = await writeSample(dir, '带BOM书.txt', `\uFEFF${SAMPLE}`)
    const r = await prepare({ input: src })
    assert.equal(r.encoding, 'utf-8')
    assert.equal(r.chapterCount, 4)
    const body = readFileSync(join(r.outDir, '原文', '章节', '0001-第一章 开始.txt'), 'utf8')
    assert.ok(body.includes('张三走进车站') && !body.includes('\uFEFF'), 'BOM 剥离，不进正文')
  })
})

// ---------- 产物增强三件套（票C：Q-22，2026-10-23）----------

test('逐章记录十三列：章字数紧跟标题、剧情线仍第 8 列、爽点强度与类型接在情绪后（A-3，Q-23/Q-24、A-09 跟进）', async () => {
  await withDir('prepare-q23-col', async ({ dir }) => {
    const src = await writeSample(dir, '十一列书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const record = readFileSync(join(r.outDir, '工作', '逐章记录.md'), 'utf8')
    const lines = record.split(/\r?\n/)
    const header = lines.find((l) => l.startsWith('| 全局章号'))
    assert.ok(header, '应含表头行')
    const cols = header.slice(1, -1).split('|').map((c) => c.trim())
    assert.equal(cols.length, 13, '表头十三列')
    assert.equal(cols[2], '章字数', '章字数紧跟标题（脚本填，不由 agent 判断）')
    assert.equal(cols[6], '一句话事件', '剧情线插在「一句话事件」后')
    assert.equal(cols[7], '剧情线')
    assert.equal(cols[8], '伏笔埋/收', '「伏笔埋/收」仍在剧情线后')
    assert.equal(cols[10], '章末钩型', '章末钩型接在情绪后（Q-23）')
    assert.equal(cols[11], '爽点强度', '爽点强度接在钩型后（A-09 正名，原「爽点标记」）')
    assert.equal(cols[12], '爽点类型', '爽点类型为末列（A-09：只有强度统计不出「哪种爽点反复用」）')
    const dataRows = lines.filter((l) => /^\| \d/.test(l))
    assert.equal(dataRows.length, 4, '行数＝章节数（含前言）')
    for (const row of dataRows) {
      assert.equal(row.slice(1, -1).split('|').length, 13, `每行 13 格：${row.slice(0, 30)}`)
    }
  })
})

test('合成书骨架：总表 15 列表头、大纲含「## 故事设计」且七项引导齐（A-3，Q-23/Q-24 跟进）', async () => {
  await withDir('prepare-q23-skel', async ({ dir }) => {
    const src = await writeSample(dir, '骨架书二.txt', SAMPLE)
    const r = await prepare({ input: src })
    // 总表 15 列表头
    const table = readFileSync(join(r.outDir, '故事底本', '故事剧情', '分卷总表.md'), 'utf8')
    const header = table.split(/\r?\n/).find((l) => l.startsWith('| 卷 |'))
    assert.ok(header, '分卷总表应含表头行')
    assert.equal(header.slice(1, -1).split('|').length, 15, '分卷总表 15 列')
    // 大纲四块，第一块故事设计七项引导
    const outline = readFileSync(join(r.outDir, '故事底本', '故事剧情', '全书大纲.md'), 'utf8')
    assert.ok(outline.includes('## 故事设计'), '全书大纲骨架应含「## 故事设计」')
    for (const item of ['主题母题', '主角 logline', '核心欲望与恐惧', '主要对手与对抗结构', '弧光终点', '读者承诺', '结局形态']) {
      assert.ok(outline.includes(`- ${item}：（待填）`), `故事设计块缺七项引导之一「${item}」`)
    }
    // 卷纲九段骨架随契约
    const vol = readFileSync(join(r.outDir, '故事底本', '故事剧情', '卷纲', '卷01-全书.md'), 'utf8')
    assert.ok(vol.includes('## 主要冲突与对手') && vol.includes('## 节奏与章末钩画像'), '卷纲骨架应含新段名')
  })
})

test('指纹七项存在性：指纹段含场景切换密度与情绪标签词密度两行，且纳入偏离章（A-3）', async () => {
  await withDir('prepare-q22-fp', async ({ dir }) => {
    const src = await writeSample(dir, '指纹书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const style = readFileSync(join(r.outDir, '故事底本', '文风.md'), 'utf8')
    const fp = style.slice(style.indexOf('## 定量指纹'), style.indexOf('## 原文样本'))
    for (const key of ['句均长', '短句比', '对话占比', '了密度', '疲劳词密度', '场景切换密度', '情绪标签词密度']) {
      assert.ok(fp.includes(`- ${key}：`), `指纹段应含「${key}」行`)
    }
    assert.ok(fp.includes('场景切换密度偏离章：'), '场景切换密度应纳入偏离章 top3')
    assert.ok(fp.includes('情绪标签词密度偏离章：'), '情绪标签词密度应纳入偏离章 top3')
  })
})

test('指纹扩容计数：场景切换只认行首标记、情绪标签词全文计数（Q-22）', () => {
  const text = [
    '第一章 一', '次日，张三启程。', '',
    '第二章 二', '清晨，李四赶到。他说次日再来。', '',
    '第三章 三', '与此同时，王五心里一紧。', '',
  ].join('\n')
  const fp = fingerprint(detectChapters(text))
  // 手工账：正文非空白字符 8＋15＋12＝35；行首场景标记 3 个（次日/清晨/与此同时，「他说次日再来」不算）；
  // 情绪标签词 1 个（心里一紧）。密度＝次数/字符数×10000，保留一位小数。
  assert.equal(fp.base.场景切换密度, +(3 / 35 * 10000).toFixed(1))
  assert.equal(fp.base.情绪标签词密度, +(1 / 35 * 10000).toFixed(1))
  assert.deepEqual(Object.keys(fp.base), ['句均长', '短句比', '对话占比', '了密度', '疲劳词密度', '场景切换密度', '情绪标签词密度'], 'base 七项')
  assert.ok(fp.deviating.场景切换密度.length === 3 && fp.deviating.情绪标签词密度.length === 3, '新增两项各有偏离章 top3')
})

test('prepare 返回批数＝manifest 批数（「规模预告」行的数据源，A-5 前置单测）', async () => {
  await withDir('prepare-q22-scale', async ({ dir }) => {
    const src = await writeSample(dir, '规模书.txt', SAMPLE)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(r.batches, manifest.batches.length, '返回批数＝manifest 批数')
    assert.equal(manifest.batches.length, 1, '5 章单卷应为 1 批')
  })
})


test('前言不占批位：20 章正文＋前言应切 1 批，不能切成 [0-19]+[20] 两批（#4 实测）', async () => {
  // 龙族2 实测：正文正好 20 章（单批上限 20），前言因挂着第 0 章号被算进批内，
  // 把本应 1 批的工作切成 2 批，第二批只装 1 章——凭空多出一个会话单位的成本。
  const lines = ['前言部分，交代背景。', '']
  for (let i = 1; i <= 20; i++) lines.push(`第${i}章 标题${i}`, '', `正文第${i}段。`, '')
  const text = lines.join('\n')
  await withDir('prepare-batch-preface', async ({ dir }) => {
    const src = await writeSample(dir, '二十章书.txt', text)
    const r = await prepare({ input: src })
    const manifest = JSON.parse(readFileSync(join(r.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(manifest.chapterCount, 21, '前言＋20 章＝21 条')
    assert.equal(manifest.batches.length, 1, '正文 20 章应正好 1 批（前言不占名额）')
    assert.equal(manifest.batches[0].startCh, 1, '批从正文第 1 章起，不含前言')
    assert.equal(manifest.batches[0].endCh, 20, '批到正文第 20 章止')
    // 反向：21 章正文才该切 2 批——证明上限仍是 20，没被顺手放宽。
    const more = ['前言部分，交代背景。', '']
    for (let i = 1; i <= 21; i++) more.push(`第${i}章 标题${i}`, '', `正文第${i}段。`, '')
    const src2 = await writeSample(dir, '二十一章书.txt', more.join('\n'))
    const r2 = await prepare({ input: src2 })
    const m2 = JSON.parse(readFileSync(join(r2.outDir, '工作', 'manifest.json'), 'utf8'))
    assert.equal(m2.batches.length, 2, '正文 21 章应切 2 批')
    // #7：切分点按字数均衡选，不再固定满 20 章再甩一个 1 章的尾批。
    // 旧行为是 [1-20]+[21-21]（尾批 1 章，字数差近 20 倍）。
    for (const b of m2.batches) {
      assert.ok(b.endCh - b.startCh + 1 <= 20, '单批不超过 20 章')
      assert.ok(b.endCh - b.startCh + 1 >= 2, '不产生只有 1 章的尾批')
    }
    assert.equal(m2.batches[0].startCh, 1, '首章从 1 起')
    assert.equal(m2.batches.at(-1).endCh, 21, '末章到 21 止')
    assert.equal(
      m2.batches[0].endCh + 1, m2.batches[1].startCh, '批间连续，不漏章不重章',
    )
    const [c0, c1] = m2.batches.map((b) => b.chars)
    assert.ok(Math.max(c0, c1) / Math.min(c0, c1) < 2, `两批字数应均衡，实得 ${c0} / ${c1}`)
  })
})

test('Q-25 收窄：例行附注丢弃计数、结构附注归集、正文干净', async () => {
  const text = [
    '第一章 一', '正文。',
    '求月票！', '求推荐票！', '感谢老板打赏！', '请假一天。',
    '关于本卷的结构：这是一个三段式的卷，前半铺垫，中段爆发，结尾收束，节奏层层递进，我在大纲里规划了五个月。',
    '',
    '第二章 二', '正文。', '新书《某某》已经发布，欢迎大家去看。',
    '',
    '第三章 三', '正文。', '完本感言：感谢大家一年陪伴，主角最后回到了故乡，反派得到了结局。',
  ].join('\n')
  await withDir('prepare-q25', async ({ dir }) => {
    const src = await writeSample(dir, '收窄书.txt', text)
    const r = await prepare({ input: src })
    const notes = readFileSync(join(r.outDir, '原文', '作者的话.md'), 'utf8')
    assert.ok(notes.includes('作者自述'), '标题改「作者自述」')
    assert.ok(notes.includes('【第1章】关于本卷的结构'), '结构附注归集')
    assert.ok(notes.includes('【第3章】完本感言'), '完本感言归集')
    assert.ok(notes.includes('【第2章】新书'), '续作预告归集')
    assert.ok(notes.includes('4 条已按 Q-25 丢弃'), '例行附注丢弃计数（求月票/求推荐票/感谢打赏/请假四条）')
    const ch3 = readFileSync(join(r.outDir, '原文', '章节', '0003-第三章 三.txt'), 'utf8')
    assert.ok(!ch3.includes('完本感言'), '结构附注不进正文')
  })
})

function hasGbk() {
  try {
    new TextDecoder('gbk')
    return true
  } catch {
    return false
  }
}
