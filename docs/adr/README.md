# 决策记录（ADR）

本目录是 Enki 的决策索引。一条决策一个永久 ID：产品决策沿用 PRD 的 `Q-NN`，技术决策沿用技术文档的 `D-NN`，承重决策另立 `ADR-NNNN`（`docs/adr/` 下的文件）。ID 一旦分配不再复用；决策被推翻时保留原条目，把状态改为 `superseded` 并指向取代它的 ID。

状态只有四个取值：`accepted`（已采纳）、`superseded`（被后续决策取代）、`rejected`（已否决）、`proposed`（提案中）。

本索引只记账，不写正文：决策正文在 PRD 的 Q 表、技术文档的 D 表与各 ADR 文件里，索引不复述理由。改 Q/D 表后必须同步本索引，`test/adr.test.mjs` 守覆盖率与重复。

## 决策索引

Q 行为产品决策（PRD「开放问题」表），D 行为技术决策（技术文档「架构决策」表）。标题取各表第二列，超过 60 字截断。

| ID | 决策 | 状态 | 来源 | 备注 |
|---|---|---|---|---|
| Q-01 | 全书大纲的结构 | accepted | PRD Q 表 | — |
| Q-02 | 分卷总表的列 | superseded | PRD Q 表 | 被 Q-76 取代 |
| Q-03 | 卷纲与幕纲的固定段名 | superseded | PRD Q 表 | 被 Q-76 取代 |
| Q-04 | 卷名与幕名的来源 | accepted | PRD Q 表 | — |
| Q-05 | 内容由谁生成 | accepted | PRD Q 表 | — |
| Q-06 | 大书如何分批 | accepted | PRD Q 表 | — |
| Q-07 | 产物目录位置 | accepted | PRD Q 表 | — |
| Q-08 | 旧报告式产出是否保留 | accepted | PRD Q 表 | — |
| Q-09 | 人物主次的判定 | accepted | PRD Q 表 | — |
| Q-10 | 角色重名怎么处理 | accepted | PRD Q 表 | — |
| Q-11 | 次要角色收录到什么程度 | accepted | PRD Q 表 | — |
| Q-12 | 四个集合的分类子目录 | accepted | PRD Q 表 | — |
| Q-13 | 逐章记录、别名词典的位置 | accepted | PRD Q 表 | — |
| Q-14 | 专题单体是否强制 | accepted | PRD Q 表 | — |
| Q-15 | 情绪字段形态 | accepted | PRD Q 表 | — |
| Q-16 | 出版书 v1 范围 | accepted | PRD Q 表 | — |
| Q-17 | 幕的生成策略 | accepted | PRD Q 表 | — |
| Q-18 | 金手指的定位 | accepted | PRD Q 表 | — |
| Q-19 | 主角与主要角色的解构形态 | accepted | PRD Q 表 | — |
| Q-20 | 模板的统一骨架与概念定义 | accepted | PRD Q 表 | — |
| Q-21 | 开篇专项与定量文风 | accepted | PRD Q 表 | — |
| Q-22 | 逐章记录是否增「剧情线」列与支线缺席检测、指纹是否扩容 | accepted | PRD Q 表 | — |
| Q-23 | 数据列扩展（模板字段审查 P0/P2/P3） | accepted | PRD Q 表 | — |
| Q-24 | 故事设计层与模板段补齐 | accepted | PRD Q 表 | — |
| Q-25 | 作者的话产物收窄 | accepted | PRD Q 表 | — |
| Q-26 | 逐章记录增「章字数」列（D-23） | accepted | PRD Q 表 | — |
| Q-27 | 人物卡增可感知三字段（D-22） | accepted | PRD Q 表 | — |
| Q-28 | 技能触发方式改为仅显式调用 | accepted | PRD Q 表 | — |
| Q-29 | 出处覆盖率从 88.6% 推到 95% 的路径 | accepted | PRD Q 表 | — |
| Q-30 | PRD 数字纳入一致性测试 | accepted | PRD Q 表 | — |
| Q-31 | `pre-commit` 钩子在本机不可用 | accepted | PRD Q 表 | — |
| Q-32 | 卡片字段与散文引句进校验（v0.3.0，破坏性） | accepted | PRD Q 表 | — |
| Q-33 | 校验器的「两套账」：`data.errors` 与 `problems` 必须一致 | accepted | PRD Q 表 | — |
| Q-34 | 质量门从守「体量」改守「判据密度」 | accepted | PRD Q 表 | — |
| Q-35 | 7 个判断字段移出元字段白名单 | accepted | PRD Q 表 | — |
| Q-36 | 视角章占比按「子串包含」统计，不要求列值全等 | accepted | PRD Q 表 | — |
| Q-37 | 幕边界 J-05 的阈值定为「主角连续缺席 ≥8 章」，不用报告建议的「≥3 章或占该幕 ≥30%」 | accepted | PRD Q 表 | — |
| Q-38 | 幕末衔接查「同值无说明」，不查「有落差」 | accepted | PRD Q 表 | — |
| Q-39 | 引句深度闸门查「不可替代性」，且只对引号内文字判 | accepted | PRD Q 表 | — |
| Q-40 | 结构对账查「同一事实的多个副本是否一致」，四类各留反例 | accepted | PRD Q 表 | — |
| Q-41 | 出版书建卷层，「跳过幕判定」改为「幕＝原文单元但照做幕纲」 | accepted | PRD Q 表 | — |
| Q-42 | 状态以磁盘内容为准，`manifest.files` 只作线索 | accepted | PRD Q 表 | — |
| Q-43 | 破坏性重建要二次确认，文件状态要给稳定写入口 | accepted | PRD Q 表 | — |
| Q-44 | 统计类数字一律由脚本产出，agent 只转述 | accepted | PRD Q 表 | — |
| Q-45 | 伏笔编号由脚本排，agent 只报内容 | accepted | PRD Q 表 | — |
| Q-46 | 逐章记录加「爽点类型」，原「爽点标记」正名为「爽点强度」 | accepted | PRD Q 表 | — |
| Q-47 | 人物卡「功能位」由开放举例改为闭合枚举 | accepted | PRD Q 表 | — |
| Q-48 | 作者自查题移出判据层，单立 `references/解读提示.md` | accepted | PRD Q 表 | — |
| Q-49 | references 按「能不能拿来判定」分三层，判据层可整读 | accepted | PRD Q 表 | — |
| Q-50 | 视野分级：每个阶段能读什么按三档定死 | accepted | PRD Q 表 | — |
| Q-51 | 不带章号的散文结论也进覆盖率分母 | accepted | PRD Q 表 | — |
| Q-52 | 文风偏离判定按 ≥2σ，不取固定 top-N | accepted | PRD Q 表 | — |
| Q-53 | notFound 分流成「可还原／不可还原」，章题不当引句 | accepted | PRD Q 表 | — |
| Q-54 | 脚本写 manifest 前必须复核，冲突重读重试 | accepted | PRD Q 表 | — |
| Q-55 | `工作/增量/` 是合法的过程目录，命名规则收紧 | accepted | PRD Q 表 | — |
| Q-56 | `write-rows --dry-run` 收集全部错误；05 不再重复标阶段 2 | accepted | PRD Q 表 | — |
| Q-57 | 分卷总表照抄卷纲要查，但只查「照抄」不查「不一致」 | accepted | PRD Q 表 | — |
| Q-58 | 报告要素四表进 `COLUMNS`，四张分开登记 | accepted | PRD Q 表 | — |
| Q-59 | 卷级派生统计交给 `volume-stats.mjs`，三项一次算完 | accepted | PRD Q 表 | — |
| Q-60 | 快速模式切章口径唯一化（`--dry-run` 给列表），02/03 合并一次通读 | accepted | PRD Q 表 | — |
| Q-61 | 产物文件状态：骨架建成后必须有地方把它标成 filled | accepted | PRD Q 表 | — |
| Q-62 | 快速模式对账交 `reconcile.mjs`，五项一次核完并给退出码 | accepted | PRD Q 表 | — |
| Q-63 | 核心冲突装置只有一个定稿处：06／07 只写增量，09 一次性定稿 | accepted | PRD Q 表 | — |
| Q-64 | 幕判定改流式：每 20–40 章定一幕，不等全卷 | accepted | PRD Q 表 | — |
| Q-65 | 修复轮次落盘：`progress --repair-round` | accepted | PRD Q 表 | — |
| Q-66 | 出处核验拆分：脚本先定位，子代理只判同指；裁决每批落盘 | accepted | PRD Q 表 | — |
| Q-67 | 08 的出场统计一律取 `entity-index --json`，agent 不自算 | accepted | PRD Q 表 | — |
| Q-68 | `ENUMS.峰值强度` 进契约：它是独立字段，不做映射（化解与决议 12 的表面冲突） | accepted | PRD Q 表 | — |
| Q-69 | 留存机制收口为「爽点密度＋章末钩强度」，其余四项进 `RESERVE_OUT_OF_SCOPE` | accepted | PRD Q 表 | — |
| Q-70 | 模板系列三条遗留补齐：A-09 商业外证空值写法、B-07 说明段不参与段名校验、R-05 前四卷补全回填 | accepted | PRD Q 表 | — |
| Q-71 | M-15 的判据落在「句子」而非「出现次数」 | accepted | PRD Q 表 | — |
| Q-72 | 峰值与逐章情绪**给映射**（C6 的原本要求），不是只进契约就算完 | accepted | PRD Q 表 | — |
| Q-73 | 峰值取值改「枚举词 + 紧跟分隔符」，不用 `includes`/`startsWith` | accepted | PRD Q 表 | — |
| Q-74 | 爽点密度进分卷总表（16 列），由 `volume-stats --write-total` 写入 | accepted | PRD Q 表 | — |
| Q-75 | `volume-stats` 的占位判定从「整行」改为「按字段」 | accepted | PRD Q 表 | — |
| Q-76 | 列数、段数、枚举与阈值以哪处为准 | accepted | PRD Q 表 | — |
| D-01 | 段名/表头/白名单/阈值以 `contract.mjs` 为唯一机器源；`assets/` 模板是人读副本，一致性由 … | accepted | 技术文档 D 表 | — |
| D-02 | 拆书脚本放技能内 `skills/book-breakdown/scripts/`，测试放仓库 `test/` | accepted | 技术文档 D 表 | — |
| D-03 | 切章是纯规则宽正则，不用 LLM 兜底 | accepted | 技术文档 D 表 | — |
| D-04 | 分卷三级信号按优先级：①「第X卷」独立行（唯一权威锚点）②章号重启检测 ③「(第N卷完)」尾标记回推；全部失效时全书为… | accepted | 技术文档 D 表 | — |
| D-05 | agent 分批以卷为单位、每批 ≤20 章；每批完成即写入逐章记录（事务性：批不完整不落盘） | accepted | 技术文档 D 表 | — |
| D-06 | 逐章记录是过程层的唯一事实源：幕判定、出场统计、别名统计、断点续跑都从它派生 | accepted | 技术文档 D 表 | — |
| D-07 | 出处格式「第 N 章＋引句」在 agent 写入时强制；validate 只做格式校验，不回源核对引句真伪 | accepted | 技术文档 D 表 | — |
| D-08 | 全自动，不设确认；非常规叙事书的「唯一真相」不自动裁决，产物显式「未决/双重记录」 | accepted | 技术文档 D 表 | — |
| D-09 | 出版书由 `book_type=出版` 走降级目录树分支（无分卷总表/卷纲，幕＝原文单元），不复制第二套模板 | accepted | 技术文档 D 表 | — |
| D-10 | 输入编码检测：非 UTF-8 时用 `TextDecoder('gbk')` 转码后写入产物副本，原文件不动，mani… | accepted | 技术文档 D 表 | — |
| D-11 | 全书层的「核心冲突装置」在卷级循环之前先产出初版，作为后续所有卷的口径锚 | accepted | 技术文档 D 表 | — |
| D-12 | 断点续跑以 manifest 内受管状态块记账：批表（卷号、批号、章号区间、状态）与阶段表只由脚本写入；写盘走「临时文… | accepted | 技术文档 D 表 | — |
| D-13 | 切章噪音阈值：疑似标题行 >100 字符判噪音丢弃；切出的短章 <10 字符并入前章；宽正则全失效时不降级造章，直接按… | accepted | 技术文档 D 表 | — |
| D-14 | 汇总层守恒与红旗：分批摘要→卷级汇总时断言块数守恒（输入块数＝汇总记录数）；逐章记录的一句话事件字符数 ≥ 该章原文字… | accepted | 技术文档 D 表 | — |
| D-15 | validate 输出分两级：错误（退出 1，阻断）与警告（不阻断，列入报告）；总判定固定三档「通过／需修改／不通过」 | accepted | 技术文档 D 表 | — |
| D-16 | 骨架先行：初始化（阶段 2）即从 contract＋模板生成全部固定产物的骨架文件（段名＋待填占位），卷纲/幕纲/主角… | accepted | 技术文档 D 表 | — |
| D-17 | 进度状态模型分四层：阶段／卷／批／文件，记于 manifest 状态块；批为主进度口径，产物文件四态（骨架／已填写／校… | accepted | 技术文档 D 表 | — |
| D-18 | 中断语义固定五档：暂停／取消＝优雅停于批边界、产物永不自动删除；继续＝prepare 重入幂等（已存在即对账续跑）；重… | accepted | 技术文档 D 表 | — |
| D-19 | 批内允许分片落盘：每批 ≤20 章为上限，批内可按 5-6 章幂等写盘（只改本批行）；批粒度是进度单位，不是写盘单位 | accepted | 技术文档 D 表 | — |
| D-20 | 分卷一级信号区分卷首锚点与卷末总结行：「第N卷＋总结/感言/致歉/感谢/记录/说明」类行按卷尾信号切卷，其余按卷首锚点… | accepted | 技术文档 D 表 | — |
| D-21 | D-07 的回源核对落成两级：`scripts/verify-quotes.mjs` 用确定性规则判三档（本章命中／章… | accepted | 技术文档 D 表 | — |
| D-22 | 人物卡加「体貌锚点／衣着与装束／神态与动作锚」三字段，均登记进 `SOURCE_CLAIM_LABELS`（受 … | accepted | 技术文档 D 表 | — |
| D-23 | 逐章记录加「章字数」列，由 `prepare` 直接写入 `manifest.chapters[].chars`，… | accepted | 技术文档 D 表 | — |
| D-24 | 新增 `scripts/write-rows.mjs`：按章号确定性写逐章记录行（agent 提交 JSON 数组，脚… | accepted | 技术文档 D 表 | — |
| D-25 | 新增 `scripts/entity-index.mjs`：从逐章记录反转出「实体→章号」索引（`--list`/… | accepted | 技术文档 D 表 | — |
| D-26 | 阶段 5 的取证章数设上限（主角/主要配角 ≤6、次要角色 ≤2、集合条目 ≤3），并明确「骨架全量、卡片采样」的边界… | accepted | 技术文档 D 表 | — |
| D-27 | 新增 `scripts/quote-finder.mjs`：给定实体与章号，用确定性检索把含该实体（含别名词典里全部别… | accepted | 技术文档 D 表 | — |
| D-28 | 批次大小维持每批 ≤20 章，不放大到 40 章 | accepted | 技术文档 D 表 | — |
| D-29 | 新增 `scripts/cost.mjs` 落实 M-06：`--record`/`--set` 把各阶段用量累加进 … | accepted | 技术文档 D 表 | — |
| D-30 | 新增 `scripts/reference-index.mjs` 生成 `references/索引.md`：逐节列出… | accepted | 技术文档 D 表 | — |
| D-31 | 新增 `scripts/reconcile.mjs`：快速模式对账五项一次算完（摘要行数、摘要超 60 字行数、无法摘… | accepted | 技术文档 D 表 | — |
| D-32 | 新增 `progress --repair-round 轮次:说明`，写进 `manifest.repairs`；同一… | accepted | 技术文档 D 表 | — |
| D-33 | `quote-finder` 增 `--grep-all`：一批引句先用 4-gram 倒排找候选章，再算相似度，输出… | accepted | 技术文档 D 表 | — |
| D-34 | `entity-index` 的 `buildIndex` 增产 `分卷章数`／`视角章`／`volChapters`… | accepted | 技术文档 D 表 | — |
| D-35 | 重复事实的判据落在句子层面：同一句定义式不得出现两次；概念在「核心卡／判据表／模板取值／错法表」各出现一次不算重复 | accepted | 技术文档 D 表 | — |
| D-36 | 派生列走「写一次、两处用」：`computeVolumeStats` 产出 `sharpDensity` 字段，… | accepted | 技术文档 D 表 | — |
| D-37 | 占位符按**字段**判，不按行判 | accepted | 技术文档 D 表 | — |

## ADR

承重决策另立正文，按编号排列：

| 编号 | 标题 | 状态 | 文件 |
|---|---|---|---|
| 0001 | 规范自有化：规范正文由本仓自持，上游降为参考 | accepted | [0001-规范自有化.md](0001-规范自有化.md) |
| 0002 | 过程路径以契约与脚本为准 | accepted | [0002-过程路径以契约与脚本为准.md](0002-过程路径以契约与脚本为准.md) |
| 0003 | 子代理接口字段以 `AGENT_REVIEW` 为准 | accepted | [0003-子代理接口字段以-AGENT_REVIEW-为准.md](0003-子代理接口字段以-AGENT_REVIEW-为准.md) |
| 0004 | docs-check 成为文档门禁 | accepted | [0004-docs-check-门禁.md](0004-docs-check-门禁.md) |
