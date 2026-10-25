# M1 里程碑审核报告

- 审核人：Sonnet 5.5（只读审核，未改动任何代码文件）
- 审核对象：`/Volumes/Elements/Claude/english-exam-workbench/`，对照 `docs/设计方案.md` 第 2、3、5、9 节与 `docs/M1-交付说明.md`
- 已做验证：通读 `src/main/**`、`src/preload/**`、`src/renderer/**`、`native/macos/ocr.swift`、`electron.vite.config.ts`、`package.json`；运行 `npm run typecheck`（通过）；只读检查两个 userData 目录及其中的 SQLite（拷贝后查询）、`out/` 构建产物、`ewb-ocr` 二进制（universal，minos 13.0，ad-hoc 签名）
- 未验证：GUI 实际运行、Windows 行为、打包后行为（仓库里没有任何 electron-builder 配置，无法验证）
- 说明：Vision OCR 在我的沙箱内无法运行（返回 GenericObjCError），这是沙箱限制，不计入问题。

## 总体结论

**Pass after fixes（修完 P0 后可进入 M2）。**

骨架本身是通的：`node:sqlite` 能用，没有任何原生模块依赖；点“导入试卷”按钮（走系统对话框）这条路径在 Mac 上跑通了（3 份样本，库里 `papers/pages` 数据与交付说明一致）；ewb:// 协议有路径防护；contextIsolation / sandbox / 禁 nodeIntegration 都开着；typecheck 通过。

但交付说明有若干条与事实不符，且存在会直接影响 M2 的结构性问题：
1. 拖拽导入和点击选择在 Electron 45 下是坏的。
2. 隐藏的 PDF 渲染窗口会破坏主窗口生命周期（Mac Dock 激活失效、Win 关窗后进程不退）。
3. “提取中”状态没有任何恢复机制。
4. PDF 文本层被丢弃，M2 的“文本版 P1”拿不到输入。
5. Windows OCR 完全不存在，并且在 Windows 上会静默产出“已完成但没有文字”的试卷。

下面共 **6 个 P0、14 个 P1、11 个 P2**。

---

## 关于“两个数据目录”的判断

**判断：是 bug（潜在的配置缺陷），不是正常现象。** 只是后果目前较轻。

事实：
- `~/Library/Application Support/Electron/workbench-data/`：`db.sqlite` 仅 4096 字节，**没有任何表**（我拷贝后用 sqlite3 查过，`no such table: settings`），`files/` 为空；同级有 Chromium 的 `Local State`、`GPUPersistentCache`，说明当时确实有一个完整的 Electron 进程以名字 “Electron” 跑起来过。
- `~/Library/Application Support/english-exam-workbench/workbench-data/`：8 张表、`schema_version=1`、3 份试卷，均为 `done`。

原因：`db.ts:106-109` 的数据目录取自 `app.getPath('userData')`，而 userData 取决于 Electron 在运行时解析出的应用名。从项目根目录以 `electron .` / `electron-vite dev` 启动时，名字取自 package.json 的 `name`（`english-exam-workbench`）。如果用 `electron out/main/index.js` 之类的方式直接指向入口文件，或从别的 cwd 启动，就会退回到默认名 “Electron”。代码里没有 `app.setName()` / `app.setPath('userData', …)`，package.json 也没有 `productName`。

后果：
- 同一台机器上，换一种启动方式就换一个数据目录，用户会觉得“试卷全没了”。
- 开发数据与将来正式版的数据没有隔离。
- 另外，“Electron”目录里那个无表的库不是当前 `initDatabase()` 能正常产生的状态：它在 `db.ts:142` 开 WAL 之后，会马上走到 `db.ts:156` 建表。因此它大概率来自更早版本的代码或被中断的一次启动。这一点我无法完全确定。
- 这也说明 `initDatabase` 不是原子的（见 P1-10）。

修复建议：见 P1-1。可以直接删掉 “Electron” 那个目录。

---

## P0（进入 M2 前必须修）

### P0-1　拖拽导入、点击选择导入在 Electron 45 下完全失效，交付说明却写“已完成”

- 位置：`src/renderer/pages/PaperLibrary.tsx:62-74`（`handleDrop`），`:196-207`（Dragger）；`src/preload/index.ts` 没有暴露取路径的方法
- 问题：`handleDrop` 依赖 `file.originFileObj.path`。`File.path` 在 Electron 32 起已被移除，Electron 45 里恒为 `undefined`。代码在拿不到 path 时只是 `files.length === 0` 然后什么都不做，**没有任何提示**。另外：
  - 点击 Dragger 区域会弹出浏览器原生文件选择框，同样没有 path，同样静默无反应，而界面文案写着“拖拽到此处，或点击选择”。
  - 即便修好 path，antd `onChange` 在多文件拖入时会按文件逐个触发，`info.fileList.length = 0` 的写法既在改 props 又拦不住并发调用，会导致同一批文件被重复提交，后面的撞上“重复导入”报错。
- 触发场景：把任意 PDF 拖进“试卷库”。什么都没发生。
- 建议：
  1. preload 暴露 `getPathForFile: (f: File) => webUtils.getPathForFile(f)`。
  2. 去掉 antd Dragger 的上传语义，改成自己的 `onDragOver/onDrop` 区域，一次 drop 事件里同步取全部路径，再一次性调用 `papers.import`。
  3. 点击区域改为调用 `dialog.openFiles`。
  4. 拿不到路径时给出明确提示。
  5. 交付说明里“拖拽上传”一项需要更正，验收要补一条拖拽用例。

### P0-2　隐藏的 PDF 渲染窗口会被当成“普通窗口”，破坏应用生命周期

- 位置：`src/main/pipeline/pdf-renderer.ts:23`（`new BrowserWindow({show:false, offscreen:true})`）、`src/main/index.ts:54-58`（`activate`）、`:61-67`（`window-all-closed`）
- 问题：隐藏窗口一旦创建（第一次导入 PDF 时），就会常驻在 `BrowserWindow.getAllWindows()` 里。
  - Mac：用户关闭主窗口后点 Dock 图标，`activate` 里判断 `getAllWindows().length === 0` 为 false，**不会重建主窗口**，应用像“死了”一样。
  - Windows/Linux：关闭主窗口后 `window-all-closed` 不会触发（还有一个隐藏窗口），`app.quit()` 不会被调用，**进程残留**，SQLite 文件仍被占用，下次启动会撞到文件锁。`destroyPdfRenderer()` 只写在 `window-all-closed` 里，永远走不到。
  - 另外 `papers.ts:17-20` 的 `data:changed` 也会广播给这个隐藏窗口。
- 触发场景：导入一份 PDF，然后点红叉关闭主窗口。
- 建议：
  - 用 `BrowserWindow.getAllWindows().filter(w => w !== pdfWin)`，或者记录主窗口引用 `mainWindow` 并以其为准判断 `activate` 和是否退出。
  - 在 `before-quit` / `will-quit` 里销毁渲染窗口。
  - 广播事件只发给主窗口的 `webContents`。
  - 长期方案：按设计文档把 pdfjs 放进真正的渲染进程或 utility 进程，避免隐藏窗口。

### P0-3　macOS 关闭窗口就关闭数据库，再从 Dock 激活后所有 IPC 报错

- 位置：`src/main/index.ts:61-67`
- 问题：`window-all-closed` 里无条件 `closeDatabase()`，但 `process.platform === 'darwin'` 时 app 不退出。之后 `activate` 只重建窗口，不会重新 `initDatabase()`，`getDb()` 抛“数据库未初始化”。当前这个 bug 被 P0-2 掩盖了：只有在没导入过 PDF（例如只导入图片）时才会触发，修了 P0-2 之后就会稳定触发。
- 触发场景：只导入 PNG → 关闭窗口 → 点 Dock 图标 → 试卷库全部加载失败。
- 建议：数据库只在 `before-quit` / `will-quit` 里关闭；`window-all-closed` 只负责非 Mac 平台 `app.quit()`。

### P0-4　“提取中”没有恢复机制：崩溃/退出后永久卡死，失败项还不能重新导入

- 位置：`src/main/pipeline/extract.ts:62-93`；`src/main/index.ts:47-52`；`src/main/pipeline/ocr.ts:22`；`src/main/pipeline/pdf-renderer.ts:64-107`
- 问题（合在一起是“状态卡死”问题）：
  1. 启动时没有任何“把 `extracting` 扫回 `failed/imported`”的清理。应用在提取中被关闭或崩溃，试卷永远显示“提取中”。
  2. 没有 `papers.reprocess` / 重试入口（设计文档 IPC 表里有）。
  3. 重复检测（`:50-54`）不排除 `failed` 状态的行，因此提取失败的文件**无法再次导入**，只能先删除。而删除又不会清理磁盘文件（P1-5）。
  4. `execFile` 没有 `timeout`（`ocr.ts:22`），`executeJavaScript` 没有超时，PDF.js 或 Vision 一旦挂住，导入 IPC 永远不返回，界面一直转圈，状态永远 `extracting`。
  5. 失败时之前已写入的 `pages` 行不会清理（见 P1-9），重试会产生重复页。
- 触发场景：导入 20 份 PDF 的过程中关闭应用；或遇到一个加密 PDF/损坏 PDF 之后想修好文件重新导入。
- 建议：
  - 启动时执行 `UPDATE papers SET status='failed', error='上次提取被中断' WHERE status='extracting'`。
  - 给 OCR 和 PDF 渲染加超时（例如每页 60s），超时按失败处理。
  - 实现 `papers.reprocess(id)`，重试时先清空该纸的 `pages` 和渲染图。
  - 重复检测对 `failed` 的行提示“可重试”，而不是直接拒绝。
  - 提取过程用事务（至少是“先清后写”）。

### P0-5　PDF 文本层被丢弃；`text_source` 记录与实际存储内容不符；M2 的“文本版 P1”拿不到输入

- 位置：`src/main/pipeline/extract.ts:109-147`（尤其 `:111`、`:124-131`），`src/main/pipeline/pdf-renderer.ts:93-94`，`src/main/db.ts:28-37`
- 问题：
  - 设计文档的 OCR 分层是“文本层优先，无文本层或文字很少时才 OCR”（第 2 节）。实现是“只要 Mac 上 OCR 可用就**每页都 OCR**”，且 PDF.js 取出的 `rp.text` 只在 OCR 失败时才被当成伪行写入，**其余情况直接丢掉**。对文本型 PDF，更准确、零成本的文本层被扔了，存进去的是 OCR 结果（我在库里核对过：样本 PDF 的 `text_source='pdf-text+ocr'`，`lines_json` 来自 Vision）。
  - `text_source='pdf-text+ocr'` 这个值既不在设计文档（`pdf-text / ocr / vision`）中，也名不副实：它不是“两者合并”，只是“有文本层但存的是 OCR”。
  - `pages` 表没有任何字段可以存放文本层全文。M2 的文本版 P1 需要 `anchor`（从原文逐字拷贝）来定位题目，必须拿到逐字文本。
- 触发场景：M2 开始实现 P1 解析时，发现对文本 PDF 只有 OCR 文本（可能有错字，影响 `anchor` 匹配），文本层已经不在库里。
- 建议：
  - `pages` 增加 `text` 列（或 `text_layer`），保存 PDF 文本层原文；`lines_json` 只放带坐标的行。
  - 判定规则按设计文档执行：文本充足 → `text_source='pdf-text'`，不跑 OCR（需要坐标时再按需 OCR）；不足 → `ocr`。
  - 废弃 `pdf-text+ocr`，或在设计文档中显式定义。
  - 考虑用 pdf.js 的 `item.transform` 直接生成文本层的行坐标，这样文本 PDF 的叠加层也有真实坐标。

### P0-6　Windows OCR 完全缺失；且在 Windows 上会静默产出“已完成但没有文字”的试卷、并用伪造坐标画叠加框

- 位置：整个仓库没有 `.ps1` 或任何 Windows OCR 脚本（`find . -name '*.ps1'` 为空，`native/` 下只有 `macos/`）；`src/main/pipeline/ocr.ts:37-39`（`isOcrAvailable()` 只判断 `darwin`）；`src/main/pipeline/extract.ts:133-135`、`:170-180`、`:213-221`
- 问题：
  - 你给的 M1 范围写明包含 Windows.Media.Ocr 的 PowerShell 5.1 脚本。仓库里没有。交付说明在“已知限制”里承认“Windows 无 OCR”，但这和范围描述不一致。如果团队决定该脚本放到 M5，请在此明确下调为 P1；但下面“静默失败”的部分无论如何必须在 M1 就修。
  - Windows 上扫描版 PDF/图片：`isOcrAvailable()` 为 false，直接写入 `lines=[]`、`text_source='ocr'`，**状态标 `done`，界面显示“已完成”**，用户完全不知道没有文字。
  - Windows 上文本型 PDF 与 docx：用 `textToFakeLines` 编造坐标（`y = i/n`，固定 `x=0.05,w=0.9`），在详情页的 OCR 叠加层里被当成真实行框渲染，位置是错的，误导截图/定位功能。
- 触发场景：Windows 用户导入一张扫描卷：试卷库显示“已完成”，详情页没有任何文字。
- 建议：
  - 增加 `OcrProvider` 抽象：`{ available(): Promise<{ok, reason}>, recognize(path) }`，Mac/Win 各一份实现。
  - 无 OCR 能力时，页面标记为 `needs_vision`（或试卷状态给出明确提示），而不是静默 `done`。
  - 伪造坐标的行必须标记 `bbox: null`，叠加层只画有真实坐标的行。
  - Windows 脚本（见下方“跨平台”一节的具体要点），建议至少把脚本先写出来并附一个手动验收清单。

---

## P1（应该修）

### P1-1　userData 目录依赖启动方式（见前述判断）

- 位置：`src/main/index.ts`（缺少）、`package.json`（缺少 `productName`）、`src/main/db.ts:106-109`
- 建议：在 `app.whenReady()` 之前执行 `app.setName('english-exam-workbench')`；dev 模式用 `app.setPath('userData', …-dev)` 与正式版隔离；package.json 增加 `productName`；加 `app.requestSingleInstanceLock()`，避免两个实例同时写同一个库。

### P1-2　`job:progress` 没有节流，也没有任何消费者；`data:changed` 在状态变化和失败时不发

- 位置：`src/main/ipc/papers.ts:25-31`（`sendProgress` 直接发送）、`:37-45`（只在成功后 `notifyDataChanged`）；渲染端 `src/renderer/App.tsx:20-31` 只监听 `data:changed`，全仓库 `grep` 没有任何 `job:progress` 的监听
- 问题：
  - 交付说明和任务描述都说“job:progress / data:changed 500ms 节流”，实际只有 `data:changed` 节流，`job:progress` 是逐条直发。
  - 渲染端没有进度 UI，用户只能看到按钮转圈；`papers:import` 要等所有文件处理完才返回，批量导入时表格在整个过程中一行都不更新。
  - 失败路径（`:42-44`）不触发 `notifyDataChanged`，库里已有 `failed` 行但列表不刷新（`PaperLibrary.tsx:54` 虽然手动 `invalidate` 了，但依赖 IPC 返回，批量导入时要等到最后）。
  - `sendProgress` 对不可见窗口（最小化）直接丢弃，恢复窗口后进度丢失。
- 建议：
  - 在状态变化点（`imported→extracting→done/failed`、页面写入）统一调用 `notifyDataChanged('papers'/'pages')`。
  - `job:progress` 按 paperId 做 500ms 合并（最后值覆盖）。
  - 渲染端用一个 `useJobProgress` hook 更新行内进度条。
  - 导入拆成“同步登记 + 异步处理队列”：`papers:import` 复制文件、写 `imported` 行后立即返回，处理走后台队列（设计文档“处理队列”页和 M2 都需要这个形态）。

### P1-3　IPC 参数校验覆盖不全，`settings:set` 可改写内部键，导入路径无来源限制，preload 的 `on` 放开任意通道

- 位置：`src/main/ipc/papers.ts:34`（`papers:import` 无校验）、`:68`、`:95`、`:103`（`id` 全部未校验）；`src/main/ipc/settings.ts:5-17`（`key`/`value` 无校验）；`src/preload/index.ts:32-36`
- 问题：
  - 声称“zod 校验 IPC 参数”，实际只有 `papers:update` 与 `papers:list` 的 filter 用了 zod。`import/get/remove/pages/settings.*` 都没有。
  - `papers:import` 接收渲染端任意路径。扩展名白名单能挡住大部分文件，但仍是“渲染端指定读取本机任意 pdf/png/jpg/docx 并复制到数据目录、再通过 ewb:// 取回”的原语。若渲染端被 XSS，这就是一个本地文件读取通道。
  - `settings:set` 允许写入任何键，包含 `schema_version`（`db.ts:157-159` 用同一张表存）。设成更大的值会让以后的迁移被跳过。
  - `window.api.on(channel, …)` 允许渲染端订阅任意通道，没有白名单。
- 建议：
  - 每个 handler 都用 zod 解析；id 用 `z.string().uuid()`。
  - 导入路径只接受由主进程 `dialog` 返回的、或由 `webUtils.getPathForFile` 拖入后在主进程登记过的路径（维护一个短期 token 集合）。
  - 设置键做白名单，内部状态键（`schema_version`）放进独立表或加前缀并拒绝外部写入。
  - `on` 改成固定的 `onDataChanged / onJobProgress`，或对 channel 做白名单。
  - 统一包一层 `handle(channel, schema, fn)`，让校验不可能被漏掉。

### P1-4　没有 CSP，也没有导航/新窗口限制

- 位置：`src/renderer/index.html`（无 `<meta http-equiv="Content-Security-Policy">`）；`src/main/index.ts:24-45`（无 `setWindowOpenHandler`、`will-navigate`）；`out/renderer/index.html` 同样没有
- 问题：没有 CSP，意味着一旦出现注入，脚本可以随意加载外部资源或执行内联脚本；没有导航限制，意味着页面可以被导向任意 URL，并且仍然带着 preload 暴露的 API。
- 建议：生产环境 CSP 例如 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' ewb: data: blob:; connect-src 'self'`（antd 需要内联样式；dev 模式要为 Vite HMR 放宽）。`will-navigate` 里拒绝非本应用地址；`setWindowOpenHandler` 默认 deny；`session.setPermissionRequestHandler` 默认拒绝。M2 加 AI 请求时，所有网络请求建议放主进程，渲染端 `connect-src` 保持收紧。

### P1-5　`papers:remove` 不删磁盘文件，也不处理“正在提取”的试卷

- 位置：`src/main/ipc/papers.ts:95-101`
- 问题：只删数据库行，`files/<paperId>/` 里的原件与页面 PNG 永远留在磁盘上（数据目录会持续膨胀，用户“删除”后隐私数据仍在）。如果这份试卷正在提取，后台继续 `INSERT INTO pages`，会因外键失败而抛错，catch 里又去 `UPDATE` 一个不存在的行。
- 建议：删除前检查提取状态（提示“正在处理，请稍候”或取消任务）；数据库删除成功后再 `fs.rm(paperDir, {recursive:true, force:true})`（失败只记日志）；`questions` 等依赖 `ON DELETE CASCADE`，所以第 97 行手动删 `pages` 是多余的。

### P1-6　迁移机制不是真正的迁移

- 位置：`src/main/db.ts:5`、`:145-161`
- 问题：逻辑是“版本号 < 当前版本就整体执行一遍 `SCHEMA_SQL`”。`CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，所以 M2 一旦要加列（例如 P0-5 建议的 `pages.text`），v1 用户的库不会被升级。此外：没有事务包裹，建表中途失败会留下半成品；没有“数据库版本高于程序版本”的保护；版本号放在可被渲染端改写的 `settings` 表里（见 P1-3）；没有 `busy_timeout`。
- 建议：改成 `MIGRATIONS: Array<(db) => void>`，按序执行，每步一个事务，用 `PRAGMA user_version` 存版本；高于已知版本时拒绝启动并提示升级。`db: any` 建议改成 `DatabaseSync` 类型。

### P1-7　HEIC/EXIF 方向问题：叠加层与图片错位，HEIC 不一定能显示

- 位置：`src/main/pipeline/extract.ts:158-165`；`native/macos/ocr.swift:33-47`
- 问题：
  - `extractImage` 把 jpg/jpeg/heic 的**原始字节直接拷贝成 `page-1.png`**，扩展名与内容不符，协议再按 `image/png` 返回。JPEG 靠浏览器内容嗅探能显示；HEIC 在 Chromium 内是否能解码取决于系统/版本，**没有测试覆盖**（样本里没有 HEIC）。交付说明只写“依赖系统解码能力”。
  - Swift 用 `CGImageSourceCreateImageAtIndex` 取的是**未经 EXIF 方向旋转**的像素，`VNImageRequestHandler` 也没传方向；而 Chromium 显示 JPEG 时会按 EXIF 旋转。手机拍的竖版试卷（EXIF 方向 6/8）会出现：OCR 坐标与显示图旋转 90°，叠加框全部错位；`width/height` 也是未旋转的值。
- 触发场景：用手机拍一张竖版试卷导入，打开叠加层。
- 建议：导入图片时统一规范化——用 `nativeImage`（或 Mac 上的 `sips`）读取、按 EXIF 旋转、重新编码为 PNG/JPEG 并写成真实的 `page-1.png`，再对规范化后的图做 OCR；原图保留为 `original.<ext>`。HEIC 在 Windows 需要系统 HEIF 扩展，需要在失败时给出明确提示。

### P1-8　docx 导入：丢失图片，详情页无法看到文字，页面行为异常

- 位置：`src/main/pipeline/extract.ts:190-211`；`src/renderer/pages/PaperDetail.tsx:89-93`、`:117`；`src/main/pipeline/extract.ts:208`（`text_source='pdf-text'`）
- 问题：
  - 设计文档写的是 mammoth 文本 + 解压 `word/media` 取图片。实现只做了文本。小学英语卷大量依赖“看图选词/看图写话”，图片全部丢失。
  - 写入的 `pages` 行 `image_rel=''`，详情页缩略图与主图都请求 `ewb://page/<id>/`，协议返回 400，页面是破图；叠加层画的是伪造坐标的框，docx 的**文字内容在界面上根本看不到**（详情页没有文本视图）。
  - `text_source` 用了 `pdf-text`，语义不对。
- 建议：用 mammoth 的 `convertToHtml` 或自行解 zip 取 `word/media/*`，保存为资源并记录位置；详情页对 `image_rel` 为空的页显示文本视图；`text_source` 增加 `docx`（并同步更新设计文档与 zod 枚举）。M5 若要截图，需要 docx→PDF 的路径（Mac 可用 `textutil`/LibreOffice，Windows 需要另想办法），请在 M2 前决定。

### P1-9　提取不是原子的：失败后残留半截数据

- 位置：`src/main/pipeline/extract.ts:56-93`、`:137-140`
- 问题：先复制文件、再 `INSERT papers`，随后每页单独 `INSERT pages`，没有事务。第 3 页失败时第 1、2 页已入库，试卷却是 `failed`，页数为 0；`page_count` 只在成功时更新。另外 `INSERT papers` 在 `copyFileSync` 之后，若插入失败会留下孤儿目录。
- 建议：提取阶段先在内存里收集所有页，再在一个事务里写入 `pages` 与 `papers.status`；失败时清理目录（或保留但标记）。

### P1-10　`initDatabase` 失败没有任何处理

- 位置：`src/main/index.ts:47-52`；`src/main/db.ts:124-162`
- 问题：`await initDatabase()` 抛错（磁盘只读、库损坏、`node:sqlite` 不可用）时，`whenReady().then` 里没有 catch，窗口不会创建，用户看到的是“点击图标没反应”。`require('node:sqlite')` 的 catch 里日志还说“尝试 sql.js 回退”，实际没有回退。
- 建议：捕获后 `dialog.showErrorBox` 并退出；需要的话把库路径、版本等写进日志；去掉误导性的日志文案。

### P1-11　`ewb://` 协议的路径检查偏弱

- 位置：`src/main/protocol.ts:32-42`、`:48`、`:58-63`
- 问题：
  - `resolved.startsWith(path.resolve(filesDir))` 没有加路径分隔符；`files` 与 `files-x` 前缀相同的兄弟目录会通过。目前靠“`paperId`、`fileName` 不含 `..`”兜住，但这是第二道防线失效后的“偶然安全”。
  - 先检查 `..` 再没有做 URL 解码，如果以后有人在这里加 `decodeURIComponent`，检查就失效。
  - 没有 `realpath`，数据目录里如果出现符号链接可以逃逸。
  - 设计文档说“按资源 ID 访问图片”（`ewb://page/<paperId>/<n>`），实现是按任意文件名访问，因此 `original.pdf`、`original.docx` 也能被渲染端直接读取，白名单应只允许 `page-<n>.png`。
  - `readFileSync` 阻塞主线程且整文件进内存；`Cache-Control: max-age=3600`：M2 的“重新处理”会覆盖同名 `page-1.png`，渲染端一小时内看到的还是旧图。
- 建议：
  - 解析时用 `path.relative(base, target)`，拒绝以 `..` 开头或为绝对路径的结果；
  - `paperId` 校验为 uuid，文件名校验为 `^page-\d+\.png$`（或改成 `ewb://page/<paperId>/<idx>` 通过数据库查 `image_rel`）；
  - 用 `net.fetch(pathToFileURL(resolved))` 流式返回；缓存头改成基于 mtime 的 `ETag`，或 URL 带版本参数。

### P1-12　PDF.js 的渲染稳健性：字体/CMap、整本一次性回传、无清理

- 位置：`src/main/pipeline/pdf-renderer.ts:64-107`
- 问题：
  - `getDocument({data})` 没有传 `cMapUrl` / `standardFontDataUrl`。含有未内嵌中文字体或标准 14 字体的 PDF（学校出的卷子常见）可能渲染成缺字/乱码；样本是内嵌字体的，没覆盖到这个场景。
  - 全部页面 PNG 转 base64 后在一次 `executeJavaScript` 里返回。30 页扫描卷（每页数 MB）会产生数十到上百 MB 的 IPC 字符串，有内存和长度风险。应改为每页渲染、每页落盘。
  - `doc.destroy()` 没有放进 `finally`，出错会泄漏；`page.cleanup()` 没有调用；加密 PDF 的错误信息是英文原始异常，直接显示给教师。
  - 超大页面尺寸（海报/大幅面扫描）在 `scale:2` 下可能超过 Canvas 上限，没有上限保护。
- 建议：分页调用（`renderPage(i)` 返回，主进程立刻落盘并释放）；传入 CMap/字体数据（可通过 `ewb://` 或自定义协议提供）；错误按类型翻译成中文提示。

### P1-13　并发：`ensureWindow` 有竞态，且共享同一个 canvas

- 位置：`src/main/pipeline/pdf-renderer.ts:20-54`、`:70-72`
- 问题：`ensureWindow` 在 `initialized` 变为 true 之前有多个 `await`。并发调用（比如用户先后点两次“导入”，或 M2 按设计开 2 路并发）会各自创建一个新窗口，第一个窗口的引用被覆盖而泄漏。同时所有调用共用页面里同一个 `#c` canvas，交错执行会互相覆盖画布，**页面图片会张冠李戴**。
- 建议：用一个 Promise 缓存初始化；渲染串行化（简单的 mutex/队列），或每个任务独立 canvas；在 M2 的任务队列里明确并发上限（设计文档写的是 2 路，PDF 渲染这一环仍应串行）。

### P1-14　`status` 语义与设计冲突：提取完成就标 `done`

- 位置：`src/main/pipeline/extract.ts:83-84`；`src/main/types.ts:6`
- 问题：枚举本身和设计文档一致（`imported/extracting/parsing/reviewing/done/failed`），但提取一结束就置 `done`，试卷库显示“已完成”。在设计里 `done` 是“解析+审核完成”的终态，M2 要把提取完成的试卷送去 `parsing`。按现在的状态机，M2 无法区分“只提取了文本”和“全部完成”的试卷，已有数据会被误当成已处理。
- 建议：提取完成后回到 `imported`（并用单独的字段，比如 `stage`/`extracted_at` 表示提取已完成），或新增 `extracted` 状态并更新设计文档；M1 的 UI 文案也要相应改成“已提取”。

---

## P2（建议）

1. `src/main/ipc/papers.ts:52-62`：`PaperFilterSchema` 接收 `textbook`、`region`，但 SQL 没有用它们，过滤被静默忽略；`school_year_start` 用 `if (f.school_year_start)` 判断，别的数值型过滤也要小心 0 值。
2. `papers:update`（`papers.ts:73-93`）没法把字段清空（`undefined` 被跳过，也没有 `null` 分支）；`id` 不存在时返回 `undefined`，类型声明却是 `Paper`。
3. 重复导入：设计文档要求“同一文件导入两次给**警告**”，实现是直接拒绝（`extract.ts:52-54`）；`file_hash` 只有普通索引，没有 UNIQUE，数据库层面没有保障。建议改成可选“仍然导入”，或明确修改设计文档。
4. `school_year_start`：与设计一致（2025 表示 2025-2026 学年，显示为 `2025-2026`）。但录入框标签是“学年起始”，没有任何提示；M2 的 AI 预填容易把“2026 学年”这种简称直接填成 2026。建议在表单旁提示示例，并在 AI 解析提示词里明确换算。
5. `grade` 存的是 TEXT（`'1'..'6'`），设计文档写的是 1-6 数值；M3 做排序/区间统计会不便。建议 INTEGER 存储，枚举保持 1-6。
6. `PaperDetail.tsx` 只在 `['papers']` 前缀失效时刷新，`['pages', id]` 没有任何失效来源；缩略图直接加载整张 2x PNG；`failed` 的试卷在详情页看不到 `error` 原因（`PaperLibrary.tsx:158` 只有 tooltip）。`statusMap` 在两个页面各写一份，且详情页的少了 `parsing/reviewing`。
7. `PaperLibrary.tsx:52`：`f.path.split('/').pop()` 在 Windows 路径上不会取到文件名，应由主进程在结果里带 `fileName`。
8. 图片导入会保存两份相同内容（`original.png` 与 `page-1.png`，我在 3 号样本的目录里确认大小一致），浪费空间；`copyFileSync` 会把 exFAT 上的 `rwx` 权限位原样带到目标文件。
9. 导入白名单缺 `.jfif/.webp/.heif/.tif`；`dialog.showOpenDialog` 没有设置父窗口（不是模态）。
10. 版本和交付说明不一致：说明写 React 19.1.0、pdfjs-dist 4.9.155、TypeScript ~5.8；实际安装的是 React 19.3.1、pdfjs-dist 4.10.38、TypeScript 5.9.3（`package.json` 全是 `^`）。`@types/uuid` 对 uuid 11 是多余的，而且可以直接用 `crypto.randomUUID()` 去掉一个依赖。
11. 数据目录将来可改（设计文档第 2 节）：SQLite WAL 在 exFAT/网络盘上存在共享内存映射和锁的问题，设置里改目录时要检测并提示或降级为 `journal_mode=DELETE`。

---

## 重点核对项逐项结论

### 1. 正确性

- **去重**：同一进程内“哈希→查询→插入”之间没有 `await`，所以不会有并发竞态；但见 P2-3（无 UNIQUE）、P0-4（失败项阻挡重新导入）。
- **AppleDouble**：只在导入的 basename 上过滤 `._*`，行为正确（`extract.ts:35-37`）。目录导入不存在，所以不需要递归过滤。
- **`.doc`**：能拒绝并提示（对话框的“所有文件”过滤器会让用户选到 `.doc`，然后 toast 提示“请先另存为 .docx”），符合要求。
- **事件**：见 P1-2。
- **状态/恢复/并发**：见 P0-4、P1-9、P1-13。

### 2. 安全

- 已满足：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；preload 没有直接暴露 `ipcRenderer`；`papers:update` 使用 zod，且动态拼 SQL 的列名只来自 zod 解析后的 key（`z.object` 默认会剔除未知键），没有注入面；`papers:list` 的值全部走参数绑定。
- 缺口：P1-3（校验覆盖、settings 键、任意路径、`on` 通道）、P1-4（CSP/导航）、P1-11（协议路径检查）。我没有发现能直接绕过现有 `..` 拦截的路径穿越，但检查方式偏脆弱。

### 3. 跨平台

- **Windows OCR 脚本不存在**（P0-6）。因为没法评审实现，这里只列出 M5 实现时必须覆盖的要点：
  1. PS 5.1 调用 WinRT 需要 `[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]` 一类的类型加载，以及 `Add-Type -AssemblyName System.Runtime.WindowsRuntime` 后通过反射的 `AsTask` 包装 `IAsyncOperation`；
  2. 用 `StorageFile.GetFileFromPathAsync` + `BitmapDecoder` 得到 `SoftwareBitmap`；
  3. 语言选择：先 `OcrEngine::TryCreateFromLanguage('zh-Hans-CN')`，没有语言包就退到 `TryCreateFromUserProfileLanguages()`，仍然拿不到就返回明确的错误码，让主进程切换到 vision 兜底；一个引擎无法同时识别中英混排，需要决定策略（例如中英各跑一遍再合并）；
  4. `OcrLine` 本身没有包围盒，要把 `Words` 的 `BoundingRect` 合并；Windows OCR 不给置信度，`conf` 需要约定固定值；中文识别结果在字间会带空格，需要去除 CJK 字符之间的空格；注意 `OcrEngine.MaxImageDimension`；
  5. 输出编码：`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`（PS 5.1 默认控制台编码会把中文变成乱码），用 `-NoProfile -ExecutionPolicy Bypass -File` 调用，stdout 只输出一段 JSON，日志走 stderr；
  6. 把脚本放在 `native/windows/ocr.ps1`，与 Mac 保持同样的 JSON 契约。
- **硬编码**：`ocr.ts:14,16` 路径硬编码 `native/macos/bin/ewb-ocr`，`isOcrAvailable()` 只认 darwin；`PaperLibrary.tsx:52` 用 `'/'` 分割路径。主进程路径都用了 `path.join`，这一点没问题。
- **pdfjs worker 打包后**：运行时 `require.resolve('pdfjs-dist/package.json')` 然后 `fs.readFileSync(legacy/build/*.mjs)`（`pdf-renderer.ts:17,37-38`），再用 Blob 注入。产物里 `pdfjs-dist` 是 `require` 外部依赖（`out/main/index.js:259`），打包后在 asar 内用 `fs` 读是可行的，**设计上能工作**，但没有 electron-builder 配置，未实际验证。另外它用的是 legacy 构建，Electron 45 完全可以用主构建（体积和兼容性更好）。
- **原生助手路径**：`ocr.ts:13-17` 打包时指向 `process.resourcesPath/native/macos/bin/ewb-ocr`。这要求 extraResources 把 `native/macos/bin` 拷到 `Resources/native/macos/bin`，而**仓库里没有任何 electron-builder 配置**，交付说明里也没有说明，所以无法确认能解析到。同时，universal 二进制是 ad-hoc 签名（linker-signed），之后进 dmg 需要被整体重新签名。
- **原生模块**：`package.json` 中无原生依赖，`node:sqlite` 为内置，满足跨平台打包要求。需要注意：`node:sqlite` 在 Node 24 里仍可能打印实验性警告，且 API 属于不稳定级别，升级 Electron 时要回归。
- **Swift 助手**：minos 13.0、arm64+x86_64，OK。但没有构建脚本（没有 `npm run build:ocr` 或 shell 脚本）、`bin/` 里还留着旧名字 `paperocr`，二进制进库但无法复现构建。建议加 `scripts/build-ocr-mac.sh`（`swiftc -target … -O` + `lipo` + `codesign`），删掉 `paperocr`。

### 4. 与设计文档的一致性

| 项 | 结论 |
|---|---|
| papers / pages / questions / question_kps / kps / qtypes / reports / settings 字段 | 基本一致，8 张表齐全 |
| `school_year_start` | 一致（2025 = 2025-2026 学年，界面显示 `2025-2026`）；缺使用提示（P2-4） |
| status 枚举 | 一致；但使用方式有语义问题（P1-14） |
| `text_source` | 不一致：多了 `pdf-text+ocr`，docx 用了 `pdf-text`（P0-5、P1-8） |
| `grade` 类型 | TEXT，设计为 1-6 数值（P2-5） |
| IPC 命名 | `papers.import/update/list/remove` 一致；缺 `papers.reprocess`；额外有 `get/pages/dialog/settings.getDataDir`；设计中的 `data.chooseDir` 未实现 |
| 事件 | `job:progress` 与 `data:changed` 已有；批量节流只有后者（P1-2） |
| 图片协议 | 设计为按 `<paperId>/<n>` 访问；实现按文件名（P1-11） |
| OCR 分层 | 实现未按“文本层优先”（P0-5）；Windows 分层缺失（P0-6） |
| PDF 在渲染进程 | 实际在隐藏窗口，且有生命周期副作用（P0-2） |
| 数据目录/改位置 | 默认位置已实现，设置里不可改（M4 范围，可接受） |

### 5. 可维护性（对 M2 的影响）

- 提取流程与导入 IPC 绑死在一个函数里，没有“阶段”概念（`stage`/`current_step`），做不到设计文档要求的“失败后从失败阶段重试”和“2 路并发”。M2 加 AI 解析时，建议先把 `importPaper` 拆成 `register → extract → parse` 三个可单独重放的阶段，由一个任务队列统一调度并发出事件。
- 类型重复了三份：`main/types.ts`、`preload/index.ts`（全是 `any`）、`renderer/env.d.ts`。建议新建 `src/shared/`，放置 zod schema 与类型，由主进程、preload、渲染端共同引用；`window.api` 的类型由 preload 导出推断。
- OCR 需要 provider 接口（Mac Vision / Windows / 视觉模型兜底）才能承接 M2 的“视觉模型兜底”。
- `TextSourceEnum` 定义了但从未使用；`ocr.ts` 与 `extract.ts` 的 `OcrLine` 和叠加层的伪坐标混在一起，缺少“有无真实坐标”的字段。
- `db: any` 以及大量 `any`（`papers.ts:53`、preload 返回值）会让 M2 的改动失去类型保护。
- `net` 在 `protocol.ts` 里导入了但没使用；`out/` 目录和 AppleDouble 文件（`._*`）在项目目录里，需要确保将来加 `.gitignore` 和 electron-builder 的 `files` 过滤。

---

## 交付说明中与事实不符或不准确的陈述

1. “拖拽上传”——实际不可用（P0-1）。
2. “500ms 批量通知防抖”——只适用于 `data:changed`，`job:progress` 没有（P1-2）。
3. “Zod schema 校验 IPC 参数”——只覆盖 2 个入口（P1-3）。
4. “支持 HEIC”——没有任何 HEIC 样本测试，且是原样拷贝成 `.png`（P1-7）。
5. “docx：mammoth 提取纯文本”——属实，但缺图片，且详情页看不到文本（P1-8）。
6. 技术栈版本与实际安装版本不一致（P2-10）。
7. 测试验证表只有 3 个样本，且全部通过点击按钮走对话框路径；没有拖拽、docx、`.doc`、重复导入、失败路径、Windows 的验证记录。
8. “文本来源 pdf-text+ocr”——存的其实是 OCR 结果（P0-5）。

---

## 结论

**Pass after fixes。**

- 必须在进入 M2 前处理：P0-1 至 P0-6。
- 建议与 M2 同期修复：P1-1 至 P1-14，其中 P1-2（队列与事件）、P1-6（迁移）、P1-14（状态语义）会直接影响 M2 的数据与流程设计，建议排在 M2 第一批。
- 复审建议：修完 P0 后，补一份包含“拖拽/点击导入、关窗再激活（Mac）、关窗退出（Win，可用 CI 验证）、提取中强杀后重启、竖版手机照片叠加、docx、重复导入/失败重试”的验收清单再审一次。
