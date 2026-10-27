# M6 代码审核（Sonnet 全新上下文，只读）

> 审核范围：工作区相对 HEAD 的未提交差异（`git diff HEAD` 加未跟踪文件，约 178 个已跟踪文件 + 新文件）。
> 方法：读文档 → 读源码 → 对可疑点在 scratchpad 里写小脚本直接调用 `src/` 里的纯函数复现（没有改任何项目文件，没有启动应用，没有调用 AI）。另跑了 `tsc --noEmit`（node + web 两个工程），都通过。
> 不运行 E2E / build / dist。

## 结论：**不通过**

- P0：0 条
- P1：5 条
- P2：14 条

没有发现会破坏数据、泄漏密钥或崩溃的 P0。5 条 P1 都是「功能和承诺不一致」：其中 3 条是 M6 最核心的两个卖点（事实核对、重复卷提醒）在常见情形下失效，1 条是真实推理模型下 P1 解析的超时，1 条是给家长的 Word 导出的格式风险。

---

## 一、P1（功能错误或用户会明显受影响）

### P1-1　P1 解析是非流式调用，超时是「总时长」而不是「空闲时长」；32768 上限下推理模型很容易先超时
- 位置：`src/main/ai/client.ts:126-130`（`timer` / `bump`，只有流式分支在收到数据时 `bump()`）、`src/main/parse/run.ts:228-231`（`timeoutMs: cfg.timeout_sec * 1000`，默认 180 秒，`src/main/ai/types.ts` 的 `DEFAULT_AI_CONFIG.timeout_sec`）。
- 触发场景：deepseek-v4-pro 这类先思考再作答的模型解析多页卷子。非流式时，从发出请求到服务端回完整 JSON 之前，没有任何数据到达，180 秒一到就 `timeout`。M6 把输出上限从 8192 提到 32768，一次调用的时长随之变长；交付说明里实测的 P2 用了 149 秒、11450 token，还是流式的。P1 的真实调用一次都没测过（§5 的三次是 P2、家长版、老师版）。
- 后果：`timeout` 属于可重试错误，会连续 4 次（1 次 + 3 次重试）各等 180 秒，约 12 分钟后才报「AI 等了太久没有回应」。体验报告里「干等 3 分钟、报错看不懂」的问题换了一种形式回来；而且新加的「length 自动翻倍」在这条路径上永远轮不到，因为总是先超时。
- 建议：
  1. P1 也改成流式（或者至少对 `reasoning` 模型用流式只为保活），让 `bump()` 生效；
  2. 或者对推理模型把非流式的总超时放到 `max(timeout_sec, 600)`；
  3. 补一次真实 P1 调用（≤1 次）验证。

### P1-2　事实核对很容易被换个说法绕过，「宁可多标也不漏标」与实际不符
- 位置：`src/shared/factcheck.ts:26-29`（`REL_RE` 的连接词表、`CUE_RE` 的口气词表）、`:95-100`（`isRuleSentence`）、`:136-167`（`checkRules` 的第二步按词语覆盖率判定）。
- 复现（证据 = `time for 后接名词，time to 后接动词原形`、`tomato 的复数加 -es`）：

  | 句子 | 结果 |
  |---|---|
  | `time for 后接动词` | 标「矛盾」（单测覆盖的就是这种） |
  | `time for 后面要接动词，孩子容易错` | **不标** |
  | `time for 加动词` | **不标**（不被当成规则句，没有口气词） |
  | `time for 要接动词` / `time for 之后要用动词原形` | **不标** |
  | `time for 的后面应该跟 doing` | **不标**（词语覆盖率 ≥ 0.6 且有一条证据提到 time，直接放行） |
  | `tomato 的复数加 -s`（把 -es 写成 -s） | **不标** |
  | `time to 后接名词，如 time to lunch` | 标「矛盾」 |

- 后果：A3 要拦的就是 time for / time to 这种错。模型换一句「后面要接」就过关了，而且报告里「未核实 0 句」会让老师以为已经全部核对过。交付说明 §7.3 写「它宁可多标也不漏标」，与上面的结果相反。
- 建议：
  1. 对证据里出现过「英文固定搭配 → 词类」关系的短语（`time for` / `time to` 等），句子里只要出现该短语又出现任何词类词（名词 / 动词 / 动名词 / doing），不管连接词是什么，一律走词类比对；
  2. 「覆盖率放行」改成：规则句里凡是英文词语在证据里**没有出现在同一条证据子句里**的，一律标「未核实」；
  3. 把上表的句子全部加进 `tests/unit/factcheck.test.mjs`，作为必须被标记的负面用例。

### P1-3　家长版：矛盾句有时删不掉，但提示却写「已从家长版里删掉」，正文里也没有标记
- 位置：`src/main/report/finish.ts:42-46`、`src/shared/factcheck.ts:36-42`（`plainLine` 把引用 token / `〔…〕` / 反引号抠掉后才切句）和 `:206-219`（`removeSentence` 按原行子串查找）。
- 复现：家长版原文 `1. 练习 It's time for 后接[2025卷 · 7]动词原形，孩子容易错。`
  - `checkRules` 找到矛盾句，但句子是抠掉了 `[2025卷 · 7]` 之后的文字，在原行里不是连续子串，`removeSentence` 什么也没删；
  - `warnings` 里照样写「有 1 句……矛盾，已从家长版里删掉」；
  - 最后 `markFindings` 同样按子串找，也找不到，所以正文里连「〔与题目解释矛盾〕」标记都没有。
  - 结果：写反的规则原样留在家长版，没有标记，提示还说已经删了。
- 家长版提示词没有要求写引用，所以概率不高，但模型偶尔会带上引用；一旦发生就是把错话发给家长。
- 建议：
  1. `removeSentence` / `markFindings` 改成按「去掉了 Markdown 和引用之后的文字」做字符偏移映射，或者让 `checkRules` 同时返回命中句在原行里的起止位置；
  2. 删除后再跑一遍 `checkRules`，仍有 conflict 就不要写「已删掉」，而是把这份家长版标成不可核对通过（`needsConfirm` 之外再加「含矛盾句」，确认框里必须勾选）；
  3. 单测补一个「引用在句子中间」的用例。

### P1-4　疑似重复检测只看「新卷包含在旧卷里」：先导入第 1 页、后导入整卷时，被排除的是整卷
- 位置：`src/main/parse/similar.ts:62-80`（`findSimilar`，`ratio = inter / target.keys.size`）、`:93-110`（`detectSimilar` 只标新卷）。
- 复现（用 `tests/unit/fixtures/g4-papers.json` 的真实题目）：旧卷 = 第 1 页（22 个有效题目键），新卷 = 整卷（33 个）：
  - 年级、学年都读出来且一致 → `ratio = 0.67`，命中「同年级同学年 ≥ 0.5」，**整卷被标成 suspect 并从统计里排除**，提示还写「像是《第 1 页》的一部分」（方向反了）；而残缺的第 1 页被计入统计；
  - 卷头信息没读出来 → 两边都不标，两份都计入，等于重复计数。
- 后果：体验报告问题 4 的原场景只修了一个方向；反过来（运营先传了照片，之后又传整份 PDF）会把完整的卷子悄悄排除掉。代码注释写「反过来的情况不标，见交付说明」，但 `docs/M6-功能交付说明.md` 里并没有这一条（全文搜索 `反过来` 无结果）。
- 建议：
  1. 同时算 `ratio`（新含于旧）和 `reverse`（旧含于新）；当 `reverse ≥ 0.8` 且新卷明显更大时，标记的应当是**旧卷**（或者两边都给提示，让老师选留哪份），不要只拿新卷开刀；
  2. 文案按方向分别写「像是《X》的一部分」与「包含了《X》」；
  3. 交付说明补上这个限制，单测补「先局部后整卷」的用例。

### P1-5　手写 OOXML 的元素顺序和缺 `tblGrid`：只用 mammoth 读回过，没在 Word / WPS 验证
- 位置：`src/main/report/docx.ts:60-64`（`para()` 里 `<w:ind>` 写在 `<w:spacing>` 前面）、`:84-86`（`<w:tbl>` 只有 `tblPr`，没有 `tblGrid`）。
- 问题：按 ECMA-376，`w:pPr` 的子元素顺序是 `…pBdr, shd, …, spacing, ind…`，这里 `ind` 在 `spacing` 前，**所有列表项（indent = 360）都是这个顺序**；`w:tbl` 里 `tblGrid` 是必需子元素。mammoth 对顺序和缺项很宽容，所以「mammoth 能读回」不能证明 Word 能打开；Word 对元素顺序较严格，可能弹「发现无法读取的内容」。家长版最终多半就是导 Word。交付说明 §2 C 行和 §7.1 自己也承认没在 Word / WPS 里打开过。
- 建议：把 `ind` 挪到 `spacing` 之后；表格补 `<w:tblGrid>`（按列数平分）并给每个 `w:tc` 加 `w:tcW`；在 Windows 的 Word 和 WPS 各打开一份含列表、表格、截图的样本验证；发布前这是必做项。

---

## 二、P2（体验或可维护性）

### P2-1　家长版可能变成空报告，仍能「我已核对」并复制
- 位置：`src/main/report/finish.ts:48-52`、`src/shared/report-post.ts:104-118`（`PARENT_BANNED` 含 `难点|样本|统计|同比|重点知识` 等很宽的词）。
- 复现：模型写 `这是孩子的难点，统计显示样本较少。` 之类两句话，`sanitizeParent` 全删，`finishReport` 得到只有标题的正文 `# 标题\n\n`，只多一条「家长版内容很少」警告；报告照样入库，`needsConfirm` 为真，老师点「我已核对」后可导出、复制到微信（只有标题一行）。程序写的标题没被删，是对的。
- 建议：删完后正文 < 40 字时不入库，按失败处理（返回白话错误 + 保留草稿），而不是仅警告；把 `难点` 这类单词从 `PARENT_BANNED` 里拿掉，只拦统计词和百分比。

### P2-2　复制到微信会把「未核实」标记静默去掉；而导出的 Word / PDF 里标记又原样留着，应用里又没有编辑入口
- 位置：`src/main/report/service.ts:202-204`（`wechatText` 先 `stripMarks`）、`src/shared/report-post.ts:128`；`src/renderer/pages/Report.tsx` 的确认框文案「改掉不对的地方」。
- 问题：报告正文没有编辑功能，老师「改掉」无从谈起；点「我已核对」后，复制出去的纯文本里 unverified 句子没有任何标记（E2E 还专门断言了没有 `〔未核实〕`），而 Word / PDF 里家长会看到 `〔未核实〕`。两个出口口径不一致。
- 建议：确认框里列出的未核实句子要求逐条勾「已确认无误」或「已删除」，并提供「从家长版里删掉这一句」按钮（后端据此改 markdown 再存）；有 conflict 时禁止确认。

### P2-3　docx 转义漏掉 U+FFFE / U+FFFF，会生成非法 XML
- 位置：`src/main/report/docx.ts:21`（`esc` 只剔除 `\u0000-\u0008\u000b\u000c\u000e-\u001f`）。
- 复现：正文含 `￿` 或 `￾`，用 `xmllint` 检查 `word/document.xml` 报 `Char 0xFFFF out of allowed range`（`& < > " ` 和 0x00–0x1F 控制字符的转义是对的，孤立代理项会在写入时被替换成 U+FFFD，不会出错）。
- 触发概率很低（OCR 乱码或模型异常输出），但一份坏文件就是「打不开的家长报告」。建议正则补上 `￾￿`，并在 `buildDocx` 末尾对 `document.xml` 做一次非法字符断言。

### P2-4　迁移 v10 没有升级前备份；有不可逆的数据改写；依赖会变化的代码
- 位置：`src/main/db.ts:393-425`（v10）、`:540-553`（`runMigrations`）。
- 已核对：v1–v9 与 HEAD 逐字一致（`git diff HEAD -- src/main/db.ts` 只有新增行，没有 `-` 行）；每步一个事务，`ALTER`、触发器重建、`PRAGMA user_version` 都在事务里，失败会 `ROLLBACK`，`addCol` 幂等。新字段默认值合理（`reports.reader` 默认 `full`、`confirmed_at` 为空、`similar_state` 为空、`max_tokens_auto` 按旧值迁移）。
- 问题：
  1. 升级前没有拷贝数据库。v10 会直接改写 `questions.bbox_json`（`repairNeighborEdges`，非手工框），失败回滚但成功后不可逆。若这套收缩算法对两栏试卷有误判（本题和右边另一栏的题被判成「同一行」，被缩到另一栏前面），老师只能手工重画；
  2. 迁移里调用的是当前的 `repairNeighborEdges` / `KP_PLAIN`，以后谁改了这两个函数，v10 对还没升级的库的行为就变了，迁移应该冻结当时的逻辑；
  3. 旧库里已有的重复卷不会被检测（`detectSimilar` 只在解析结束时调用），体验报告里的「3 份卷子、基线被扭曲」在升级后的真实数据上依然存在，直到老师重新解析。
- 建议：`initDatabase` 在 `currentVersion < target` 时先把 `ewb.db`（含 `-wal`）拷成 `backups/pre-v10-<时间>.db`；v10 的框修复挪到迁移外、做成可撤销的读取时修正（或在迁移里内联冻结算法）；在「关于」里加「检查重复试卷」按钮，对已有卷子补跑一遍 `detectSimilar`。

### P2-5　输出上限：「自动」按名字猜模型，猜错首个请求就 400，手填值也会被自动翻倍突破
- 位置：`src/main/ai/providers.ts:62-95`（`REASONING_NAME_RE` 含 `deepseek-v\d`、`o[134]`、`think`；`effectiveMaxTokens`）、`src/main/ai/client.ts:302-322`。
- 问题：
  1. 自定义服务商里填 `deepseek-v3.1` 之类、名字命中正则但服务商输出上限只有 8K 的模型，自动模式首个请求就发 `max_tokens: 32768` → 400「AI 拒绝了这次请求」。只有「翻倍之后」的 400 才有回退，首个请求的 400 没有（对 `response_format` 和 `temperature` 倒是有）；
  2. 管理员关了「自动」手填一个小值（例如为了控制费用），`ceiling = max(模型天花板, 手填值)`，遇到 length 仍会翻倍到模型天花板（65536），手填值只是软上限，设置页文案应说明，或者手动模式不翻倍；
  3. 翻倍重试使一次调用的最长时间约翻倍，界面进度条封顶 95% 且写「通常 2–3 分钟」，没有整体墙钟上限。`deepseek-v4-pro` 的 `ceiling: 65536` 是估计值，交付说明没有说明来源。
- 优先级结论（自动 vs 手填）：自动开时完全忽略 `max_tokens` 里的数；自动关时用手填值，天花板不低于手填值——这个行为本身自洽，也有迁移保护（旧默认 8192 → 自动，其余数值 → 手动）。
- 建议：首个请求遇到 400 且报错含 `max_tokens` 时，先降到 `defaultMaxTokens` 的一半或 8192 再试一次；手动模式下 `escalateOnLength` 不启用；加一个 15–20 分钟的整体上限。

### P2-6　疑似重复的提示口径和边界
- 位置：`src/main/stats/core.ts`（`scopeNotes.similarSuspects`）、`src/renderer/stats/Parts.tsx:36`、`src/renderer/components/SimilarNotice.tsx:10-14`。
- 问题：
  1. `similarSuspects` 是全库计数，不跟随年级 / 学期 / 学年筛选，也不管 `includeReviewing`：看五年级报告时会提示「有 1 份四年级疑似重复卷没计入」；
  2. 界面的 `similarSentence` 永远写「像是《X》的一部分」，主进程 `similarText` 才区分「基本一样」；
  3. 原卷被删后，剩下的 suspect 卷永远被排除，提示里只写「另一份已有的卷子」，老师不知道为什么；应当在 `papers:remove` 里把指向被删卷的 `similar_state='suspect'` 清掉或重新检测；
  4. 统计页提示没有说明「打开『包含重复导入』也能计入」；
  5. 阈值写死（0.8 / 0.5 / 0.3），交付说明已承认是经验值。
- 默认不计入统计的做法本身没问题（偏保守）：试卷库行内有「疑似重复」标签，每个统计页顶部有说明，试卷库和统计的差额能解释，上面第 1 点是例外。

### P2-7　A4「不误伤」的 E2E 检查是空转的
- 位置：`tests/e2e/run-m6.cjs` 的 `A4 不误伤`。
- 夹具里 23 份卷子的题干是 `Q-n 题干` 这类占位文字，规范化后不足 `MIN_KEY_CHARS = 8`，题目键为空，根本没有参与比较，所以「没有被误标」永远成立。单测 `similar.test.mjs` 用真实卷子文字，覆盖了这个风险，E2E 这条只是摆设；建议用真实长度的题干，或者删掉这条以免误导。

### P2-8　E2E 改动：有一条断言变成恒真，一条被放松；文档与事实不一致
- `tests/e2e/run-m2.cjs`（约 747 行）：「进入审核页后主侧栏自动收起」改成「侧栏宽度 < 100px」。新侧栏恒为 84px，在任何页面都成立，这条断言已经不再检验审核页的任何行为（恒真）。建议改成在审核页检查 `.ewb-main` 宽度 ≥ 某值，或者直接删掉这条并说明行为已取消。
- 同文件（约 715 行）：「标黄的题背景是 rgb(255,251,230)」改成「红色通道在 200–259 且和普通题不同」，范围比原来宽（任何偏红 / 橙 / 黄的颜色都过）。设计上换色可以接受，但应收紧到设计令牌的实际值（`--ewb-red-soft` 的计算值）。
- 其余改动逐条核对过，属于改选择器 / 期望文案 / 版本号：`launch` 里把 `admin_open` 设为 true、`stat()` 读取方式、`dropFiles` 先 `scrollIntoView`、v9→v10、提示词版本 v1.1→v2.0、AI 失败场景改成「白话在 `error`，技术原因在 `error_detail`」（密钥脱敏检查还多检查了 `error_detail`，是加强）。没有发现断言被整条删除，检查项总数（52 / 155 / 159 / 175）不变。
- 文档不一致：`docs/M6-功能交付说明.md` 开头说「没有改 `package.json` 的依赖」「`smoke-packaged.cjs` 我没有运行也没有改它」，但实际 `package.json` 新增了 `lucide-react`、`@fontsource-variable/source-sans-3`，版本升到 1.1.0，`smoke-packaged.cjs` 的读数选择器被改（设计说明 §8.3 倒是写了）。发布说明里要统一。

### P2-9　`questions:confirmPaper` 悄悄清空 `ai_meta_json`，两份交付文档都没写
- 位置：`src/main/ipc/questions.ts:283`。
- 整份确认后「AI 猜测」标签消失（设计意图合理），但这是不可逆的数据改写：之后「重新打开」或重新解析，系统就不知道哪些字段原本是 AI 填的，`pickPrefill` 会把它们当成老师填的而不覆盖。需要在交付说明里记一笔，并加一条单测（目前没有任何测试覆盖这个副作用）。

### P2-10　证据包可能包含未经审核的 AI 易错说明
- 位置：`src/main/stats/evidence.ts:52-70`（`scope.where` 沿用统计范围）。
- 打开「含待审核」时，范围内未审核卷子里 AI 自己写的 `error_reason` 也会进入「老师审核过的题目解释（证据）」，事实核对就变成了自己核对自己。建议证据只取 `papers.status='done'` 的卷子，无视 `includeReviewing`。

### P2-11　`stripInternalCodes` 会删掉正文里的大写单词
- 位置：`src/shared/report-post.ts:62-83`（`single` 取全部单段大写代码，含题型码 `MATCH` `ORDER` `OTHER` `FORM` `FILL` `WRITE` 等，按整词匹配删除）。
- 例句或题干摘录里出现全大写的 `MATCH`、`ORDER` 就会被吞掉。建议只在「｜」前后、表格代码列、括号里这些明确的位置去代码，不要对整行做裸词替换。

### P2-12　构建产物里带进了设计过程和预览资源
- `src/renderer/index.html:15-22` 的 THESIS / OWN-WORLD / FINISH 注释（含「用户在方向页选定 Build this」「种子 ba0d512d」）会随安装包发给所有用户；设计说明 §8.1 说是为了让构建产物 grep 得到，建议改成只留一行版本标记。
- `/design/*` 预览路由（`App.tsx`）在正式版里也能通过 `#/design` 打开，附带 `sampleData` 与 10 张 `real-q-*.png`（看起来是真实原卷的裁切），建议只在开发构建里挂这个路由，确认图片没有版权 / 学校信息问题。

### P2-13　`ai_drafts` 的生命周期没处理完
- `src/main/pack/apply.ts:386` 覆盖导入时清了 `reports` / `ai_analyses`，没清 `ai_drafts`（旧草稿会出现在新数据的范围里）；`deleteReport` 也不清对应草稿。草稿不是有效结果、也不能导出，所以只是显示上的杂质，顺手清掉即可。

### P2-14　流式读取没有在 finally 里释放 reader
- `src/main/ai/client.ts:198-250`：超时 / 取消时靠 `AbortController` 终止连接，这是够用的；但 `handleLine` 内部若抛错（比如 `onDelta` 回调异常）reader 不会被 `cancel()`。无泄漏的实证，建议 `finally { reader.cancel().catch(()=>{}) }` 作为保险。

---

## 三、按审核重点逐项的结论

1. **AI 调用稳定性**
   - 无无限重试：`escalated`、`emptyRetried`、去 `response_format`、去 `temperature` 各最多一次；网络类重试受 `maxRetries`；`attempt--` 只在这些一次性分支里用。
   - 超时计时器：`once()` 的 `finally` 里 `clearTimeout`；流式 `bump()` 重置；P1 的 `setInterval` 在 `finally` 里清掉；`createStream.dispose()` 在 `finally` 里；P3 / P2 的 `inflight`、`busyScopes`、`offGone` 都在 `finally` 里释放，没有计数泄漏。
   - 问题见 P1-1（非流式超时）、P2-5（自动 / 手填、翻倍、400 回退）。
2. **分读者报告和事实核对**：问题见 P1-2、P1-3、P2-1、P2-2、P2-3、P2-10、P2-11。「我已核对」前的出口：后端 `assertExportable` 同时挡住 `report:export`（md / pdf / docx）和 `report:copyWechat`，界面按钮置灰只是第二道，这一点是对的；没有找到绕过路径（报告页本身的文字仍可以手动选中复制，这无法避免）。程序写的标题和（非家长版的）样本提示在 `sanitizeParent` 之后才加，不会被家长版净化删掉；家长版不加样本提示，是设计选择。
3. **迁移 v10**：见 P2-4。v1–v9 未动；可回滚；新字段默认值合理；缺备份、不可逆框修复、未回扫已有重复卷。
4. **疑似重复卷**：见 P1-4、P2-6、P2-7。阈值逻辑在单向场景下正确且有真实数据单测。
5. **IPC 安全**：新通道 `ai:modelProfile`、`papers:acceptSimilar`、`report:confirm`、`report:copyWechat`、`report:reveal` 都已在 `ipc-channels.ts` 分类，`ipc-guard-audit` 的规则满足；`reveal` 只认本次运行里 `report:export` 成功写出的绝对路径（`exported` 集合），页面脚本传任意路径返回 `false`，不能打开任意路径；设置白名单新增的 4 个键各有类型校验（布尔 / `ops|tutor`）；`ai_key_enc` 没有出现在新增的任何日志、`detail`、数据包（settings 白名单之外全删）、剪贴板路径里，`statusError` 先脱敏再截断，`error_detail` 的 E2E 也检查了密钥不泄漏。`papers:acceptSimilar` 没放进 `EXPORT_BLOCKED`，但它只改一列，不影响导出，可以接受。
6. **渲染进程 UI**：用脚本对比了 `data-testid` 的增删：只有 `badge-queue` / `badge-review`（挪到 `design/DesignShell.tsx`，仍在）和 `recent-${id}`（挪到 `Overview.tsx`，仍在），没有真正丢失；`useBoolSetting` 等 hook 没有违反 hooks 规则（`SimilarNotice` 先调 hooks 再早退）；页面里没有硬编码颜色（仅 `page-review.css` 原卷纸上两个固定色，设计说明已写明）；主题切换通过 `ThemeProvider` 统一。我没有逐个比对全部 40 多个页面文件的条件渲染，抽查了 `Report.tsx`、`QueuePage.tsx`、`QuestionForm.tsx`、`ReviewPage.tsx` 的保存 / 提示逻辑，没有发现写反或遗漏。
7. **E2E 放宽**：见 P2-8，其余改动属于选择器 / 文案 / 版本号。

## 四、读了哪些文件，哪些没读

**读了（全文或相关 diff）**
- 文档：`docs/体验报告/汇总与改进方案.md`、`docs/M6-功能交付说明.md`、`docs/M6-设计系统说明.md`（含第八节）。
- 主进程：`src/main/db.ts`（v10 全部、`runMigrations`）、`ai/client.ts`、`ai/stream.ts`、`ai/drafts.ts`、`ai/friendly.ts`、`ai/chunk.ts`、`ai/providers.ts`、`ai/types.ts`、`ai/config.ts`（相关部分）、`ai/prompts.ts` / `prompt-rules.ts` / `taxonomy.ts` 的 diff、`ai/prompts/p3_parent.*`、`ipc-channels.ts`、`ipc/ai.ts` / `report.ts` / `papers.ts` / `questions.ts` / `settings.ts` / `taxonomy.ts` 的 diff、`preload/index.ts` 的 diff、`report/service.ts`、`report/finish.ts`、`report/docx.ts`、`report/export.ts` diff、`parse/run.ts` / `parse/queue.ts` / `parse/similar.ts`、`pipeline/queue.ts` diff、`stats/analysis.ts` diff、`stats/evidence.ts`、`stats/core.ts` / `filter.ts` / `p3-collect.ts` diff、`pack/*` 的 diff、`taxonomy/edit.ts` diff、`busy.ts`。
- 共享：`src/shared/factcheck.ts`、`report-post.ts`、`crop.ts`。
- 渲染进程：`pages/Report.tsx`、`pages/QueuePage.tsx`、`pages/review/QuestionForm.tsx`、`pages/review/ReviewPage.tsx`（前 200 行）、`components/SimilarNotice.tsx`、`RoleGuide.tsx`、`Plain.tsx`、`AppLayout.tsx` diff、`hooks/useElapsed.ts`、`useUiPrefs.ts`、`pages/Help.tsx`、`stats/Parts.tsx`（相关部分）、`stats/reportStore.ts` / `analysisStore.ts` diff、`App.tsx` / `main.tsx` / `index.html` diff；对全部 `src/renderer` diff 跑了 `data-testid` 增删对比脚本，以及硬编码颜色扫描。
- 测试：`tests/e2e/` 下全部已修改文件的 diff（`lib.cjs`、`run.cjs`、`run-m2.cjs`、`m3-phases-ui.cjs`、`m3-phases-ai.cjs`、`m4-lib.cjs`、`m4-phases-data/report/tax.cjs`、`smoke-packaged.cjs`）、`run-m6.cjs` 的检查项清单、已修改单测的 diff、`similar.test.mjs`、`report-finish.test.mjs` 开头、`ipc-guard-audit.test.mjs`。
- 命令：`git diff HEAD`（各文件）、`git status`、`tsc --noEmit -p tsconfig.node.json` 与 `tsconfig.web.json`（都通过）；另在 scratchpad 里写了 4 个只读复现脚本（家长版净化、docx XML 良构、事实核对措辞、疑似重复方向）。

**没读 / 只扫了一眼**
- `src/renderer/design/**`（设计系统本身，只看了 `index.html` 引用、颜色扫描、资源列表）。
- 渲染进程里 `Overview.tsx`、`PaperDetail.tsx`、`PaperLibrary.tsx`、`DistributionTab.tsx`、`CompareTab.tsx`、`HotTab.tsx`、`KpDrawer.tsx`、`Settings.tsx`、`AiSettings.tsx`（仅看了输出上限相关行）、`DataSettings.tsx`、`TaxonomySettings.tsx`、`Onboarding.tsx`、`StatsFilter.tsx`、`Treemap.tsx`、`MarkdownView.tsx` 等只做了 testid / 颜色 / `key` 的机械扫描，没有逐行审条件渲染。
- `src/main/seed/kp-plain.ts` 的 145 条白话内容（内容准确性需要英语老师过）、`shared/glossary.ts` / `roles.ts` / `plain-text.ts` / `consistency.ts` 的文案。
- 其余提示词文件（`p3_boss` / `p3_teacher` / `p1_*` / `p2_*`）的正文，及 `docs/prompts/v2-*.md`。
- `tests/mock-ai/*`、`tests/unit` 里除上述外的新增单测（`ai-reasoning`、`crop`、`m6-data`、`pack-plain`、`m6-text`、`factcheck` 的全文），没有逐条核对，也没有运行单测和任何 E2E。
- 没有在 Windows、Word、WPS 上验证任何东西；没有碰真实用户数据目录；没有调用 AI。
