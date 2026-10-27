# M6 三审（Sonnet 全新上下文，只读）

> 范围：上次复审（`M6-sonnet复审.md`）之后新增 / 改动的代码，即「四角色验收后的返工增量」：R1 家长版（`shared/parent-fix.ts`、`p3_parent` 提示词）、R2 老板版（`setBossReviewLine`、`softenOverclaims`、`topScoreGapWarning`、`confirmReport` 去行）、R3 事实核对误报与文案、R4 代码过滤（`shared/code-guard.ts`、`db-repair.ts`）与截图框修正（`parse/ink.ts`、`parse/refine-run.ts`、`PAD = 0`）、R5 单考点分析（`stats/kp-analysis.ts`、`ai:kpAnalysis` / `ai:analyzeKp`）与界面（`KpDetailDrawer`、「交给老师核对」、采纳框错误）、上次复审里提出的 N-1 / N-3 的修法（确认框逐句确认、`similar-runner` 后台扫描）。
> 方法：读代码 + 在 scratchpad 里写临时脚本直接调用 `src/` 的纯函数复现；跑了 `tsc --noEmit`（node、web 两个工程都通过）和 `tests/unit/ipc-guard-audit.test.mjs`（通过）。没有跑 build / E2E / dist，没有调用 AI，没有改项目文件。

## 结论：**不通过**

- P0：0 条
- P1：2 条（都在家长版的质量把关上）
- P2：10 条

家长版是这轮最敏感的产物（直接发给家长），这次的「后处理」虽然补了很多规则，但把关有两个洞：整条校验被 `endWithPeriod` 自己架空，「至少留 2 条」的逻辑又只管超字数那一段，所以「只剩一条电报句 + 程序补的问候 + 通用安慰」的家长版可以顺利点「我已核对」、复制到微信。

---

## P1

### P1-1　家长版的「内容太少」把关被程序自己补的问候和结尾撑过去了；「至少留 2 条」只在超字数那段生效
- 位置：`src/shared/parent-fix.ts:fixParent`（整条校验后 `good`，只有超字数循环里有 `texts.length > 2`）、`src/shared/report-post.ts:confirmBlockReason`（只看 `parentBodyLength < PARENT_MIN_CHARS(40)`）。
- 复现（`scratchpad/pf2.mjs`，用 `finishReport` 全流程）：模型把 3 条里 2 条写成坏的，剩一条时，出来的家长版是
  ```
  各位家长好，这次期末英语有这几个小地方孩子容易错，在家几分钟就能帮上：

  1. tomato 一个其他多个。

  整体不用太担心，孩子基础不错，继续保持就好。
  ```
  `parentBodyLength = 54 ≥ 40`，`confirmBlockReason` 返回 `null`：后端 `confirm`、`copyWechat`、`export` 都放行，界面上「我已核对」「复制到微信」都能点。warnings 里只有「只剩 1 条，建议重新生成」一句，没有任何阻断。条数为 0 时同理（问候 34 字 + 一句结尾 ≥ 40）。
- 影响：原审核 P2-1 要堵的就是「被清空的家长版还能发给家长」；现在程序补的问候和结尾把这个口子又打开了。交付说明 §12.6 写的"至少留 2 条"只对"超字数时不再删"有效，对"坏条目被整条去掉"无效。
- 建议：`confirmBlockReason` 对家长版要求正文里有序号要点 ≥ 2 条（最好 3 条），并且字数统计排除程序补的问候和只有一句的结尾；不够就按"不能核对通过"处理，界面写白话原因。

### P1-2　「整条校验」被 `endWithPeriod` 架空，验收时那条读不通的 r2 句子原样留了下来
- 位置：`parent-fix.ts:fixParent`——先 `endWithPeriod(j.text)` 再 `itemProblems(f.text)`。
- 问题：`endWithPeriod` 给任何以汉字 / 字母收尾的文本补一个「。」，于是 `itemProblems` 里的「没有一句以句号结尾的完整句子」和「句子没写完（以的 / 和 / 逗号结尾）」两条永远不会触发（有了「。」就不是以逗号 / 「的」结尾，也满足"有句号"）。
- 复现（`pf1.mjs`、`pf2.mjs`）：
  - `西红柿绵羊：tomato 一个其他多个`（验收报告里点名读不通的那条）→ 去标题后变成 `tomato 一个其他多个。`，**通过了校验，留在家长版里**；
  - `孩子容易写错 tomato 的` → 补成 `…的。`，通过；
  - 单测 `parent-fix.test.mjs:108` 直接对**没补句号**的字符串调用 `itemProblems`，所以能通过，和真实流水线的行为不一致（测试没覆盖 `fixParent` 里的顺序）。
- 影响：交付说明 §12.6 "有问题的整条去掉并给提示，不拼接、不截断"对这类电报句不成立，只有「问……，答……」和名词堆标题两条规则真的在生效。
- 建议：先 `itemProblems(原文)` 再补句号（或把补句号后的结果和原文都检查）；`itemProblems` 的"完整句子"要求句内至少有谓语（例如含「容易」「要」「说」「写」「问」之类动词或 ≥ 10 个汉字），而不只是 4 个汉字加一个句号；给 `fixParent` 加一个端到端单测，输入 r2 的三条坏条目，断言输出里一条都不剩。

---

## P2

### P2-1　老板版：确认后「有 N 处还没核对」那一行被删掉，未核实的说法从此没有任何痕迹；那一行里还写着一句没依据的保证
- 位置：`report/service.ts:confirmReport`（`setBossReviewLine(rep.markdown, 0)`）、`shared/report-post.ts:bossReviewLine`（「不影响上面的投入方向」）、`unacknowledgedSentences`（只管家长版）。
- 删除本身是安全的：只删整行完全匹配 `> 有 N 处说法还没经老师核对（不影响上面的投入方向）` 的行（`BOSS_REVIEW_RE` 带 `^…$`），不会误删正文。
- 问题：①老板版不要求逐句确认，点一下「我已核对」，那一行就消失，页脚改成"数据口径"，未核实的句子没有标记也没有记录，看上去就是"已核对"；以前老师版 / 完整版是逐句标记，老板版现在是全无痕迹。②「不影响上面的投入方向」是程序写死的断言：未核实的句子可能恰恰在"三句话结论"里。
- 建议：老板版和家长版一样，确认时要求逐句确认或删除；那一行去掉后半句保证，或改成「有 N 处说法还没经老师核对」。

### P2-2　`softenOverclaims` 生成不通顺的句子
- 位置：`parent-fix.ts:OVERCLAIMS`。
- 复现（`b1.mjs`）：`学生都容易错，要重点补。` → `学生AI 估计容易错的比较多，要重点补。`；`这两块全部易错，建议先投。` → `这两块AI 估计里容易错的比较多，建议先投。`；`全部都是易错题` → `AI 估计里容易错的比较多题`；`名词复数不是难点` → `名词复数不是 AI 估计里容易错的地方`。这些文字直接进老板版 PDF / Word。
- 建议：替换后做语法兜底（改写成整句，或只在前面加「AI 估计：」而不是替换半句）；匹配时带上主语边界，否定句（"不是难点"）不要改。

### P2-3　`repairKpNames` 每次启动都跑、没有备份，会把 `A.M`、`P.M`、`P.E`、`T.V` 这类缩写名字改掉
- 位置：`src/main/db-repair.ts`、`db.ts:initDatabase`（每次启动调用，注释也写"幂等，每次启动都跑"）、`shared/code-guard.ts:looksLikeCode`。
- 问题：`looksLikeCode` 的正则把所有「大写字母 + 点 + 大写字母」都当成代码（`scratchpad/c1.mjs`：`A.M`、`P.M`、`U.S`、`P.E`、`T.V` 均为 true）。老师自己起的、恰好是缩写的知识点名称（"A.M / P.M"，时间表达是小学英语常见考点）会被静默改成「待命名的考点」，原名丢失，没有备份；之后也无法再把它改回去（名称入口同样拒绝）。循环里是逐个 `UPDATE`，没有事务。
- 缓解：目前"名称就是代码"的节点只可能来自旧版本的采纳 bug，真实命中面很小；`stage-db`（数据包导入）也做同样替换，口径一致。
- 建议：只修"名称与自己的 `code` 相同，或名称恰好等于树里存在的某个节点 / 题型代码"的节点，不看正则；放进一次性标记（像 `crop_refined_v1`）而不是每次启动；改名前把旧名字写进 `kps.note` 或日志；放进事务。

### P2-4　截图框修正：一次性覆盖旧框、不可撤销；`PAD = 0` 让没被修过的框裁得更紧
- 位置：`parse/refine-run.ts:refineAllOnce`、`refinePaperBoxes`；`shared/crop.ts`（`PAD_X = PAD_Y = 0`）。
- 已核对没问题的：老师手画的框（`bbox_source = 'manual'`，由 `questions:update` / 合并时写入）在 `refineBoxes` 里被跳过；`refinePaperBoxes` 读—改—写是同步的，不会和审核页的保存交错；标记 `crop_refined_v1` 在全部扫完后才写，中途退出会重跑（修过的框再修一遍应当稳定，但没有测）；`is_sample = 1` 不动。
- 问题：①覆盖的是 `bbox_json`，原框不留副本。已经在 v10 的库里首次启动新版本时（测试机、内部用户）没有"升级前备份"兜底，只有从 v9 升级的才有。②`PAD = 0` 之后，凡是没被 `refineBoxes` 改过的框（数据包合并导入的别人机器上的卷子、解析时修框失败的、没找到空白的）裁出来比以前更紧，以前 0.4% / 0.8% 的留白正是为这些框准备的；而 `refineAllOnce` 只在本机第一次启动时跑，之后导入的包不会再修。③全库扫描在主进程里逐份同步读图（每份 `setImmediate` 让一次），页数多的大库启动后会有断续卡顿。
- 建议：写 `bbox_json_orig`（或把原框写进 `questions.flags_json`）以便回退；数据包合并导入完成后对新增的卷子也跑一次 `refinePaperBoxes`；`PAD` 保持 0 的前提是"所有框都已修过"，否则对未修的框在 `cropPixels` 里保留一个很小的留白（例如按 `bbox_source` 区分）。

### P2-5　`kpAnalysisBusy` 定义了没接上 `busy.ts`
- 位置：`stats/kp-analysis.ts:134`；`src/main/busy.ts` 只看 `analysisBusy() || reportBusy()`。
- 影响：单考点分析正在流式生成时，覆盖导入数据包 / 更改数据目录不会被拦（提示"有 AI 分析正在生成"那一条对它不生效）；生成结束时 `INSERT OR REPLACE INTO ai_analyses` 会落到换过的库里。
- 缓存 / 取消 / 并发本身没发现问题：`inflight`（按 requestId）和 `busy`（按 scopeKey）都在 `finally` 里释放；`ai:cancel` 现在依次尝试 P2 / P3 / 单考点三套取消；缓存键 `cacheKeys(scopeObject)` 含考点代码和提示词；失败草稿用同一个 scopeKey；`ai:analyzeKp` 在 `WRITE_CHANNELS`、`ai:kpAnalysis` 在 `READONLY_CHANNELS`，`ipc-guard-audit` 通过。
- 建议：`busyReason()` 加上 `kpAnalysisBusy()`。

### P2-6　后台整库扫描用的是开始时的快照，最后一次性写回
- 位置：`parse/similar.ts:scanGen`（先读全部状态 → 内存比对 → 事务里写 `changed`），`similar-runner.ts`。
- 问题：扫描期间（`scanSimilarAsync` 每 12ms 让一次事件循环）老师点了「确实是新卷」（accepted）、删了卷子、或者另一份卷子解析完成触发了 `detectSimilar`，扫描结束时按快照写回，可能把 `accepted` 改回 `suspect`（仅当扫描对该卷的判断发生了变化时）。窗口很小，但之前同步版不存在这个问题。
- 建议：事务内写回前对每个要改的卷子重新读一次 `similar_state`，已是 `accepted` 的跳过。

### P2-7　家长版问候语写死「这次期末英语」
- 位置：`parent-fix.ts:PARENT_GREETING`。
- 筛选条件是期中、单元测验时，家长版开头仍写"期末"。建议按筛选范围里的考试类型生成（或去掉"期末"）。

### P2-8　`stripItemTitle` 会吃掉合理的开头短语；超 300 字只警告
- `stripItemTitle` 的第二个正则把"2–8 个汉字 + 冒号"一律当小标题去掉（`scratchpad/pf1.mjs`：`孩子常错：…`、`注意读音：…`、`例句：…`、`易错点：…` 都被削掉了前缀），多数无害，但会丢掉承上启下的话。
- 超字数的处理：先去例句，再去最后一条，至少留 2 条；如果两条本身就超过 300 字（实测 515 字），不会再处理，只在 finishReport 里加一句警告，家长版仍可确认、复制。建议超过 300 时同样列进 `confirmBlockReason`，或对单条做硬上限。

### P2-9　`topScoreGapWarning` 对"先投"的识别比较脆
- 位置：`report-post.ts:bossPicked`——只认"先投…三块 / 几块 / 其他 / 。"；`k.includes(p)` 用单字做包含判断（`先投入` 会产生 token "入阅读"）。AI 换个说法（"建议优先投入…"）就拿不到 picked，会误报"分值最高的 X 没进先投"。这只是 warnings，不阻断；建议再放宽一点，或在提示词里把句式固定死。

### P2-10　E2E 增量的取舍（审阅结论：合理，附两点说明）
- M3 `PAD` 改成 0：`m3-phases-ui.cjs` 现在断言"容器 = 库里 bbox（误差 < 0.3%）"。与 `shared/crop.ts` 一致，改动合理；缺点是这条检查不再证明有留白，留白现在只靠 `ink.ts` 的单测（`ink-crop`）保证。
- M4 样本提示黄条数量 1 → 0：改成"`report-sample-warning` 为 0 且正文里该句子恰好出现 1 次"。同一个信息仍然只展示一次（挪进了正文开头），原来的"必须出现一条说明"换成"不能出现重复说明"，语义上没有放宽。
- `m3-phases-ai.cjs` / `lib.cjs` / `m4-phases-report.cjs` 的其余改动都是改选择器、期望文案（今年 / 去年及以前、白话报错、折叠后先展开）和版本号，没有发现断言被删、被弱化成恒真。
- 注意：`m3-phases-ai` 的"P2 抽屉"检查名称里仍写"抽屉里的 AI 分析只显示这一小节"，而现在词条抽屉用的是单考点分析（`KpDetailDrawer`）；该检查实际测的是同比页的 `KpDrawer`，不是新抽屉，建议在 `run-m6` 里补一条针对 `kp-detail-ai`（生成、缓存、取消）的 E2E（目前交付说明只记录了真实 AI 抽屉一次，41 秒）。

---

## 重点项逐条回答

1. **`parent-fix.ts` 会不会把正确内容删光？至少留 2 条有没有边界问题？**——会（P1-1）。"至少留 2 条"只约束"超字数后去掉最后一条"这一步；坏条目被整条去掉（`good` 过滤）时可以减到 0 条。同时 `PARENT_MIN_CHARS` 把程序补的问候和结尾也算进去，所以空壳家长版过得了确认。另外校验本身被补句号架空（P1-2）。
2. **老板版规则**：降级断言可用但会产生不通顺的句子（P2-2）；「有 N 处还没核对」这一行只删整行精确匹配的文字，确认时不会误删正文（`b1.mjs`：N→0 删除、0→N 插在"三句话结论"节末、前后各留一个空行都对），但确认后无痕迹（P2-1）；最高分大类检查只是 warning，识别"先投"的方式较脆（P2-9）。
3. **代码过滤**：名称入口拒绝代码样名称（`kpNameProblem`）、数据包导入时把代码名改成「待命名的考点」（`stage-db`）、统计 / 提示词 / 导出 / 建议文字全部过 `safeKpName`、`safeSuggestion`：这些都是对的；启动时 `repairKpNames` **不是一次性迁移，每次启动都跑**，会误改 `A.M`、`P.M` 这类名称，没有备份（P2-3）。
4. **截图框修正**：手画框（`bbox_source = 'manual'`）不会被改；一次性（`crop_refined_v1`）；不可逆，没有原框备份；`PAD = 0` 对未修过的框偏紧（P2-4）。
5. **单考点 AI 分析**：缓存、取消、单请求并发（按 requestId 和 scopeKey 双重去重）都没问题；唯一缺口是没接进 `busy.ts`（P2-5）。
6. **IPC**：新增通道（`ai:kpAnalysis`、`ai:analyzeKp`、`papers:scanSimilarStatus`、`papers:scanSimilar`、`report:removeSentence`、带 `acknowledged` 的 `report:confirm` 等）都已分类，`ipc-guard-audit` 通过；`report:confirm` 的 `acknowledged` 经 zod 限制（≤ 500 条、每条 ≤ 2000 字）。
7. **E2E**：见 P2-10，没有发现放宽。
8. **界面**：`KpDetailDrawer` 逻辑正常（路径 / 数据 / 易错原因 / 题目 / `AnalysisPanel` 的 kp 模式；关掉再开不丢进行中状态）；「交给老师核对」只是把标题、三个要看的点、未核实 / 矛盾句子原文写进剪贴板，没有写库、没有联网，剪贴板失败时退回 `execCommand`；采纳框的后端拒绝原因显示在框内（`kp-approve-error`，打开时清空），但修改名称时不会清掉旧错误，是小问题；家长版确认框现在要求逐句勾选（回应了上次的 N-1），后端 `unacknowledgedSentences` 同步校验。

---

## 读了哪些文件，哪些没读

**读了**：`docs/体验报告/M6/汇总与返工.md`、`docs/M6-功能交付说明.md` §12、`docs/M6-设计系统说明.md` §8.5d；`src/shared/parent-fix.ts`（全文）、`code-guard.ts`、`report-post.ts`（老板版与家长版相关部分）、`factcheck.ts` 的相关部分；`src/main/report/finish.ts`（全文）、`report/service.ts`（`confirmReport`、`removeReportSentence`、`topScoreOf`、`bossSampleLine` 相关）、`db.ts` 的 `initDatabase`、`db-repair.ts`、`db-backup.ts`、`pack/stage-db.ts` / `exporter.ts` / `kp-rules.ts` 的 diff、`parse/ink.ts`、`parse/refine-run.ts`、`parse/similar.ts`（`scanGen` / `scanSimilarAsync`）、`similar-runner.ts`、`stats/kp-analysis.ts`、`ipc/ai.ts` / `ipc/stats.ts` / `ipc/papers.ts` / `ipc-channels.ts` / `preload` 的相关部分、`ai/taxonomy.ts` / `ipc/questions.ts` 的 diff、`shared/crop.ts`；渲染进程 `Report.tsx`、`KpDetailDrawer.tsx`、`AnalysisPanel.tsx` / `analysisStore.ts` 的 diff、`QuestionForm.tsx` 的采纳框；E2E 的 `m3-phases-ui.cjs`（PAD 一处）、`m3-phases-ai.cjs`、`m4-phases-report.cjs`（样本提示两处）、`run-m6.cjs` 的相关段；`tests/unit/parent-fix.test.mjs` 的前半部分。
**临时脚本**（scratchpad，未改项目）：`pf1.mjs`、`pf2.mjs`（家长版边界）、`b1.mjs`（老板版规则）、`c1.mjs`（代码识别误报）。

**没读 / 没验证**：`stats/evidence.ts` 的分值排序改动、`p3_*` / `p2_kp` 提示词正文、`factcheck.ts` 本轮新增的误报修复（引号例句、错误语境）的全部分支、`report/export.ts` / `docx.ts` 的页脚改动、`mdhtml.ts`、`NoticeStack`、设置页和试卷库的设计返工、`tests/unit` 里新增的 `ink-crop`、`stats-name-guard`、`code-guard` 等单测的内容；没有运行单测（除 `ipc-guard-audit`）、E2E、打包；真实 AI 的 r3 家长版只读了成品，没核对原始输出；Word / WPS、Windows 仍未验证。

---

## 复核

> 复核对象：`docs/M6-功能交付说明.md` §12.9 的三审修复。方法：重跑三审的临时脚本 + 新写脚本（`pf3.mjs`、`pf4.mjs`、`k1.mjs`）；跑了 `tsc --noEmit`（node、web 都通过）和 7 个相关单测（`parent-fix`、`report-finish`、`report-post`、`code-guard`、`similar`、`ipc-guard-audit`、`stats-name-guard`，全部通过）。没有跑 build / E2E / dist，没有调用 AI，没有改源码。

### 复核结论：**通过**（没有 P0，没有 P1；两条 P1 都确认已修）

### 一、两条 P1

**P1-1 内容太少被绕过——已修。**
- 重跑 `pf2.mjs`（3 条坏条目 + 通用安慰 / 1 条坏条目 + 通用安慰）：坏条目全部去掉，正文只剩问候和结尾，`confirmBlockReason` 返回「这份家长版只剩 0 条要点（至少要 2 条）……」。
- `pf3.mjs` 走完整 `finishReport` → `confirmBlockReason`：r2 三条坏条目 → 0 条，拦；「两条以「的」结尾的半句 + 一条好的」→ 1 条，拦；「1 条电报 + 1 条好的」→ 1 条，拦；2 条好的、3 条好的 → 放行。
- 三个出口都走同一个把关：`confirmReport`（`service.ts:230`）、`assertExportable`（`service.ts:265`，`report:copyWechat` 和 `report:export` 都调它）、`itemOf.blockReason`（界面置灰）。要点计数用 `parentItemCount`（编号行），字数只数编号要点，程序补的问候和结尾不再撑过 40 字线。
- 附带效果：`removeReportSentence` 把某条删空后条数下降，同样会被拦。

**P1-2 整条校验被补句号架空——已修。**
- `fixParent` 现在先校验模型写的原文，不再给要点补句号（`endWithPeriod` 只用于结尾那句）。`itemProblems` 新增「句末没有标点」「没有一句带动作的完整话」「有一句话没有动作」。
- 复现：「西红柿绵羊：tomato 一个其他多个」「缩写和分类：can not 变 can't」「问 can not，答 can't」→ 三条全部整条去掉；「孩子容易写错 tomato 的」→ 去掉；`pf1.mjs` 的 telegram 用例输出里不再有任何编号要点。
- 反向检查（有没有误删好句子）：`pf4.mjs` 用 7 条自然写法的好要点（带例句、带"在家做"、带标准答案），全部通过；`PREDICATE` 是一个宽松的字符集（要 / 是 / 有 / 不 / 说 / 写……），不会误杀正常句子，代价是挡不住"有动词字但读不通"的句子，可以接受。
- 单测补了端到端：`parent-fix.test.mjs` 用 `tests/unit/fixtures/parent-r2.md`（真实输出）走 `fixParent` / `finishReport`，断言整条去掉并被 `confirmBlockReason` 拦下；`parent-r3.md` 和第一次的 r3 原样放行、不改写、微信字数 ≤ 300。没有看到断言被删或放松。

### 二、新增代码审查

| 项 | 结论 |
|---|---|
| `repairKpNames` 一次性 + 事务 + `kp_names_orig_v1` | **正确。** `k1.mjs`：第一次修了 `RD.U1`（`RD.INFER.OPINION`）和 `GR.U10`（`GR.TENSE.FUT`），`P.M` 不动；原名写进 `kp_names_orig_v1`；第二次返回 0；`BEGIN/COMMIT` 包住所有改名和两个 settings 写入，异常 `ROLLBACK`。`A.M / P.M / P.E / T.V / U.S` 不再被当成代码（识别要求以 GR / FN / LS / MC / PH / RD / VO / WR 开头）。数据包导入由 `stage-db` 在校验前统一换名，口径一致。 |
| `crop_orig_v1` / `restoreOriginalBoxes` | **无 P0 / P1。** 先在内存里算出全部变化，再一个事务里「存原框（只存第一次）+ 写新框 + 写备份」；手画框（`bbox_source = manual`）在 `refineBoxes` 里被跳过；还原时也跳过手画的。见下面的 P2-a / P2-b。 |
| 数据包导入走修框 | **正确。** `data.ts:161`：合并导入用 `report.newPaperIds`（`applyMerge` 在 `COMMIT` 之后才赋值），覆盖导入用 `'all'`（先删 `crop_refined_v1` 再走 `refineAllOnce`）；放在 `applyMerge / applyOverwrite` 成功之后、`void` 后台执行，失败只写日志，不影响导入结果。手画框不动。 |
| 微信超 300 字改成拦截 | **正确。** `confirmBlockReason` 用 `markdownToWechat(markdown, { spaced: true })`（家长版去标记，与 `wechatText` 同口径）数字数，> `PARENT_MAX_WECHAT` 即拦确认 / 复制 / 导出；`fixParent` 仍会先去例句、去最后一条（至少留 2 条）尽量压到 300 以内，所以只有压不下去时才会被拦（我的 515 字两条用例会被拦，文案白话）。副作用见 P2-d。 |
| 扫描写回前逐份重读 | **正确。** `similar.ts` 写回前对每份 `changed` 的卷子重读 `similar_state / similar_to`，与扫描开始时不同、或卷子已不存在就跳过；`accepted` 不会被覆盖。小缺口见 P2-e。 |
| `kpAnalysisBusy` 接进 `busy.ts` | **已接**（`busy.ts:19`）。 |
| 其余（老板版一行改文案并只删该行、问候按考试类型、`stripItemTitle` 不削承上启下的开头、`softenOverclaims` 改整句、`bossPicked` 放宽） | 看了对应单测与实现，没有发现新问题。 |

### 三、新增 E2E / 单测有没有放宽

- `run-m2.cjs` 的「先移开鼠标再取色」：只在取色前加了 `page.mouse.move(0, 0); await sleep(250)`，目的是去掉悬停底色的干扰；断言本身（`bg[1] === --ewb-red-soft 的计算值`、`bg[0] === 'rgba(0, 0, 0, 0)'`）一个字没变，**没有放宽**，反而更稳。
- 本轮改动的单测（`code-guard`、`similar`、`report-finish`、`parent-fix`、`report-post`）都在加严或补用例；`code-guard` 的断言随识别规则改成「`A.M` 等不是代码」，是预期内的改动。没有发现被删除或弱化成恒真的断言。

### 四、仍存在的问题

**P0：无。　P1：无。**

P2（不阻塞）：
- **a.** `restoreOriginalBoxes()` 没有任何调用方（没有 IPC、没有按钮），"可还原"实际只有开发者能用；`crop_orig_v1` 里记着的是修框之前的框，如果之后对同一道题「仅重新定位」（题目 id 不变、框被重新算出），还原会把较新的框盖回旧框。建议要么给它加一个设置页里的入口并在 `locate` 重算时清掉对应备份，要么在文档里写明只用于排查。
- **b.** `crop_orig_v1` 是一整行 settings JSON，题目被删后条目不清理，每修一份卷子都会把整行读出再写回（卷子越多越慢，300 份时可接受，几千份会明显）。建议按卷子拆开存或定期清理已不存在的题目 id。
- **c.** `KP_CODE` 现在只认 8 个内置前缀：AI 编造的不在这个列表里的「代码」（如 `SY.FOO.BAR`）不会被 `safeKpName` / 名称校验当成代码，采纳时可以成为名称、界面上也原样显示（`k1.mjs`：`SY.FOO.BAR`、`U.U1` 均为 false）。报告正文那边的 `stripInternalCodes` 仍是宽松匹配，所以只影响审核页 / 设置页。可以接受，建议在 `approveSuggestion` 里额外拒绝「全大写 + 点 + 无汉字」形态的名称。
- **d.** 超过 300 字改成拦截以后，旧版本已经「我已核对」的长家长版，导出 / 复制也会被拦，老师需要重新生成；文案已经写明原因，但应在升级说明里提一句。
- **e.** 扫描写回时，如果判断依赖的"对方卷子"在扫描期间被删，`similar_to` 可能写成一个已不存在的 id（界面显示"另一份已有的卷子"）；影响很小，下一次扫描会自己纠正。
- **f.** 导入后的后台修框（`refineImported`）不在 `busyReason()` 里：它跑的时候再触发覆盖导入 / 更改数据目录不会被拦，修框是按 `getDb()` 取库的，会写到新的库里（`refineAllOnce` 只在 `crop_refined_v1` 缺失时跑，所以后果有限）。建议给它一个 busy 标志。

### 五、复核读了什么

`docs/M6-功能交付说明.md` §12.9；`src/shared/parent-fix.ts`（`fixParent`、`itemProblems`、`PREDICATE`）、`report-post.ts`（`confirmBlockReason`、`parentItemCount`）、`code-guard.ts`；`src/main/db-repair.ts`、`db.ts`（`initDatabase` 调用处）、`parse/refine-run.ts`（全文）、`ipc/data.ts` 导入段、`pack/apply.ts` 的 `newPaperIds`、`parse/similar.ts` 写回段、`busy.ts`、`report/service.ts` 的三处把关；`tests/e2e/run-m2.cjs`（取色段）、`tests/unit/parent-fix.test.mjs`（r2 / r3 回放部分）；脚本 `pf2/pf3/pf4/k1`。
未读：本轮对 `finish.ts` / `service.ts` 里其余文案改动的细节、提示词正文变化、`similar.test` / `code-guard.test` 的全部用例、真实 AI 输出。
