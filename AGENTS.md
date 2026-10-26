# enki 开发说明

本文件写给在本仓库内开发的 agent。README.md 给人看，本文件回答两件事：这个仓库是什么；要做某件事时读哪份规则。

## 项目是什么

小说拆书技能包，目前只有一个 `book-breakdown`：把整本 txt 拆成结构化、可校验、可按层复用的产物（结构化模式，默认）或章节摘要报告（快速模式）。通过 `npx skills add Chained1001/enki` 安装。

## 怎么读用户的话

**用户举的例子是类别的样本，不是任务清单。**

- 他说「比如 A」，意思是「存在一类东西，A 只是其中一个」。要问「A 属于哪一类」，然后按类穷举，不是只查 A。
- 他说「A、B 等等」，意思是「A 和 B 是我举出来的两个，还有 C、D、E 没列，因为一次列不完」。要按类补齐 C 到 E，不是做完 A 和 B 就交差。
- 判断方法：把他的例子抽象一层（「动机」→「驱动力」，「大纲」→「所有产物」），再回到原问题看这一类还覆盖了谁。只修他点名的那个，等于没听懂。

例：用户说「大纲和卷纲里没有人物动机」，实际要求是「所有产物都要能支撑反向写作，动机只是我恰好先发现的那一个」。

## 开始之前

1. 读 `README.md` 的「技能列表」，知道有哪些技能。
2. 改哪个技能，就读它的 `SKILL.md`。
3. 要动规则，按 `docs/规范/00-总则.md` 的「按需查阅」表找到对应标准，只读那一份，不必全读。

## 环境准备

- Node.js 24 及以上。
- 零依赖：不运行 `npm install`，只用 `node:` 内置模块。
- 不需要联网，不需要额外环境变量。

## 目录与性质

| 路径 | 性质 | 说明 |
|---|---|---|
| `skills/` | 交付 | 唯一发布内容 |
| `templates/` | 留存 | 派生后必留，`scripts/init-skill.mjs` 运行时读取 |
| `docs/规范/` | 留存 | 标准正文，自有；改动走 PR 并记 `CHANGELOG.md` |
| `scripts/`、`test/`、`evals/` | 开发 | 只服务本仓库 |

性质三档：交付＝随 `npx skills add` 安装；留存＝随仓库保留但不安装；开发＝只服务本仓库。

## 事实源

一个事实只在一处写正文，其余位置写指针。

| 事实 | 事实源 |
|---|---|
| 目录与性质 | 本文件的「目录与性质」节 |
| 技能清单与用途 | `README.md` 的「技能列表」节 |
| 当前版本号 | `package.json` 的 `version` |
| 变更历史 | `CHANGELOG.md` |
| 规则 | `docs/规范/` |
| 规范来源 | `docs/规范/来源.md` |
| 产品契约与运行流程 | `docs/产品/PRD.md`（「产品流程」节） |
| 段名、表头、枚举、阈值 | `skills/book-breakdown/scripts/contract.mjs` |
| 术语 | `GLOSSARY.md` |

两处冲突且判不出哪处是真源时，先裁决再动手，把裁决记进 `CHANGELOG.md` 的 `[Unreleased]`（或 `docs/adr/`）。

## 改动同步

| 改动 | 同次改 |
|---|---|
| 技能增删或改名 | `README.md` 的「技能列表」节 |
| `package.json` 的 `version` | `CHANGELOG.md` 的版本段 |
| 新增或删除评测用例 | `evals/cases/` 下的用例与 `README.md` 的技能说明 |

## 验证

| 命令 | 通过标准 |
|---|---|
| `npm run validate` | 退出码为 0 |
| `npm test` | 退出码为 0 |

### 真书规模断言（`test/realbook-scale.test.mjs`）

把十本实测书的（类型、章数、卷数、均章）写成断言，判定逻辑一漂移就变红。原文不入库，测试在运行时读主机上的原文；目录不存在或缺某本书时，对应用例 `skip` 并写明原因，不会误报失败。

原文目录默认为 `C:/Users/22940/Desktop/开发/辅助内容/小说原文`，可用 `ENKI_REALBOOK_DIR` 覆盖：

```powershell
$env:ENKI_REALBOOK_DIR = 'D:\小说原文'; npm test
```

基线来自同一条检测流水线（`detectChapters` → `detectVolumes` → `detectBookType`），均章口径为「正文单元字数之和 ÷ 正文单元数（不含前言）」，与 `detectBookType` 内部一致。**改动阈值或判定条件后若这些用例变红，先确认是想要的行为变更，再更新基线数字**——不要为了让测试变绿去改断言。

新增实测书时，用下面的脚本采集数字再填进 `BASELINE`：

```js
// 放到仓库内任意位置执行：node collect.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectBookType, detectChapters, detectVolumes }
  from 'file:///C:/Users/22940/Desktop/开发/网文拆书/Enki/skills/book-breakdown/scripts/prepare.mjs'
const SRC = process.env.ENKI_REALBOOK_DIR ?? 'C:/Users/22940/Desktop/开发/辅助内容/小说原文'
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.txt'))) {
  const text = readFileSync(join(SRC, f), 'utf8')
  const chapters = detectChapters(text)
  const volumes = detectVolumes(chapters, text.split(/\r?\n/))
  const units = chapters.filter((c) => !(c.no === 0 && c.title === '前言'))
  const avg = units.length ? Math.round(units.reduce((s, c) => s + c.chars, 0) / units.length) : 0
  console.log(`  { file: '${f}', bookType: '${detectBookType(chapters)}', chapterCount: ${chapters.length}, volumeCount: ${volumes.length}, avg: ${avg} },`)
}
```

## 提交

提交信息按 `docs/规范/04-提交与分支.md`。

## 工作队列

待做的工作记在 GitHub issues（`Chained1001/enki`），不写进本文件——本文件只写指针，避免票号过期。

开工前查 frontier：没被未完成 issue 阻塞的那张就是下一张。

`gh issue list --state open --json number,title,blockedBy`

## 禁止事项

- 禁止把整本小说复制进仓库，改为只写路径（原因：语料不入库）。

「原因」写可核查的后果，或写会被哪条检查发现，不写「更清晰」「更好维护」。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Chained1001/enki`, created and read with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map one-to-one to labels of the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root, no `GLOSSARY-MAP.md`. See `docs/agents/domain.md`.
