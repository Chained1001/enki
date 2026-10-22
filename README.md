# enki

把下载的小说 txt 拆成可查的章节摘要与写作要素。给作者自己用。

状态：实验

## 安装

```bash
npx skills add Chained1001/enki
```

前置条件：Node.js 24 及以上。

安装后确认：触发 `book-breakdown`，给一段含三章的小文本，应产出 3 行摘要与要素表。

## 技能列表

| 技能 | 用途 | 扩展键 |
|---|---|---|
| `book-breakdown` | 按章拆解整本小说 txt，产出章节摘要与写作要素 | 无 |

## 目录

| 路径 | 说明 |
|---|---|
| `skills/` | 技能源码，唯一发布内容 |
| `templates/` | 新建技能用的模板，不要删 |
| `docs/规范/` | 开发标准 |
| `scripts/`、`test/`、`evals/` | 校验、测试、评测 |

## 开发

| 命令 | 作用 |
|---|---|
| `npm run validate` | 静态校验 `skills/` |
| `npm test` | 运行全部测试 |

## 反馈

无，本项目不接收反馈。

## 维护者

Chained1001

## 许可证

MIT，见 LICENSE。