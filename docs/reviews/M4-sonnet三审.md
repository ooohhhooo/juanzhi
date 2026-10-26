# M4 三审报告（Sonnet 5.5，新上下文，聚焦复核二轮返工）

> 审核对象：二轮返工后的工作区（相对 `96b01bd` 未提交）。对照物：`docs/reviews/M4-sonnet复审.md`、`docs/M4-交付说明.md` §13「复审返工（二轮）」。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（24 组全过，新增 `ipc-guard-audit`）。**没有**跑 E2E、没有启动 Electron、没有调用真实 AI、没有改任何项目文件（只写了本报告）。
> 复现与变异：复审的复现脚本 `/tmp/claude-501/rv/{x1,k1,j1}.mjs` 对修后的代码重跑；新增 `/tmp/claude-501/rv/j2.mjs`（invalid journal 两次启动、反斜杠 / 尾斜杠 / 大小写 / 符号链接写法）；变异测试在 `/tmp/claude-501/mut2/`（项目副本，改的是副本）。均不入库。

## 结论

**通过。P0 = 0，P1 = 0。** 复审的 P1-A 和 8 条 P2 都修到位，原复现全部不再复现，对应测试在回退修复时会失败。二轮新增代码里没有发现会丢数据、卡死或绕过防线的问题，只有几条 P2 / 小项（见第三节），可以排进 M5 前的收尾，不阻塞。

---

## 一、复审问题逐条核实

| 编号 | 结果 | 依据 |
|---|---|---|
| **P1-A** 导出读文件失败：未捕获异常 + 永不结束 + 锁不释放 | **已修** | `exporter.ts` 新增 `zip.on('error', fail)`；`fail` 只 reject 一次，先 `unpipe` 再 `out.destroy()`，`close` 在失败后不再 resolve。重跑 `rv/x1.mjs`（`createReadStream` 对 `page-1.png` 报 `EBUSY`）：`buildPack promise: rejected: 没有写入权限，或文件正被其他程序占用，数据包没有导出`，`uncaughtException: null`（修前是 pending + 未捕获异常）。`data.ts` 的 `finally` 释放 `setExporting` / `withOp` 不变。变异：删掉 `zip.on('error', fail)`，`pack-db.test.mjs` 失败（与协调会话核实一致）。 |
| P2-1 导入的知识点树不校验 | **已修** | 新增 `pack/kp-rules.ts`，在 `stage-db.ts:113` 暂存校验里调用（合并和覆盖都先过）。重跑 `rv/k1.mjs`（level 99 / −5、互为父节点、16 万字 note）：暂存阶段被拒，`知识点「X.A」的说明超过 500 个字，已拒绝导入`。`mergeKps` 另按实际挂到的上级重算层级、超 3 层整批拒绝。变异：去掉层级对上级的检查、去掉 note 长度检查、去掉合并后的 3 层检查，`pack-db` 单测都失败；去掉「环」检查**存活**，但那是等价变异——严格递增的层级校验已经保证无环，环检查只是兜底，不算缺口。 |
| P2-2 P3 调用点没有测试 | **已修** | 取数收进不依赖 electron 的 `stats/p3-collect.ts::collectP3Source`，`report/service.ts:50` 只调它。变异：`P3_HOT_LIMIT` 改回 30、`p3-collect.ts` 里的实参改回 30，`report-p3.test.mjs` 两次都失败。 |
| P2-3 重启拦截清单漏通道 | **已修** | `settings:set`、`data:pickPack` 已进 `WRITE_CHANNELS`；分类抽到 `ipc-channels.ts`；新单测 `ipc-guard-audit` 扫 `src/main` 下全部 `ipcMain.handle`，要求每个通道在两张表之一、不能两表都在、表里不能有不存在的通道、导出期间拦的通道必须是写入类。变异：去掉这两个通道各自被抓到。 |
| P2-4 启动时 journal 恢复失败只写控制台 | **已修**（有两处文案小问题，见 P2-C） | `db.ts` 把结果记进 `startupNotice`，`app:info` 返回，`RestartGate` 启动时弹窗；恢复抛错、journal 不认都会提示。 |
| P2-5 journal 校验过松 | **已修** | `inspectJournal`：`filesRel` 必须恰好是 `files`，`backupFilesRel` 必须匹配 `backups/pre-import-<8位>-<6位>[-<4位hex>]/files`，反斜杠写法（Windows 写出的 journal）经 `norm` 后也认。复审时能通过的 `db.sqlite`、`samefiles` 写法现在都是 `invalid`（`rv/j1.mjs` tamper 全部为 null）。变异：去掉任一条检查，单测失败。四个时间点的恢复（未改名 / 旧目录已改名 / 两者都换完 / 已提交）我重跑过，行为都对且幂等。 |
| P2-6 导入的自定义提示词静默生效 | **已修** | `ImportReport.promptsImported / promptsKeptLocal`，结果弹窗里两条提示（`DataSettings.tsx:212-213`）；变异（去掉计数）被抓到。 |
| P2-7 解包错误归因 | **已修** | `reader.ts` 的 `ioProblem`：`ENOSPC/EDQUOT`、`EACCES/EPERM/EROFS`、`EBUSY/ETXTBSY`、`EMFILE`、`EIO` 分别给话，读包与写暂存区分文案，认不出来才说「已损坏」；`openZip`、`openStream`、`z.on('error')`、条目内的 catch、建暂存目录都接入。变异（去掉 `ENOSPC`）被抓到。 |
| P2-8 迁移不带 `backups/` | **已修** | `data.ts:218-224` 迁移时复制 `backups/`；失败清理也包含它。见第二节第 5 条对「会不会误删源目录」的核对：不会。 |

---

## 二、二轮新增代码核对

### 1. `pack/kp-rules.ts`

规则与 `taxonomy/edit.ts` 一致（层级 1–3、子 = 父 + 1、根 = 第 1 层、父在包内、名称 1–30、说明 ≤ 500、引入年级 1–6 或空、代码不重复、总数 ≤ 5000）。我核对了本机产生知识点的所有路径，确保**本机自己导出的包不会被自己的校验拒绝**：内置种子（名称最长 21 字、说明最长 62 字、年级 3–6）；编辑器 add / update（zod 限 60 字，`cleanName` 再限 30；说明 zod 限 500）；move / merge 之后 `setLevels` 重算层级；采纳 AI 建议（名称 ≤ 30、父在第 3 层时挂到上一级）。没有发现会误拒的情形。单测的 10 种坏树和我的变异结果一致。

残余（P2-B）：只限制了长度，没限制「单行 / 可打印」和代码格式——见第三节。

### 2. `ipc-channels.ts` + `restart.ts` 的通道分类

对 `READONLY_CHANNELS` 里每个通道逐个看了实现，有没有写入类被归成只读：

- `ai:test`：`testConnection` 会 `recordUsage` 往 `ai_usage` 写一行（`ai/config.ts:104`），分类注释却写成「只发一次连通测试请求」。写的只是用量日志，重启后丢一行无关紧要，且 `ai:saveConfig` 已拦，所以重启待定期间测连通本来也没意义。记为小项，不影响结论。
- `ai:compareAnalysis`、`report:get`、`report:list`：读取时会回写 `checked_*` 缓存列；缓存可重算，丢了无害。
- `parse:cancel`、`queue:pause`：只改内存状态 / 终止一个本来就在跑的任务。
- `stats:exportMatrix`、`report:export`：只写用户选的文件。
- `data:exportPack`：读旧库写用户选的文件；`data:discardPack`：只清暂存；`data:openBackup`、`settings:openDataDir`、`dialog:openFiles`、`app:restart`：界面动作。

没有真正会改库或改文件目录的通道被归成只读。`WRITE_CHANNELS` 里的 `EXPORT_BLOCKED` 子集校验、audit 单测对以后新增通道的约束都是对的。

### 3. `db.ts` 的 `startupNotice` 与 journal 收紧

我用 `rv/j2.mjs` 跑了「不合规 journal」的两次启动：

- 第一次：`recoverImportJournal` 把 journal 改名为 `import-journal.json.invalid-<时间戳>`，然后抛错，`db.ts` 记成 `failed` 提示；
- 第二次：没有 `import-journal.json` 了，返回 `null`，不再弹。

结论：**不会每次启动都弹**（改名成功的话）；改名失败（目录只读等）时 journal 留在原处，每次启动都会再提示，这正是想要的「没解决就继续提醒」。**也不会丢恢复机会**：合规的 journal（我们自己写的两个位置）仍照原逻辑自动恢复；不合规的 journal 本来就不应该被信任着去改目录，原文件还保留作线索，导入前备份也在。`.invalid-*` 文件没有清理，累积也只会是几个很小的文件。两条文案问题见 P2-C。

### 4. `reader.ts` 的 `ioProblem`

映射表合理，`ENOENT` 只在读包时翻译成「找不到数据包」，写暂存目录的 `ENOENT` 仍归为包问题（那是暂存目录被外力删了，极少见）。真正损坏的 deflate 数据（zlib 错误码是 `Z_DATA_ERROR`）和 yauzl 的格式错误没有 `errno` 码，仍走「已损坏」，不会被误翻成磁盘问题。小问题：条目处理中读压缩包本身的 `EIO` 会走 `ioProblem(e)`（不带 `toRead`），文案变成「写入磁盘时出错」，方向说反了，无害。

### 5. 迁移带走 `backups/` 的失败清理会不会误删源目录的备份

**不会。** 清理只删 `target` 下的 `db.sqlite(-wal/-shm)`、`files`、`backups`、`.migrating`。`backupsTarget = path.join(target, 'backups')`，而 `target` 必须通过 `checkTargetDir`：不是当前数据目录（`isSamePath` 按真实路径、macOS / Windows 不分大小写）、不在它里面、也不是它的上级，并且必须是空文件夹（忽略 `.DS_Store` 等）。因此目标里不可能已有 `backups`，`target/backups` 也不可能就是源的 `backups`。`changeDir` 里会再校验一次，不依赖 `chooseDir` 时的检查。复制全程只读源，没有任何对源目录的删除。唯一代价是迁移时间和空间接近翻倍（已写入 §10）。

### 6. `p3-collect.ts`、`apply.ts` 提示词计数

读过，与旧逻辑等价，没有新问题。

---

## 三、新发现（均为 P2 / 小项，不阻塞）

**P2-A 导出失败路径上 `.part` 在 Windows 可能删不掉**（`exporter.ts:128-135` + catch）：`fail` 里 `out.destroy()` 是异步关闭，紧接着 catch 里 `fs.rmSync(part)`；macOS 上没问题（单测、E2E 都过），Windows 上句柄还没真正关闭时 `rmSync` 会 `EBUSY`/`EPERM`，被 try/catch 吞掉，`.part` 残留（下次导出同名会覆盖，不影响功能）。另外 `unpipe` 之后 `zip.outputStream` 没有销毁，正在读的那个源文件的读句柄要到 GC 才释放。（推断，未在 Windows 验证。）建议：`fail` 里等 `out` 的 `close` 事件之后再 reject，并 `zip.outputStream.destroy()`。

**P2-B 导入的知识点代码 / 名称 / 说明只限长度，不限字符**（`kp-rules.ts:22,28-30`）：**已复现**（直接调 `validateKpRows`）：代码含换行和 `|` 的节点、名称和说明含换行的节点都通过。代码会进 AI 提示词的知识点树文本、`|` 会让 P3 的表格列错位（P3 的 `oneLine` 只处理名称）。影响是有上限的（说明 ≤ 500 字，和本机编辑器一样），比复审时的「16 万字」小得多。建议代码按 `edit.ts` / IPC 的格式（`^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$` 加数字段）校验，名称拒绝控制字符，说明把换行压成空格。

**P2-C `startupNotice` 的两处文案 / 时机问题**（`db.ts:455-463`）：①「备份目录已不存在，保持现状」这一类（崩溃发生在 journal 写好、还没改名之前，文件一个字没动）被归为 `failed`，弹窗说「文件和数据库可能对不上」，是误报（`rv/j1.mjs` 的 a 阶段）；②提交之后只是 `clearJournal` 失败，也会说「自动恢复没有成功」，实际数据是对的。两者都应该走 `recovered` 类的温和文案。③提示保存在主进程内存里且从不清除，页面重载 / macOS 关窗再开窗会再弹一次，直到下次重启；用户点「知道了」后可以在主进程里清掉。

**小项**：①`ai:test` 的分类注释与事实不符（见第二节 2）；②解包时读压缩包的 `EIO` 文案方向说反（见第二节 4）；③`.invalid-*` journal 不会自动清理。

---

## 四、给下一步的建议

1. 通过，可以提交。上述 P2 建议在 M5 前顺手处理，P2-A 若要在 Windows 上做发布前验证，请一并实测。
2. 完整 E2E 由协调会话在跑；本次三审没有读 E2E 结果以外的运行产物，二轮新增的 E2E（导出失败两条、启动提示两条、迁移带 backups）我只读过断言，没有重跑。
