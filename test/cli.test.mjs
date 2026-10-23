import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const tmpBasePath = join(here, '.tmp', 'cli')
const tmpBase = async () => {
  mkdirSync(tmpBasePath, { recursive: true })
  return tmpBasePath
}
const validate = join(here, '..', 'scripts', 'validate.mjs')
const init = join(here, '..', 'scripts', 'init-skill.mjs')
const prepare = join(here, '..', 'skills', 'book-breakdown', 'scripts', 'prepare.mjs')
const validateOutput = join(here, '..', 'skills', 'book-breakdown', 'scripts', 'validate-output.mjs')
const fixtures = join(here, 'fixtures')

// stdin 固定 ignore：受限沙箱里接管/继承宿主 stdin 可能被拒（EPERM），这与被测行为无关（评审 P19）。
// stdout/stderr 用临时文件承接：受限沙箱禁止子进程经管道输出（EPERM，status 变 null），
// 打开的文件描述符不受此限。文件里的内容与管道等价，仍是被断言对象（评审 P19）。
// 临时文件一次一目录，用完即删；目录落在 test/.tmp/cli/（.gitignore 已排除）。
const run = (script, args) => {
  mkdirSync(tmpBasePath, { recursive: true })
  const dir = mkdtempSync(join(tmpBasePath, 'run-'))
  const outPath = join(dir, 'stdout.txt')
  const errPath = join(dir, 'stderr.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [script, ...args], {
      stdio: ['ignore', outFd, errFd],
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  // 句柄已关闭，此时读回的是子进程写完落盘的全部内容。
  try {
    return {
      status: result.status,
      stdout: readFileSync(outPath, 'utf8'),
      stderr: readFileSync(errPath, 'utf8'),
    }
  } finally {
    // 自清理：读完即删，断言中途抛错也不留临时文件。
    rmSync(dir, { recursive: true, force: true })
  }
}

// 跳过条件只剩硬性不适用：被测脚本文件不存在。
// 不再用「子进程管道可用性」探测整组跳过（评审 P19：那会让 9 条契约测试在受限环境无声失效，
// 违反规范 02 禁止无条件跳过；本环境不可用时应让测试响亮地失败，而不是跳过）。
const cliTest = (script, name, fn) =>
  test(name, existsSync(script) ? {} : { skip: `被测脚本不存在：${script}` }, fn)

cliTest(validate, '未知参数退出码为 2', () => {
  const r = run(validate, ['--bogus', join(fixtures, 'valid')])
  assert.equal(r.status, 2)
})

cliTest(validate, '--help 输出用法且退出码为 0', () => {
  const r = run(validate, ['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法/)
})

cliTest(validate, '校验失败退出码为 1', () => {
  const r = run(validate, [join(fixtures, 'invalid', 'broken-link')])
  assert.equal(r.status, 1)
})

cliTest(validate, '--json 输出单个对象，结构为 ok、errors、data', () => {
  const r = run(validate, ['--json', join(fixtures, 'valid')])
  assert.equal(r.status, 0)
  const obj = JSON.parse(r.stdout)
  assert.equal(obj.ok, true)
  assert.deepEqual(obj.errors, [])
  assert.ok('data' in obj)
})

cliTest(validate, '--json 失败时 errors 每项含 code、file、message', () => {
  const r = run(validate, ['--json', join(fixtures, 'invalid', 'broken-link')])
  assert.equal(r.status, 1)
  const obj = JSON.parse(r.stdout)
  assert.equal(obj.ok, false)
  assert.equal(obj.errors[0].code, 'E_LINK')
  assert.ok(obj.errors[0].file && obj.errors[0].message)
})

cliTest(init, 'init-skill 未知参数退出码为 2', () => {
  const r = run(init, ['x', '--bogus'])
  assert.equal(r.status, 2)
})

cliTest(init, 'init-skill 缺少 name 退出码为 2', () => {
  const r = run(init, [])
  assert.equal(r.status, 2)
})

cliTest(init, 'init-skill --dry-run 只输出动作，不落盘', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const root = await mkdtemp(join(await tmpBase(), 'dry-'))
  try {
    const r = run(init, ['demo-skill', '--root', root, '--dry-run'])
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(root, 'skills', 'demo-skill')), false)
    assert.match(r.stdout, /将生成/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

cliTest(init, 'init-skill 目录已存在时退出码为 1，--force 可覆盖', async () => {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'force-'))
  try {
    await mkdir(join(root, 'skills', 'taken'), { recursive: true })
    assert.equal(run(init, ['taken', '--root', root]).status, 1)
    assert.equal(run(init, ['taken', '--root', root, '--force']).status, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------- book-breakdown CLI 契约（评审 P19/P20，派单 A-3/A-6）----------

cliTest(prepare, 'prepare --json --bogus 退出 2 且 stdout 可解析为单对象', () => {
  const r = run(prepare, ['--json', '--bogus'])
  assert.equal(r.status, 2)
  const obj = JSON.parse(r.stdout)
  assert.equal(typeof obj, 'object')
  assert.ok(!Array.isArray(obj))
  assert.equal(obj.ok, false)
  assert.equal(obj.errors[0].code, 'E_ARGS')
  assert.ok(obj.errors[0].message)
})

cliTest(validateOutput, 'validate-output --help 退出 0', () => {
  const r = run(validateOutput, ['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法/)
})

cliTest(validateOutput, '产物 fixture 过 validate-output --mode progress：退出 0 且零错误（锁定产物形态）', () => {
  const fixture = join(fixtures, 'products', '合成小书_拆解')
  const r = run(validateOutput, ['--json', '--mode', 'progress', fixture])
  assert.equal(r.status, 0)
  const obj = JSON.parse(r.stdout)
  assert.equal(obj.ok, true)
  assert.equal(obj.data.verdict, '进行中')
  // 零错误＝目录树与 manifest 完全符合契约；fixture 漂移会让这条失败（评审 P20）。
  assert.equal(obj.data.errors, 0)
})

after(async () => {
  await rm(tmpBasePath, { recursive: true, force: true })
  try {
    await rmdir(join(here, '.tmp'))
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
})
