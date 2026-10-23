# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## 本仓库：**single-context**

只有一个上下文，没有 monorepo 信号（无 `pnpm-workspace.yaml`、`package.json` 无 `workspaces` 字段、无 `packages/`）。`GLOSSARY.md` 与将来的 `docs/adr/` 都放在仓库根。

### 本仓库特有的前置阅读

除 `GLOSSARY.md` 外，动本仓库的代码或规则前还应读：

| 文件 | 为什么 |
|---|---|
| `AGENTS.md` | 目录性质（交付／留存／开发三档）、事实源表、改动同步表 |
| `skills/book-breakdown/scripts/contract.mjs` | 段名、表头、枚举、阈值的**唯一事实源**；PRD 与模板是它的受守卫副本 |
| `docs/产品/PRD.md` | 产品契约与运行流程；改动常需同步此文件的对应节 |

**没有 `docs/adr/`**：本仓库的决策记录目前写在 `docs/产品/PRD.md` 的开放问题表（Q-01…Q-30）与 `docs/技术/` 的决策节（D-01…D-28）里，不是独立 ADR 文件。若将来建 `docs/adr/`，新决策写在那里，历史决策不必迁。
