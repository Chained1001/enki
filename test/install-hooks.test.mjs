// 防的漂移：钩子内容与命令脱节，或装到非 git 仓库里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HookExistsError, NotGitRepoError, installHooks } from '../scripts/install-hooks.mjs'

async function withRepo(run) {
  const root = await mkdtemp(join(tmpdir(), 'hooks-'))
  await mkdir(join(root, '.git', 'hooks'), { recursive: true })
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('安装后钩子存在且只调用 npm run check', async () => {
  await withRepo(async (root) => {
    const result = await installHooks({ root })
    assert.equal(result.action, 'installed')
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /^npm run check$/m)
    // check 已把 validate 与 test 串起来，钩子不再各跑一遍。
    assert.doesNotMatch(text, /^npm run validate$/m)
    assert.doesNotMatch(text, /^npm test$/m)
  })
})

test('钩子含 _拆解/ 产物目录暂存黑名单', async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.ok(text.includes('_拆解/'), '钩子应含 _拆解/ 匹配串，否则产物目录能直接提交')
    // 取暂存清单要带 --cached --name-only；关掉路径转义，中文书名才不会被转成八进制而漏匹配。
    assert.match(text, /git -c core\.quotePath=false diff --cached --name-only/)
    assert.match(text, /grep -F '_拆解\/'/)
    // 命中后必须非 0 退出，并给出中文原因与修法。
    assert.match(text, /exit 1/)
    assert.match(text, /产物目录（\*_拆解\/）不得入库/)
    assert.match(text, /git rm --cached/)
  })
})

// 夹具 test/fixtures/products/合成小书_拆解/ 是有意入库的合成数据：黑名单若对它也生效，
// 夹具将永远提交不了。豁免按前缀做，与 .gitignore 的口径一致。
test('黑名单豁免 test/fixtures/products/ 下的合成夹具', async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /grep -v '\^test\/fixtures\/products\/'/)
    // 豁免必须写在提示文案里，避免后人把它当漏写删掉。
    assert.match(text, /测试夹具 test\/fixtures\/products\/ 除外/)
  })
})

test('黑名单检查先于 npm run check 执行，check 仍是一行完整命令', async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    // 回归：命令仍在，且独占一行完整可执行。
    assert.match(text, /^npm run check$/m)
    // 黑名单先跑：产物目录应在跑校验前就被拦下，而不是先浪费一轮 docs-check、validate 与 test。
    const checkAt = text.search(/^npm run check$/m)
    assert.ok(checkAt >= 0)
    const guardAt = text.indexOf('_拆解/')
    assert.ok(guardAt >= 0)
    assert.ok(guardAt < checkAt, '黑名单检查应位于 npm run check 之前')
    // 钩子由 POSIX sh 执行：不得出现 [[ ]]、Bash 数组等 bash 专有语法。
    assert.match(text, /^#!\/bin\/sh$/m)
    assert.equal(text.includes('[['), false)
  })
})

test('--package-dir 让钩子切到子目录', async () => {
  await withRepo(async (root) => {
    await installHooks({ root, packageDir: '基座' })
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /cd "\$root\/基座"/)
  })
})

test('已有钩子时拒绝覆盖，--force 可覆盖', async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    await assert.rejects(() => installHooks({ root }), HookExistsError)
    const result = await installHooks({ root, force: true })
    assert.equal(result.overwrite, true)
  })
})

test('非 git 仓库时拒绝安装', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nogit-'))
  try {
    await assert.rejects(() => installHooks({ root }), NotGitRepoError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--dry-run 不写文件', async () => {
  await withRepo(async (root) => {
    const result = await installHooks({ root, dryRun: true })
    assert.equal(result.action, 'dry-run')
    assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false)
  })
})

// 真跑一遍：内容断言只能证明字符串在，证明不了 sh 语法与 grep 判断真的成立。
// 本机 Git for Windows 的 sh.exe 在部分受限环境下无法启动（signal pipe 创建失败），此时跳过并说明原因；
// CI 的 ubuntu-latest 有 sh，会实跑这条。
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0

test('直接执行钩子时拦下 _拆解/ 产物、放行夹具（需 sh）', { skip: !hasSh && '当前环境无法启动 sh（Git for Windows 的 sh.exe 启动失败），该用例由 CI 的 Linux 环境覆盖' }, async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    const write = (rel, text) => {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text, 'utf8')
    }
    // 只 init 与 add，不 commit：无需 git 身份配置，也只考察黑名单那一段，
    // 不把 npm run validate / npm test 牵进临时仓库（钩子缺 package.json 会 exit 0）。
    assert.equal(git('init', '-q').status, 0)
    const runHook = () => spawnSync('sh', [join(root, '.git', 'hooks', 'pre-commit')], { cwd: root, encoding: 'utf8' })

    // 1) 夹具路径：黑名单必须放行，钩子以 0 退出。
    write('test/fixtures/products/合成小书_拆解/原文/合成小书.txt', '合成夹具\n')
    assert.equal(git('add', '-A').status, 0)
    const fixtureRun = runHook()
    assert.equal(fixtureRun.status, 0, `夹具应放行，实际输出：${fixtureRun.stdout}${fixtureRun.stderr}`)
    assert.doesNotMatch(fixtureRun.stderr, /不得入库/)

    // 2) 产物路径：黑名单必须拦下，非 0 退出并给出中文原因与修法。
    write('某书_拆解/原文/x.txt', '真书语料\n')
    assert.equal(git('add', '-A').status, 0)
    const productRun = runHook()
    assert.notEqual(productRun.status, 0, '产物目录内的文件不得通过')
    assert.match(productRun.stderr, /产物目录（\*_拆解\/）不得入库/)
    assert.match(productRun.stderr, /某书_拆解\/原文\/x\.txt/)
    assert.match(productRun.stderr, /git rm --cached/)
  })
})
