# M4 复审报告（Sonnet 5.5，新上下文，未参与编码，未参与首轮审核）

> 审核对象：相对 `96b01bd` 的未提交工作区（返工后的版本）。对照物：`docs/reviews/M4-sonnet审核.md`（首轮）、`docs/M4-交付说明.md`（含 §13 返工记录）、`docs/设计方案.md`。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（23 组全过）。**没有**跑 E2E、没有启动 Electron、没有调用真实 AI、没有改任何项目文件（只写了本报告）。`tests/e2e/last-result-m4.json` 只读过：166 条全 pass。
> 复现与变异：首轮脚本 `/private/tmp/claude-501/rv4/s1–s4.mjs` 重跑；新脚本在 `/tmp/claude-501/rv/`（`j1.mjs` journal 各阶段与篡改、`k1.mjs` 恶意知识点树、`x1.mjs` 导出时读文件失败），变异测试在 `/tmp/claude-501/mut/`（项目副本，改的是副本）。均不入库。

## 结论

**不通过。P0 = 0，P1 = 1（新发现）。**

首轮 5 个 P1 全部真的修好了：原复现脚本不再复现，对应单测在把修复回退时会失败（唯一的保留意见是 P1-4 的调用点没有测试，记为 P2）。返工新增的主进程 IPC 拦截、覆盖导入的提交点、journal 相对路径、settings 逐键校验、`changeDir` token 都读过、试过，没有找到绕过。

但导出数据包这条路径有一个首轮没看到、返工又靠 `exporting` 标志和 `opActive` 放大了的问题：**导出过程中任何一个文件读取失败，会变成主进程未捕获异常，并且导出请求永远不返回，「导出中」状态永远不释放**（P1-A）。另有 7 条 P2。

---

## 一、首轮问题核实

### P1

| 编号 | 结果 | 依据 |
|---|---|---|
| P1-1 COMMIT 之后失败会把 files 换回旧的 | **已修** | 重跑 `rv4/s2.mjs`（`fs.rmSync` 对 `import-journal.json` 抛 `EPERM`）：不再报错；库是新的（A卷）、files 是新的（idA 目录在）、备份目录还在、marker 在。`apply.ts:395-408` 提交后的清理各自 try/catch，只写报告提示。变异：在副本里去掉内层 try/catch 并去掉 `committed = true`，`pack-db.test.mjs` 失败（被抓到）。注意：单去掉 `committed = true` 一行是等价变异（存活），因为真正起作用的是内层 try/catch，`committed` 只是保险，不算测试缺口。 |
| P1-2 导入的 settings 值不校验 | **已修** | `rv4/s3.mjs` V1：`ai_prompts = 'null'` 的包合并后，B 库里一个设置都没写进来。`pack/settings-rules.ts` 四个白名单键逐键校验，未知键 `default` 分支 fail-closed；`ai/prompts.ts:48-53` `overrides()` 经 `sanitizeOverrides` 洗数据，`null`/字符串/非文本值都回退默认。`pack-db` 单测覆盖 null/数字/超长/缺占位符/未知键/部分合格；变异（未知键默认改为放行）被 `settings-rules` 单测抓到（`pack-db` 里不会，因为未知键本来就进不了查询，等价）。密钥类键（`ai_key_enc`、`ai_config`、`import_marker`）不在 `PACK_SETTING_KEYS`，带不进来。 |
| P1-3 示例报告 / 分析被导出 | **已修** | `rv4/s1.mjs`：快照里示例报告 0、示例 `ai_analyses` 0；`s3.mjs` V4：导入到 B 后 0。导出侧 `exporter.ts:54-55`，导入侧 `apply.ts` 的 `copyReports` 与 `ai_analyses` 拷贝都带过滤。变异：分别去掉这四处，`pack-db` 单测四次都失败。E2E 用真实流程生成示例范围的 P3 报告和 P2 分析后导出核对（读代码确认，未重跑）。 |
| P1-4 P3 易错点只在前 30 个里找 | **已修**（回归保护有缺口，见 P2-2） | `service.ts:51` 传 `P3_HOT_LIMIT = 1000`。把 `rv4/s4.mjs` 的 `30` 改成 `1000`：`ERROR_PRONE` 第一行就是偏门易错节点 X。单测 `report-p3.test.mjs:200-217` 造了 35+1 个节点，且保留「截到 30 时它掉出去」的断言，能证明原问题。 |
| P1-5 「需要重启」只在渲染端 | **已修** | `restart.ts` 状态在主进程；`app:info` 返回 `restartPending/target/oldDir`（`ipc/data.ts:67-72`）；`RestartGate` 挂载时查询（`RestartGate.tsx:8`）；`installIpcGuards()` 在注册任何 IPC 之前调用（`index.ts:144`）。E2E（读代码，`m4-phases-more.cjs:67-82`）覆盖：重载页面后拦截仍在、写入类请求被主进程拒绝且旧目录没被写、读取不受影响、macOS 关窗再 `activate` 后仍在。 |

### P2

| 编号 | 结果 | 依据 |
|---|---|---|
| 1 E2E 空转断言 | **已修** | `stagingEmpty()` 真读暂存目录（`m4-phases-data.cjs:22`）；AI 设置不被覆盖改成 B 先配好密钥 + `b-local-model` 再断言原样（`:137-175`）；版本过新的正则收紧到 `数据库版本 v99 … 更新版本的软件`（`:190`）。 |
| 2 `changeDir` 接受任意路径 | **已修** | `chooseDir` 主进程签发 token（`ipc/data.ts:177-186`），`changeDir` 只收 token 并重新 `checkTargetDir`。成功后 `dirChoice = null`，不能重放；失败后同一 token 可重试（直到下一次 `chooseDir`），没有时间过期，这是单窗口应用，可接受。 |
| 3 覆盖导入清掉本机提示词 | **已修** | 覆盖不再删设置，`importSettings` 本机有就保留；单测 `pack-db.test.mjs:496-500`。 |
| 4 覆盖导入知识点树为空 | **已修** | `rv4/s3.mjs` V3 现在直接抛 `数据包里的知识点树缺少 145 个内置节点…`，覆盖整体回滚（`apply.ts:361-363`）。 |
| 5 journal 存绝对路径 | **已修**（校验偏松，见 P2-5） | 存相对路径、读回时必须在数据目录内；`j1.mjs` 试了 `../x`、绝对路径、`files/../../zzz`、`.`、`..files` 都被拒。 |
| 6 Windows 改名无重试 | **部分修** | `renameRetry` 用在目录改名上，逻辑简单正确；`clearJournal`、`writeJournal` 的最后一步 `renameSync` 没有重试（前者已不致命，后者失败只会让导入安全地失败）。Windows 未实测，交付说明已如实写。 |
| 7 主线程长任务 / 不能取消 / 不查磁盘 | **未修**（已列入已知缺口） | 说明与事实相符。 |
| 8 导出期间可重新提取旧卷 | **已修**，但引出 P1-A | `EXPORT_BLOCKED` 拦住 `papers:import/reprocess/remove`、`parse:start`、`queue:resume`、`data:*`；释放在 `finally`。读取类与审核编辑不拦，快照开始时已取完，合理。 |
| 9 导出的 .md 带 HTML | **已修** | `neutralizeHtml`，围栏内不动；单测 `report-p3.test.mjs:220-229`。 |
| 10 知识点树 | **(a) 维持（协调会话已定）；(b)(c) 已修** | (b) 重新启用检查同级重名（`edit.ts:191`）；(c) `oneLine` 转义 `|`/换行，单测有。合并逻辑我手推了四种主次组合（S 主/T 次、S 次/T 主、都次、S 主/T 无），都对；`kps`/`question_kps` 上的修订号触发器仍在（v8 只重建了 papers/questions/question_kps 的），合并后统计与报告「已过期」判定会随之更新。 |
| 11 信任包里的 `builtin` | **已修** | 合并写入一律 `builtin=0`（`apply.ts:127`）；覆盖只认本机内置代码。 |
| 12 迁移目标无完成标记 | **已修** | `.migrating` 标记，`hasDataLayout` / `checkTargetDir` 都认。 |
| 13 导入的 JSON 列 | **已修** | `parse/run.ts` 的 `result_json` 失败给明确中文提示。 |
| 14 `ui_*` 设置无校验 | **已修** | 随 P1-2。 |

---

## 二、新问题

### P1

#### P1-A 导出数据包时任何文件读取失败：主进程未捕获异常 + 导出永不返回 + 「导出中」状态永久卡死

- 位置：`src/main/pack/exporter.ts:109-123`（只监听了 `zip.outputStream` 与写流的 `error`）；放大器 `src/main/ipc/data.ts:28-33`（`withOp` 的 `opActive`）、`:100-111`（`setExporting`）。
- 问题：yazl 的所有文件读取错误（`addFile` 里的 `fs.stat` 失败、`createReadStream` 出错、「文件大小与读到的字节数不符」）都是 `self.emit('error')`，发在 **`ZipFile` 对象上**，不是 `outputStream`（`node_modules/yazl/index.js:36,37,45,74,187`）。`exporter.ts` 没有 `zip.on('error', …)`，所以：①Node 把它当未处理的 `'error'` 事件抛成 `uncaughtException`（应用里没有任何 `uncaughtException` 处理，Electron 弹「主进程出现 JavaScript 错误」对话框）；②`new Promise` 永远不 resolve 也不 reject，`data:exportPack` 的 `await buildPack` 永不返回，`finally` 不执行，于是 `opActive = '导出数据包'` 与 `exporting = true` **永久不释放**：之后「导入数据包 / 更改数据目录 / 加载示例数据」全部报「正在导出数据包…」，导出按钮一直转圈，直到重启应用；`.part` 文件也残留。
- 触发条件：导出过程（可能几分钟）中某个页面图 / 原件被杀毒软件或同步软件锁住（Windows 的 `EBUSY`/`EPERM`）、被用户在资源管理器里删了或移走、磁盘 I/O 错误、文件在导出中被改写（大小变化）。Windows 是用户的目标平台，所以不算罕见。
- 复现（**已复现**，`/tmp/claude-501/rv/x1.mjs`）：真实 `buildPack`，把 `fs.createReadStream` 对 `page-1.png` 换成会报 `EBUSY` 的流。3 秒后：`buildPack promise: pending`，`uncaughtException: EBUSY: resource busy or locked, open`。
- 为什么测试没抓到：导出只有 happy path 与写出失败（ENOSPC 之类走 `outputStream`/写流）的覆盖；交付说明 §3.3 的 ⚠️ 也没提这条。
- 建议修法：`zip.on('error', reject)`（并在 reject 路径上 `out.destroy()`、删 `.part`）；`data.ts` 的 `setExporting(false)` 已经在 `finally`，一旦 Promise 能 reject 就会释放。补单测：对 `fs.createReadStream` 注入失败，断言 `buildPack` rejects、没有 `uncaughtException`、`.part` 被清掉。可顺手给导出加一个总超时兜底。

### P2

1. **导入的知识点树完全不校验：层级、环、名称长度、`note` 长度都可被包随意写入**（`apply.ts:94-130` `mergeKps`，覆盖模式的 `copyRows(db, 'kps', …)`；`stage-db.ts` 对 `kps` 只检查列存在）。**已复现**（`rv/k1.mjs`）：包里放 `X.A`（level 99、parent=`X.B`、`note` 16 万字）和 `X.B`（level −5、parent=`X.A`）并把题目标注指过去，合并导入成功，两个节点原样进了树；`distribution` 只剩 2 个节点（该卷的知识点统计被带歪）。因为 `note` 会被注入 P1 提示词（设计方案 kps 一节），一个包能让每次 AI 解析的提示词带上大段攻击者文字并放大 token 费用；环节点互为子节点，编辑器里无法删除（只能停用）。本地编辑 `edit.ts` 限制了名称 30 字、note 500 字、最多 3 层，导入绕过了这些。建议：导入时按 `edit.ts` 同一套规则校验（level 1–3 且等于上级 level+1、无环、名称 ≤30、note ≤500、`intro_grade` 1–6 或空），不合格的节点丢弃并在报告里说明。
2. **P1-4 的回归保护缺调用点**：`service.ts:51` 的实参没有任何测试（该文件依赖 electron，单测不加载）。把它改回 `30` 所有单测和 E2E 照过（E2E 夹具只有 17 个知识点）。变异测试只改了常量 `P3_HOT_LIMIT`。建议把「取全量 + 取前 10」的组合抽成不依赖 electron 的小函数，由单测和 `service.ts` 共同调用。
3. **写入类通道清单漏项**（`restart.ts:19-26`）：`settings:set` 未列入（引导的 `onboarding_done`、`default_textbook`、`ui_stats_filter` 在「需要重启」后仍写旧库，重启后丢；影响很小，但与注释「写入类请求都拦」不符）；`data:pickPack` 未列入——重启待定期间仍可把最大 8 GiB 的包解到**旧**数据目录的 `.import-staging` 里，之后 `importPack` 才被拒。我逐一核对了全部已注册通道（对照 `ipcMain.handle` 扫描）：其余写入类都在清单里、清单里没有拼错的通道、读取类没有被误拦；`report:list` / `ai:compareAnalysis` 会回写 `checked_*` 缓存列，无害。（**已核对 / 部分为推断**）
4. **启动时 journal 恢复失败只有一行 `console.warn`**（`db.ts:450-455`）：`revertSwap` 抛错（例如 Windows 占用）时，数据库已回滚而 `files/` 仍是新导入的，应用照常启动，老师看到的是旧卷子缺页面图，没有任何提示；journal 保留所以下次启动会重试，这点是对的。建议失败时把这条原因经 `app:info`（或启动对话框）带给界面。（推断；`j1.mjs` 验证了各阶段正常路径）
5. **journal 校验只保证「在数据目录内」，不保证是预期的目录**（`journal.ts:38-54`）：`filesRel: 'db.sqlite'`、`backupFilesRel: 'backups'` 能通过 `readJournal`（**已复现**，`j1.mjs` 的 `dbfile` 与 `samefiles` 用例）。数据包写不出 journal（它在数据目录根，包只能写暂存目录），所以只有本机已有写权限的人能利用，风险低。成本很低的收紧：`filesRel` 必须恰好是 `files`，`backupFilesRel` 必须匹配 `backups/pre-import-…/files`。各阶段恢复（journal 已写未改名 / 旧目录已改名新目录未就位 / 两者都换完未提交 / 已提交）我用真实模块逐个跑了，行为都对，且重复执行幂等；其中前三种单测只覆盖了最后一种，建议补进单测。
6. **包里的自定义提示词静默生效**：`importSettings` 只在丢弃时写 warning，成功补上 `ai_prompts` 时没有提示。别人发来的包会悄悄改掉本机 P1/P2/P3 的提示词（设置页能恢复默认，但老师不知道）。建议导入报告里写一句「导入了 N 条自定义提示词」。
7. **解包错误归因**（`reader.ts:113,158`）：除名字 / 大小问题外，所有非 `PackError`（包括解包时磁盘写满 `ENOSPC`、权限错误）都归为「数据包已损坏」，会让老师以为包坏了。建议对 `ENOSPC/EACCES/EPERM/EBUSY` 单独给话（导出侧已经这么做了）。（推断）
8. **迁移数据目录不带走 `backups/`**（`ipc/data.ts:214-217` 只复制库与 `files/`）：覆盖导入前的备份留在旧目录；如果老师照常识把旧目录删了，备份也没了。至少在迁移完成的提示里说明；或把 `backups/` 一起移。

附带小项（不单列）：`copyReports` 与导出 / 清除示例数据判断「示例报告」都靠 `filter_json` 里恰好是 `"sample":true`（应用自己生成的永远是这个写法，包里手工写成 `"sample": true` 能绕过导入侧过滤，但绕过的只是一条示例报告，无害）。

---

## 三、按任务要求逐项的核对结果

**主进程包装 `ipcMain.handle`**：包装在所有注册之前；同步 `throw` 经 Electron 变成被拒绝的 invoke；读取类没被误拦；导出期间只拦会改写试卷文件的通道；`withOp` 与 `setExporting` 的释放都在 `finally`，唯一的卡死路径是 P1-A（Promise 根本不结束）。漏项见 P2-3。

**覆盖导入提交点与 journal**：顺序为备份 → `BEGIN IMMEDIATE` → 写库 → 写 journal → 目录改名 → `COMMIT` → 清理。提交前任一步失败都回滚并把目录换回；提交后只清理且不回滚。各阶段残留 journal 的启动处理见 P2-5，相对路径校验无法被数据包绕过（见 P2-5 对威胁面的说明）。

**settings 逐键校验**：四个白名单键都有分支，`default` fail-closed；导出侧与导入侧用同一份 `PACK_SETTING_KEYS`；密钥类键带不进来；`import_marker` 只能由程序自己写。

**`changeDir` token**：不可重放（成功即清）；没有时间过期；路径每次重新校验。

**示例数据排除**：派生表只有 `reports`、`ai_analyses`（`ai_usage` 无示例产生的行，`settings.ui_stats_filter` 不导出）。导出、导入（合并 / 覆盖）、清除示例数据三处一致。

**报告引用与 XSS**：引用必须在程序生成的索引里（`stripUnknownCitations`），渲染端全是文本节点；PDF 页面所有文字转义、无脚本、窗口 `javascript:false` + `sandbox`、没有远程资源（`mdhtml` 不支持链接和图片，只有程序裁的 data URI）；`cropForRef` 再校验一次文件名格式与目录范围。

**知识点合并后的统计与修订号**：见 P2-10 行。

**示例数据清除与首次启动**：`clearSample` 在一个事务里删示例卷（级联）、示例报告和分析缓存，再删文件；示例卷的「重新提取」会因找不到原件而被拒绝，不会损坏数据。首次启动卡片逻辑（老用户直接记为已引导、教材版本只作缺省）读过，没有问题。

---

## 四、建议修复顺序

1. P1-A：`zip.on('error', reject)` + 单测（几行代码）。
2. P2-1：导入知识点按 `edit.ts` 同一套规则校验。
3. P2-2、P2-3、P2-5：小改动，一并处理；P2-4、P2-6 在界面上加一句提示。
4. 修完请只复核 P1-A 的单测是否会在回退时失败（把 `zip.on('error')` 去掉应当失败），其余无需整体重审。
