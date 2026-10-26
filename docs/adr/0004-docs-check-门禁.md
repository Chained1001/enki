# 0004 docs-check 门禁

## 状态

accepted

## 背景

P1-4 之前，两类文档事实没有机器门禁。

- `AGENTS.md` 是 agent 找规则的入口，里面用反引号写了一批路径与节名。文件改名、删除或标题改写后，指针仍指向旧位置；agent 按指针读会读到不存在的东西，而 `npm run check` 照样通过。
- `GLOSSARY.md` 的格式（`- **术语**：定义`）、定义长度 60 字上限与拼音序全靠人看。术语一多，逆序和超长不会自己暴露。
- `npm run check` 当时只跑 `validate` 与 `test`；CI 与 pre-commit 也直接跑这两条，文档问题进不了门禁。

## 决策

新增 `scripts/docs-check.mjs`，并入 `npm run check`，CI 与 pre-commit 只跑这一条。

- `AGENTS_POINTERS` 列出 AGENTS.md 必须指向的文件：路径必须用反引号写出、目标必须存在；标了 `heading` 的还须在目标文件里有同名 `##` 二级标题。新增指针要同时改 `AGENTS.md` 与这张表。
- `GLOSSARY.md` 检查：术语行格式为 `- **术语**：定义`、定义按码点计不超过 60 字、术语不重复、按 `zh-u-co-pinyin` 严格升序。
- `npm run check` 依次跑 docs-check、`npm run validate`、`npm test`；`.github/workflows/ci.yml` 与 `scripts/install-hooks.mjs` 生成的 pre-commit 钩子都只调这一条。

## 后果

- 改 `AGENTS.md` 指针或改目标文件名时，两处要同次改；只改一处会让 check 退出 1，提交与 CI 都被拦。
- GLOSSARY 的定义要压到 60 字内、术语要按拼音序插入；否则 check 报行号，不进入 validate/test。
- docs-check 只查「指针可解析」与「术语表格式」，不查文档内容是否正确；语义仍靠 PR 审阅。
- 本地 pre-commit 在部分 Windows 环境起不来 `sh`（Q-31），此时须手工补跑 `npm run check` 并在提交信息记录。

## 相关

- 日期：2026-10-26
- 提交：`4402c29`（docs-check 门禁与 CI 接入）
- 文件：`scripts/docs-check.mjs`、`test/docs-check.test.mjs`、`package.json`、`.github/workflows/ci.yml`、`scripts/install-hooks.mjs`、`AGENTS.md`、`GLOSSARY.md`
- 索引：`docs/adr/README.md`
