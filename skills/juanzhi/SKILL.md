---
name: juanzhi
description: 调用「卷知」（小学英语试卷分析桌面软件）的命令行：导入校内英语试卷（pdf / 图片 / docx）、查看试卷和知识点统计、生成老板版 / 老师版 / 家长版 / 完整版考情分析报告并导出 md、docx、pdf。当用户要分析小学英语试卷、看考情、出报告、给家长发总结、或提到「卷知」「juanzhi」时使用。
---

# 卷知命令行（juanzhi）

卷知是装在用户电脑上的桌面软件，数据只存在本机。它的命令行和窗口共用同一个程序和同一份数据。

## 什么时候用

- 用户要把一批试卷导入卷知并让 AI 解析；
- 用户要看某个年级 / 学期 / 学年的知识点统计、重难点、同比；
- 用户要生成考情分析报告（老板版、老师版、家长版、完整数据版）并导出文件。

不要用它做别的事：它不能删除试卷或报告，不能设置 API Key，不能改数据目录，也不能替老师点「我已核对」。

## 怎么调用

优先用短命令 `juanzhi`（用户在卷知「设置 → 管理员设置 → 命令行工具」里装过）。没有就用完整路径：

- Mac：`"/Applications/卷知.app/Contents/MacOS/卷知" cli <命令>`
- Windows：`"<安装目录>\EnglishExamWorkbench.exe" cli <命令>`（直接运行 exe 拿不到输出：加 `--result-file <文件>`，用 `Start-Process -Wait -PassThru` 等它结束再读文件；用 `juanzhi` 短命令则没有这个问题）

**stdout 只有一段 JSON**：成功 `{"ok":true,"data":…}`，失败 `{"ok":false,"code":"…","message":"中文白话","exit":N}`。进度写在 stderr，可以忽略。先解析 JSON 的 `ok`，失败时把 `message` 原样转告用户。

## 使用前提（先检查）

1. **卷知窗口必须关闭。** 窗口开着时命令行报 `app_running`（退出码 3）：请用户先关闭卷知窗口，不要重试。
2. **先跑 `juanzhi status`。** 看 `ai.configured`：为 `false` 时 `import` 和 `report generate` 会报 `ai_not_configured`（退出码 5）。这时让用户打开卷知窗口，到「设置 → AI 服务」里填写；**你不能也不应该设置或询问 API Key**。

## 命令清单

| 命令 | 作用 |
|---|---|
| `status` | 版本、数据目录、卷子数（按状态）、AI 是否已配置、OCR 是否可用 |
| `import <文件…> [--wait]` | 导入并自动提取 + AI 解析；会一直等到每份进入「待审核」或失败（几分钟）；`--timeout <秒>` 限制最长等待 |
| `papers list [--grade --semester --year --exam-type --textbook --region --status]` | 试卷列表 |
| `papers show <id>` | 一份试卷的题目、知识点、状态 |
| `papers confirm <id> --i-reviewed` | 跳过人工审核直接确认整份试卷（**见下面的规则**） |
| `stats overview` / `stats hot [--level 1\|2\|3]` / `stats compare --target <学年> [--base before\|<学年>]` | 统计；都支持筛选：`--grade 1-6 --semester 上\|下 --year <学年起始年> --exam-type 单元测试\|期中\|期末\|月考\|其他 --textbook --region --include-reviewing --include-duplicates` |
| `report generate --reader boss\|teacher\|parent\|full [筛选]` | 生成报告 |
| `report list` / `report show <id>` | 报告列表 / 详情 |
| `report export <id> --format md\|docx\|pdf --out <路径>` | 导出文件 |

`--out <文件>` 把 JSON 同时写进文件（`report export` 里 `--out` 是文档路径，JSON 副本用 `--result-file <文件>`）。

## 典型流程

1. `juanzhi status`：确认 AI 已配置；没配就告诉用户去窗口里配，然后停下。
2. `juanzhi import <文件…> --wait`：导入、等解析。命令会运行几分钟，不要中途打断。结果里每份有 `status`（`reviewing` 成功；`failed` 失败；`duplicate` 已经导入过）。
3. **提醒用户人工审核**：「这几份卷子是 AI 解析的，题型、分值、知识点可能有错，请在卷知窗口里审核（或告诉我你已经审核过了）」。统计默认只计入已确认的卷子；`--include-reviewing` 可以把待审核的也算上，但要告诉用户这些数据未经审核。
4. 用户确认后，`juanzhi stats overview` / `stats hot` 看统计；样本少时返回里有提示，**不要对「难点」下结论**。
5. `juanzhi report generate --reader <读者> [筛选]`：生成。读返回的 `unverified`（事实核对没通过的句子）和 `warnings`，**把它们转告用户**，不要自己悄悄删掉或改写。
6. `juanzhi report export <id> --format docx --out <路径>`：导出，把文件路径告诉用户。

## 必须遵守的规则

- **`papers confirm` 不能替用户做决定。** 它会跳过人工审核，AI 的错会直接进入统计和报告。只有用户明确说了「我已经审核过了」，才加 `--i-reviewed` 运行。用户没说，就让他到卷知窗口里审核，不要自己加这个参数。
- **家长版不能直接发给家长。** 家长版只要老师没在窗口里点「我已核对」，`report generate`、`report show` 返回 `parentDraft: true`，`report export` 的文件开头有「AI 草稿 · 未经老师核对，请勿直接发给家长」，JSON 里 `draft: true`。你没有任何命令能替老师点「我已核对」。把文件交给用户时要说清楚：这是草稿，需要老师读一遍、在卷知窗口里点「我已核对」后才能发给家长。
- 所有报告都是 AI 生成的草稿：难度、易错点是 AI 估计，不是学生成绩；`unverified` 里的句子是事实核对没通过的，需要老师核对。
- 不要把 stdout 的 JSON 以外的东西当结果；不要在输出里猜测密钥或服务地址（命令行也不会输出它们）。

## 错误码（退出码）

| 码 | `code` | 怎么办 |
|---|---|---|
| 0 | — | 成功 |
| 1 | `internal` | 内部错误，把 message 转告用户 |
| 2 | `usage` | 命令或参数不对，按 message 修正后重试 |
| 3 | `app_running` | 卷知窗口开着：让用户先关闭窗口 |
| 4 | `cli_busy` | 另一个命令行任务在跑：等它结束后重试 |
| 5 | `ai_not_configured` | 让用户到窗口「设置 → AI 服务」里配置 |
| 6 | `not_found` | id 不存在，用 `papers list` / `report list` 查 |
| 7 | `invalid_state` | 状态不允许（试卷没解析完、没有可统计的卷子），按 message 处理 |
| 8 | `confirmation_required` | `papers confirm` 缺 `--i-reviewed`：让用户去窗口里审核 |
| 9 | `import_failed` | 有文件失败，`data.papers` 里有每份的原因 |
| 10 | `timeout` | 等待超时；没处理完的卷子退回「已提取」或失败，可以让用户到窗口的处理队列里重试，或加大 `--timeout` |
| 11 | `export_blocked` | 家长版没通过把关（内容太少、有矛盾句），建议重新生成 |
| 12 | `busy` | 有别的后台任务占着，稍后再试 |
| 13 | `data_unavailable` | 数据目录不可用：让用户检查 |
| 14 | `ai_failed` | AI 服务调用失败（网络、密钥、额度），转告用户 |

## 不能做的事

- 不能删除试卷或报告；
- 不能设置、读取、询问 API Key；
- 不能通过参数改数据目录；
- 不能替老师点家长版的「我已核对」；
- 不能在卷知窗口开着时使用命令行。
