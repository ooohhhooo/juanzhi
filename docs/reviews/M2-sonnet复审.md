# M2 返工复审报告

- 审核人：Sonnet 5.5（全新视角，只读；除本文件外未改任何文件；未运行 E2E、未调用任何真实网络 API、未执行 git 写操作）
- 对象：`/Volumes/Elements/Claude/english-exam-workbench/` 相对 `7211fc1` 的未跟踪与未提交改动；对照 `docs/reviews/M2-sonnet审核.md` 和 `docs/M2-交付说明.md` §10
- 已做：
  - 通读返工涉及的源码：`ai/{guard,config,client,secret,prompts,png}.ts`、`parse/{merge,run,queue,locate,validate}.ts`、`ipc/{ai,parse,questions,papers,settings}.ts`、`pipeline/queue.ts`、审核页 `ReviewPage.tsx` / `QuestionForm.tsx`、`QueuePage.tsx`、`AiSettings.tsx`、`PaperLibrary.tsx`、`db.ts` 迁移。
  - 通读测试：`tests/unit/*` 全部新增文件、`tests/e2e/run-m2.cjs` 与 `lib.cjs`、`tests/mock-ai/*`、`tests/real-ai/run.cjs`。
  - 运行 `npm run typecheck`：通过（node 和 web 两套）。
  - 运行 `npm run test:unit`：8 组全过。
  - 在 scratchpad 里拷贝源码，把修复分别还原后重跑单测，确认测试在修复前真的会失败（见 §1.0）。
  - 核对 `last-result-m2.json`（151/151 通过）、`last-result.json`（52/52 通过）。
  - 核对 `docs/prompts/v1-sonnet改写.md` 的 git diff。
  - 用假密钥加未知 provider 跑了 `tests/real-ai/run.cjs`（在启动 Electron 和联网之前就退出，退出码 2）。
- 没做 / 做不到：
  - 没有跑 GUI、E2E 和 `npm run build`（`out/` 正被别的进程使用）；E2E 结果只核对了结果文件和脚本断言本身。
  - 没有 Windows 环境，没有真实 API。
  - 以下凡写「推断」的是读代码推出来的，没有实际复现。

---

## 一、逐条核对

### 1.0 「测试修复前会失败」的实测

在 scratchpad 里改回旧逻辑，重跑对应单测：

| 还原的修复 | 结果 |
|---|---|
| 去掉 `merge.ts` 的 `impliedContinuation` 和大题、材料的兜底（P1-4） | `parse-pipeline.test` 断言失败：「漏设标记也要按续写合并」`2 !== 1` |
| 去掉 `locate.ts` 的 c2 回退（游标连锁） | 断言失败：「第 3 题的 anchor 在游标之前也要能找到」 |
| `client.ts` 里 Retry-After 只对 429 生效（P2-3） | 断言失败：「按 Retry-After=1s 等待，实际 20256ms」 |
| 去掉 temperature 回退（P2-4） | 直接抛 `AiError: 请求被拒绝（HTTP 400）…invalid temperature` |
| `redirect:'follow'` 加上不脱敏（P2-2） | 断言失败 |

所以单测是真断言，不是写死为真。P1-1/2/3/5 的复现测试在 E2E 里。我没法重跑，是读脚本判断的：每条的断言都依赖修复前不成立的状态，下面逐条写。

### 1.1 上轮 P1（5 条）

| 编号 | 结论 | 依据 |
|---|---|---|
| P1-1 再导入删掉解析失败的卷子 | **已修** | 代码：`pipeline/queue.ts:107-121`（`extractFailed` 在 `:110`，`live` 在 `:115`），`extractFailed = failed && error_stage !== 'parse'`，只清这类；解析失败的当作 `live`，返回 `duplicate` 并带 `parseFailed`。`useImportFlow.tsx` 显示提示。`error_stage` 的来源链路是通的：`drain()` 提取失败时写 `'extract'`，`recoverInterruptedPapers` 补写，`runJob` 失败写 `'parse'`，`saveResults` / `reprocessPaper` 清空。测试：E2E「P1-1 再导入」（`run-m2.cjs:397-408`）先让有 36 道旧题的卷子 AI 解析失败，再拖入同一文件，断言出现重复确认框、含「处理队列」、试卷 id 不变、状态仍是 failed、36 题和 2 页都在。修复前会静默删除重建，`stillThere[0].id === id` 必失败，**能复现**。 |
| P1-2 没配 AI 时队列页无法重试提取 | **已修** | 代码：`ipc/parse.ts:23`，只有 `stage==='ai'` 检查 `isAiReady()`；`extract` 走 `reprocessPaper(id,true)`，提取后 `maybeAutoParse` 自己判断 AI 是否就绪。测试：E2E `phaseNoAi`（`run-m2.cjs:996-1019`）用全新数据目录，强杀提取，重启后试卷是 failed 且 `error_stage=extract`，在队列页点 `retry-extract`，断言停在 `extracted`、没有「尚未配置」提示、mock 的 P1 请求数为 0；并断言 `ai` 阶段仍被拒。修复前 `parse:start` 抛错、状态保持 failed，**能复现**。 |
| P1-3 合并后表单陈旧 | **已修** | 代码：`ReviewPage.tsx:53,325,333-341` 合并后 `await invalidateQueries` 再 `setFormVersion(v+1)`，表单 `key={id:version}` 整体重挂载。测试：E2E「P1-3 合并后表单」（`run-m2.cjs:866-872`）读 DOM 里 `f-stem` 的值与选项个数，等于合并后的内容，再 `fill` 第 0 个选项，等 1.2 秒后读库，断言只有这一项变、其余选项没被旧草稿覆盖。修复前草稿是旧值，**能复现**。而且它读的是界面，不是库。 |
| P1-4 跨批续写依赖模型自觉 | **已修** | 代码：`merge.ts:86-90` 的 `impliedContinuation`、`:51-52` 的 `looksContinued`、`:70` 的材料续写、`run.ts:295` 对所有 `continues_next` 的题加 `stem_incomplete`、`validate.ts:66` 把扣分调到 0.35（0.65 < 0.7）。测试：单测（见 §1.0，修复前失败）和 E2E 两条：`noFlag`（仍 36 题、Q25 完整、AI 备注有「没有标注续写」）、`dropContinued`（Q25 不是最后一题也带 `stem_incomplete`，置信度 0.65 低于阈值，第 36 题不带）。mock 的 `quirks` 是新加的，确实模拟了模型漏设。有一个副作用，见 §2 P2-N3。 |
| P1-5 密钥守卫在空地址时失效 | **已修** | 代码：新增 `ai/guard.ts` 的 `sameServer`（两边都必须是合法 http(s) 且 origin 相同，任一边为空或非法一律 false）。`saveConfig`（`config.ts:41`）和 `testConnection`（`:85`）都走它。保存密钥要求地址非空（`:40`）。测试：单测 `ai-guard.test` 覆盖空、非法、端口、协议。E2E `phaseKeyGuard`（`run-m2.cjs:1022-1062`）在应用关闭时用 SQL 把已存 `base_url` 改成空，重启后断言：不带密钥改地址被拒、`ai:test` 被拒、「保持为空」也被拒、对方 mock 收到 0 个请求；同时重输地址和密钥可恢复。修复前 `old.base_url &&` 会放行，**能复现**。有一点要注意：单测只测纯函数，`saveConfig` 的接线靠 E2E，不是缺口，是分工。 |

### 1.2 上轮 P2（24 条）

| 编号 | 结论 | 依据 / 备注 |
|---|---|---|
| P2-1 `ai:test` 协议、1×1 图 | 已修 | `testConnection` 先 `isHttpUrl`（E2E 用 `file:///etc/passwd` 验证被拒）；`png.ts` 生成 128×128 PNG，单测验证合法 PNG，E2E 用 mock 记录图片尺寸（`run-m2.cjs:116`）。各家真实最小边长未查，交付说明已标 ⚠️，如实。 |
| P2-2 请求层加固 | 已修（有两个小缺口，见 §2 P2-N1、P2-N2） | `redirect:'error'` 在 `client.ts:127`；单测断言 `init.redirect==='error'`；E2E 起第二个 mock 当「别的主机」，307 过去收到 0 个请求。脱敏：单测加 E2E（`papers.error` 和 `parse_runs.error` 扫描）。明文 http 警告 E2E 有。 |
| P2-3 Retry-After 5xx | 已修 | `client.ts:139` 对 `429 || >=500`；单测把退避起点设成 20 秒，若没按 1 秒走会超时（§1.0 已实测会失败）。 |
| P2-4 temperature 回退 | 已修 | `client.ts` 的 `sendTemperature` 开关，不占重试次数；单测。mock 没有拒绝 temperature 的行为，所以 E2E 没覆盖，交付说明已标 ⚠️，但第五节那行写得有点满，见 §3。 |
| P2-5 视觉图缩放 | 已修 | `run.ts:133-147`，长边 >1600 缩成 JPEG；E2E 用 1190×1684 样本图，mock 解析 JPEG SOF 得到长边 1600、比例保持，bbox 反向 OCR 验证未受影响。 |
| P2-6 questions IPC | 已修 | `remove` 入事务；拆分不再复制 `kp_suggestion` 且 `MIN(COALESCE(confidence,1),0.69)`；合并并入知识点和建议；`reopenIfDone`。E2E `phaseApiRules` 逐条断言（建议只留原题、新题置信度 ≤0.69、合并后 Q23 主知识点不变且并入 Q24 的主次知识点、序号连续、done→reviewing 且只改 `reviewed` 不触发）。事务本身只能靠读代码确认。 |
| P2-7 审核页竞态 | 已修（代码层面），测试覆盖弱，交付说明对测试的描述不实 | ① 叠加层 `overlay` + `flush` 返回时若同题已有新 pending 就不回写（`ReviewPage.tsx:21-29,77-96`）；② `secondaryKey` 依赖（`QuestionForm.tsx:36-39`）；③ 按钮上按 Enter 不触发确认（`:140`）；④ `flush` 返回布尔值，`confirmCurrent` 据此中止；⑤ `onRemove` 有 try/catch（`:342-350`）；⑥ 防抖 300ms 加 `beforeunload`/`pagehide`。我推演了几种时序，没找到导致数据丢失的路径；残留的只是窄窗口里的视觉闪回，见 §2 P2-N6。**测试**：E2E 里没有任何用例聚焦在按钮上按 Enter（③），也没有让 `flush` 失败（④）。交付说明 §10 的 P2-7 行说「③④ 的逻辑……有 E2E」，**与事实不符**，见 §3。 |
| P2-8 解析记录取错 | 已修（有副作用，见 §2 P2-N4） | `questions:list` 只取 `status='done'` 的最近一条（`questions.ts:107`）；E2E 取消后断言 `run.status==='done'` 且版本与试卷一致。 |
| P2-9 「仅重新定位」复用过期结果 | 已修 | `reprocessPaper` 在事务里清空所有 `result_json`，done/ai_done/running 置 `superseded`（`pipeline/queue.ts`）；E2E 断言所有 run 的 `result_json` 为 null、没有 done 类状态、有 `superseded`，之后点 locate 得到「没有可复用」。 |
| P2-10 `parse_runs` 状态残留 | 已修（仅代码审读） | `parse/queue.ts:86` 失败出口统一把 running/ai_done 的 run 置 failed。交付说明已如实标 ⚠️ 没有复现测试。 |
| P2-11 AI 猜测标记整体清掉 | 已修 | `papers.ts:84` 起只清值真正变化的字段；`handleEditSave` 把空值统一成 `null`，不会因 `''` 对 `null` 误判。E2E：只改学校 → 标记全留；改年级 → 仅年级消失。 |
| P2-12 换行符 | 已修（Windows 未验证） | `.gitattributes`（提示词 txt 和 docs md 固定 LF）；`prompts.ts` 的 `trimEnd` 去 `\r` 和全部尾部空白；抽取脚本和单测都先 `\r\n→\n`。 |
| P2-13 `.gitignore` | 已修 | 补齐 `.env`、`.env.*`、`*.log`、`npm-debug.log*`、`*.sqlite*`、`*.tsbuildinfo`、`coverage/`、`.claude/settings.local.json`。 |
| P2-14 system 必须含 JSON | 已修 | `savePrompt` 对 p1 系的 system 检查；E2E 验证被拒。 |
| P2-15 阈值单一来源 | 已修 | `validate.ts` 的 `LOW_CONFIDENCE`；`questions:list` 返回给界面，SQL 用参数。`ReviewPage.tsx:43` 里的 `?? 0.7` 只是加载前的兜底，`tests/real-ai/run.cjs` 里的 `0.7` 是脚本自己的，都无害。 |
| P2-16 `dumpCall` 注释 | 已修 | `run.ts:106-109`。 |
| P2-17 迁移依赖可变种子 | 已修（有一个小缺口） | 种子改名 `KP_SEEDS_V1` / `QTYPE_SEEDS_V1`，`taxonomy.test` 对内容算 sha256 并硬编码校验值，谁改种子谁失败。缺口：派生逻辑 `buildKpRows`（父节点、层级、sort）不在校验范围，改了它同样会让新装和升级用户得到不同的树。建议把 `buildKpRows()` 的输出也纳入校验和。 |
| P2-18 `ai_usage` 外键 | 已修 | 有意不加；`config.ts` 注释和设计方案 §3 都写明。 |
| P2-19 real-ai 脚本 | 已修 | 我实跑了「假密钥加未知 provider」：先读 `providers.ts`、报错、退出码 2，没有启动 Electron、没有联网；没设密钥时退出码 0。预设改读 `providers.ts`；`finally` 里删临时目录。仍从未用真实密钥跑过，交付说明已标。 |
| P2-20 Windows 跑 E2E | **按约定留 M5** | 已顺手把 `symlinkSync` 改成 `'junction'`（`run-m2.cjs:559`）。 |
| P2-21 deepseek-chat 下线说明 | **按约定保留原文** | `providers.ts` 注释和 `AiSettings.tsx:116` 文案原样，没动。 |
| P2-22 其余测试可信度 | 见 §1.4 | |
| P2-23 设计方案 §3 | 已修 | 我逐项核对了 §3 新增文字和实际 schema（papers 新列与状态说明、questions 全部新列、kps/qtypes 新列、materials/parse_runs/ai_usage、settings 白名单和密钥存放），一致。 |
| P2-24 提示词示例代码 | 已修 | `git diff 7211fc1 -- docs/prompts` 只有 3 行。我把新文件里 `RD_MC`、`MC`、`PH.PHONICS.COMBO`、`GR.NOUN.PLURAL.IRR` 反向替换回 `READ_CHOICE`、`CHOICE`、`PH.VOWEL.AR`、`GR.NOUN.PLURAL_IRR` 后，与 `7211fc1` 的文件逐字节相同，说明只动了示例代码。`PROMPT_DEFAULT_VERSION` 升到 `v1.1`；`prompts-sync` 单测检查资源文件与 docs 一致，示例代码都在内置树和题型表里（在旧资源文件上会失败）。 |

### 1.3 第四节「交付说明里 ✅ 与实际不符」（9 条）

| 项 | 结论 | 依据 |
|---|---|---|
| AI 猜测（详情页、编辑弹窗、改后消失） | 已修 | E2E `run-m2.cjs:334-353`：详情页 `ai-guess` ≥3、弹窗 ≥4；`papers.update` 只改学校 → 标记全留，改年级 → 仅年级消失。第二条是直接调 API，不是点编辑表单，但逻辑全在主进程，等价。 |
| 从指定阶段重试 | 已修 | P1-2 已修并有 E2E。 |
| 拆分/合并 | 已修 | 现在合并的是「原题 10 + 刚拆出的新题」，断言题干 = 原题干 + `\n` + 新题干、选项等于拆前、序号连续、第 11 题未被动，随后检查表单（P1-3）。 |
| 拖动框 8 个手柄 | 已修 | `run-m2.cjs:798-819`：n/s/e/w/nw/ne/sw 逐个真实鼠标拖动，断言方向变化和另一侧边不动，加上原有的 se。 |
| 审核页其余项 | 已修 | 侧栏宽度 <100、筛选计数 2/35/36、选第 26 题翻到第 2 页并展开短文、虚线框开关（≥8 → 0）、选第 36 题框滚进可视区、150%/200% 缩放。 |
| 导航徽标 | **部分修** | 只断言了 `badge-queue`（`run-m2.cjs:223`）。`badge-review` 仍没有任何测试引用。§3.5 的 ✅ 写的是「处理队列、审核」两个徽标。第四节处理那行写的是「（队列页进行中数量）」，写得诚实，但 §3.5 的原行没改。 |
| Retry-After | 已修 | |
| 密钥「不改发」 | 已修 | P1-5。 |
| 缓存命中 | 已修 | 用例名和交付说明都改成了「记录链路，⚠️ 不代表真实命中率」。 |
| system 与 docs 一致 | 已修 | E2E 改为 `docsPrompt()` 直接从 docs 抽正文比较；另有 `prompts-sync` 单测防「docs 改了资源文件没重抽」。 |

### 1.4 第五节「测试可信度」

| 项 | 结论 | 依据 |
|---|---|---|
| 1 mock 配合得太好 | 部分修 | 新增 `quirks`（`noFlag`、`dropContinued`、`typo`、`badPage`）、围栏 JSON、`400echo`、307 `redirect`，E2E 逐项断言。**没做的**：模型编造不存在的 `material_id`。这条本来也在上轮清单里（「编造的材料 id」），交付说明没提。 |
| 2 缓存命中是模拟的 | 已修 | 见上。 |
| 3 mock 不做真实约束 | 部分修 | 交付说明说「`temperature`/`response_format` 回退有单测与 mock 行为」。实际 `response_format` 有 mock 指令 `bad_response_format`（原来就有），`temperature` 在 mock 里**没有**拒绝行为，1×1 图也不会被 mock 拒绝（只记录尺寸）。只有单测覆盖，E2E 不覆盖。 |
| 4 迁移测试是退化的 v4 | 已修 | `lib.cjs:buildRealV4Db` 用 `git show 7211fc1:src/main/db.ts` 抠出 `MIGRATIONS`，Node 剥离类型后执行，断言恰好 4 步；取不到时 `check` 记失败，不是静默跳过。依赖仓库里有 `7211fc1`（M1 提交，合入后仍在）。 |
| 5 密钥扫描覆盖面 | 已修 | `phaseFinalScan` 扫 4 个数据目录的数据库文件加 6 张表加所有应用进程的 stdout/stderr。小问题：`run-m2.cjs:1082` 末尾的 `&& out.length >= 0` 恒真，无害但没意义。 |
| 6 合并测试合错对象；UI 无断言 | 已修 | 见 §1.3。 |
| 7 locate 游标连锁失败 | 已修 | `locate.ts` 加 c2 回退，单测已实测会失败（§1.0）。副作用见 §2 P2-N5。 |
| 8 未覆盖项 | 保持 ⚠️ | 交付说明「仍未覆盖，保持 ⚠️」，与事实一致。 |

### 1.5 约束遵守情况

| 要求 | 结果 |
|---|---|
| P2-24 只改示例代码 | 遵守，已逐字节反向验证。 |
| P2-23 同步设计方案 §3 | 遵守。 |
| 不改 v1–v5 已有迁移 | `git diff 7211fc1 --numstat -- src/main/db.ts` 为 `84 0`，没有删除行，v1–v4 原样。v5 的行号区间和上轮引用（`db.ts:229-235` 里的种子写入、`:299-311` 里的迁移循环）一致。唯一的触碰是 v5 里引用的 `QTYPE_SEEDS` 改名为 `QTYPE_SEEDS_V1`（`db.ts:4,235`），语义不变。上轮的 v5 内容没有快照可对，只能确认这几处一致，不能逐行证明。没有新增 v6，也确实不需要。 |
| 第四、五节每条要么补断言要么改 ⚠️ | 基本遵守。除 §1.3、§1.4 标「部分修」的三处外，其余成立。 |

---

## 二、新问题

**P0：无。**

**P1：无。** 返工没有引入需要阻塞合入的回归。密钥边界、URL 协议检查、重定向、脱敏、数据库事务、迁移不可变、审核页状态竞态、队列和解析的状态流，我都推演过，没找到会丢数据或泄露密钥的路径。

### P2（建议修，不阻塞）

**P2-N1　密钥守卫依赖 `keyStorage()`，而它在「密文存在但当前解不开」时返回 `'none'`**
- 位置：`src/main/ai/secret.ts:41-45` 和 `config.ts:41`
- 问题：`keyStorage()` 在 `ai_key_enc` 行存在但 `getApiKey()` 返回 null（safeStorage 暂时不可用、钥匙串被拒绝等）时返回 `'none'`。此时 `saveConfig` 的 `keyStorage() !== 'none'` 为假，守卫整个跳过，页面脚本可以不带密钥把地址改成任意主机。之后钥匙串恢复，同一份密文又能解开，旧密钥就会发往新地址。
- 原因：守卫的前提是「当前有可用密钥」，而不是「库里有密钥」。
- 修法：守卫改看「`ai_key_enc` 行存在或内存里有密钥」，不要看能否解密。例如新增一个 `hasStoredKey()` 只查行是否存在。
- 概率低（桌面 macOS/Windows 上 `isEncryptionAvailable()` 通常稳定），但这个守卫存在的唯一理由就是不留缝。

**P2-N2　错误片段脱敏发生在截断之后，且 `ep-` 规则会误伤豆包的接入点 ID**
- 位置：`src/main/ai/client.ts:80`、`src/main/ai/guard.ts:45`
- 问题：
  1. `redact(body…slice(0, 300), …)` 先截断再脱敏。密钥正好跨在第 300 个字符上时，只剩一段前缀，既不等于完整密钥，也可能短于正则要求的 8 位，会漏出来。
  2. `/(sk|ak|key|ep)-…{8,}/` 会把 `ep-2025…` 替换掉。豆包预设说明里要求用户填的就是推理接入点 `ep-…`，它是模型名，不是密钥。服务商报 400/404 回显模型名时，用户看到的是「［密钥已隐藏］」，更难排错。
- 修法：先对整段响应文本脱敏，再截断。`ep-` 这条去掉（豆包密钥是 UUID 形式，已知密钥的精确替换已经覆盖），或改成只在 `Bearer`/`api key` 邻近时才替换。

**P2-N3　大题兜底 `looksContinued` 在两边标题都为空时会误并**
- 位置：`src/main/parse/merge.ts:51,101-104`
- 问题：`sameTitle('', '')` 为真。若两个不同的大题序号相同（听力「一」、笔试「一」）、模型又都没识别出标题，而前一批最后一个大题恰好和本批第一个大题同序号，就会被当成同一个大题，题目挂到旧实例上；同键的第二份题会被当「重复」丢弃（只留一条 AI 备注）。返工之前这种情况会各自成为新实例。
- 修法：`looksContinued` 要求 `last.title.trim() !== ''`（至少一边有标题时才用标题相等来判断）。再补一条空标题的单测。
- 属于罕见输入下的轻微退化。

**P2-N4　「仅重新定位」会把成功的运行翻成 running，失败或取消后永久降级，审核页顶栏随之丢失或回退到旧运行**
- 位置：`src/main/parse/run.ts:403`，`src/main/parse/queue.ts:78,86`，配合 `src/main/ipc/questions.ts:107`
- 问题：`locate` 阶段把原来 `done` 的那条运行改回 `running`。若随后被用户取消（`queue.ts:78`）或在定位/入库阶段抛错（`:85`），这条运行就成了 `cancelled` / `failed`。而题目没变，`questions:list` 只看 `status='done'`（P2-8 的修法），于是审核页顶栏的「提示词版本」和「AI 备注」整个消失（只有这一条运行时），或回退到更早的一条 done 运行（此时显示的版本、备注属于另一次解析，正是 P2-8 想避免的错位）。
- 修法：locate 不要改动被复用的那条运行的状态；要记录这次重定位，另插一行。或者取消、失败时把状态恢复成进入前的值。
- 只有 locate 加取消/失败才会触发，不影响主流程。

**P2-N5　游标回退（c2）找到的位置不打标记**
- 位置：`src/main/parse/locate.ts` 的 c2 段
- 问题：忽略游标从头精确搜索，如果同一段文字出现多次（例如两个大题里都有「1. What is this?」），会取最先出现的那一个，而这个结果没有 `locate_fuzzy` 之类的标记，置信度不降，老师无从察觉。返工之前这种题要么走模糊匹配要么 `locate_failed`（都有标记）。
- 修法：c2 命中时给结果加一个标记（复用 `locate_fuzzy`，或新增 `locate_rescan`），让它进入「需关注」。

**P2-N6　审核页叠加层的窄窗口**
- 位置：`ReviewPage.tsx:90-95`、`QuestionForm.tsx:37-39`
- 问题：
  1. 写库失败时 `setOverlay` 丢掉的是该题的整个叠加层，包括此时已排队、尚未写出的新修改，界面会先回退，几百毫秒后那个新修改又写成功，界面再跳回去。
  2. 一次在写库之前发起、写库之后才返回的整表重取，会带回旧的 `kp_main` / `kp_secondary` / `reviewed`，同步 effect 会把用户刚改的知识点在表单里短暂盖回旧值（库里是对的）。
- 都只是视觉闪回，库里数据正确，不丢数据。交付说明已对 ①② 标了 ⚠️「靠代码审读」。给出来是为了让后续有人加测试时知道该测什么。
- 修法（可选）：写库失败时只丢掉已经发出去的那一批（需要把已发的 patch 和排队的 patch 分开存）；同步 effect 在存在本题叠加层时跳过。

**P2-N7　「重新提取」「从头重试」对解析失败的卷子没有二次确认**
- 位置：`PaperLibrary.tsx:127-133,220-222`（确认框只对 `reviewing`/`done` 出现）；`QueuePage.tsx:64-71`（`restart` 同样）
- 问题：P1-1 的修法让 `error_stage='parse'` 的卷子保留旧题目（包含已审核的成果）。但这类卷子在试卷库点「重新提取」、在队列页的下拉里选「从头重试」，不会弹确认，会直接清掉所有题目。上轮 P1-1 的出发点正是保护这份成果，这里留了一个后门。
- 修法：`confirmReprocess` 和 `restart` 的判断改成「该卷子当前有题目」（或 `status in (reviewing, done)` 或 `failed && error_stage==='parse'`），统一弹确认。

**P2-N8　审核页「与下一题合并」按钮没有防连点**
- 位置：`QuestionForm.tsx:168`，`ReviewPage.tsx:333-341`
- 问题：`onMerge` 是异步的，期间按钮可以再点。第一次合并还在飞行时第二次点击会再把后面一题并进来，而合并没有撤销。这个问题不是返工引入的，但 P1-3 把合并路径改成了更慢的「写库 + 重取 + 重挂载」，窗口变长了。
- 修法：合并期间禁用按钮（局部 `busy` 状态），或者让主进程接受「期望的下一题 id」并校验。

### 与交付说明、测试相关的小项（P2）

- **P2-N9**　`tests/e2e/run-m2.cjs:1082` 的 `out.length >= 0` 恒真，删掉。
- **P2-N10**　`PaperLibrary.tsx` 与 `QueuePage.tsx` 对 `failed` 卷子的操作入口不一致（库里只有「重新提取」，队列里有 AI 重试、阶段菜单、重新提取），这是体验问题，不阻塞。

---

## 三、交付说明里 ✅ 与实际的出入

| 位置 | 说法 | 实际 |
|---|---|---|
| §10 P2-7 | 「竞态类的修复只有 ③④ 的逻辑与 P1-3 的行为有 E2E」 | **不实**。E2E 里没有「焦点在按钮上按 Enter」的用例，也没有「`flush` 失败」的用例（`grep Enter` 只有 `run-m2.cjs:711` 一处，焦点在 body）。③④⑤ 都只有代码审读。应改为：只有 P1-3 的行为有 E2E，①–⑥ 均无直接用例。 |
| §3.5 导航徽标行（`M2-交付说明.md:100`） | ✅「处理队列、审核带数量」 | 只有处理队列的徽标有断言，审核徽标 `badge-review` 没有。第四节处理表那行写的是「队列页进行中数量」（诚实），但 §3.5 的原行没同步改。 |
| §10 第五节「mock 不做 DeepSeek 的真实约束」（`:270`） | 「测试图尺寸、`temperature`/`response_format` 回退有单测与 mock 行为」 | `temperature` 在 mock 里没有拒绝行为，1×1 图也不会被 mock 拒绝（只记录尺寸）。只有单测覆盖这两项。 |
| §3.1「提示词管理」行（`:49`）、§4 第 10 条（`:145`） | 「`prompt_version` 记为 `v1+自定义·<6 位哈希>`；点恢复默认后回到 `v1`」 | 默认版本现在是 `v1.1`，自定义是 `v1.1+自定义·…`。E2E 已按 `v1.1` 断言（`run-m2.cjs:118`），文字没同步。 |
| §3.1「已存密钥不能被改发」行 | 「E2E 验证两条路径都被拒」 | 现在是更多路径（含空地址），§10 P1-5 已写清，此行可顺手更新。 |
| §3.6 迁移 v5 行 | ✅ | 与返工后的测试一致（真实 v4 库），不是问题，只是确认。 |

除上表外，我核对过的 ✅ 都与事实一致：
- typecheck 和 8 组单测通过。
- E2E 52 加 151 项（结果文件逐项计数）。
- P1-1 至 P1-5 的复现测试。
- 第四节的断言补充。
- P2 表里 ✅ 的项（P2-10、P2-12、P2-19 末尾的 ⚠️ 也写明了）。
- `db.ts` 没有删除行。

---

## 四、结论

**通过。**

- 上轮 5 个 P1 全部修复，每条都有在修复前会失败的测试：单测实测还原后失败；E2E 的断言依赖修复前不成立的状态，且读的是界面或库，不是写死为真。
- 24 条 P2 中，22 条已修，P2-20 按约定留 M5，P2-21 按约定保留原文。
- 第四、五节：9 条中 8 条补了真断言，1 条（导航徽标）只补了一半；第五节 8 条中 6 条已修，2 条为部分修（mock 真实性、mock 约束），其中一处写得偏满，见 §3。
- 返工没有引入 P0/P1。新发现 8 条 P2（§2），其中值得在合入前顺手处理的是：
  - P2-N1（密钥守卫改看「库里有无密文」）。
  - P2-N2（先脱敏再截断，去掉 `ep-` 规则）。
  - P2-N7（解析失败的卷子重新提取要二次确认）。
  
  这三条都是小改动。
- 交付说明需要订正 §3 列出的 3 处措辞。其中 P2-7 那一行是对测试覆盖的错误陈述，应优先改。
