// 两个会让产物「丢东西」或「记不准」的口子（B-07）：
//   1) --force 一句话就把整份产物归档重建，此前没有任何阻力；
//   2) 进度状态只能手判手写，没有稳定写入口，续跑时照抄上次记录的标签。
//
// 这两条的共同点：出错时都不报错，只是「东西没了」或「账不对」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { prepare, countFilledArtifacts } from '../skills/book-breakdown/scripts/prepare.mjs'
import { detectFileState, resyncFileStates, updateProgress } from '../skills/book-breakdown/scripts/progress.mjs'

// 用 fileURLToPath 而不是手撕 URL：pathname 会保留 %XX 编码（中文路径必踩），
// 而 new URL('..', import.meta.url) 又把它指向临时目录。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PREPARE = join(REPO, 'skills/book-breakdown/scripts/prepare.mjs')
const PROGRESS = join(REPO, 'skills/book-breakdown/scripts/progress.mjs')

const SAMPLE = ['第一章 相遇', '正文一', '', '第二章 同行', '正文二', '', '第三章 风波', '正文三', ''].join('\n')

async function withBook(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'force-'))
  try {
    const src = join(dir, '书.txt')
    await writeFile(src, SAMPLE, 'utf8')
    const r = await prepare({ input: src })
    await fn({ dir, src, out: r.outDir, r })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const fillFile = async (out, rel) => {
  const p = join(out, rel)
  const t = await readFile(p, 'utf8')
  await writeFile(p, t.replace(/（待填）/g, '这里填好了，约二十字的内容。'), 'utf8')
}

// ---------- --force 二次确认 ----------

test('--force 单用报参数错，消息写明会丢多少文件与归档到哪里', async () => {
  await withBook(async ({ src, out }) => {
    await fillFile(out, '故事底本/全书设定/世界观.md')
    await fillFile(out, '故事底本/文风.md')
    await assert.rejects(
      () => prepare({ input: src, force: true }),
      (e) => {
        assert.equal(e.code, 'E_FORCE_CONFIRM')
        assert.match(e.message, /2 个已填文件/, `应数出 2 个已填文件，实际消息：${e.message}`)
        assert.match(e.message, /世界观\.md/, '应举例列出会丢的文件')
        assert.match(e.message, /归档到：/, '应给出归档路径')
        assert.match(e.message, /--i-know/, '应给出确认方式')
        return true
      },
    )
  })
})

test('--force 单用时产物目录原封不动（拒绝要真的什么都没做）', async () => {
  await withBook(async ({ src, out }) => {
    await fillFile(out, '故事底本/文风.md')
    const before = readFileSync(join(out, '故事底本/文风.md'), 'utf8')
    await assert.rejects(() => prepare({ input: src, force: true }))
    assert.ok(existsSync(out), '产物目录必须还在')
    assert.equal(readFileSync(join(out, '故事底本/文风.md'), 'utf8'), before, '文件内容不能被碰')
    // 也不能留下归档目录
    const parent = join(out, '..')
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(parent)
    assert.ok(!names.some((n) => n.includes('_旧')), `不该产生归档目录：${names.join('、')}`)
  })
})

test('--force --i-know 才归档重建', async () => {
  await withBook(async ({ src, out, r }) => {
    const forced = await prepare({ input: src, force: true, iKnow: true })
    assert.ok(forced.archived?.includes('_旧1'), '归档目录名应含 _旧1')
    assert.equal(forced.action, 'prepared')
  })
})

test('--i-know 单用（不带 --force）报参数错——它是确认，不是独立动作', () => {
  const r = spawnSync(process.execPath, [PREPARE, 'whatever.txt', '--i-know'], { encoding: 'utf8' })
  assert.equal(r.status, 2, `参数错应退出 2，实际 ${r.status}；stderr=${r.stderr}`)
  // 消息中文可能受控制台编码影响，只断言关键 token
  assert.match(r.stderr, /--i-know/, 'stderr 应提到 --i-know')
  assert.match(r.stderr, /--force/, 'stderr 应提到 --force')
})

test('countFilledArtifacts 按内容数，不按 manifest 标签数', async () => {
  await withBook(async ({ out }) => {
    const before = await countFilledArtifacts(out)
    // 刚 prepare 完：所有固定产物都是骨架，不该有任何「已填」
    assert.equal(before.length, 0, `刚生成的产物不该有已填文件，实际：${before.slice(0, 5).join('、')}`)
    await fillFile(out, '故事底本/全书设定/世界观.md')
    const after = await countFilledArtifacts(out)
    assert.deepEqual(after, ['故事底本/全书设定/世界观.md'])
  })
})

// ---------- progress --file ----------

test('progress --file 写入指定文件的状态', async () => {
  await withBook(async ({ out }) => {
    await updateProgress({ root: out, file: ['故事底本/全书设定/世界观.md:validated'] })
    const m = JSON.parse(readFileSync(join(out, '工作/manifest.json'), 'utf8'))
    assert.equal(m.files['故事底本/全书设定/世界观.md'], 'validated')
  })
})

test('progress --file 越界状态值报参数错', async () => {
  await withBook(async ({ out }) => {
    await assert.rejects(
      () => updateProgress({ root: out, file: ['故事底本/全书设定/世界观.md:半成品'] }),
      (e) => {
        assert.equal(e.code, 'E_ARGS')
        assert.match(e.message, /不在枚举内/)
        assert.match(e.message, /skeleton/, '错误消息应列出合法值')
        return true
      },
    )
  })
})

test('progress --file 拒绝不存在的文件与越界路径', async () => {
  await withBook(async ({ out }) => {
    await assert.rejects(() => updateProgress({ root: out, file: ['故事底本/不存在的.md:filled'] }), /文件不存在/)
    await assert.rejects(() => updateProgress({ root: out, file: ['../外面.md:filled'] }), /产物根下的相对路径/)
    await assert.rejects(() => updateProgress({ root: out, file: ['故事底本/全书设定/世界观.md'] }), /应为 相对路径:状态/)
  })
})

test('progress --resync-files 按内容重判：填了的记 filled，没填的仍 skeleton', async () => {
  await withBook(async ({ out }) => {
    await fillFile(out, '故事底本/全书设定/世界观.md')

    // 模拟「照抄上次记录」的坏状态：把已填的记成 skeleton，把骨架记成 filled
    const mp = join(out, '工作/manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.files['故事底本/全书设定/世界观.md'] = 'skeleton'
    m.files['故事底本/文风.md'] = 'filled'
    writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`, 'utf8')

    const { changed } = await resyncFileStates({ root: out })
    assert.ok(changed >= 2, `至少纠正 2 项，实际 ${changed}`)

    const after = JSON.parse(readFileSync(mp, 'utf8'))
    assert.equal(after.files['故事底本/全书设定/世界观.md'], 'filled', '已填的应记 filled')
    assert.equal(after.files['故事底本/文风.md'], 'skeleton', '没填的应记 skeleton')
  })
})

test('resync 不覆盖人工标定的 validated／failed（那是流程判断，内容推不出来）', async () => {
  await withBook(async ({ out }) => {
    await fillFile(out, '故事底本/文风.md')
    await updateProgress({ root: out, file: ['故事底本/文风.md:validated'] })
    await resyncFileStates({ root: out })
    const m = JSON.parse(readFileSync(join(out, '工作/manifest.json'), 'utf8'))
    assert.equal(m.files['故事底本/文风.md'], 'validated')
  })
})

// ---------- 判据对齐 ----------

test('detectFileState 与校验器同判据：占位算骨架、空表格算骨架、有数据算已填', () => {
  assert.equal(detectFileState('# 标题\n\n- 字段：（待填）\n', 'a.md'), 'skeleton')
  // 纯表格：表头 + 分隔行，零数据行
  assert.equal(detectFileState('| 主名 | 别称 |\n| --- | --- |\n', '工作/别名词典.md'), 'skeleton')
  assert.equal(detectFileState('| 主名 | 别称 |\n| --- | --- |\n| 张三 | 三哥 |\n', '工作/别名词典.md'), 'filled')
  // 有段落的文件里表格为空，不等于文件没写
  assert.equal(detectFileState('## 段落\n\n正文。\n', 'a.md'), 'filled')
  // 引用块里提到占位字样不算未填
  assert.equal(detectFileState('> 骨架文件，把所有（待填）替换掉\n\n## 段\n\n内容。\n', 'a.md'), 'filled')
})
