# M3 第三轮审核报告（Sonnet 5.5，新加入的复审员）

> 审核对象：相对 `38659df` 的未提交工作区（`git diff 38659df` + 未跟踪文件，忽略 `._*` 与 png）。
> 对照物：`docs/reviews/M3-sonnet复审.md`（P1-A、P1-B、P2-N1～N10）、`docs/M3-交付说明.md` §13、协调方这一轮的 5 条要求。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（15 组全过，含 `stats-fuzz` 120 个随机库 14 400 项对拍）。**没有**运行 E2E、没有调用真实 API、没有改任何源码或文档（只写了本报告）。E2E 只读了 `tests/e2e/last-result*.json` 与 `last-perf-m3.json`（M1 52 / M2 155 / M3 159，失败 0；M3 结果的时间戳晚于最后一次源码修改）。
> 我自己写的脚本都在 `$TMPDIR/rv3/`（不入库）：`trig.mjs`（触发器逐项）、`oracle.mjs`（随机写入 × 统计快照对拍）、`rep.mjs`（代表卷手算）、`drawer.mjs`（抽屉 = 表格）、`misc.mjs`（BASE_YEARS / 空提示）、`up.mjs`（v7→v8 升级）、`banner.mjs`、`perf.mjs`，以及 `mut/` 下的 13 处变异。全部用真实迁移建库（`tests/unit/helpers/db.mjs` 取 `db.ts` 里的 `MIGRATIONS`）。

## 结论摘要

**通过。** P0 = 0，P1 = 0。上一轮的两条 P1（触发器太宽、抽屉基线不对齐）都真的修好了，我没有找到任何一条「会改变统计结果却不推高修订号」的写入路径，也没有找到抽屉与表格对不上的情形。

仍有 5 条 P2，其中 **P2-1（「含待审核」横幅的份数在新代表卷口径下偏大）和 P2-2（几处面向用户的口径文字还写着旧规则）是这一轮改口径时顺带引入的，都是一两行的改动，建议在交付前顺手修掉**；其余是长期隐患或测试缺口，不阻塞。

---

## 一、逐条核对表

状态：已修 / 部分修 / 未修 / 引入新问题。「修前会失败？」= 我在 `$TMPDIR/rv3/mut` 副本里把该修复改回去，现有测试是否报错。

### 协调方这一轮的 5 条要求

| # | 要求 | 结论 | 依据 |
|---|---|---|---|
| 1 | P1-A 触发器加 `WHEN`，v8 里 DROP 重建，v7 不动 | **已修** | `db.ts:288-321`。papers：`AFTER INSERT … WHEN NEW.status IN counted`；`AFTER UPDATE OF status, grade, semester, school_year_start, exam_type, textbook, region, file_hash, created_at, title … WHEN OLD.status IN counted OR NEW.status IN counted`（离开 / 进入计入都推高）；`AFTER DELETE … WHEN OLD.status IN counted`。questions / question_kps：`WHEN EXISTS(所属卷 status IN counted)`。kps / qtypes 沿用 v7 的无条件触发器。v7 的代码块没有改动（与上一轮复审引用的形态一致），`git diff --numstat` 对 `db.ts` 为纯新增 85 行、0 删除。v7 → v8 升级实测：`user_version` 8、旧缓存行保留、`checked_rev` 为 NULL（下次读核对一次）、升级时 rev +1、升级后进度写入不再推高、v8 重复执行不报错（`up.mjs`）。详见第二节 |
| 2 | P1-B：对齐后的基线范围抽成共用函数，抽屉也用它 | **已修** | `core.ts:526` `sideScopes()`。调用点：`compare()`（`core.ts:544`）、`analysis.ts:117` `sidesEmpty`（读缓存状态）、`analysis.ts:66`（P2 的 `both` 用 `cmp.base.years` 和 `cmp.align`，来自 compare，即 sideScopes 的结果）、`ipc/stats.ts:73` 抽屉 `side.kind === 'base'` → `S.sideScopes(…).sB`。除 `sideScopes` 自己和 `filter.ts` 外，源码里没有任何地方再手写基线 `paperScope(f, base…)`（grep 过）。目标侧 `kind:'year'` 仍直接 `paperScope(filter,{eq})`，与 `sideScopes` 里 `sT` 的写法逐字相同。**同比表、抽屉、P2 输入三处基线范围是同一个函数**。抽屉 IPC 用 electron，不能单测，我按它的逻辑独立复算：80 个随机库 × 5 种筛选 × 对齐开/关 × 基线两种，共 2643 个知识点项，抽屉卡片所属卷数 = 表格 `aB`/`aT` 全部相等（`drawer.mjs`）。E2E 有对齐开 / 关两个用例 |
| 3 | 重复组代表：先 done，同状态再选最早导入 | **已修，手算一致** | `filter.ts:88` `ORDER BY CASE WHEN o.status='done' THEN 0 ELSE 1 END, o.created_at, o.rowid`。手算 2 个场景见第三节，全部与代码一致。变异：去掉 CASE → `stats-core` 报「含待审核：副本是 done，原件虽然更早也不顶掉它」。**但改口径带来了两处遗留，见 P2-1、P2-2** |
| 4 | 尽量修 P2 | 见下表 | 10 条里 8 条已修、1 条部分修、1 条未修（如实记入 §8） |
| 5 | BOM 改成显式转义、措辞如实、设计方案 §4 同步 | **已修** | `csv.ts:4` `const BOM = '﻿'`；单测 `stats-csv.test.mjs:20`、E2E `m3-phases-ui.cjs:285` 都用转义；`grep -rn $'\xEF\xBB\xBF' src tests` 无命中；交付说明里没有字面 BOM；§12 第 6 行与 §13 的 P2-N8 行如实写了「之前的说明与实际不符，复审指出后才真正改」。设计方案：§3 的 `ai_analyses` / `data_rev` / `settings`、§4 的「计入范围、重复导入（done 优先）、同比默认按学期对齐」都已补，内容与 v8 触发器和代表卷规则一致 |

### 上一轮 P1 / P2

| 编号 | 结论 | 核对依据 | 修前会失败？ |
|---|---|---|---|
| P1-A 读缓存状态因无关写入整套重算 | **已修** | 同上第 1 行；写入类型 × 期望 × 实际见第二节，115 项里 114 项一致，1 项是应用里不存在的理论路径（P2-3）。另做了 2877 次随机写入的快照对拍：0 处「统计变了而修订号没变」，0 处「进度写入却推高」 | 是：变异 M2～M8（去掉 `OR NEW.status`、去掉 `OR OLD.status`、`UPDATE OF` 去掉 `semester` / `file_hash`、`questions_u` / `papers_i` / `question_kps_d` 去掉 `WHEN`）全被 `stats-core.test.mjs` 抓到 |
| P1-B 抽屉基线不对齐 | **已修** | 同上第 2 行 | 抽屉 IPC 接线只有 E2E 抓得到（见 P2-5）；`sideScopes` 对齐永远关（M12）被 `stats-core` 抓到 |
| N1 SSE 末行无换行 | **已修** | `client.ts:204-205`：循环结束后 `buf += dec.decode()`，残留的一行也走 `handleLine`；真正中断（既无 finish 也无 `[DONE]`）仍抛 `network`。单测 3 种流（只剩 `[DONE]` / 只剩 finish 块 / 末行被切成两包）；mock 新增 `p2_nonl`，E2E 断言只发 1 次请求 | 是：M10 去掉残留行处理 → `ai-client.test` 失败 |
| N2 `BASE_YEARS` 列出没有贡献的学年 | **已修** | `core.ts:537` `baseYears` 取自对齐后的 `sB`。复现场景：2023 只有下学期 3 份、2024 上学期 4 份、目标 2025 上学期 5 份 → 对齐后 `base.years=[2024]`、`BASE_YEARS=2024-2025学年`、`BASE_PAPERS=4`；不对齐 `[2023,2024]` 7 份（`misc.mjs`） | 是：M9 → `stats-core` 报「BASE_YEARS 只列对齐后真正贡献了卷子的学年」 |
| N3 对齐后基线为空的提示 | **已修（逻辑）** | `shared/emptyReason.ts` 纯函数，同比页 `CompareTab.tsx:86` 与总览 `core.ts:644` 共用。三个场景手验：目标只有上学期 / 基线只有下学期 → 「…有 5 份卷子，但它们的学期与目标学年（只有上学期的卷子）不一致，按学期对齐时被排除了…可以关掉『按学期对齐』」；总览版指路到「分析看板 → 同比」；目标学期全未填同理；关掉对齐后 `empty=false`。页面上的实际文字没有 E2E（§8 已如实写） | 单测覆盖各情形 |
| N4 同比页范围说明数字范围 | **部分修** | 改成「按当前筛选、不限学年」统计，并用 `hint` 写明「同比实际比较的卷子还要按目标 / 基线学年与『按学期对齐』再取，份数可能更少」（`CompareTab.tsx:83`）。数字本身仍不是同比的实际范围，但文案已如实说明，我认为可接受 | — |
| N5 含待审核时副本被原件顶掉 | **已修** | 见协调方第 3 条。**引入的遗留见 P2-1、P2-2** | 是（M1） |
| N6 测试缺口 | **已修** | 新增 `stats-fuzz.test.mjs`（朴素实现逐卷逐题逐节点对拍，120 库 × 对齐 × 含待审核 × 含重复）、`stats-core` 的「同一文件 + 学期对齐」叠加用例、E2E 抽屉对齐用例。我的变异 M13（去重按 `o.id` 分组）被抓到 | 是 |
| N7 设计方案未更新 | **已修** | 见协调方第 5 条 | — |
| N8 BOM | **已修** | 见协调方第 5 条 | 单测断言 `startsWith('﻿')` |
| N9 跨学年同一文件 | **未修（如实）** | 交付说明 §8 末尾「跨学年的同一文件算不算重复」写明未改，原因是需要先定口径 | — |
| N10 对齐时 `SAMPLE_WARNING` 不写学期范围 | **已修** | `p2.ts:90-92`：只要有警示就附「学期范围：目标学年…；基线已按学期对齐，只取…」。无警示时 `SAMPLE_WARNING` 为「无」，学期范围仍在 `FILTER_DESC` 里（`describeFilter(…, cmp)`）。E2E 手算校验过文字 | 是：M11 → `stats-p2` 失败 |

---

## 二、触发器验证表（`trig.mjs`，真实迁移 v1–v8；`rev` = `data_rev.rev`）

「期望」是我在运行前按规则写下的：只有计入统计（done / reviewing）的卷子、它的题与标注、统计用到的卷子列、知识点树 / 题型表变动，才推高；进入或离开计入也推高。

| 写入类型 | 期望 | 实际 |
|---|---|---|
| 新建「刚导入」的卷子；imported → extracting → extracted → parsing | 不变 | 不变 |
| 非计入状态下写 page_count / warning / parse_stage / error / error_stage / extracted_at / parsed_at / prompt_version | 不变 | 不变 |
| extracting 阶段写 pages；parsing 阶段写题、写题的标注、改题 | 不变 | 不变 |
| parsing → reviewing（开始计入） | 变 | 变 |
| reviewing → done；done → reviewing（审核里改了内容）；reviewing → done | 变 | 变 |
| done → failed（离开计入）；reviewing → imported（reprocess 重置） | 变 | 变 |
| failed → imported；非计入卷状态 → 非计入状态 | 不变 | 不变 |
| imported → parsing → reviewing（重新解析） | 变 | 变 |
| 删除 done / reviewing 卷（含题与标注的级联） | 变 | 变（由 papers 删除触发器推高；子表级联时所属卷已不存在，不重复推高，不影响结果） |
| 删除 imported / extracting / extracted / parsing / failed 卷（含题与标注） | 不变 | 不变 |
| done / reviewing 卷改 grade / semester / school_year_start / exam_type / textbook / region / title / file_hash / created_at（9 列 × 2 种状态） | 变 | 变（18 项全部） |
| failed 卷改上述 9 列 | 不变 | 不变（9 项） |
| done 卷改 school / total_score / duplicate_of / ai_meta_json（统计不用） | 不变 | 不变 |
| 一条 UPDATE 同时把状态改为计入并写进度 | 变 | 变 |
| done 卷的题改 score / qtype / difficulty / error_prone / error_reason / stem / no_label / ord / section / reviewed / edited / page_idx / bbox_json（13 列） | 变 | 变（13 项） |
| extracted 卷的题改上述 13 列；新增 / 删除题 | 不变 | 不变 |
| done 卷新增题、删除题、整卷题全删（reprocess） | 变 | 变 |
| done 题：加次知识点、次→主（`UPDATE is_primary`）、改 `kp_code`、`INSERT OR REPLACE` 改主次、删标注、`setKps` 全套（DELETE 全部 + INSERT）、直接删题（级联删标注） | 变 | 变 |
| done 题：`INSERT OR IGNORE`（已存在的行，空操作） | 不变 | 不变 |
| extracted 题加 / 改 / 删标注 | 不变 | 不变 |
| 知识点：改名、改 `parent_code`、合并 `merged_into`、改 level / sort / deprecated / intro_grade、新增节点、`INSERT OR REPLACE`、删除节点 | 变 | 变（7 项） |
| 题型表：改名、改 group、新增 / 删除 | 变 | 变 |
| 拆分 done 卷的一道题（照 `questions:split` 的语句序列：`ord+1`、改原题、`INSERT … SELECT`、复制标注，随后 `reopenIfDone`） | 变 | 变 |
| 合并 done 卷相邻两题（照 `questions:merge`：改题、`setKps`、删题、`ord-1`，随后 `reopenIfDone`） | 变 | 变 |
| 写 settings / 写 pages（done 卷的页面）/ 写 ai_analyses | 不变 | 不变 |
| 重复组：另一份同 hash 的副本 reviewing → done（代表可能改变） | 变 | 变 |
| 重复组：另一份 done → failed（代表换回） | 变 | 变 |
| 重复组：同 hash 的新副本在 extracting 阶段写进度；extracting → extracted → parsing | 不变 | 不变 |
| **题从 done 卷移到非计入卷（`UPDATE questions SET paper_id`，应用里没有这条路径）** | 变 | **不变**（触发器只看 `NEW.paper_id`）—— P2-3 |
| 触发器清单 | 15 个 | 15 个（papers / questions / question_kps 各 3 个带 WHEN 的 + kps / qtypes 各 3 个无条件的） |

共 115 项，114 项与期望一致，1 项为理论路径。

**快照对拍（`oracle.mjs`，4 个种子，共 2877 次随机写入）**：每次写入前后各算一份「概览（去掉『最近导入』）+ 分布 + 重难点 + 6 种筛选下目标 2024 / 2025 × 对齐开 / 关的同比与 P2 输入指纹」，写入让快照变了而修订号没变 → 漏报。种子 777 / 11 / 22 / 33 的结果：漏报 **0**，进度类写入误推高 **0**；写入种类含状态切换、9 种元数据列、8 种题字段、标注增删改（含 `INSERT OR REPLACE`）、题增删、卷增删、知识点改名 / 改父节点 / 合并 / 取消合并、题型改名、进度写入、pages 写入、同 hash 副本改状态。其中修订号推高但快照其实没变的约占 20%（例如 reviewing 卷在 `includeReviewing=false` 视图下的改动、`reviewed` 位翻转），属于偏保守的安全方向。**对拍有效性**：我把 `OLD.status` 条件去掉后重跑，对拍立刻报出漏报。

**写入开销（`perf.mjs`，内存库，500 份 × 40 题 × 每题约 1.3 条标注，每卷一个事务）**：无触发器 224 ms，v8 触发器 446 ms；折合每份卷多约 0.4 ms，对实际导入（每份卷提取 + AI 解析以秒计）可以忽略。

---

## 三、代表卷新口径手算（`rep.mjs`，运行前写下期望）

**场景 1**：同一文件 X 三份：A reviewing（10:00，最早，标 A.1 分 2）、B done（10:05，标 B.1 分 3）、C done（10:10，标 C.1 分 4）。

| 设置 | 手算 | 代码 |
|---|---|---|
| 默认（只 done） | 可见 {B, C}，代表 B → 1 份、1 题、总分 3，只出现 B.1 | 一致 |
| 含待审核 | 可见 {A, B, C}，done 优先 → B（旧口径会是 A）→ 同上 | 一致 |
| 含重复导入 | B、C 两份，2 题，总分 7 | 一致 |
| 含待审核 + 含重复 | 3 份，总分 9 | 一致 |
| 范围说明（默认 / 含待审核） | 待审核 1、合并 1 ／ 待审核 0、合并 2 | 一致 |
| B 撤回为 reviewing 后 | 默认可见 {C} → C；含待审核：C 是 done → 仍 C | 一致 |
| C 也撤回 | 默认 0 份；含待审核：全是 reviewing → 最早的 A | 一致 |

**场景 2**：文件 Y：D done 年级 5（09:00）、E done 年级 4（09:30）；文件 Z：F、G 都 done 年级 4、同一秒导入，F 先插入。

| 设置 | 手算 | 代码 |
|---|---|---|
| 不筛选 | Y→D（最早）、Z→F（同秒先插入）；2 份、2 题，A.1=1、C.1=1 | 一致 |
| 年级 = 4 | Y 只剩 E；Z→F；B.1=1、C.1=1 | 一致 |
| 年级 = 5 | 只有 D | 一致 |
| 删除 D 后不筛选 | Y→E；B.1=1、C.1=1 | 一致 |

14 项全部一致。

---

## 四、新问题

### P0

无。

### P1

无。

### P2

**P2-1　「含待审核」横幅与开关旁的份数，在新代表卷口径下偏大（这一轮改口径带来的回归）**
- 位置：`src/main/stats/core.ts:222`（`reviewing` = 满足维度筛选的全部 reviewing 卷，不看去重）；`src/renderer/stats/StatsFilter.tsx:98,119-120`（横幅「{pending} 份待审核的试卷已计入」）。
- 复现（`banner.mjs`）：K1 reviewing（原件）+ K1d done（副本，同 hash）+ R1 reviewing。打开「含待审核」：实际计入 {K1d, R1}（其中 reviewing 只有 R1 一份），横幅却写「2 份待审核的试卷已计入」。E2E 里这两个数字同时出现且都 pass（「19/60，R1 计入」与「2 份待审核已计入」），互相矛盾而没有被发现。旧口径（最早导入的作代表）下 K1 被计入，数字恰好对；新口径下 K1 让位给 K1d，横幅就多算了。统计数字（卷数、题数、出现率）本身都是对的，错的是对老师的说明。
- 修法：开关打开时，横幅的份数改成「实际计入的 reviewing 卷」：`SELECT COUNT(*) FROM papers p WHERE <paperScope(f) 的条件> AND p.status='reviewing'`；同时可以补一句「另有 N 份待审核的卷子因同一文件已有已确认的副本而未重复计入」。开关旁「含待审核（N 份）」是「有 N 份待审核」的意思，可以保持不变。补一个单测（K1 / K1d / R1 场景）。

**P2-2　面向用户的口径文字、注释和交付说明里还写着旧规则（「取最早导入的」）**
- `src/renderer/stats/Methodology.tsx:14`（口径说明弹窗）：「…取最早导入的那份作代表」，没有写「已确认的优先」；
- `src/renderer/stats/StatsFilter.tsx:114`（「包含重复导入」的提示）：同样只写「取最早导入的」；
- `src/main/stats/filter.ts:83` 的行内注释、`tests/e2e/fixtures-m3.cjs:69` 的注释（「打开『含待审核』后取最早导入的 K1，仍是 1 份」）、`tests/e2e/m3-phases-ui.cjs:157` 的检查名（「K1 取代它的副本 K1d，数量不变」，新口径下恰好反过来）；
- `docs/M3-交付说明.md:240`（§6-1「取…最早导入的」）：§13 的「重复组代表」一行声称 `naive.cjs`、设计方案 §4、§3.1、§4、§6-1 都已同步改，但 §6-1 实际没改。§12 第 314 行是历史记录，可以保留，加一句「现已改，见 §13」更清楚。
- 影响：口径说明弹窗是老师核对数字时会读的文字，与实际规则不符。修法：把这几处改成「已确认的优先，同状态取最早导入的」；E2E 检查名改为「K1d（已确认）顶上，数量不变」。

**P2-3　触发器只看 `NEW.paper_id`：题在卷子之间移动时可能漏推高（理论路径）**
- 位置：`db.ts` v8 的 `trg_rev_questions_u`。`UPDATE questions SET paper_id = …` 把题从 done 卷移到非计入卷时，`NEW.paper_id` 对应的卷子不计入 → 不推高，但 done 卷的统计变了（`trig.mjs` 里唯一不符的一项）。应用里没有任何代码改 `paper_id`（`grep` 过所有 `UPDATE questions`），所以现在不会触发。
- 修法（可选）：`questions_u` 的条件改成 `EXISTS(… p.id = NEW.paper_id …) OR EXISTS(… p.id = OLD.paper_id …)`；`question_kps` 的 `question_id` 同理。或者在迁移注释里写明「题不会换卷」。

**P2-4　`papers` 更新触发器的列清单是白名单，将来新增统计相关列时会静默漏推高**
- 位置：`db.ts:302`（`UPDATE OF status, grade, …`）。现在列清单与 `core.ts` / `filter.ts` 用到的 papers 列完全对得上（我逐个核对了 `p.` 的引用：school_year_start / grade / semester / exam_type / textbook / region / status / created_at / file_hash / title）。风险在后续里程碑加列（比如「科目」）。
- 修法：加一个单测，遍历 `PRAGMA table_info(papers)`，要求每一列要么在触发器的列清单里，要么在一个明写的「不影响统计」名单里（`school`、`total_score`、`duplicate_of`、`error`、…）；新增列没登记就报错。

**P2-5　抽屉 IPC 的范围接线没有单测，只有 E2E**
- 位置：`src/main/ipc/stats.ts:66-75`。`stats:questions` 里「用哪个范围」这段在 electron 模块里，单测够不着；`sideScopes` 本身有单测，但「抽屉真的调用了它」只靠一个 E2E 用例保护。建议把这段抽成 `core.ts` 里的纯函数（如 `drawerScope(db, filter, side)`），单测直接覆盖三种 `side`。我用 `drawer.mjs` 按同一逻辑复算了 2643 项，没有不符，所以只是防回退用。

---

## 五、对重点问题的直接回答

1. **触发器有没有漏掉会改变统计结果的写入路径？** 没有。手工 115 项 + 2877 次随机写入对拍，0 处漏报；唯一的缺口是应用里不存在的「改题的 `paper_id`」（P2-3）。
2. **该变就变、不该变就不变？** 是。导入 / 提取 / 解析阶段的进度、页面、解析中的题与标注、failed、重试，修订号都不变；进入 / 离开计入、已计入卷的统计列、题、标注、拆分合并、知识点树、题型表、重复组里另一份的状态变化，都推高。
3. **代表卷新口径对吗？** 对，14 项手算全部一致；遗留是横幅份数与文字（P2-1、P2-2）。
4. **P1-B：三处是同一个函数吗？** 是（`sideScopes`），抽屉卡片所属卷数 = 表格份数，2643 项无不符。
5. **返工有没有带来新问题？** 只有 P2-1、P2-2 两处属于这一轮改口径的副作用；其余是隐患与测试缺口。
6. **交付说明是否如实？** 总体如实，已知缺口（N9、对齐为空的页面文字无 E2E、第一次核对仍约 330 ms 略超 300 ms）都写了。不符的只有 §6-1 的旧规则（P2-2），以及 §13 里「同步改了 §6-1」那一句。

## 六、结论

**通过。** P0 = 0，P1 = 0。建议在合并前顺手修 P2-1 与 P2-2（各一两行，且都与老师看到的数字说明有关）；P2-3～P2-5 可以放到后续里程碑，但 P2-4 的单测成本很低，建议和 P2-1 一起补上。
