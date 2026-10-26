# 0003 子代理接口字段以 AGENT_REVIEW 为准

## 状态

accepted

## 背景

P0-4 之前，出处核验子代理的字段有三份互不相同的写法。

- 10 发给子代理的是 `{编号, 引句}`；
- 子代理声明的输入是 `file`／`line`／`quote`；
- 10 落盘又写 `编号`／`裁决`／`章号`／`依据句`／`说明`。

而 10 自己规定「缺任一必需字段则不采信」，于是每一批裁决都会判失败——不是子代理判错，是三方根本对不上名字。字段表写在流程文档正文里，改一处不会带动另外两处，也没有测试守。

## 决策

`skills/book-breakdown/scripts/contract.mjs` 的 `AGENT_REVIEW` 是接口字段的唯一机器源，分三组：

- 输入：6 字段——`编号`、`文件`、`行号`、`引句`、`候选章号`、`候选句`；
- 输出：8 字段——`编号`、`文件`、`行号`、`原引句`、`判定`、`建议章号`、`理由`、`处置建议`；
- 汇总：1 键——`裁决合计`（`转述`／`拼接`／`编造` 三键计数，`未裁决` 不计入）。

三处只引用、不复写：

1. `skills/book-breakdown/workflows/10-校验交付.md` 的发送清单与落盘说明指向 `agents/出处核验.md` 的字段表，不再列字段名；
2. `skills/book-breakdown/agents/出处核验.md` 的「输入」节与「输出」表按 `AGENT_REVIEW` 逐字写；
3. `test/agent-schema.test.mjs` 从 `contract.mjs` 读三组字段，断言前两处与之一致，并禁止 10 再写第三份字段表。

## 后果

- 改字段必须同次改 `contract.mjs`、`agents/出处核验.md` 与 `workflows/10-校验交付.md`；漏一处 `test/agent-schema.test.mjs` 变红。
- 10 不再复写字段名（测试用正则禁止），文档里只剩指针，字段解释只有一处正文。
- 新增字段先改契约再改文档；测试会先红，不会出现「文档先写、契约后补」的静默漂移。
- 子代理的只读约束一并保留：落盘是调用方的事，`裁决.json` 由主线程写。

## 相关

- 日期：2026-10-26
- 提交：`fefe688`（contract 新增 `AGENT_REVIEW`，`裁决.json` 从 5 字段改为 8 字段）
- 文件：`skills/book-breakdown/scripts/contract.mjs`、`skills/book-breakdown/agents/出处核验.md`、`skills/book-breakdown/workflows/10-校验交付.md`、`test/agent-schema.test.mjs`
- 索引：`docs/adr/README.md`
