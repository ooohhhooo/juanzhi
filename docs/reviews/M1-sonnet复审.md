# M1 里程碑复审报告（第二轮）

- 审核人：Sonnet 5.5（只读，未改动任何代码文件，只写本文件）
- 对象：`/Volumes/Elements/Claude/english-exam-workbench/`，对照 `docs/M1-交付说明.md`（修订版）、`docs/reviews/M1-sonnet审核.md`、`docs/设计方案.md`
- 已做：通读 `src/**`、`native/**`、`tests/e2e/run.cjs`、`make-fixtures.py`、`last-result.json`、`electron.vite.config.ts`、`package.json`；看了 `docs/screenshots/fix-02/04/05`；运行 `npm run typecheck`（通过）、`npm run build`（通过，仅 antd 的 "use client" 警告）；用 Python 对 PowerShell 里的 CJK 空格正则做了行为模拟。
- 未做：没有启动 GUI、没有跑 E2E（按要求）。没有 Windows 环境，也没有 `pwsh`，PowerShell 脚本只做了桌面推演，下面凡是"推断"都已标明。
- 判断原则：交付说明里的每条"✅"都当作待证明的主张，逐条回到代码和截图核对。

## 总体结论

**Pass after fixes（Mac 侧 M1 可以过；新增 P0 = 0）。**

第一轮的 6 个 P0 里，5 个是真修好了，1 个（P0-6）修到了 M1 要求的程度（静默失败消除、不再造假坐标），但错误原因被吞掉，Windows 脚本本身未验证且有明显缺陷。14 个 P1 里 10 个真修好，3 个部分修好（P1-3、P1-4、P1-8），1 个是待决策（P1-14）。

这一轮的实现质量明显比第一轮好：拖拽用真实 CDP drop 验证，队列/恢复/迁移/事务都落地了，E2E 也不是摆设。但我找到 1 个新的、会在正式版里稳定触发的 P1（拖到非试卷库页面会把整个窗口导航成文件），以及几处交付说明与代码不符。

设计文档把 Windows OCR 放在 M5（第 9 节），所以 `ocr.ps1` 的问题不阻塞 M1，但应该在 M5 前修掉；它已经提前交付了，我按"必须在 M5 前通过 Windows 实机"来分级。

---

## 一、第一轮 P0 / P1 逐条核对

### P0

| 编号 | 结论 | 证据与说明 |
|---|---|---|
| P0-1 拖拽/点击导入 | **真修好** | `preload/index.ts:6` 暴露 `webUtils.getPathForFile`；`PaperLibrary.tsx:79-105` 原生 `onDrop`，一次 drop 同步取全部路径、一次 `papers.import`；`:54-58` 点击区走 `dialog.openFiles`；`:100-103` 取不到路径有提示。`run.cjs:74-86` 用 CDP `Input.dispatchDragEvent` 派发 dragEnter/dragOver/drop，是浏览器内核生成 File 对象，证据有效。遗留：点击/按钮的对话框是替身（交付说明已如实标 ⚠️）。**但引入了新问题 N1（拖到库页面以外会导航窗口）。** |
| P0-2 隐藏窗口破坏生命周期 | **真修好（Mac 已验）** | `window.ts` 独立主窗口引用；`index.ts:102-104` `activate` 只看主窗口；`:62-66` 主窗口 `closed` 时销毁渲染窗口；`:111-114` `before-quit` 兜底；`events.ts:20,32` 只发主窗口。E2E `run.cjs:289-300` 验证 0 窗口残留与重建。Windows 逻辑推演成立（主窗口关 → 渲染窗口销毁 → `window-all-closed` 触发 → quit）。小瑕疵见 P2-A（关窗时正在跑的任务会被误杀成失败，以及初始化竞态）。 |
| P0-3 关窗即关库 | **真修好** | 数据库只在 `before-quit` 关（`index.ts:111-114`），`window-all-closed` 只在非 darwin 退出（`:107-109`）。E2E 验证关窗 → activate → IPC 可用。 |
| P0-4 提取中无恢复 | **真修好（超时未测）** | 启动恢复 `queue.ts:126-132`；`reprocess` `queue.ts:109-123`；失败项可重导 `queue.ts:74-82`；事务写入 `extract.ts:65-83`；OCR 与 PDF 每页超时 `extract.ts:97`、`pdf-renderer.ts:96-124`。强杀恢复 E2E 设计得好（`run.cjs:312-322` 紧盯状态，杀前必须是 imported/extracting，否则不算过）。超时分支确实没被触发过，代码逻辑我读过是成立的；唯一缺口见 P2-A（初始化阶段没有超时）。 |
| P0-5 PDF 文本层 | **真修好（引出新 P1 N3）** | `pages.text`/`ocr_conf` 迁移 v2；`extract.ts:119-123` 文本层 ≥50 字用 `pdf-text` 且不跑 OCR；`pdf-renderer.ts:163-200` 用 `item.transform` 生成真实行坐标。我看了 `fix-02` 截图，叠加框与文字贴合。判定规则本身太粗，见 N3。 |
| P0-6 Windows OCR / 静默失败 | **部分修好** | 静默 `done` 已消除：`textSource` 为 `needs_ocr`/`none`，试卷带警告，不再造假坐标（`extract.ts:130-136,173`）。脚本已写（`native/windows/ocr.ps1`）。**但 OCR 出错的真实原因被吞掉**（N2），脚本推演发现 2 个会实际出错的点（N5、N6）和 1 个体验问题（N7）。 |

### P1

| 编号 | 结论 | 证据与说明 |
|---|---|---|
| P1-1 userData | **真修好** | `index.ts:13-16` 在 `requestSingleInstanceLock`（`:69`）之前显式 `setPath`，顺序正确。E2E 第 3 次启动验证默认路径。二次实例分支未测，代码读起来没问题；E2E 第 2 次 `kill -9` 后重启成功，间接证明陈旧锁能被识别。 |
| P1-2 事件/进度 | **真修好** | `events.ts` 两个通道都 500ms 合并、只发主窗口；`queue.ts:64-106` "登记即返回 + 后台串行"；`PaperLibrary.tsx:31-36,217-222` 行内进度。 |
| P1-3 IPC 校验 | **大部分修好，一个"不修"理由站不住** | zod 全覆盖（`papers.ts:15,19,47,53,76,102`；`settings.ts:10-24`），`on()` 白名单（`preload:3,38`）。**"导入路径只接受主进程发放的"不是形式主义：** 交付说明说"主进程无法区分真假路径"，这不对。preload 夹在中间：渲染端主世界脚本拿不到 `ipcRenderer`，只能调 `api.getPathForFile(file)`，而这个函数要真实 File 对象，`new File([...])` 返回空串。所以让 preload 在 `getPathForFile` 成功时向主进程登记路径（一次性、带 TTL），主进程只收已登记或对话框返回的路径，这是真边界。M1 没有远程内容也没有注入面，所以降为 P2-D；**M2 要渲染 AI 生成的 Markdown 报告时就必须做。** |
| P1-4 CSP/导航 | **部分修好** | CSP 已验证（`index.html:6`），`setWindowOpenHandler` 全拒，权限默认拒绝。**但 `will-navigate` 在生产环境放行任意 `file://`（`index.ts:51-54`），拖拽到非库页面会把窗口导航成被拖入的文件。见 N1。** |
| P1-5 删除清文件 | **真修好** | `papers.ts:75-99`：处理中拒绝、先删库后清盘。 |
| P1-6 迁移 | **真修好** | `db.ts:5-125,168-203`：逐版本、每步事务、`user_version`、高版本拒绝。E2E 验证 v0→v3。M2 若做"重建表"型迁移，要在事务外先关 `foreign_keys`，现在不用管。 |
| P1-7 EXIF/HEIC | **真修好（仅 Mac）** | `extract.ts:142-178` 统一规范化为 PNG；mac HEIC 走 ImageIO（`ocr.swift:31-59`）。E2E 夹具构造正确（`make-fixtures.py:11-17` 像素横存 + EXIF=6），且断言竖图 + OCR>30 行，这个组合能间接证明方向正确（方向错 Vision 基本识别不出这么多行）。Windows HEIC 未验。 |
| P1-8 docx | **部分修好，交付说明有一句不实** | 文本入库与详情页文本视图是真的（`PaperDetail.tsx:157-165`，`fix-05` 截图）。**但交付说明写"不再请求空图片"不实：`PaperDetail.tsx:91-95` 缩略图不判断 `image_rel`，docx 页仍请求 `ewb://page/<id>/` → 400，`fix-05` 截图左上角就是一张破图。** 图片提取没做；设计文档（第 2 节表格）写明 M1 范围包含 `word/media` 解压。另有"纯图片 docx 静默显示已提取"的新问题，见 N4。 |
| P1-9 原子性 | **真修好** | `extract.ts:65-83` 内存收集 + 单事务；失败清图（`:86`）。故障注入没做，可接受。 |
| P1-10 initDatabase | **真修好** | `index.ts:83-92`。 |
| P1-11 ewb:// | **真修好** | `protocol.ts:7-8,31-46`：UUID + `^page-\d+\.png$` + 带分隔符前缀校验 + `net.fetch(file://)` 流式。E2E 验证 200/400/400/400。"不做 realpath"的理由成立（目录内容全由应用生成）。小问题见 P2-F（ETag 没处理 304）。 |
| P1-12 PDF 稳健性 | **真修好** | 逐页落盘、`finally` 销毁、8192 上限、CMap/标准字体经 `ewb://pdfjs/`，GBK-EUC-H 夹具的判别力我认可（`make-fixtures.py:50-61`，且交付说明说用纯 Node 做过对照）。 |
| P1-13 并发 | **真修好** | `pdf-renderer.ts:20-21,27-75` Promise 缓存 + 串行锁。 |
| P1-14 status 语义 | **未解决（待决策）** | 见第五节建议。 |

### P2（11 项）

1 ✅（`papers.ts:33-39`）；2 ✅（null 分支，但表单有新坑，见 P2-H）；3 ❌ 待决策；4 ❌（M2 前补一句提示即可）；5 ❌（同意留到 M3）；6 部分；7 ✅（主进程带 `fileName`）；8 ❌；9 部分；10 ✅（uuid 已移除，`electron` 已固定）；11 ❌（数据目录目前不可改，无影响）。

---

## 二、新问题与遗留问题

### P0

无。

### P1

**N1　拖拽文件到"试卷库以外"的页面，会把整个窗口导航成该文件（仅生产构建）**
- 位置：`src/main/index.ts:51-54`；`src/renderer/pages/PaperLibrary.tsx:39-47`
- 问题：阻止浏览器默认拖放行为的 `dragover/drop` 监听只在 `PaperLibrary` 挂载期间存在。其它页面（详情页、设置、占位页）没有。此时松手，Chromium 会发起到 `file:///…/x.pdf` 的导航，而 `will-navigate` 在生产环境对 `file://` 一律放行（`url.startsWith('file://')`）。开发模式反而因为只放行 devServerUrl 而被挡住，所以开发者在 `npm run dev` 里看不到这个问题，E2E 也只往拖拽区里拖。
- 触发：老师在详情页或设置页，想再导入一份卷子，把 PDF 随手拖进窗口。整个应用界面被 PDF 查看器/图片替换，窗口里没有返回按钮；preload 的 API 还会注入到这个 `file://` 页面里。需要重启应用才能恢复。
- 建议：
  1. `will-navigate` 改成只放行"与当前应用入口完全相同的 URL（忽略 hash）"，其它一律 `preventDefault`。
  2. 把 `dragover/drop` 的 `preventDefault` 挪到 `App.tsx`，全局生效；更好的是做全局拖放导入（任意页面拖入都走导入并跳转试卷库）。
  3. 补一条 E2E：在详情页往窗口拖文件，断言 URL 不变。

**N2　OCR 出错的真实原因被吞掉，用户看到的是"没有识别出文字"**
- 位置：`extract.ts:94-104`（`runOcr` 只 `console.warn` 后返回 null），`extract.ts:58-63`、`:130-136`、`:173`，`ocr.ts:65-66`
- 问题：交付说明 §5 说"退出码 3 主进程译成『未安装 OCR 语言包』"。这段译文是写了，但抛出的 Error 在 `runOcr` 里被吞，永远到不了界面。`isOcrAvailable()` 在 darwin/win32 上恒为 true，所以 Windows 缺语言包、二进制/脚本丢失（打包路径错）、超时、图片超尺寸，最终都落成 `text_source='none'` + 警告"有 N 页没有识别出文字"，用户无法区分"这页真没字"和"OCR 根本没跑起来"。
- 触发：Windows 机器没装中文 OCR 语言包；或打包后 `resources/native` 路径不对。
- 建议：`runOcr` 返回 `{ ok:false, reason }`，把首个失败原因拼进 `papers.error` 的警告；增加一个 `ocr:status` IPC（检查二进制/脚本存在，Windows 再探测语言包），在设置页显示"OCR：可用 / 缺语言包 / 缺组件"。这条也同时解决打包路径无法验证的盲区。

**N3　PDF 文本层的判定只看字数，乱码文本层会直接通过并跳过 OCR**
- 位置：`extract.ts:23,119`
- 问题：`trim().length >= 50` 就当作可信文本层并且不跑 OCR。学校出的卷子常见两种坑：①Word 导出的 PDF 字体缺 `ToUnicode`，pdf.js 读出一堆私有区字符或 U+FFFD，字数照样超过 50；②扫描件被扫描 App 加了页眉/水印文字，文本层有 50+ 字但正文是图。两种情况页面都被标成 `pdf-text`，文字内容是错的，而且 M2 的文本版 P1 要靠这份文本做 `anchor` 逐字匹配。
- 触发：导入任何字体缺 ToUnicode 的 PDF（校考卷里不少见）。
- 建议：加质量门——可读字符（字母、数字、CJK、常见标点）占比 < 0.8，或含有 U+FFFD/私有区字符，或"文本字数与页面面积/图像覆盖率明显不匹配"，就当作无文本层走 OCR；同时在 `pages` 里保留 `text_layer_chars` 便于排查。另外 M2 做 `anchor` 匹配时必须做空白归一化：`pdf-renderer.ts:177` 的"按间距补空格"启发式和原文并不一一对应。

**N4　docx：纯图片/空文本的 docx 会静默显示"已提取"；设计要求的图片提取仍未做**
- 位置：`extract.ts:180-189`；`PaperDetail.tsx:91-95`
- 问题：老师把扫描图贴进 Word 是非常常见的做法，这类 docx 的 `extractRawText` 返回空串，但页面仍是 `text_source='docx'`、试卷"已提取"、没有警告。图片在设计文档里属于 M1（`word/media`），目前只有文本。再叠加缩略图破图（见 P1-8 行）。
- 建议：见第五节对 P1-8 的方案。至少现在就把"docx 文本为空"归为 `none` 并给警告，缩略图对 `image_rel===''` 的页不渲染 `<img>`，并去掉 docx 页上无意义的"OCR 叠加"开关。

**N5　Windows 脚本：`Await-AsyncOp` 靠 `GetInterfaces()` 推断结果类型，推断大概率失败（M5 前必须验证）**
- 位置：`native/windows/ocr.ps1:55-60`
- 问题（推断，无法在本机运行）：`$AsyncOp.GetType()` 在 Windows PowerShell 5.1 里对 WinRT 异步对象返回的要么是 `System.__ComObject`（`GetInterfaces()` 为空），要么是 `IAsyncOperation<T>` 接口类型本身（`GetInterfaces()` 只返回它的父接口 `IAsyncInfo`，不含自己）。两种情况下 `$resultType` 都是 `$null`，`MakeGenericMethod($null)` 抛异常，被外层 `catch` 捕获后 `exit 1`。也就是第一次 `await`（`GetFileFromPathAsync`，`:96`）就会挂，整个脚本在所有 Windows 上都出不了结果。业界通行写法是调用点显式传结果类型。交付说明也承认"错误最可能出在 WinRT 异步等待"。
- 触发：任何 Windows 机器。
- 建议：把函数签名改成 `Await($op, $resultType)`，调用点显式传 `[Windows.Storage.StorageFile]`、`[Windows.Storage.Streams.IRandomAccessStream]`、`[Windows.Graphics.Imaging.BitmapDecoder]`、`[Windows.Graphics.Imaging.SoftwareBitmap]`、`[Windows.Media.Ocr.OcrResult]`（对应类型要先用 `ContentType=WindowsRuntime` 语法加载）。无 Windows 环境时，最快的办法是把这段脚本放进 GitHub Actions `windows-latest` 跑一遍样本（设计文档第 8 节本来就有这个计划）。

**N6　Windows 脚本：去除汉字间空格的正则会漏掉一半**
- 位置：`native/windows/ocr.ps1:171`
- 问题：`([CJK])\s+([CJK])` → `$1$2` 是不重叠匹配，第二个汉字被第一次匹配消耗，下一对就匹配不上。我用 Python 同样语义模拟："中 文 字 符 识 别" 得到 "中文 字符 识别"。Windows 中文 OCR 恰恰常在字间插空格，所以结果仍有大量断字空格，会直接影响 M2 的 `anchor` 匹配。
- 建议：用环视：`(?<=[一-鿿　-〿＀-￯])\s+(?=[一-鿿　-〿＀-￯])` 替换为空串。

**N7　Windows 主进程调用：每页 OCR 会闪一个控制台窗口；输出解析不抗 BOM**
- 位置：`src/main/pipeline/ocr.ts:58-79`
- 问题：`execFile('powershell', …)` 没有 `windowsHide: true`，从 GUI 进程拉起控制台子进程时每页都会闪一个黑窗（30 页的卷子闪 30 次）。`'powershell'` 依赖 PATH，建议用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。`JSON.parse(stdout)` 对 BOM 敏感：`ocr.ps1:12` 设置 `[Console]::OutputEncoding` 是在控制台已附着的前提下才生效的，且 5.1 在某些宿主下可能带 BOM，防御性地 `stdout.replace(/^﻿/, '')` 成本为零。
- 建议：加 `windowsHide: true`、全路径、去 BOM；脚本里加 `$ProgressPreference='SilentlyContinue'`。

### P2

**P2-A　渲染窗口生命周期的几个边角**（`pdf-renderer.ts`、`index.ts:62-66`）
- `:40-43` `closed` 回调不比较身份，旧窗口的 `closed` 如果在新窗口创建之后才到，会把新窗口的引用清掉；应写 `if (win === w) win = null`。
- `:31-66` 初始化失败（`loadURL` 或脚本注入出错）时 `w` 没有销毁，是泄漏的隐藏窗口，在 Windows 上会让 `window-all-closed` 永不触发。
- 初始化阶段（`loadURL`、注入 pdf.js）没有超时，一旦挂住，串行锁后面的所有导入都卡住，直到重启。
- 没有监听 `render-process-gone`，渲染进程崩溃后窗口对象还在，之后所有任务都失败，除非碰巧走到超时销毁。
- 主窗口关闭会销毁渲染窗口（`index.ts:65`），在 Mac 上如果此时正在提取，当前这份试卷会被标成失败，信息是 Electron 的英文内部错误；关闭前应等待队列、或提示、或至少把这种失败转成"已取消，请重试"。

**P2-B　大文件与同步阻塞**
- `queue.ts:10` 允许 500MB，但 `pdf-renderer.ts:91,99` 整本 base64 后塞进 `executeJavaScript` 字符串，V8 字符串上限约 512MB，超过约 300MB 的 PDF 会直接失败；建议上限降到 100–150MB，或改成让渲染窗口 `fetch('ewb://…')` 流式读取。
- `queue.ts:72` 同步 `readFileSync` 全文件算哈希 + `copyFileSync`，100 个文件的批量导入会阻塞主进程（界面卡住）；改成流式哈希 + 异步复制。
- PNG 直接复制（`extract.ts:150-151`）既不规范化也不读尺寸：OCR 失败/不可用时 `width=height=0`；超过 Windows OCR 上限（`MaxImageDimension`）的大 PNG 会失败；16 位/调色板 PNG 在 Windows 解码后的像素格式可能不被 OCR 接受（建议脚本里用 `GetSoftwareBitmapAsync(Bgra8, Premultiplied)`）。

**P2-C　pdf.js 宿主页加固**（`protocol.ts:73-78`、`pdf-renderer.ts:102`）
`host.html` 没有 CSP，`getDocument` 没关 `isEvalSupported`。恶意 PDF 的执行环境是无 preload 的沙箱窗口，影响面小，但成本几乎为零：给 host.html 加 `default-src 'none'; script-src blob:; worker-src blob:; connect-src ewb:; img-src blob: data:`，`getDocument` 传 `isEvalSupported:false`。另外 `PDFJS_FILE_RE`（`:69`）允许文件名 `..`；URL 解析会先规整掉，实际到不了，但应改成显式排除。打包进 asar 后 `net.fetch(file://…app.asar/…)`（`:83-85`）能否工作我无法确认，建议这几个小资源直接 `fs.promises.readFile`（asar 感知）返回。

**P2-D　IPC 其余**（`settings.ts:16-30`、`papers.ts:15-17`）
- 路径登记方案见上（M2 渲染 Markdown 前必须做）。
- `settings:get` 对任意 key 开放，M2 的 `ai_api_key` 不应能被渲染端读回（设计文档说用 `safeStorage`）；`settings:set` 的 value 没有大小/类型校验，`undefined` 会让 `JSON.stringify` 返回 `undefined` 后绑定出错。
- CSP 可再补 `base-uri 'none'; form-action 'none'`；权限请求之外加 `setPermissionCheckHandler`。

**P2-E　`error` 字段兼作警告**（`extract.ts:76`、`PaperLibrary.tsx:219`）
`status='done'` 且 `error` 非空表示警告，M2 的"清除错误/重试"很容易把它当真错误处理。建议随 P1-14 的迁移一起加 `warning` 列。

**P2-F　ewb:// 缓存头**（`protocol.ts:54-61`）
设了 `ETag` + `no-cache`，但没处理 `If-None-Match`，浏览器每次都拿到完整 200，缩略图每次进详情页都重新传输。要么处理 304，要么改成 URL 带版本参数 + `max-age`。

**P2-G　docx 缩略图破图**（`PaperDetail.tsx:91-95,116`）
见 N4。属于交付说明与实际不符，应该一并改正说明。

**P2-H　编辑表单**（`PaperLibrary.tsx:133-145,327`）
总分 `InputNumber` 允许小数，而 zod 是 `int()`，保存时抛 ZodError，`handleEditSave` 没有 try/catch，弹窗停着没有任何提示。

**P2-I　Windows 小问题**
`papers.ts:90-92`、`queue.ts:17` 的 `fs.rmSync` 在 Windows 上遇到杀毒/索引占用会 `EBUSY`，加 `maxRetries:5, retryDelay:100`；`ocr.ps1` 中 `Test-Path`/`Resolve-Path` 应改 `-LiteralPath`（路径含 `[` 时会被当通配符）；`$word.BoundingRect` 的行若没有 Words 则 `minX` 仍是 `MaxValue`（`:152-165`），要加保护；`$stream.Dispose()` 应放进 `finally`；`conf=0.8` 写死（`:185`）会让平均置信度失真，且设计文档里"置信度低 → 视觉模型兜底"永远不触发，建议输出 `null` 并让主进程区分；脚本应输出实际使用的语言（`lang`），英文 Windows 回退到 `en-US` 引擎时中文会丢，主进程要据此提示。学校电脑上 PowerShell 的约束语言模式或组策略执行策略（`-ExecutionPolicy Bypass` 会被组策略覆盖）可能直接让 `[Type]::Method` 与反射失效。**M5 建议直接做一个编译好的 `ewb-ocr.exe`（C# 单文件，.NET Framework 自带 csc 就能编），与 Mac 的二进制契约对称，同时绕开 PS 反射、策略、启动开销。**

**P2-J　退出时的任务**
`index.ts:111-114` 在 `before-quit` 里直接关库并销毁渲染窗口，队列里的任务会在后台抛"数据库未初始化"（不影响数据，下次启动被恢复流程标成失败）。队列非空时建议弹确认。

**P2-K　M2 提示**
`reprocessPaper`（`queue.ts:109-123`）只清 `pages`，M2 有了 `questions` 之后要同步清；`pdf-renderer.ts:167-186` 的行是内容流顺序，没有按几何位置排序，多栏卷面阅读顺序可能错乱，M2 给模型前建议按 (y, x) 排序。

**P2-L　E2E 对真实数据目录有副作用**
`run.cjs:331-337` 第 3 次启动不设 `EWB_USER_DATA_DIR`，会在开发者真实的 `~/Library/Application Support/english-exam-workbench` 下建库并占用单实例锁；如果开发者正开着应用，这一项会直接失败。可以只用 `electron.launch` + `app.evaluate` 取 `getPath`，并在 `initDatabase` 前退出，或给测试加一个"只打印路径"的开关。

---

## 三、E2E 是否真的证明了它声称的内容

**总体：真实有效，不是演戏。** 它启动 `out/` 里的真实 Electron，用 CDP 派发真实 drop 事件，用 `kill -9` 杀真实进程，DB 只用于读取核对（只有旧库夹具是直接写 DB，这是合理的）。`last-result.json` 与代码和截图相符，34 项与交付说明一致。以下是我找到的"证据强度不够"的地方：

1. **有一项是硬编码通过。** `run.cjs:253`：`check('对话框导入', …, true, …)`，第一个参数之后直接给了 `true`，前一行 `waitFor(...)`（`:252`）的结果被丢弃了。它没有证明"点击导入按钮 → 对话框 → 入队"。（实际上如果这条链坏了，后面 `jpg.id` 会因 `undefined` 抛异常，整个测试以"E2E 异常"收场，所以不会静默漏过，但这一项自己不具备证明力。）改成 `check(..., !!(await waitFor(...)))`。
2. **"真实坐标"断言区分不出真假。** `run.cjs:157-158` 检查坐标在 0–1 内、`w>0,h>0`、行数>5。第一轮被我批评的"伪造坐标" `x=0.05,w=0.9,y=i/n` 也满足这些条件。真正有说服力的是 `fix-02/04` 截图（我看了，对齐是真的），但那是人眼证据，不是断言。建议加一条：同一页上 PDF 文本层行框与 Vision OCR 行框的 IoU 中位数 > 0.5，或至少断言 `x`、`w` 不是常数。
3. **CSP 断言偏弱。** `run.cjs:124-125` 只检查 meta 文本存在且控制台无 CSP 报错；监听器在窗口开始加载之后才挂（`:67-69`），早期报错可能漏掉。图片能经 `ewb:` 加载（`:168`）间接证明 `img-src` 生效，这一点是有效的。
4. **没覆盖也没声明的路径：** `will-navigate`/`setWindowOpenHandler`/权限处理（交付说明已标"已写未测"，但这正好是 N1 藏身处）；拖到拖拽区以外；`needs_ocr` 分支；单实例第二实例；超时分支（已声明）。
5. **跨平台上"绿"的含义不同。** Windows 生命周期项在非 darwin 上硬编码 `false`（`:302`），这套测试在 Windows 上不可能全绿；而数据目录那项在非 darwin 上无条件通过（`:337`）。交付说明里的"34/34"只适用于 macOS。这个处理方式是诚实的，但上 CI 前需要把平台分支做完整。
6. **HEIC 项有条件跳过**（`:270` 的 `if (heic)`）。夹具生成依赖 `sips`，如果 `sips` 失败这一项会静默消失，34 就变成 33，而脚本不报错。建议在 darwin 上缺 HEIC 夹具时直接 fail。
7. **`uiDone`（`:142`）判断偏松**：只确认了 `g4-2026` 一行显示"已提取"，没有校验三份都刷新。影响不大。

我没有重跑 E2E（按要求）。如果协调会话要重跑，建议在补完 N1 的断言后一起跑。

---

## 四、Windows 脚本桌面推演与主进程一致性

**参数与输出契约：一致。**
`ocr.ts:60` 传 `-NoProfile -ExecutionPolicy Bypass -File <script> <imagePath>`，对应脚本 `param($ImagePath)`；输出 `{lines:[{text,x,y,w,h,conf}],width,height}`，与 `OcrPageResult` 和 Mac 契约一致；坐标都是左上原点、0–1 归一化（Vision 的 `y = 1 - maxY` 在 `ocr.swift:94`，Windows `BoundingRect` 本来就是左上原点）。退出码 3 ↔ `ocr.ts:65`。

| 项 | 结论 |
|---|---|
| WinRT 类型加载 | 写法正确（`ContentType=WindowsRuntime`，`Windows.Foundation` 作为 `OcrEngine` 的程序集提示是惯用写法）。`Windows.Globalization.Language` 也已加载。未加载 `SoftwareBitmap`/`IRandomAccessStream`，目前因为类型靠运行时推断所以不需要，**改成显式传类型（N5）后必须补加载**。 |
| `AsTask` 反射 | 重载筛选条件（`Count -eq 1` 且参数类型名 `IAsyncOperation`1`）是对的，能挑到 `AsTask<TResult>(IAsyncOperation<TResult>)`。问题在 `:55-60` 的结果类型推断（N5）。`Wait()` 无超时，靠 Node 的 `execFile timeout:60_000` 兜底，可以接受。 |
| 语言回退 | 逻辑正确：`zh-Hans-CN` → `TryCreateFromUserProfileLanguages()` → 退出码 3。问题是回退到非中文引擎时，主进程不知道（P2-I 建议输出 `lang`）。 |
| 编码 | 脚本 UTF-8 带 BOM（已验证文件头 `EF BB BF`）是对的；输出用 `UTF8Encoding($false)` 避免 BOM 也对；stderr 同走 `[Console]::Error`。主进程防御性去 BOM 见 N7。 |
| 坐标归一化 | 用 `PixelWidth/PixelHeight` 归一化，与送给 OCR 的位图一致（EXIF 已由主进程规范化掉，所以没有 `OrientedPixelWidth` 问题）。行框由 `Words.BoundingRect` 合并，正确。 |
| 去汉字空格 | 有 bug（N6）。 |
| 错误码 | 1 = 读图/识别/超尺寸/未知；2 = 类型加载；3 = 无语言包。主进程只对 3 做了翻译，且被吞（N2）。 |
| 尺寸限制 | 脚本在超限时直接 `exit 1`；主进程对 PNG 直传没有缩放（P2-B）。PDF 与规范化图都在 8192 以内，低于 Windows 的 10000 上限。 |

---

## 五、对开发者 §7 开放问题的建议

### P1-14　status 语义：建议新增 `extracted`，M1 就改

- 现状：`done` 被同时用来表示"提取完成"，而设计里 `done` 是 imported → extracting → parsing → reviewing → done 的终态。`extracted_at` 是个补丁，查询方还是得写 `status='done' AND …`，M3 看板一旦写 `WHERE status='done'` 就会把"只提取过"的卷子算进统计。
- 建议状态流：`imported → extracting → extracted → parsing → reviewing → done`，`failed` 另带 `failed_stage`。
- 现在就改的成本很小：枚举（`types.ts:6`）、`extract.ts:76`、两处 `statusMap`、`recoverInterruptedPapers`、E2E 里约 6 处 `'done'` 断言，再加迁移 v4：`UPDATE papers SET status='extracted' WHERE status='done'`（M1 的所有 `done` 行都只是已提取，映射无歧义）。同一个迁移里把"警告"拆到新的 `warning` 列（P2-E）。
- 好处是 M2 的恢复策略可以更精确：`parsing` 被中断时回到 `extracted`（提取数据完好，不必重来），而不是一律标失败。
- 关于"任务原始验收要求都到 done"：这条验收的本意是"提取流程能走完"，改名不改变意图，建议协调会话把验收措辞改成"到 extracted"。如果一定要保留 `done`，那么退而求其次：M2 第一个迁移必须做上面的映射，并在 M2 任务书里明确"M1 遗留的 done 等同 extracted"，在此之前任何代码都不能把 `done` 当作"已处理完"。

### P1-8　docx 图片：M1 末补"文本 + 图片"，M5 再谈截图渲染

- 设计文档本来就写了 mammoth + `word/media`，所以这是"补齐 M1 范围"，不是新增需求。
- 方案 A（建议现在做，约 1 天）：用 `mammoth.convertToHtml` 的 `convertImage` 回调按文档顺序把图存成 `files/<id>/media-<n>.<ext>`（只收 png/jpeg/gif，`emf/wmf` 记录为"不支持的图片"并提示），`pages.text` 里用 `[图1]` 占位保持相对位置，新增 `pages.assets_json` 记录图片清单；`ewb://` 白名单增加 `^media-\d+\.(png|jpe?g|gif)$`；详情页按占位把图片内联在文本中。M2 的视觉版 P1 提示词可以直接消费这些图。
- 同时加告警：扫描 `word/document.xml`，如果含 `w:txbxContent`（文本框）或大量 `w:drawing`，提示"文本框/浮动图形内容可能没有提取"（mammoth 会丢这两类）；文本为空且无图则标 `none` 并告警（N4）。
- 方案 B（docx → PDF 再渲染）：**不要走 Word/LibreOffice 自动化**。Mac 没有系统自带的 docx→PDF，Windows 要装 Office 才能 COM，教师电脑不可控。如果 M5 的"题目截图"需要 docx 页面图，用"mammoth HTML → 隐藏窗口 `printToPDF` → 现有 PDF 流水线"，好处是顺带得到文本层与真实坐标，代价是版式只是近似（表格、文本框、浮动图会变形）。UI 上写明"需要精确截图，请先在 Word 里另存为 PDF 再导入"。
- 结论：A 先做；B 作为 M5 的可选项，不阻塞。

### P2-3　重复导入：沿用"默认拒绝"，加"仍然导入"，不加 UNIQUE

- 设计文档（第 3 节 `file_hash` 一行）写的是"警告"，不是"拒绝"，所以应当改实现、不是改文档。
- 做法：`papers:import` 的返回值对重复项给出 `{ duplicateOf: { id, title }, error: 'duplicate' }`；渲染端弹一个确认框列出重复文件，用户确认后再用 `allowDuplicates: [paths]` 重新调用；失败项自动替换的现有行为保留。
- 不要加 UNIQUE 索引（与"仍然导入"冲突）。加一列 `duplicate_of TEXT NULL`（可与 v4 迁移同做），M3 做统计时可以按它排除或提示，因为重复卷子会直接扭曲考频。
- 补充：哈希只能识别字节完全相同的文件，同一份卷子"扫描一次 + 导出 PDF 一次"识别不出来；M2 的审核页可以再按（学校、年级、学年、考试类型）给一个"疑似重复"提示。

---

## 六、交付说明中与实际不符或不准确的陈述

1. P1-8 行"不再请求空图片"：不实。`PaperDetail.tsx:91-95` 对 docx 页仍然请求空图片；`docs/screenshots/fix-05` 里就是一张破图。
2. §5 / P0-6"退出码 3 主进程译成『未安装 OCR 语言包』"：代码里有这句译文，但被 `runOcr` 吞掉，用户永远看不到（N2）。
3. §3 总结的"34/34 通过"：其中"对话框导入"一项是硬编码通过（`run.cjs:253`）；Windows 生命周期项在非 Mac 上必败，数据目录项在非 Mac 上必过；"34/34"仅对 macOS 成立。
4. P1-3 "主进程无法区分真假所以不做令牌"：理由不成立，见 P1-3 行。
5. P1-4 "导航限制已写未测"：如实，但实现本身有洞（N1）。

其它主张我逐条核对后与代码、截图、`last-result.json` 一致（包括：拖拽 CDP 验证、PDF 文本层字数与行数、EXIF/HEIC 尺寸、协议四种返回码、迁移、强杀恢复、userData 路径、CMap 夹具）。

---

## 七、建议的下一步（按优先级）

1. 修 N1（含 E2E 断言）、N2、N3、N4（改缩略图 + 空 docx 告警），这四条应在进入 M2 前完成。
2. 决定 P1-14，并在同一个迁移里处理 `warning` 与 `duplicate_of`。
3. 做 P1-8 方案 A 与 P2-3，可与 M2 前期并行。
4. Windows：先在 GitHub Actions `windows-latest` 跑 `ocr.ps1`（修完 N5、N6、N7），再决定是否改成编译好的 helper；打包配置（`extraResources` 把 `native/macos/bin` 与 `native/windows` 放到 `resources/native/…`、Mac 重新签名）和 N2 的 OCR 状态面板一起验证。
5. M2 开始前：preload 路径登记令牌（P1-3 遗留）、`safeStorage`、`anchor` 空白归一化与行排序。

---

## 结论

**Pass after fixes。**

- 新增 P0：0。
- 第一轮 P0：5 个真修好，1 个（P0-6）部分修好；第一轮 P1：10 个真修好（P1-7 仅 Mac），3 个部分修好（P1-3、P1-4、P1-8），1 个待决策（P1-14）。
- 新增 P1：7 个（N1 到 N7，其中 N5、N6、N7 属 Windows，按设计在 M5 前必须过实机）；新增 P2：12 组（P2-A 到 P2-L）。
- 进入 M2 的前置条件：N1、N2、N3、N4 修完，P1-14 定下来；Windows 相关三条在 M5 前修完并实机验证即可。
