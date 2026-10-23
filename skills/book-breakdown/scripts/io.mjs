// 三个脚本共用的 IO 原语：manifest 受控读取（P5）与带 fsync 的原子写（P8）。
// 只用 Node 内置模块；错误用中文、带 code，供 --json 输出。
import { readFile, rename, rm, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'

export class IoError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// 读取并校验 manifest：损坏→E_MANIFEST（不抛裸 SyntaxError）；缺必填字段→E_MANIFEST。
export async function readManifest(root) {
  const file = join(root, '工作', 'manifest.json')
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new IoError('E_MANIFEST', `manifest 不可读（${file}）：${error.message}。请先运行 prepare 或用 --force 重建`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new IoError('E_MANIFEST', `manifest 损坏（${file}）：${error.message}。请用 prepare --force 归档重建`)
  }
  if (typeof manifest.chapterCount !== 'number' || !Array.isArray(manifest.volumes) || !Array.isArray(manifest.chapters)) {
    throw new IoError('E_MANIFEST', `manifest 字段不完整（${file}）：chapterCount/volumes/chapters 必填。请用 prepare --force 重建`)
  }
  return manifest
}

// 原子写：临时文件 → fsync → rename；失败清理临时文件（P8）。
export async function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
