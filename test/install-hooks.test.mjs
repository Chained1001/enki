// 防的漂移：钩子内容与命令脱节，或装到非 git 仓库里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('安装后钩子存在且调用 validate 与 test', async () => {
  await withRepo(async (root) => {
    const result = await installHooks({ root })
    assert.equal(result.action, 'installed')
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /npm run validate/)
    assert.match(text, /npm test/)
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
