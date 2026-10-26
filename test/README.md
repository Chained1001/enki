# test 说明

本目录的测试只服务本仓库，不随技能发布；`npm run check` 会依次跑 docs-check、`npm run validate` 与这里全部 `*.test.mjs`。

## 真书规模断言（`realbook-scale.test.mjs`）

把十本实测书的（类型、章数、卷数、均章）写成断言，判定逻辑一漂移就变红。原文不入库，测试在运行时读主机上的原文；目录不存在或缺某本书时，对应用例 `skip` 并写明原因，不会误报失败。

原文目录不写死进仓库：用 `ENKI_REALBOOK_DIR` 覆盖。默认值只能写成本机示例 `C:/Users/<你>/Desktop/开发/辅助内容/小说原文`（本机示例，勿入库）；真实路径留在各自主机上。

```powershell
$env:ENKI_REALBOOK_DIR = 'D:\小说原文'; npm test
```

基线来自同一条检测流水线（`detectChapters` → `detectVolumes` → `detectBookType`），均章口径为「正文单元字数之和 ÷ 正文单元数（不含前言）」，与 `detectBookType` 内部一致。**改动阈值或判定条件后若这些用例变红，先确认是想要的行为变更，再更新基线数字**——不要为了让测试变绿去改断言。

新增实测书时，用下面的脚本采集数字再填进 `BASELINE`。脚本存到仓库根目录后执行 `node collect.mjs`，`import` 按仓库根目录解析：

```js
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectBookType, detectChapters, detectVolumes }
  from './skills/book-breakdown/scripts/prepare.mjs'
const SRC = process.env.ENKI_REALBOOK_DIR ?? 'C:/Users/<你>/Desktop/开发/辅助内容/小说原文'
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.txt'))) {
  const text = readFileSync(join(SRC, f), 'utf8')
  const chapters = detectChapters(text)
  const volumes = detectVolumes(chapters, text.split(/\r?\n/))
  const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
  const avg = units.length ? Math.round(units.reduce((s, c) => s + c.chars, 0) / units.length) : 0
  console.log(`  { file: '${f}', bookType: '${detectBookType(chapters)}', chapterCount: ${chapters.length}, volumeCount: ${volumes.length}, avg: ${avg} },`)
}
```

跑之前确认 `ENKI_REALBOOK_DIR` 指向的目录里是 txt 原文；读不到时先看用例的 `skip` 原因，不要直接改断言。
