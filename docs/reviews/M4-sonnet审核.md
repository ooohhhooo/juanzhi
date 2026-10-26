# M4 审核报告（Sonnet 5.5，新上下文，未参与编码）

> 审核对象：相对 `96b01bd` 的未提交工作区（`git diff 96b01bd` + 未跟踪文件，忽略 png / `last-result*.json`）。
> 对照物：`docs/M4-交付说明.md`、`docs/设计方案.md`（§2 / §3 / §5 / IPC 表）、`docs/prompts/v1-sonnet改写.md` P3 与 §7、M3 三份审核报告的标准。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（22 组全过）。**没有**跑 E2E（协调会话在跑；`tests/e2e/last-result-m4.json` 158 条全 pass，只读过）、没有启动 Electron、没有调用真实 AI、没有改任何项目文件（只写了本报告）。
> 复现脚本在 `$TMPDIR/rv4/`（= `/private/tmp/claude-501/rv4/`，不入库）：`s1.mjs`（示例报告随包导出）、`s2.mjs`（提交后失败的覆盖导入）、`s3.mjs`（恶意设置 / 示例报告导入 / 空知识点树覆盖）、`s4.mjs`（P3 易错点表被截断）。全部用项目的真实模块和真实迁移（`tests/unit/helpers`）。

## 结论

**不通过。P0 = 0，P1 = 5。**

数据包导入的几道主防线（zip slip、符号链接、炸弹、白名单、触发器 / 视图、按列拷贝、导入前备份和失败回滚）我逐条看了代码，没有找到绕过；`pack/reader.ts`、`pack/stage-db.ts`、`pack/names.ts` 的质量明显高于一般水平。问题出在防线**之外**：导入的**设置值没有校验**（能让 AI 功能永久报错且界面里恢复不了）、覆盖导入**提交之后**的一个失败点会把文件目录换回旧的而数据库已是新的、导出包里**带着示例数据产生的报告**、P3 的易错点表在知识点多一点时**直接漏掉**、以及数据目录更改后「需要重启」的拦截在 macOS 关窗再开时**失效**。另外有若干测试写死为真或空转的断言（P2）。

---

## P1

### P1-1 覆盖导入：COMMIT 之后任何一步抛错，会把 files/ 换回旧的，而数据库已经是新的（且提示「已全部撤销」）

- 位置：`src/main/pack/apply.ts:378-380`（`COMMIT` → `inTx = false` → `clearJournal(...)` 都在同一个 `try` 里）与 `:383-395`（catch 里 `if (swapped) revertSwap(...)`）。
- 问题：`db.exec('COMMIT'); inTx = false` 之后紧跟的 `clearJournal`（`fs.rmSync(journal, {force:true})`，**没有重试**）如果抛错（Windows 上杀毒 / 索引器占着文件，`EPERM` / `EBUSY` 很常见），catch 分支并不知道事务已经提交：`inTx` 是 false 所以不 ROLLBACK，但 `swapped` 是 true 所以照样 `revertSwap`——把**新 files 目录挪回暂存目录、把备份里的旧 files 换回来**。结果：数据库里是数据包的数据，磁盘上是旧文件；随后 `data:importPack` 的 catch 调 `discardPending()` 把暂存目录（现在装着数据包的页面图和原件）整个删掉；`reverted = true` 还会把刚做好的备份目录一起删掉。界面上显示「导入失败，已全部撤销，现有数据没有变化」，**这句话是假的**。
- 复现（**已复现**，`s2.mjs`）：A 环境导出一个包，B 环境（有一份「B卷」和它的文件）走 `extractPack → prepareStagedDb → applyOverwrite`，在调用前把 `fs.rmSync` 换成「路径以 `import-journal.json` 结尾时抛 `EPERM`」。输出：
  ```
  error: 导入失败，已全部撤销，现有数据没有变化：EPERM ... 已把 files 目录换回导入之前的
  B after: papers in DB: [ 'A卷' ]                 ← 库是新的
  files on disk: [ '…0003' ]（idA 目录不存在，idB 目录存在）   ← 文件是旧的
  backups: false                                  ← 备份也被删了
  marker in settings: "a6237b51-…"                ← 库里已经有这次导入的 marker
  ```
- 影响：新导入的卷子没有页面图和原件（截图、重新提取、导出都坏），备份没了，用户被告知「没变化」。数据包原文件还在，所以不是不可恢复，但老师不会知道要重导，所以按 P1 而不是 P2。
- 建议：`COMMIT` 成功后立即设 `committed = true`，之后的 `clearJournal / pruneBackups / dirBytes` 全部各自 `try/catch` 只记日志（journal 残留无害：下次启动 `recoverImportJournal` 看到 marker 一致就只清 journal）；catch 里 `if (committed) return report`。再补一条单测：对 `clearJournal` 注入失败，断言 DB 与 files 仍是新的、没有撤销。顺手给 `clearJournal` / 目录改名加几次短重试（Windows）。

### P1-2 导入的 settings 值完全不校验：`ai_prompts` 为 `null`（或类型错）会让所有 AI 功能报错，而且在界面里恢复不了

- 位置：`src/main/pack/apply.ts:247`（合并 `INSERT OR IGNORE … SELECT value_json`）与 `:354`（覆盖 `INSERT OR REPLACE`）；消费方 `src/main/ai/prompts.ts:57-61`（`overrides()`）。
- 问题：白名单只限制了「哪几个键」，没限制「值长什么样」。`overrides()` 是 `try { return JSON.parse(row.value_json) } catch { return {} }`——`'null'`、`'"abc"'`、`'5'` 都能 `JSON.parse` 成功，返回 `null` 等非对象。随后 `promptText()`（`overrides()[k]`）、`promptViews()`（设置 → 提示词页）、`savePrompt()` / `resetPrompt()`（`const o = overrides(); delete o[...]` / `o[k] = text`）全部 `TypeError`。也就是：P1 解析、P2、P3 的取提示词都崩，**设置里「恢复默认」也崩**，只能手工改 SQLite。值是对象但里面不是字符串（`{"p3_report.user": 5}`）也会让 `fillTemplate` 崩。另外导入的提示词绕过了 `savePrompt` 的必需占位符、P1 的 `json` 字样、6 万字上限三项校验。
- 复现（**已复现**，`s3.mjs` V1）：构造 `settings.ai_prompts = 'null'` 的包，真实走 `extractPack → prepareStagedDb → applyMerge`，B 库里 `ai_prompts` 行就是 `null`；用与 `overrides()` 相同的两行代码读取后 `o['p3_report.user']` 抛 `Cannot read properties of null`。（`prompts.ts` 依赖 electron，没法在脚本里直接 import，所以这一步是等价代码重放。）
- 影响：交付说明把数据包当作「不可信输入」来防，这是一条能持久瘫痪核心功能的路径（拿到的包是别人发来的、或者传输中损坏时都会遇到）。
- 建议：导入这四个设置键时按键做 schema 校验（`ai_prompts` = `Record<有效 id.part, string(≤6万字)>`，其余键按 `settings:set` 同样的类型规则），不合格的**丢弃并在报告 warnings 里说明**；同时让 `overrides()` 在结果不是纯对象时返回 `{}`（防御读取侧）。补单测。

### P1-3 示例数据产生的 P3 报告 / P2 分析缓存会被导出进数据包，导入后出现在对方的报告历史里（与交付说明 §3.3「示例数据不进包 ✅」不符）

- 位置：`src/main/pack/exporter.ts:50-56`（只 `DELETE FROM papers WHERE is_sample = 1`，没动 `reports` / `ai_analyses`）；对照 `src/main/sample/load.ts:107-108`（清除示例数据时按 `"sample":true` 删这两张表——说明作者知道它们属于示例数据）。
- 问题：用示例数据范围生成过 P3 报告（或 P2 分析）的电脑，导出的包里带着这些行（markdown 里引用着示例卷的题号）。导入（合并和覆盖都会拷贝 reports；覆盖还会拷贝 `ai_analyses`）后，对方的「AI 报告」历史里多出一条「示例数据 · 考情分析报告」，标「已过期」，而对方可能根本没加载过示例数据；之后若加载示例数据，引用的题号（示例 id 是确定性 UUID）会「复活」。这违反任务书「示例数据……不混入真实统计 / 数据包导出」，也让交付说明的 ✅ 不实。
- 复现（**已复现**，`s1.mjs`、`s3.mjs` V4）：库里有 1 份真实卷 + 1 份示例卷 + 一条 `filter_json = {"sample":true}` 的报告 + 一条示例 `ai_analyses`；`makeCleanSnapshot` 之后快照里 `papers`=1，但示例报告=1、示例 `ai_analyses`=1；把这个包合并导入到空库，B 库里 `reports WHERE filter_json LIKE '%"sample":true%'` = 1。
- 测试为什么没抓到：单测 `pack-db` 和 E2E「示例数据 导出」只断言 `is_sample` 的卷子 / 文件不在包里，没有造示例报告。
- 建议：导出快照里加 `DELETE FROM reports WHERE filter_json LIKE '%"sample":true%'` 与 `ai_analyses` 同样处理；导入侧（不可信输入）也丢掉 `filter_json` 带 `sample:true` 的报告 / 分析行。补一条「有示例报告时导出 → 包里没有」的单测。

### P1-4 P3「易错点」表只在前 30 个二级知识点里找，真正最易错的知识点可能整表缺失

- 位置：`src/main/report/service.ts:51`（`hot(db, filter, 2, 30, undefined, false)`——第 4 个参数是**按优先级截断的行数**）→ `src/main/stats/p3.ts:103`（`hot.rows.filter(h => h.errorCount > 0)…slice(0, 10)`）。
- 问题：`hot()` 先按 `priority`（出现率 × 分值占比 ×（1+易错加权））排序再 `slice(0, limit)`；P3 只拿到前 30 个二级知识点，再从里面挑「有易错题的」。二级节点内置就有 67 个，500 份卷子的库里很容易超过 30。优先级低（出现得少、分值小）但**易错题最多**的节点掉出前 30，就不会出现在 `ERROR_PRONE` 里；没有任何节点在前 30 里有易错题时，占位符是「（无）」，模型会写「没有突出的易错点」——和看板（全量）及交付说明 §3.1「易错点表 = 有易错题的二级知识点集合」都对不上。
- 复现（**已复现**，`s4.mjs`）：5 份卷子 × 35 个高频二级节点（无易错题），另有一个只在 1 份卷子里出现、有 2 道易错题的二级节点 X。`distribution` 里 X 的 `errorCount = 2`；`hot(…, 30)` 里没有 X；`buildP3Input(...).placeholders.ERROR_PRONE` 为 `（无）`；`hot(…, 1000)` 里 X 排第 36。
- 测试为什么没抓到：E2E 夹具总共只用到 17 个知识点代码（`fixtures-m3.cjs`），单测的几套数据集同理，永远到不了 30。
- 建议：取全量（`limit` 传足够大，或单独对 `errorCount > 0` 的节点查），再自己排序取前 10；补一个 >30 个二级节点的单测（上面的构造即可）。

### P1-5 更改数据目录后的「需要重启」拦截只存在于当前渲染进程：macOS 关窗再点 Dock 图标，或重载窗口，拦截就没了，老师继续在旧目录里工作

- 位置：`src/renderer/stats/restartStore.ts`（状态只在内存）、`src/renderer/components/RestartGate.tsx`；主进程已经提供了 `restartPending`（`ipc/data.ts:37,69,75`，`env.d.ts:454,469`）但**渲染端没有任何地方读它**（`grep restartPending src/renderer` 只有类型声明）；`src/main/index.ts:154-161,159-161`（macOS 关闭窗口不退出，`activate` 时 `createWindow()` 新建渲染进程）。
- 问题：迁移 / 切换完成后，配置文件已指向新目录，但主进程内存里（`dataDirResolved`、已打开的数据库连接、队列）仍是旧目录。拦截弹窗是渲染端的内存状态；老师点左上角红点关掉窗口再点 Dock 图标（或 `Cmd+R` 重载），弹窗消失，后续导入 / 审核 / 加载示例数据全部写进**旧**目录；真正重启后换成新目录，这些新工作「不见了」。交付说明 §6-6 承认拦截只在界面层，但没有提到这条最常见的 macOS 绕过路径；而交付说明又建议老师「确认新目录没问题后自己删掉旧目录」——组合起来就是丢数据。
- 复现：**推断**（代码路径明确，未启动应用）。步骤：设置 → 更改数据目录 → 迁移到空文件夹 → 弹出重启提示 → 关闭窗口 → 点 Dock 图标 → 窗口正常可用，`app:info.restartPending === true` 但界面不拦。
- 建议：`RestartGate` 挂载时调 `window.api.app.info()`，`restartPending` 为 true 就直接显示拦截（并把 `target/oldDir` 一并由主进程返回）；更稳妥的是主进程在 `restartPending` 后对所有写入类 IPC 直接拒绝。补一个 E2E：迁移后 `page.reload()` 拦截仍在。

---

## P2

1. **E2E 里写死为真 / 空转的断言**（`tests/e2e/m4-phases-data.cjs`）：
   - `:111` 与 `:149`：`!fs.existsSync(path.join(dataDirOf(), '.import-staging', 'x'))` ——`x` 目录从来不存在，这个条件永远为真；「暂存目录已清掉」在往返导入和覆盖回滚这两处**实际上没有被检查**（只有最后恶意包那一条检查了 `.import-staging` 是否为空）。
   - `:167`「本机的 AI 设置不被覆盖：覆盖后 B 里仍没有密钥」：B 本来就没有密钥（全新 userData），包里也不会有，所以这条断言在「覆盖导入把密钥冲掉」的坏实现下同样通过；真正的检查只在单测 `pack-db.test.mjs:359-381`。交付说明 §3.5 写的验证方式是「单测 + E2E」，E2E 部分是空的。
   - `:182`「数据库版本过新」的预期正则是 `更新版本的软件|数据库已损坏|没有通过完整性检查`，把 `user_version` 篡改成 99 后无论走哪条拒绝路径都通过；版本路径本身只被 `pack-db` 单测验证（有，所以只算 P2）。
2. **`data:changeDir` 接受渲染端传来的任意路径**（`ipc/data.ts:180-181`）：导入包的路径特意做成「只能来自系统对话框 + token」（`pickPack` / `importPack`），但更改目录却是 `chooseDir` 返回路径后由页面再传回来。页面脚本（例如将来某处 XSS）可以绕过对话框，把整个库 + 文件复制到任意空目录，或把配置指向任意含 `db.sqlite` 的目录。建议与 `pickPack` 同一套：`chooseDir` 在主进程记下 token，`changeDir` 只收 token。
3. **覆盖导入会清掉本机的自定义提示词 / 偏好**（`apply.ts:344`）：先 `DELETE` 白名单键，包里没有 `ai_prompts` 就等于把本机改过的提示词丢了（备份里只有数据库快照，设置页没有「从备份恢复」）。至少在导入前摘要里写明；更好是包里没有的键保留本机值。
4. **覆盖导入不重新保证内置知识点树存在**（`apply.ts:343,346`）：先 `DELETE FROM main.kps`，再按包里的行拷贝。包里 `kps` 为空（手工构造或损坏）时，本机知识点树被清空，`question_kps` 悬空。**已复现**（`s3.mjs` V3：`kps` 145 → 0）。建议至少在拷贝后断言内置节点数不为零，否则整体回滚。
5. **崩溃恢复的 journal 存的是绝对路径**（`journal.ts:17-24,35-41`）：把数据目录整个拷到别处（比如换盘）而 journal 还在，`recoverImportJournal` 会按旧绝对路径去改名——可能动到旧目录。应存相对数据目录的路径，恢复时校验在 `dataDir` 之内。
6. **覆盖 / 迁移在 Windows 上对文件占用没有任何重试**（`apply.ts:374,376`，`journal.ts`，`data.ts:218`）：目录改名遇到 `EPERM` 会走回滚并报错，不会损坏，但杀毒软件扫描页面图期间会让覆盖导入反复失败。交付说明 §10 已如实写没在 Windows 上测过；建议改名前后加 3–5 次、每次 200ms 的重试。
7. **主线程长时间同步工作**：`node:sqlite` 是同步的，`integrity_check` / `foreign_key_check` / 整个 `apply*` 都在主进程里；上限定到 2 GiB 库，恶意或很大的包会让整个窗口无响应。另外 `pickPack` 的 `AbortSignal` 参数没有接线（无法取消解包），解包前没有检查磁盘剩余空间（上限 8 GiB 会写进数据目录所在盘）。
8. **导出数据包只在开始时检查 `busyReason`**（`ipc/data.ts:85`）：压缩过程是异步的，期间老师仍可「重新提取」某份旧卷（会重写 `page-N.png`）。快照里的库和打进包里的文件可能不一致。建议导出期间用同一个 `opActive` 拦住提取 / 解析入队（或在 `busyReason` 里加一个「导出中」标志）。
9. **导出的 Markdown 原样带着模型输出里的 HTML**（`export-plan.ts`，`export.ts`）：应用内渲染和 PDF 都是转义的，没问题；但 `.md` 文件里模型输出的 `<script>` / `<img onerror>` 原样写出，用会渲染 HTML 的 Markdown 查看器打开（Typora 等）会执行。建议导出时把裸的 `<` 转成 `&lt;`（或至少剥掉标签）。
10. **知识点树**：(a) 允许**停用**内置节点及其整棵子树（`edit.ts:181-186`），对老师而言和「删除」等效（从审核选择器和 AI 提示词里消失），而任务书是「内置节点只能改名」；交付说明 §6-3 已列为待确认，我倾向收紧，至少停用内置一级节点要二次确认。(b) 重新启用一个已停用的节点时不检查同级重名（`:187-192` 没有 `sameNameSibling`），可以造出两个同名同级节点。(c) 自建知识点名称允许含 `|` 和换行，而 P3 的 `KP_DIST` 是按 `|` 分列的文本表，`row()` 没有像易错原因那样过 `oneLine`（`p3.ts:95`），表格会错列。
11. **合并导入信任包里新节点的 `builtin` 标志**（`apply.ts:98,125`）：包里的自建节点标成 `builtin=1` 会变成「不能删除、不能移动」。应一律按 `builtin=0` 写入，除非代码在本机内置种子里。
12. **没有完成标记的迁移目标目录**：数据目录「迁移」中途崩溃（进程被杀，不是抛错）会在目标里留下完整的 `db.sqlite` 和不完整的 `files/`，下次选这个目录会被识别为「已有数据目录」并可直接使用。建议先写 `.migrating` 标记，成功后再删。
13. **导入的 JSON 列有几处没有保护**：`ipc/papers.ts:88`（`JSON.parse(ai_meta_json)`）、`parse/run.ts:401`（`JSON.parse(last.result_json)`）；包里这两列是垃圾时，编辑该卷或「仅重新定位」会抛错。其余读取点都有 try/catch。
14. **`ui_*` 设置在导入时同样无校验**（`ui_theme` 等当前没有消费方所以无害，但与 P1-2 同源）。

---

## 已核对、没发现问题的要点

**数据包导入的防御（读了 `names.ts` / `reader.ts` / `stage-db.ts` / `apply.ts` / `journal.ts`，并对照单测的覆盖）**
- 条目名走正则白名单，再用分类结果拼目标路径，且校验仍在暂存目录内；`..`、绝对路径、盘符、`\`、控制字符、大小写 / Unicode 变体（名字必须匹配小写 ASCII UUID 与固定文件名）、尾部 `/` 的伪目录、`manifest.json/` 之类变体都被拒绝。yauzl 开了 `validateEntrySizes` 与 `strictFileNames`；中央目录与本地头不一致时 yauzl 只信中央目录的名字和偏移，本地头名字不被使用。
- 符号链接：按 Unix 模式位拒绝；即便标成 FAT 绕过，也只会被当作普通文件写出（`createWriteStream(..., 'wx')`，不会创建链接）。
- zip 炸弹：条目数、单文件、数据库、manifest、总量都按**实际解出的字节**限制；头部撒谎的单测存在。限制数值偏宽（8 GiB）见 P2-7。
- 暂存库：先 `integrity_check`，再版本检查（新于本程序拒绝、旧的在副本上迁移），再删光触发器 / 视图（迁移前后各一次），再校验必需表列、UUID、页面图 / 附件路径格式、`foreign_key_check`；然后只做 `INSERT INTO main.t (列…) SELECT 列… FROM pk.t`（两边都有的列）。包里的 trigger / view / 额外表 / 虚拟表不会进入主库；`ATTACH` 只用固定别名和参数化路径。
- 导出：`settings` 用白名单而不是黑名单，二次 `VACUUM INTO` + `secure_delete`；快照里搜不到密钥密文。`papers.file_name` 等列只当数据显示，没有任何地方拿来拼文件路径（我 grep 过 `getFilesDir` 的 13 处用法，路径都由 UUID + 固定文件名拼成）。
- 覆盖导入的回滚：除 P1-1 的「提交之后」这一窗口外，故障注入点之前的失败路径（`after-db` / `after-swap`、备份失败、`ROLLBACK`、`revertSwap`）逻辑正确；崩溃恢复靠库里的 marker 判定「是否已提交」，三种崩溃时刻（journal 已写未改名、改了一半、改完未提交）我手推都对。
- 合并去重：按 `papers.id`；同 `file_hash` 不同 id 的保留两条并标 `duplicate_of`，统计走 M3 口径只算一份；题目 id 撞车拒绝；`question_kps` 只带新卷子的题；自建知识点编号撞车时换号并重映射标注（含重映射后重复行的 `OR IGNORE` 与主知识点优先）。导入后 `bumpRev`，`checked_*` 置空，报告是否「最新」由实际文本判断。

**新 IPC / 协议 / 渲染**
- 所有新 IPC：`taxonomy:save` 的每个操作都是 `.strict()` 且代码走正则；`report:*` 的筛选用 `StatsFilterSchema`（`.strict()`，含新增的 `sample`）；`data:*` 的 token / 模式 / 备份名各自 zod 校验；`ai:cancel` 要求 UUID。（`changeDir` 的路径来源问题见 P2-2。）
- 报告渲染：`MarkdownView` 全部以 React 文本节点输出，没有 `dangerouslySetInnerHTML`（全仓 grep 过）；PDF 用的 `mdhtml.ts` 对所有文字转义，页面无脚本，打印窗口 `javascript:false` + `sandbox`；引用裁图的 `paperId` / `pageRel` 在 `cropForRef` 里按固定格式再校验一次，来自导入报告的 `refs_json` 也走不出文件目录。
- `ewb://` 协议未改，仍只放行 `page-N.png` / `media/N.ext`，且拼路径后校验在 `files/` 内。
- 流式竞态：`reportStore` 两条通道（事件 / 返回值）的收尾幂等；`activeId` 过滤迟到的 chunk；主进程同一时间只允许一份报告（`inflight`），`busy` 的返回有 E2E；生成中 `busyReason()` 拒绝导入 / 迁移，导入是同步的，期间插不进别的请求。

**口径**
- P3 占位符的数字来自 `distribution` / `hot` / `compare`，筛选范围走 `paperScope`（去重、学期对齐、`is_sample` 隔离），除 P1-4 的截断外与看板同口径；`SAMPLE_WARNING` 由程序判定，兜底插入逻辑合理（注意它依赖「样本 / 混入 / 仅供参考」三个词，模型头部碰巧写了别的含义的同字会漏补，影响很小）。
- 示例数据隔离：`paperScope`、`filterOptions`、`previewReport`、`overview` / `matrix` / CSV 导出都走同一个 `is_sample` 条件；唯一的口子是 P1-3（报告 / 分析行）。
- 迁移 v9 只新增，v1–v8 未动；`trg_rev_papers_u` 重建后 `is_sample` 在列表里。

**测试**
- `typecheck` 通过；`test:unit` 22 组全过；`last-result-m4.json` 158 条全 pass，数量与交付说明一致（E2E 我没有重跑）。
- 交付说明里标 ⚠️ / ❌ 的项（Windows、崩溃恢复没真杀进程、「立即重启」、配置目录不可用的启动对话框、旧版本包没有 E2E）确实没有断言，说明与事实相符。

---

## 建议的修复优先级

1. P1-1（提交后失败）、P1-2（设置校验）、P1-3（示例报告）：都是几行改动 + 一条单测，建议一起改。
2. P1-4：取全量热点；单测构造 >30 个二级节点。
3. P1-5：`RestartGate` 读 `restartPending`（一行）+ 一条 E2E。
4. P2-1 的三条空转断言顺手改成真检查；P2-2、P2-4、P2-11 都是小改动，建议同批处理。

修完后请再审一次 P1-1 / P1-2 / P1-3 的单测是否真会在回退修复时失败（我的复现脚本可直接改成单测）。
