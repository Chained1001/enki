# 产物 fixture（评审 P20）

本目录存放提交进仓库的「结构化产物最小样本」，用于锁定 prepare 的产物形态（目录树、manifest、骨架文件）。
`test/cli.test.mjs` 的用例「产物 fixture 过 validate-output --mode progress」对本样本运行校验，fixture 漂移（缺文件、表头不符、manifest 与树不一致）会让该用例失败。

## 内容

- `合成小书_拆解/`：prepare 对合成小书生成的完整骨架产物（网文型，5 章 1 卷，尚无幕纲＝进行中状态）。
- 小说文本为完全自造的合成文本（张三、李四在车站的流水账），不含任何真实作品内容。

## 生成命令（仓库根运行）

```sh
# 1. 把产物内的原文副本复制到产物目录外（prepare 拒绝输入落在既有产物 原文/ 内）
cp "test/fixtures/products/合成小书_拆解/原文/合成小书.txt" test/.tmp/合成小书.txt
# 2. 重新生成（--force 归档旧产物后重建）
node skills/book-breakdown/scripts/prepare.mjs "test/.tmp/合成小书.txt" --out "test/fixtures/products/合成小书_拆解" --force
# 3. 归一化 manifest：把 source.path 改为「合成小书.txt」、outDir 改为「合成小书_拆解」（去掉本机绝对路径）
#    其余文件逐字节保留；source.sha256 与 原文/合成小书.txt 保持一致，勿改动该文件内容
# 4. 验证：npm test 中 cli.test 的 fixture 用例应通过
```

注意：幕纲目录（`故事底本/故事剧情/幕纲/`）与五类集合的条目子目录在骨架阶段为空目录，git 不跟踪空目录属正常现象——产物契约只约束文件，不约束空目录。
