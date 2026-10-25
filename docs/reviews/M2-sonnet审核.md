# M2 里程碑审核报告

- 审核人：Sonnet 5.5（只读，除本文件外未改动任何文件；未运行 E2E、未调用任何真实网络 API、未执行 git 写操作）
- 对象：`/Volumes/Elements/Claude/english-exam-workbench/`，工作区相对 `7211fc1` 的全部未提交改动（18 个已修改文件 + 未跟踪的 `src/main/ai|parse|seed`、`ipc/{ai,parse,questions}.ts`、审核页/队列页/AI 设置页、`tests/{mock-ai,real-ai}`、`tests/e2e/{lib,run-m2}.cjs`、4 组新单测）
- 对照：`docs/设计方案.md`（§3、§5、§6、§7、§9）、`docs/prompts/v1-sonnet改写.md`（P1 文本/视觉版与 §七）、`docs/M2-交付说明.md`、`docs/reviews/M1-sonnet复审.md`（格式）
- 已做：通读 M2 全部新增/修改的 `src/**`；通读 `tests/e2e/run-m2.cjs`、`lib.cjs`、`tests/mock-ai/server.cjs`、`tests/real-ai/run.cjs`、4 组新单测；运行 `npm run typecheck`（通过）和 `npm run test:unit`（6 组全过）；用交付说明里的 `scripts/extract-prompts.cjs` 逻辑把 `docs/prompts/v1-sonnet改写.md` 重新抽取到临时目录，与 `src/main/ai/prompts/*.txt` 逐文件 diff（8 个全部一致）；核对 `tests/e2e/last-result-m2.json`（109 项全过）和 `last-result.json`（52 项全过）。
- 未做 / 无法做：没有跑 GUI 和 E2E，没有 Windows 环境，没有真实 API；凡标「推断」的都是读代码推出来的，没有实际复现。

---

## 一、总体结论

**不通过（需修 P1）。P0 = 0，P1 = 5，P2 = 24。**

M2 的主体质量不错：密钥边界做得比任务书要求的更严；v5 迁移增量、在事务里、v1–v4 原样未动；P1 提示词与 docs 逐字一致；校验/重试/拆批/跨批合并的状态机逻辑清晰，单测和 E2E 都是真功夫，不是摆设。没有发现会泄露密钥、破坏已有 v4 数据或让队列卡死的问题。

不通过的原因是 5 个会让用户丢数据或遇到明显功能缺陷的 P1：
1. 重新导入同一文件会静默删除「AI 解析失败」的试卷（含已审核的题目）；
2. 没配 AI 时，队列页的「重试（重新提取）」被「尚未配置 AI 服务」挡住；
3. 审核页「与下一题合并」后表单仍显示合并前的旧内容，随后改选项会把旧选项写回库；
4. 跨批续写题依赖模型自觉设置 `continued_from_prev`，漏设时残缺题被保留、完整题被丢弃，而且没有任何标记；
5. 密钥「不改发」守卫在已存地址为空时失效。

另外交付说明里有 9 处 ✅ 与实际不符或没有自动化验证支撑，见第四节。

---

## 二、重点核查十项：逐条判断

| # | 项 | 判断 | 依据 |
|---|---|---|---|
| 1 | 安全 | **基本通过，1 个守卫漏洞（P1-5）** | 见下 |
| 2 | 数据库 | **通过** | 见下 |
| 3 | 解析流水线 | **主体通过，3 个问题（P1-4、P2-9、P2-10）** | 见下 |
| 4 | 提示词 | **通过** | 见下 |
| 5 | 审核页与队列页 | **有 2 个 P1（P1-2、P1-3）** | 见下 |
| 6 | 跨平台 | **应用代码通过；测试套件有 mac 专属假设（P2）** | 见下 |
| 7 | 测试可信度 | **总体可信，有若干「配合」与未覆盖项** | 第五节 |
| 8 | 真实 API 入口 | **通过，有 3 个小问题（P2）** | 见下 |
| 9 | .gitignore | **不完整（P2）** | 见下 |
| 10 | 预设 | **DeepSeek 正确；其余家需人工核对** | 见下 |

### 1. 安全

- **API Key 只经 safeStorage**：`ai/secret.ts:13-23` 加密后 base64 存进 `settings.ai_key_enc`；不可加密时只留在内存（`:19`），不落盘。明文只在主进程（`secret.ts`、`client.ts:120` 的 Authorization 头、`config.ts:78/98`、`run.ts:137/195`）。`grep apiKey|getApiKey|Authorization|safeStorage src` 没有第二处。
- **不进入渲染进程**：`ai:getConfig` 只返回 `hasKey/keyStorage`（`config.ts:22-25`）；preload 没有任何读密钥方法；`settings:get/set` 改成读写都走白名单（`ipc/settings.ts:8-13`），`ai_key_enc`/`ai_config` 不在其中。M1 遗留的「`settings:get('ai_api_key')` 能读回」确实收掉了。E2E `密钥安全` 7 项包含扫描 DB/WAL/DOM/localStorage/控制台，证据有效。
- **不进日志**：`ai|parse|ipc` 下所有 `console.*` 都只打印 `(e as Error).message`，不含请求头/请求体。401 的错误文案不带响应片段（`client.ts:78`）。
- **不进数据库明文**：`ai_config` 无密钥；`ai_usage/parse_runs/papers.error` 只有模型名、token 数、中文错误。仍有一个小口子：400 之类的错误文案会带服务商响应前 160 字（`client.ts:83`），并写入 `papers.error`/`parse_runs.error`。若某家服务商在 400 里回显鉴权信息就会落库/上屏。见 P2-2。
- **改服务地址阻止旧密钥外发**：`config.ts:38-41` 要求「改 origin 必须同时重输密钥」，`:82-84` 让测试也不借用旧密钥；E2E 两条路径都验证。**但守卫在已存 `base_url` 为空时跳过**（`old.base_url &&`），见 P1-5。另外 `fetch` 默认跟随重定向，依赖 Chromium 在跨源重定向时剥掉 `Authorization`（标准行为，我没有实测），建议显式 `redirect:'error'`（P2-2）。
- **IPC 的 zod 校验**：`ai:*`、`parse:*`、`questions:*`、`taxonomy:*`、`settings:*` 全部有校验，`questions:update` 用 `.strict()`。`queue:*`、`ai:presets` 无参数。唯一的缝：`ai:test` 的 `cfg.base_url` 只做长度校验，没有 http(s) 限制（P2-1）。
- **`ewb://`、导航守卫、CSP**：`protocol.ts`、`window.ts`、`index.html` 都不在改动列表里；`index.ts` 只加了 3 行 `register*Ipc`。**没有放宽。** AI 返回的文本全部走 React 文本节点渲染，没有 `dangerouslySetInnerHTML`，`<u>` 标签只是字面显示，不构成 XSS。

### 2. 数据库

- `db.ts` 相对 `7211fc1` 的 diff 只有「+1 行 import」和「+v5 迁移」，**v1–v4 原样未改**（`git diff 7211fc1 -- src/main/db.ts` 已核）。
- v5 在迁移循环的 `BEGIN/COMMIT` 里（`db.ts:299-311`）；全部是 `ADD COLUMN`（先查 `table_info` 防重复）、`CREATE TABLE/INDEX IF NOT EXISTS`、`INSERT OR IGNORE`；没有 DROP/重建，`question_kps` 的级联不会误清。新增的 `NOT NULL` 列都带 DEFAULT，老行安全。
- 遗留：v5 迁移直接调用 `seed/taxonomy.ts` 的 `buildKpRows()`，今后任何人改种子文件，都会让「新装用户」和「从 v4 升级的用户」得到不同的树（P2-17）。

### 3. 解析流水线

做对的地方：
- 分批（页数 + 字数两个上限）、`halveBatch` 对半拆、拆后第二半批用的 `PREV_CONTEXT` 是第一半批合并后的最新状态（`run.ts:161`/`:243-245`），顺序正确。
- 材料前缀 `b{seqNo}` 每次 `runBatch` 递增，重试/拆批不会撞号。
- zod 失败：先带反馈重试 1 次（共 2 轮），仍失败对半拆，单页仍失败才 `ParseError`。`truncated`/`empty` 直接拆批，符合提示词 §七.1。
- 429 / 5xx / 网络 / 超时：`client.ts:201-241` 指数退避 + 抖动，429 的 `Retry-After` 封顶 30 秒；401/403 不重试；`response_format` 被拒自动去掉重试且不占次数。
- JSON 模式：system 与 user 里各有 "JSON" 字样，重试反馈消息里也有。
- 入库：`saveResults`（`run.ts:296-345`）在一个事务里 DELETE 旧题/材料 → INSERT 新题/材料/`question_kps` → UPDATE `papers` → UPDATE `parse_runs`，失败 ROLLBACK。重跑 = 先删后插，不会留下重复题或孤儿 `question_kps`（FK 级联）。
- 取消/暂停不会卡状态：取消回到开始前的状态并把 `parse_runs` 记为 cancelled（`parse/queue.ts:74-79`）；`running` 在 `finally` 里清理；暂停只拦 `pump()`；启动时 `recoverInterruptedParsing` 把 `parsing` 退回（有旧题 → `reviewing`，否则 `extracted`）。
- `kp_suggestion` 不会自动写树：整个 `src` 里往 `kps` 里 INSERT 的只有迁移种子和 `taxonomy:approveSuggestion`（需要老师点击）。

有问题的地方：P1-4（续写）、P2-9（`locate` 复用旧结果）、P2-10（失败的 `locate/save` 阶段 `parse_runs` 状态残留）。

### 4. 提示词

- 8 个资源文件与 `docs/prompts/v1-sonnet改写.md` **逐字一致**（我用同样的抽取逻辑重新生成后逐文件 diff，8/8 相同）。
- P1 user 模板里的 8 个占位符（文本版）/ 8 个（视觉版）在 `run.ts:154-162, 167` 全部提供值；`fillTemplate` 是函数式替换，值里的 `$&`、`{{X}}` 不会被二次替换（单测覆盖）；system 部分没有占位符。E2E 校验了发出的 user 文本里不残留 `{{...}}`。
- 与 §七 约定的差异都是向严格方向的：zod 失败先带反馈重试再拆批（约定是同参数重试再拆批）。
- 示例里 `CHOICE`、`GR.NOUN.PLURAL_IRR`、`PH.VOWEL.AR` 不在树里——交付说明 §5 已指出，程序有兜底。建议把 docs 里的示例改成真实代码（P2-24）。

### 5. 审核页与队列页

- 状态流 `imported → extracting → extracted → parsing → reviewing → done | failed` 在代码里自洽：`parsing` 只在 `parsePaper` 开头设置，成功 → `reviewing`，失败 → `failed` + `error_stage='parse'`，取消 → 原状态；`done` ↔ `reviewing` 由 `confirmPaper/reopen` 切换。
- 拆分/合并/确认整卷/拖框都有事务（`remove` 除外，P2-6），数据落库正确（E2E 读库验证）。拖框用 0–1 归一化并 clamp，`questions:update` 再次 zod 校验。
- 有 2 个 P1（P1-2 队列页重试被 AI 配置挡住；P1-3 合并后表单陈旧）和若干竞态 P2（P2-7）。

### 6. 跨平台

- 应用代码：路径一律 `path.join`，`image_rel` 是纯文件名；文本处理按 `\n` 切行，`normalizeText` 会去掉 `\r`；快捷键 `metaKey || ctrlKey` 都认；等宽字体栈含 `Consolas`；没有外部命令。没有发现只在 macOS 成立的运行时假设。
- 唯一值得注意：仓库没有 `.gitattributes`，Windows 上 `core.autocrlf=true` 检出的 `src/main/ai/prompts/*.txt` 会变 CRLF，而 `prompts.ts:24` 的 `trimEnd` 只剥 `\n`，发给模型的提示词会带 `\r`（P2-12）。
- 测试套件：`run-m2.cjs:462` 用 `symlinkSync(..., 'dir')`（Windows 需管理员/开发者模式，应用 `'junction'`）；`lib.cjs:94 ocrText` 与 bbox 验证依赖 macOS Vision 可执行文件，所以 M2 E2E 目前只能在 macOS 跑，M5 的 Windows CI 冒烟要另写（P2-20）。

### 8. 真实 API 入口 `tests/real-ai/run.cjs`

- 没设 `EWB_REAL_AI_KEY` 时 `:14-17` 直接 `process.exit(0)`，在 `L.launch` 之前，**确实不会启动应用、不会发请求**（`require('../e2e/lib.cjs')` 只加载 playwright-core，不联网）。
- 输出只写 `tests/real-ai/raw/<时间戳>/`，已被 `.gitignore:6` 覆盖（`git check-ignore` 验证）。写入内容：`EWB_AI_DUMP_DIR` 的逐次请求/响应（`run.ts:106-114`，只有 messages 和模型输出，图片 base64 省略，无密钥）、`summary.json`（无密钥）、`questions.json`。**密钥不会被写进输出文件。**
- 小问题：未知 `EWB_REAL_AI_PROVIDER` 静默回退到 DeepSeek（`:29`），而 `EWB_REAL_AI_KEY` 是别家的就会把密钥发给 `api.deepseek.com`；临时数据目录（含加密密钥和试卷副本）不清理；`PRESETS` 与 `providers.ts` 重复一份。见 P2-19。

### 9. .gitignore

现有 6 行：`node_modules/ out/ dist/ ._* .DS_Store tests/real-ai/raw/`。**缺：** `.env`/`.env.*`（`git check-ignore .env` 无输出，确认未覆盖）、`*.log`/`npm-debug.log*`、`*.sqlite*`、`*.tsbuildinfo`、`coverage/`、`.claude/settings.local.json`。真实 API 输出目录已覆盖。见 P2-13。

### 10. 服务商预设

| 家 | base URL | 模型 | 判断 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-pro` / 视觉 `deepseek-flash` | **与任务书一致**，且默认值不是 `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`、`qwen3-vl-plus` | URL 正确（国内站）；模型名**需人工核对**；注意 DashScope 视觉模型对图片最小边长有限制，见 P2-1 |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615`、`doubao-seed-1-6-vision-250815` | URL 正确；模型名带日期后缀，**需人工核对**，且方舟常要求填推理接入点 `ep-…`（预设提示里已说明）；seed-1.6 默认带思考，输出 token 预算需实测 |
| Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview`、`moonshot-v1-32k-vision-preview` | URL 正确；`-preview` 型号时效性差，**需人工核对**；K2 思考系列对 `temperature` 有限制，见 P2-4 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6`、`glm-4.6v` | URL 正确；模型名**需人工核对**；GLM-4.6 默认开思考，同上 |

另：`providers.ts:4` 与 `AiSettings.tsx:113` 向用户展示了「DeepSeek 已在 2026 年 7 月下线 deepseek-chat」。这是任务书给的信息，我无法验证——**需人工核对**；如果不确定，建议界面文案改成中性的「请使用控制台里列出的当前模型名」（P2-21）。

---

## 三、问题清单

### P0（必须修，影响正确性/安全/数据）

无。

### P1（应修）

**P1-1　重新导入同一文件，会静默删除「AI 解析失败」的试卷（含已审核的题目）**
- 位置：`src/main/pipeline/queue.ts:107-113`（`registerOne`）
- 问题：M1 的逻辑是「同 hash 且 `status='failed'` 的旧记录直接 DELETE 并清文件」，当时 `failed` 只可能是提取失败。M2 之后 `failed` 也包括 AI 解析失败（`error_stage='parse'`），这类试卷有完整的页面数据，如果之前成功解析过，还保留着旧题目（解析失败时 `saveResults` 没执行，旧题保留）。
- 为什么是问题：老师把「解析失败」的那份卷子再拖进来想重试，就会把原试卷、页面图、旧题目和审核成果一起删掉重建。交付说明 §3.4 称失败「保留页面数据，可不重新提取直接重试」，这条路径和它直接冲突。
- 建议：只清理 `error_stage = 'extract'`（或 `IS NULL`）的 failed 记录；`error_stage='parse'` 的当作 `live`（给出「已存在，请到处理队列重试」的重复提示）。补一条 E2E：解析失败的卷子再导入同一文件，试卷和题目都还在。

**P1-2　没配 AI 服务时，队列页「重试（重新提取）」被「尚未配置 AI 服务」挡住**
- 位置：`src/main/ipc/parse.ts:23`；调用方 `src/renderer/pages/QueuePage.tsx:140`（`retry-extract` → `start(p.id,'extract')`）
- 问题：`parse:start` 对除 `locate` 外的所有阶段都要求 `isAiReady()`，包括 `extract`。提取失败的卷子在队列页点「重试」会弹出「请先到设置填写 Base URL、模型和 API Key」。
- 为什么是问题：设计方案 §5 首次启动明确「设置 AI 可跳过，跳过则只能手动标注」。没配 AI 的老师遇到一次 OCR 失败，在队列页（设计上就是失败重试的入口）无法重试，提示还会误导人；只能绕到试卷库的「重新提取」按钮。E2E 全程配置了 mock，没覆盖这个分支。
- 建议：`stage==='extract'` 不要求 AI 已配置（提取后是否自动解析本来就由 `maybeAutoParse` 判断 `isAiReady()`）；`ai`/`locate` 才检查。补一条未配置 AI 时从队列页重试提取的 E2E。

**P1-3　审核页「与下一题合并」后，右侧表单仍显示合并前的内容；随后改选项会把旧选项写回库**
- 位置：`src/renderer/pages/review/QuestionForm.tsx:31-35`；触发点 `src/renderer/pages/review/ReviewPage.tsx:306`
- 问题：表单用 `useState(q)` 持有本地草稿 `d`，换题靠 `key={cur.id}` 重挂载；同一道题被外部更新时，只同步 `kp_main/kp_secondary/kp_suggestion_status/reviewed`。合并成功后 `cur.id` 不变，库里的 `stem/options/score` 已是合并后的内容，但草稿仍是旧值。
- 为什么是问题：老师点合并后看到的题干没变，会以为没合并成功；如果接着改某个选项，`QuestionForm.tsx:108` 用陈旧的 `d.options` 计算整个数组并发送，把合并进来的选项覆盖掉（数据丢失）。E2E 的合并检查只读库，没看界面（`run-m2.cjs:694-698`）。
- 建议：合并成功后让表单重挂载（例如 key 带上 `updated` 版本号，或合并后先 `setSelId(null)` 再选回），或者让草稿在 `q` 的内容字段变化且本地没有未保存修改时整体重置。补一条合并后断言表单里的 `f-stem` 值的 E2E。

**P1-4　跨批续写：模型漏设 `continued_from_prev` 时，残缺题被保留、完整题被丢弃，且没有任何标记**
- 位置：`src/main/parse/merge.ts:75-87`（尤其 `:82-83`）；`src/main/parse/run.ts:278`
- 问题：`mergeBatch` 只有在新记录 `continued_from_prev===true` 时才替换上一批的同键题；否则命中同键就当作「重复，保留先出现的」。同时 `finalize` 只给**最后一道**题补 `stem_incomplete`（`run.ts:278`，`i === state.questions.length - 1`），中间位置的残缺题（`continues_next=true` 却没被续上）不会被标记，置信度仍是 1.0。
- 为什么是问题：这是长卷分批的核心路径，而「模型是否可靠设置 continued_from_prev」恰恰是真实 API 上最不确定的一环（交付说明 §6 也承认从未跑过真实模型）。一旦漏设，题干/选项被截成半截，审核页不会标黄，老师很难发现。
- 建议：① 命中同键且旧记录 `continues_next===true` 时，无论新记录有没有设 `continued_from_prev`，都按续写处理（整条替换）；② `finalize` 对所有仍为 `continues_next=true` 的题（不只最后一题）加 `stem_incomplete`；③ 同理，续写大题（`merge.ts:46-61`）在模型漏设 `continued_from_prev` 时会新开一个实例，导致后续续写题找不到旧记录而重复，建议一并处理；④ 补单测：`continued_from_prev=false` 的完整记录覆盖 `continues_next=true` 的残缺记录。

**P1-5　「不改发密钥」守卫在已存 Base URL 为空时失效**
- 位置：`src/main/ai/config.ts:39`
- 问题：条件里有 `old.base_url &&`。当已保存的 `base_url` 为空而密钥已存在时（设置页允许只填密钥不填地址：`saveConfig` 只在 `base_url` 非空时校验协议，`AiSettings.tsx` 的保存也不要求），页面脚本可以不带密钥直接把地址改成任意主机并保存成功，下一次解析/测试就会把旧密钥发过去。
- 为什么是问题：这个守卫存在的唯一理由就是「渲染端被攻破时不能把已存密钥重定向」（交付说明 §3.1），漏掉一种状态就等于没有。
- 建议：改成「已存在密钥，且新旧地址 origin 不可比较或不相同（含任一方为空）→ 必须同时重输密钥」；同时把「保存密钥但 base_url 为空」也拒掉或给出提示。补 E2E：空地址 + 已存密钥 → 改地址被拒。

---

### P2（建议）

**连接与服务商**

- **P2-1　`ai:test` 不校验协议；视觉测试用的是 1×1 像素图。** `config.ts:76-97`、`ipc/ai.ts:30`、`config.ts:73`。`cfg.base_url` 不限 http(s)，渲染端可借 `ai:test` 让主进程向任意 URL 发 POST（需自带 key，风险低）；复用 `saveConfig` 里的协议检查即可。`TINY_PNG` 是 1×1，部分视觉服务商（如 DashScope 要求图片边长 >10px）会直接拒收，用户会看到「视觉模型测试失败」而配置其实没错。换成 ≥64×64 的小图（需人工核对各家下限）。
- **P2-2　请求层的加固。** `client.ts:118`：显式 `redirect:'error'`，不依赖引擎剥 `Authorization`；`client.ts:77-83`：400 的响应片段先做 `sk-[A-Za-z0-9_-]{8,}` 与当前密钥的脱敏再展示/落库；`config.ts:35`：Base URL 为 `http://` 且主机非本机时在界面提示「密钥将以明文传输」。
- **P2-3　交付说明写「429/5xx 遵守 Retry-After」，代码只对 429 生效。** `client.ts:133`。503 常带 `Retry-After`，建议一并处理，或改交付说明。
- **P2-4　`temperature` 被拒时没有回退。** `run.ts:195`、`client.ts:228`。部分思考模型（Kimi K2 thinking、OpenAI o 系列等）对 `temperature` 有限制，会返回 400，目前直接失败；仿照 `response_format` 做一次「去掉 temperature 重试」。真实 API 上才会暴露，建议在 `test:real-ai` 前加上。
- **P2-5　视觉版图片未限制大小。** `run.ts:128-131`。每页原样 base64，一批 3 页可能数 MB 到十几 MB，不少服务商有单请求上限。按长边缩到 ~1600px 再发，或在 `bad_request` 提示里提到。

**解析与数据**

- **P2-6　`questions` IPC 的小问题。** `questions.ts:164-171`：`remove` 的 DELETE 和 `ord - 1` 不在事务里；`:183-191`：拆分把 `kp_suggestion/kp_suggestion_status=pending` 复制给两半，会出现两道题各有一条待采纳建议，且 `MIN(confidence, 0.69)` 在 `confidence IS NULL` 时得到 NULL；`:216-218`：合并丢掉被合并题的 `kp_suggestion` 和知识点，且不提示；`:119` 起：`done` 状态下编辑/拆分后试卷仍是 `done`（新拆出的题 `reviewed=0`），状态与内容不一致。
- **P2-7　审核页状态竞态。** ① `ReviewPage.tsx:61-73`：`flush` 返回时用服务端视图覆盖缓存，期间若又有新的乐观修改会被短暂回退（拖框后框会闪回旧位置约半秒）；`data:changed` 触发的整表重取同理；② `QuestionForm.tsx:33-35`：同步 effect 的依赖含数组 `q.kp_secondary`，每次重取都是新数组，会在 0.5 秒防抖窗口内把用户刚改的次知识点盖回旧值；③ `ReviewPage.tsx:119`：焦点在按钮上按 Enter 会同时触发按钮点击和「确认当前题」；④ `:97-107`：`flush` 失败后仍把本题标为 reviewed（缓存），与库不一致；⑤ `:307`：`onRemove` 没有 try/catch；⑥ 防抖 0.5 秒内直接退出应用会丢最后一次修改。
- **P2-8　`questions:list` 的「解析记录」取最新一条 `parse_runs`，不论状态。** `questions.ts:99`。取消/失败后审核页顶栏显示的提示词版本、模型、AI 备注属于那次未完成的运行，而不是当前这批题目；改成取最近一条 `status='done'`，或直接用 `papers.prompt_version`（列表页用的就是它，两处来源不一致）。
- **P2-9　「仅重新定位」可能复用过期的 AI 结果。** `run.ts:377`、`pipeline/queue.ts:171-183`。重新提取（`reprocessPaper`）清了页面和题目，但没有作废旧的 `parse_runs.result_json`；之后若 AI 解析没跑就点「仅重新定位」，会拿旧文字的 anchor 对着新页面定位。重新提取时把旧 run 标 `superseded` 并置空 `result_json`。
- **P2-10　`parse_runs` 状态残留。** `run.ts:386`：`locate` 阶段先把旧 run 置回 `running`，若之后 `finalize/saveResults` 抛出非取消错误，`parse/queue.ts:80-86` 只写 papers 不更新 run，直到下次启动才被标 `interrupted`。失败路径统一更新 run 状态。
- **P2-11　`papers:update` 把所有字段的「AI 猜测」标记一起清掉。** `ipc/papers.ts:84-91` + `PaperLibrary.tsx` 的 `handleEditSave` 一次提交全部字段，所以老师只改了「学校」，年级/学年等 AI 猜测的标记也全消失。改成只清除值真正变化的字段。
- **P2-17　v5 迁移依赖可变的种子模块。** `db.ts:4,229-235`。建议迁移里冻结一份种子（或记录 `TAXONOMY_VERSION`），今后种子更新走新的迁移。
- **P2-18　`ai_usage.paper_id` 没有外键。** `db.ts` v5。删除试卷后用量行保留——如果是有意保留费用统计，在代码注释里说明；否则加级联。

**提示词与仓库**

- **P2-12　提示词资源的换行符。** 无 `.gitattributes`；`prompts.ts:24` 的 `trimEnd` 只剥 `\n`。添加 `.gitattributes`（`src/main/ai/prompts/*.txt text eol=lf`，`docs/prompts/*.md text eol=lf`），并把 `trimEnd` 改成 `/\s+$/`；`scripts/extract-prompts.cjs` 读 md 时也要先 `replace(/\r\n/g,'\n')`。
- **P2-13　`.gitignore` 补全。** 见第二节 9。
- **P2-14　`savePrompt` 不检查 system 是否仍含「JSON」。** `prompts.ts:83-93`。部分服务商（含 DeepSeek）在 `json_object` 模式下要求提示词出现 json 字样；现在靠 `client.ts:228` 的自动降级兜底，建议保存时就提示。
- **P2-15　置信度阈值 0.7 在三处各写一份。** `validate.ts:86`、`status.ts:69`、`questions.ts:114`（SQL 字面量）。改一处会让「需关注」计数和列表标黄不一致。
- **P2-16　`dumpCall` 在生产代码里。** `run.ts:106-114`。只有设了 `EWB_AI_DUMP_DIR` 才启用，目前不含密钥，没问题；建议在注释里写明「永远不要把请求头/apiKey 写进 dump」，并在 `test:real-ai` 之外不文档化这个开关。

**测试与工具**

- **P2-19　`real-ai/run.cjs` 的三个小问题。** `:28-29` 未知 provider 应报错退出而不是回退 DeepSeek（否则别家密钥会发到 `api.deepseek.com`）；`:37` 临时目录用完应删除（含加密密钥与试卷副本）；`:19-25` `PRESETS` 应直接读 `providers.ts` 的导出，避免两处漂移。
- **P2-20　M2 E2E 只能在 macOS 上跑。** `run-m2.cjs:462` 的 `symlinkSync(…, 'dir')` 在 Windows 需特权，改 `'junction'`；`lib.cjs:94 ocrText` 依赖 macOS Vision。M5 做 Windows CI 时要把 bbox 的 OCR 反验证单独分组、在 Windows 上跳过。
- **P2-22　其余测试可信度问题**见第五节（合并测试合错了对象、缓存命中是 mock 模拟的、密钥扫描覆盖面等）。

**文档与内容**

- **P2-21　DeepSeek「已下线 deepseek-chat」的断言**写进了代码注释和用户界面（`providers.ts:4`、`AiSettings.tsx:113`），需人工核对后再展示给最终用户。
- **P2-23　设计方案 §3 未同步**本里程碑新增的列和表（交付说明 §6 已自述），建议 M2 合入时一并更新，否则 M3 的统计代码会按旧模型写。
- **P2-24　提示词示例里的代码不在树里**（`CHOICE`、`GR.NOUN.PLURAL_IRR`、`PH.VOWEL.AR`）。程序有兜底，但真实模型更可能照抄示例；建议把 docs 示例改成真实代码后重跑 `extract-prompts` 并升 `PROMPT_DEFAULT_VERSION`。

---

## 四、交付说明里 ✅ 与实际不符（或没有自动化验证支撑）

| 位置 | 交付说明的说法 | 实际 |
|---|---|---|
| §3.2「AI 猜测的试卷元数据」 | ✅ E2E：「…试卷库、详情页、编辑弹窗里对应字段带『AI 猜测』；用户再改某字段后该标记消失」 | E2E 只断言了试卷库里标记数量 ≥3（`run-m2.cjs:319`），**详情页、编辑弹窗、「改后消失」都没有断言**。实现上，编辑表单一次提交所有字段，所以改任何一个字段都会清掉全部标记（P2-11），与「改某字段后该字段的标记消失」不一致 |
| §3.4「从指定阶段重试」 | ✅（API） | 「重试（重新提取）」在没配 AI 时无法使用（P1-2）；E2E 始终配置了 mock，没覆盖 |
| §3.5「拆分 / 合并」 | ✅ E2E：「合并回 36 题，题干拼接」 | 测试在拆分后停留在**新题**上点「与下一题合并」，合并的是新题和**原来的下一题**（Q11），不是「合并回去」；只断言题数和前缀，没有断言恢复原状。UI 在合并后显示陈旧表单（P1-3）测试也看不到 |
| §3.5「拖动框（移动 + 8 个缩放手柄）」 | ✅ E2E 真实鼠标 | 只测了移动和右下角（`se`）一个手柄 |
| §3.5 审核页其余项 | ✅（缩放 150%/200%、选题自动翻页并滚到框、显示其他题的虚线框、材料折叠、全部/待确认/需关注筛选、审核页自动收起侧栏） | 这些在 `run-m2.cjs` 里**没有任何断言**（最多是截图里能看到）。我只能确认代码存在 |
| §3.4「导航徽标」 | ✅ | `badge-queue/badge-review` 没有任何测试引用 |
| §3.1「超时、429/5xx 指数退避（遵守 Retry-After，上限 30 秒）」 | ✅ | `Retry-After` 只对 429 生效（`client.ts:133`）；5xx 没有 |
| §3.1「已存密钥不能被『改发』到别的地址」 | ✅ | 测试的两条路径确实被拒；但已存地址为空时守卫失效（P1-5） |
| §3.2「token / 缓存命中 / 前缀缓存」 | ✅（结构）/ ⚠️（真实命中） | 交付说明已区分得比较诚实；但 E2E 用例名「后续请求的 system 前缀相同，命中缓存」读起来像验证了命中，实际 `cached_tokens` 是 mock 按「system 见过没」模拟的（`mock-ai/server.cjs:34-39`），只能证明用量字段被解析和落库 |
| §3.2「system 与 docs 里 P1 文本版逐字一致」（E2E） | ✅ | E2E 比较的是**资源文件** `src/main/ai/prompts/p1_text.system.txt`，不是 docs。我另外重新抽取验证了 8/8 一致，所以结论成立，但这条测试本身不能防止「docs 改了、资源文件没重新抽取」 |

交付说明里**核实无误**的 ✅：typecheck/build/单测通过（我复跑了 typecheck 与 unit）；E2E 52+109 项全过（对 `last-result*.json` 逐项计数）；v1–v4 未改；v5 增量且在事务内；密钥相关 7 项；`kp_suggestion` 不自动写树；故障场景 10 类；崩溃恢复；提示词版本记录；视觉版 `ocr_failed` 路径；M1 备忘项（anchor 空白归一化、行排序、reprocess 清 questions、parsing 中断恢复、`settings:get` 白名单）。

---

## 五、测试可信度

**可信的部分：**
- 单测用的是真实 OCR 乱序数据（`parse-pipeline.test.mjs` 里 `_. It's cold` 排在第 13 题之后的行）和真实坐标；`ai-client.test.mjs` 用注入的 fetch 覆盖流式半行、429/5xx、空内容、超时、取消、`response_format` 回退，断言具体（次数、错误码、中文文案），不是写死为真。
- E2E 的 bbox 验证是「按 bbox 裁图 → 真实 Vision OCR → 必须含本题文字、必须不含相邻题文字」，判别力强；数值核对独立于 mock。
- 密钥相关 E2E 直接扫 DB/WAL 文件字节、DOM、localStorage、控制台。
- 崩溃恢复用真实 `SIGKILL`。
- 故障场景脚本和断言一一对应（请求次数、末条反馈消息、`error_stage`）。

**需要打折扣的部分：**
1. **mock 与应用「配合」得太好**：`canned.cjs` 的 `anchor`/`anchor_ref` 是手工对着应用自己重排后的行号写的（例如 Q16、Q17 都是 `1-21`），所以「两份样本各 36 题全部定位成功」只证明「给了精确 anchor 时定位代码正确」，**不是真实模型 anchor 质量的证据**。mock 从不输出：带 OCR 错字的 anchor、错页码、被代码围栏包裹的 JSON、漏设 `continued_from_prev`、编造的材料 id。P1-4 正是这类没被测到的场景。
2. **缓存命中数是模拟的**（见第四节）。
3. **mock 不做 DeepSeek 的真实约束**：不检查 `response_format` 时提示词是否含 json、不限制 `max_tokens`、不拒绝 1×1 图片、不拒绝 `temperature`。第 3 项（JSON 模式要求）只能靠静态检查提示词文本。
4. **迁移测试是「退化」出来的 v4**：先建 v5 库再 `DROP COLUMN/TABLE` 并写 `user_version=4`，不是真实 v4 代码产生的库。思路合理、覆盖了「老师自建节点/改名节点不被覆盖」，但没有用 `git stash`/`7211fc1` 构建出的真实 v4 库做对照。
5. **密钥扫描不覆盖**主进程 stdout/stderr、`parse_runs.error`、`papers.error`、`ai_usage`。代码审读下来没有泄漏路径，但测试没有证明。
6. **合并测试合错了对象**（见第四节）；**审核页多项 UI 行为无断言**（见第四节）。
7. 单测里 `locate` 的「anchor_ref 错误」「模糊匹配」「同行两题」覆盖得不错，但没有「游标被一个错误的前向命中带偏、后续题全部失败」的场景（`locate.ts:101-111` 的单调游标在一次误判后会连锁），建议补一例。
8. 未覆盖（交付说明已自述）：排队中取消的界面按钮、下拉菜单项点击、`needs_ocr` 平台分支、`none` 页走视觉、低置信度页走视觉、docx 整条流水线、Windows 上的一切。

---

## 六、结论

**不通过（需修 P1）。**

- 必须先修：P1-1（再导入删掉解析失败的卷子）、P1-2（无 AI 时无法从队列页重试提取）、P1-3（合并后表单陈旧、可能写回旧选项）、P1-4（续写依赖模型自觉，漏设即静默产生残缺题）、P1-5（密钥守卫在空地址时失效）。五条都是小改动，改完补对应用例即可复审。
- 真实 API 第一次跑之前建议顺手做：P2-1（视觉测试图）、P2-4（temperature 回退）、P2-5（图片缩放）、P2-19（real-ai 未知 provider）。
- 其余 P2 不阻塞合入，可在 M3 前处理。
