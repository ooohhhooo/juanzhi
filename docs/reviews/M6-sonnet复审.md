# M6 复审（Sonnet 全新上下文，只读）

> 复审对象：返工后的工作区，对照 `docs/reviews/M6-sonnet审核.md` 的 5 条 P1 和 14 条 P2；另审返工时新增的代码（迁移前备份与回滚、`removeSentence`、流式 P1 与总时限、自动上限降级、核对确认框、E2E 断言）。
> 方法：逐条读代码；用 scratchpad 里的临时脚本直接调用 `src/` 的纯函数复现（没有改项目文件、没有跑 build / E2E / dist、没有调用 AI）。`tsc --noEmit` 的 node 和 web 两个工程都通过。

## 结论：**通过（没有 P0，没有未修的 P1，也没有新的 P1）**

- 原 5 条 P1：5 条已修（其中 Word 一条只是「代码层修好」，实机验证仍未做，见下文，这是发布前必做项而不是代码缺陷）。
- 原 14 条 P2：12 条已修，2 条部分修（P2-2、P2-12）。
- 新问题：P0 0 条，P1 0 条，P2 6 条。

---

## 一、原 P1 逐条复核

### P1-1　P1 解析非流式、总时长超时 —— **已修**
- 依据：`src/main/parse/run.ts` 的 `chat({ …, stream: true, timeoutMs, escalateOnLength, maxTokensFallback })`；`client.ts` 流式分支每次读到数据 `bump()`，超时按空闲计；`chat()` 另有 20 分钟总时限（`maxTotalMs`）。交付说明 §5 记了 3 次真实 P1 调用（含一次推理模型 277 秒），不再有"总时长先到"的问题。
- 新代码审：`once()` 里 `timer`（空闲）和 `totalTimer`（总时限）都在 `finally` 里清掉；总时限命中时 `timeoutError` 带 `detail === 'total-timeout'`，`chat()` 里直接抛出不再重试；总时限已过时下一次 `once()` 的 `totalTimer` 为 1ms，会立刻以 total-timeout 结束；翻倍重试前检查 `Date.now() < deadline`。没有发现计时器泄漏或无限重试。（见新问题 N-5。）

### P1-2　事实核对能被换说法绕过 —— **已修（启发式，残余已如实写进交付说明）**
- 复现：用上次的 14 句测试 + 另写 18 句（见 `scratchpad/f1.mjs`、`f2.mjs`）：
  - 上次漏掉的 "time for 后面要接动词" "time for 加动词" "time for 要接动词" "time for 之后要用动词原形" "time for 的后面应该跟 doing" "tomato 的复数加 -s" 现在全部标「矛盾」；
  - 否定（"time for 不能接名词"）、口语（"for 后面跟东西，to 后面跟动作"）、两个短语同句说反、-ing 形式、词尾"不是 -s"都判对，没有对正确句子误报矛盾（17 句里只有两句没抓到："time to V" 这种缩写，以及 "在 time to 前面用动词" 这种本身有歧义的说法）。
- 交付说明 §2 现在写明"抓得到 / 抓不到 / 会误标"，不再声称"宁可多标也不漏标"。可以接受。

### P1-3　家长版矛盾句删不掉却提示"已删掉" —— **已修**
- 复现（`p1.mjs`、`r1.mjs`）：句子中间夹引用、粗体、列表序号都能删掉；`finishReport` 删完会重新核对，删不干净时 warnings 改写成"其中 N 句没能自动删掉……这份家长版不能核对通过"，同时 `confirmBlockReason` 在后端拒绝确认 / 复制 / 导出；`markFindings` 也改成按字的位置映射，找不到的单独列进 `missed`。
- 残余（P2，见 N-4）：删完句子后紧跟的引用如果前面有空格，会留下孤零零的 `[卷名 · 题号]` 和句号。

### P1-4　疑似重复方向反了 —— **已修**
- 复现（`s2.mjs`，用 `g4-papers.json` 的真实卷子）：
  - 先第 1 页、后整卷 → 被标的是第 1 页（`flagged: part, of: full`），整卷计入；
  - 卷头信息读不出来 → 仍然标第 1 页；
  - 先整卷、后第 1 页 → 标第 1 页；
  - 2024 与 2025 两份不同年的卷子、第 1 页与第 2 页分开导入 → 不误标。
- 新代码审：`decideFlag` 对称（谁被对方包含得更多标谁，一样多标后导入的）；`detectSimilar` 不动 `accepted`；`scanSimilar` 按导入先后只和更早的比，`pointsToNewer` 防止把"因更新的完整卷而被标"的旧卷当过期标记清掉；`papers:remove` 后 `redetectAfterRemoval` 重新判断。逻辑自洽。

### P1-5　Word 的 OOXML 结构 —— **已修（代码层），但实机验证仍没做**
- 复现（`d1.mjs`）：`w:pPr` 里 `spacing` 在 `ind` 前；表格有 `tblGrid`、每格 `tcW`、`tblLayout`；`rPr` / `tblPr` / `tcPr` 子元素顺序对照规范逐个看过没有问题；含 U+FFFE / U+FFFF / 控制字符 / 孤立代理项的文本生成的 `document.xml` 用 `xmllint` 检查是良构的。
- 仍未做：没有在 Word / WPS 里实际打开过（交付说明 §7.1 如实写了）。这一条我不再按 P1 计，但**发布前必须在 Windows 的 Word 和 WPS 各打开一份含列表、表格、截图的样本**。

---

## 二、原 P2 逐条复核

| 原编号 | 状态 | 依据 |
|---|---|---|
| P2-1 家长版被清空仍能核对 | **已修** | `PARENT_MIN_CHARS = 40`；`confirmBlockReason` 在 `confirmReport`、`assertExportable`、`itemOf.blockReason` 三处生效（后端拒绝 + 界面置灰并写原因）；`PARENT_BANNED` 去掉了"难点""重点知识"。`r1.mjs`：只剩一句的家长版 warnings 写"不能核对通过，请重新生成"。 |
| P2-2 复制与导出口径不一致 / 无法处理未核实句 | **部分修** | 口径统一了（`exportableMarkdown` / `wechatText`：家长版核对后两处都去标记，其他版本都保留）；新增 `report:removeSentence`（只能删清单里的句子、已核对的不能再改）；有矛盾句的家长版确认键被禁用。**没修好的**：确认框里"已确认无误"的勾选（`okSentences`）只是摆设，没有参与"我已核对"按钮是否可点，也不发给后端；非矛盾的"未核实"句子老师什么都不做也能点确认，之后家长版导出 / 复制里这些句子不带标记。见 N-1。 |
| P2-3 docx 非法字符 | **已修** | `ILLEGAL_XML` 覆盖控制字符、U+FFFE/FFFF、孤立代理项；`d1.mjs` 用 `xmllint` 验证。 |
| P2-4 迁移 v10 | **已修** | 升级前 `VACUUM INTO` 备份、失败时 `restoreBackup`、只留 3 份；v10 缩框算法冻结成 `repairNeighborEdgesV10`（和上次逐行对过一致）；升级后 `scanSimilar`；设置页有"检查重复试卷"按钮。v1–v9 仍未动（`git diff` 只增不删，仅 `runMigrations` 一行换成带备份的调用）。新增代码的问题见 N-3、N-6。 |
| P2-5 输出上限 | **已修** | 手动模式 `ceiling = 手填值`、`fallback` 为空，永远不翻倍不降级；自动模式首个请求被服务商 400 拒绝（报错含 max_tokens / maximum / exceed 等）→ 降到 8192 重试一次并在 `warnings` 里加白话提示（`fellBackTo` → `limitFallbackNotice`）；一次调用总时限 20 分钟；设置页文案已写明"手填的数不会被自动加长"。新代码审见 N-5。 |
| P2-6 疑似重复口径 | **已修** | `similarSuspects` 改为 `paperScope({…includeDuplicates:true})` 跟随当前筛选；删卷后重新判断；统计页提示补了"打开『包含重复导入』也能计入"和"也可能是旧卷"；`similar_ratio` 现在永远是"被标那份被包含的比例"，"像是…的一部分"在两个方向都成立。但我顺带发现 `duplicates` 计数把疑似重复也算进去了，见 N-2。 |
| P2-7 A4"不误伤"空转 | **已修** | `run-m6.cjs` 阶段 8：造 3 份各 3 道 ≥8 字符题干的卷子（A1、A3 一样、A2 不同），调 `papers.scanSimilar()`，断言 A2 不被标、A1/A3 恰好一份被标且 `similar_to` 指向对方、`scan.checked ≥ 3`。这条真的会失败。小缺口：没断言被标的是"后导入的那份"。 |
| P2-8 E2E 放松 / 文档不一致 | **已修** | 侧栏断言改成：`.ewb-sider` 宽 < 100、导航入口 ≥ 8、六个两字标签都在、`.ewb-main` 宽 > 1000——会随布局变化而失败，不再恒真；标黄断言改成 `bg[1] === --ewb-red-soft 的计算值`、普通题 `rgba(0, 0, 0, 0)`。交付说明头部、§7.5 已改正依赖 / 版本号 / `smoke-packaged` 的说法。 |
| P2-9 `confirmPaper` 清空 `ai_meta_json` | **已修（有意的行为，已记录并有单测）** | 交付说明 B9 行和 §9 写明是有意的；`m6-data.test.mjs` 固定了行为。 |
| P2-10 证据含未审核内容 | **已修** | `evidence.ts` 的易错说明查询加了 `p.status = 'done'`。 |
| P2-11 去代码误删大写单词 | **已修（残余很小）** | 题型码（MATCH / ORDER / FILL 等）只在括号、反引号、"｜"前这些明确位置去；仍会裸去 ≤3 个字母的代码（RD、FN、GR、MC…），极少撞上正常英文。 |
| P2-12 设计过程注释 / 预览路由 | **部分修** | `index.html` 注释精简成五行设计契约，不再有"用户选定 Build this"这类过程描述（仍带种子号，无害）；`/design/*` 路由和 `design/assets/real-q-*.png` 仍随正式版发布（设计说明里没有处理，交付说明 §10 也只是转给设计代理）。建议只在开发构建里挂路由，并确认图片没有版权 / 学校信息。 |
| P2-13 `ai_drafts` 生命周期 | **已修** | 覆盖导入、清示例、删报告都清草稿。 |
| P2-14 流式 reader 释放 | **已修** | 读取循环的 `catch` 里 `reader.cancel()`。 |

---

## 三、新问题（返工新增代码，或首轮漏看的）

### P0：无

### P1：无

### P2

**N-1　核对确认框里的"已确认无误"勾选不起任何作用**（`src/renderer/pages/Report.tsx` 的 `okSentences`、`okButtonProps`）
- 确认键只看 `conflictCount > 0` 和 `removing`；勾选状态不参与判断也不传给后端。非矛盾的"未核实"句子老师不看也能点"我已核对"，然后家长版导出 / 复制会把这些句子的标记去掉。
- 建议：家长版要求每条"未核实"句子勾选或删除后才启用确认键；后端 `confirm` 可以多收一个已确认句子的列表并存进 `reports`（顺带满足交付说明 §8-4 的留痕）。

**N-2　疑似重复的卷子被同时算进"同一文件重复导入"的提示**（`src/main/stats/core.ts` 的 `scopeNotes`：`duplicates = cnt(all) - cnt(dedup)`）
- `dedup` 现在也排除 `similar_state='suspect'`，所以一份疑似重复卷会让 `duplicates` 也变成 1。复现（`n1.mjs`）：两份卷子，其中一份标 suspect → `duplicates: 1, similarSuspects: 1`。界面会同时写"有 1 份内容重复的试卷（同一文件导入了多份）已合并"和"有 1 份疑似重复……没有计入"，前一句与事实不符。首轮我也漏看了。
- 建议：算 `duplicates` 时 `all` 和 `dedup` 都带上同一个 suspect 条件（只比较文件哈希去重的差）。

**N-3　整库扫描是 O(N²) 次数据库读取，在主线程上同步跑**（`src/main/parse/similar.ts` 的 `detectSimilar` / `scanSimilar`，`db.ts` 升级后调用）
- 每份卷子都会对其他所有卷子重新 `loadSim`（读全部题目）。实测（`n2.mjs`，每份 40 题）：100 份 ≈ 1 秒，300 份 ≈ 5.5 秒。升级时是在窗口出现前阻塞，设置页按钮点下去界面也会卡住。
- 建议：`scanSimilar` 一次性把所有卷子的题目键读进内存（`Map<id, SimPaper>`）再两两比，复杂度仍是 O(N²) 次集合运算但没有数据库往返；按钮那边给个"正在检查"并放进 `setImmediate` 分片。

**N-4　删除句子后会留下孤零零的引用和句号；删完后 `warnings` 不更新**（`src/shared/factcheck.ts` 的 `removeSentence`，`report/service.ts` 的 `removeReportSentence`）
- 复现（`r1.mjs`）：`1. **…孩子容易错** [2025卷 · 7]。另一个要点……` 删掉前半句后变成 `1.  [2025卷 · 7]。另一个要点……`——`TRAILING_JUNK` 不跳过引用前的空格。家长版里这个引用会留在导出里（微信复制会去掉引用，Word / PDF 不会）。同时生成时写进 `warnings_json` 的"有 N 句……未核实"文字不会随删除更新，界面上仍显示旧数字。
- 建议：`TRAILING_JUNK` 之前先吞掉空白；删除后重写 `warnings_json` 里与核对相关的那几条（或界面只显示 `unverified` 的实时数量）。

**N-5　翻倍重试可能在总时限快用完时才开始**（`client.ts` 的 `chat()`）
- 只检查 `Date.now() < deadline`。第一次写满 32768 token 花了 12 分钟被截断，翻倍重试只剩 8 分钟，几乎必然在"总时限"处失败，整次生成（含已花的钱）丢掉，只留草稿。
- 建议：翻倍重试前要求剩余时间 ≥ 第一次实际用时的一半（或固定 ≥ 5 分钟），否则直接按截断报错，保留已有的部分。

**N-6　升级前备份 / 升级后扫描都跳过 `user_version = 0` 的旧库**（`src/main/db.ts`：`if (currentVersion > 0 && …)`）
- M1 之前没有版本号的旧库（E2E 里专门造过这种库）升级时不会备份，也不会补扫重复卷。这类库现实中很少，但有数据时恰恰最需要备份。
- 建议：判断"库里有数据"（例如 `papers` 表存在且有行）而不是 `currentVersion > 0`。

---

## 四、读了哪些文件，哪些没读

**读了**：`docs/M6-功能交付说明.md`（头部、§2 A3 / A4 说明、§5、§6、§7、§9、§10）、`docs/M6-设计系统说明.md`（§8.3–8.5）；`src/main/ai/client.ts`（全文）、`stream.ts`、`providers.ts`、`parse/run.ts` diff、`parse/similar.ts`（全文）、`db.ts` 返工 diff、`db-backup.ts`、`ipc/papers.ts` / `ipc/report.ts` / `ipc-channels.ts` / `preload` 的相关部分、`report/service.ts`、`report/finish.ts`、`report/docx.ts`（全文）、`shared/factcheck.ts`（全文）、`shared/report-post.ts`（相关部分）、`stats/core.ts` `scopeNotes`、`stats/evidence.ts`、`pack/apply.ts` / `sample/load.ts` diff；渲染进程 `Report.tsx`（全文）、`Settings.tsx` / `AiSettings.tsx` / `Parts.tsx` / `SimilarNotice.tsx` 的相关部分、`index.html`、`App.tsx` 路由；E2E 的 `run-m2.cjs`（侧栏与标黄两处）、`run-m6.cjs` 阶段 8；`tests/unit/db-backup.test.mjs`。
**临时脚本**（全在 scratchpad，没有改项目）：`p1.mjs`、`f1.mjs`、`f2.mjs`、`s2.mjs`、`d1.mjs`（xmllint 验证）、`r1.mjs`、`n1.mjs`、`n2.mjs`。

**没读 / 没验证**：没有运行单测、E2E、打包；`tests/unit` 里新增的 `docx-structure`、`mock-finish`、`factcheck`（全文）、`report-finish` 的细节；`tests/mock-ai/*` 对 P1 流式的支持（只看了交付说明里的描述）；真实 AI 的三次 P1 记录没有核实原始输出；Word / WPS 实机、Windows 上的行为均未验证；`src/renderer` 里其余页面的设计返工内容（只看了与本轮问题相关的部分）。
