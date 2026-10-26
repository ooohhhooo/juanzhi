# M5 审核报告（Sonnet 5.5，新上下文，未参与编码）

> 审核对象：相对 `bc6174d` 的未提交工作区（`git diff bc6174d` + 未跟踪文件 `.github/`、`build/`、`scripts/*.cjs`、`docs/M5-交付说明.md`、`docs/Windows验收清单.md` 等；忽略 png / `last-result*.json`）。
> 对照物：`docs/M5-交付说明.md`（逐项核对）、`docs/安装指南.md`、`docs/Windows验收清单.md`、`docs/M4-交付说明.md` §14、`docs/reviews/M4-sonnet三审.md`。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（27 组全过）、`node scripts/verify-artifacts.cjs`（40/40）；`codesign -dv --verbose=4` / `--verify --deep --strict`、`lipo`、`otool`（直接对 `~/.ewb-build/mac-arm64/*.app` 和 `hdiutil attach -nobrowse -readonly` 挂载的两个 dmg，看完已卸载）；`@electron/asar list`；7-Zip 取出 NSIS 安装包内容；自写 PE 头解析脚本和 resedit 读资源；`@action-validator/cli` 检查 workflow；在临时目录里复制 `src/` 和 `tests/` 做了 7 次变异（不碰项目文件）。
> **没有**跑 E2E、没有跑打包版冒烟、没有重新打包、没有安装到 `/Applications`、没有碰 `~/Library/Application Support` 下本应用的数据、没有调真实 AI、没有改任何项目文件（只写了本报告）、没有 git 写操作。临时脚本在 `$TMPDIR` 和会话 scratchpad，不入库。

## 结论

**不通过。P0 = 0，P1 = 1，P2 = 8，P3 若干。**

打包本身质量不错：Mac 两个 dmg 的签名、helper、架构、asar 内容我逐项复核，和交付说明一致，没找到「运行时资源在 asar 里找不到」的路径问题；Windows 的 exe 被 resedit 改写后 PE 头、资源、校验和我自己重算过，结构自洽；NSIS 默认不删用户数据（读了模板源码）；M4 转入的 P2 项修得到位，且回退修复测试会失败（我自己做了变异）。

唯一的 P1 在**构建可复现性**上：OCR helper 在 git 里是 `100644`，任何从干净 checkout 打的 Mac 包（正是 CI 工作流要做的事）里这个 helper 都没有可执行位，Mac 上图片 OCR 整个失效。本机的包没问题只是因为 exFAT 盘上所有文件都显示成 `rwx`。修起来是几行代码，但它会让 CI 第一次跑的 macOS 冒烟必然失败、也会让「CI 产出的 dmg」与「本机验过的 dmg」不是同一回事，所以按 P1。

其余是：知识点字符限制（P2-B）留了两个口子（旧数据 / 采纳 AI 建议），可能让用户自己的数据包导不回去；安装指南和验收清单里有几处与实际安装向导 / 界面不符；应用里还留着一句过期的「完整正文在 M5 随安装包提供」。

---

## P1

### P1-1 OCR helper 的 git 模式是 100644：干净 checkout 打出来的 Mac 包里 helper 不可执行，图片 OCR 全坏

- 位置：`native/macos/bin/ewb-ocr`（`git ls-files -s` → `100644`，`git ls-tree HEAD` 同）；`electron-builder.config.cjs` `mac.extraResources`；`.github/workflows/build.yml` macOS 作业；`scripts/verify-artifacts.cjs`（没有检查可执行位）。
- 问题：项目在 exFAT 移动硬盘上，`core.fileMode=false`，所有文件在磁盘上都显示成 `rwx------`，所以 helper 当初是以 644 入库的。electron-builder 拷贝 extraResources 时（`node_modules/builder-util/out/fs.js:131-145`）的规则是「只有属主有执行位才给 group / others 加执行位」，**不会凭空加上执行位**。GitHub runner 上 checkout 出来是 `rw-r--r--`，打进 `.app/Contents/Resources/native/macos/bin/ewb-ocr` 后仍是 644，`execFile` 报 `EACCES`，`classify()` 归成 `OCR 失败`（`src/main/pipeline/ocr.ts:63-67`）。
- 复现（**已复现**）：把 helper 拷成 644，用项目自带的 `builder-util` 的 `copyFile` 拷一份，结果 `dest mode 644`，直接执行 `permission denied`（退出码 126）；`chmod 755` 后能跑。端到端（真的从干净仓库打一遍）**推断**未跑，因为不允许重新打包。
- 影响：
  1. CI 的 macOS 作业里 `smoke-packaged.cjs` 的「图片走本机 OCR」断言必然失败（Vision 组件「可用」那条只查 `existsSync`，通得过，但识别行数 0）；
  2. 如果有人直接用 CI 产物或从 GitHub 克隆下来自己打包发给老师，Mac 版图片导入全部 OCR 失败；
  3. 交付说明 §3 的 dmg 是本机打的，不受影响，但「CI 能产出同样的东西」这个前提不成立。
- 建议修法（三层都要，便宜）：① `git update-index --chmod=+x native/macos/bin/ewb-ocr`（并在 `.gitattributes` 或 README 里提一句 exFAT 上要这么做）；② `scripts/after-pack.cjs` 里对 mac 的 `Contents/Resources/native/macos/bin/ewb-ocr` 无条件 `chmod 0o755`（不依赖入库模式）；③ `verify-artifacts.cjs` 和 `packaging-config.test.mjs` 增加「helper 在包里 `mode & 0o111` 非零」的断言，这样以后任何路径丢了执行位都会在打包时就被抓住。

---

## P2

### P2-1 知识点字符限制（M4 P2-B）有两个口子：旧数据 / 采纳 AI 建议写入的节点会让用户**自己导出的数据包导不回去**

- 位置：`src/main/pack/kp-rules.ts`（导入时 `validateKpRows` 整包拒绝）、`src/main/pack/exporter.ts`（导出不校验也不规整）、`src/main/ipc/questions.ts:300-338`（`taxonomy:approveSuggestion` 直接 `INSERT INTO kps`，**没有**过 `kpTextProblem`）。
- 问题：
  - 规则对**内置种子树**没有任何影响（我用 `buildKpRows()` 的 145 个节点、`KP_CODE_RE`、名称 ≤30、说明 ≤500、`kpTextProblem` 全跑了一遍：0 个违规，最长名称 21 字、最长说明 62 字；自建节点的代码形如 `<父>.U<n>` 或 `U.U<n>`，同样符合；IPC 的 `Code` 正则 M4 起就是同一条，所以代码字符集不是新限制）。
  - 但名称 / 说明里的**换行、竖线、零宽字符**是新限制：M4 的编辑框允许输入换行（M5 才把回车改成空格），v9 时代库里已有的自建节点如果说明含换行或名称含 `|`，现在导出的数据包会被导入端按 `bad_content` **整包拒绝**（「知识点『X.U1』的说明不能包含换行……」）；错误信息指向了节点，但老师得回到源电脑改了再导，旧包则只能手工改库。
  - `taxonomy:approveSuggestion` 的名称来自 AI 的建议（老师可改但不强制），说明是程序拼的 `由老师采纳 AI 建议新增（题 ${q.no_label}）`，`no_label` 也是 AI 抽出来的。这条路径绕过了「手工编辑和数据包导入用同一套规则」的承诺：AI 给出含 `|` / 换行 / 零宽字符的名称时可以入库，之后同样让数据包导不回去。提示词那头 `loadTaxonomy` 已经折平，所以不是注入问题，只是备份可恢复性问题。
  - 还有一个体验问题：从微信 / 网页 / Word 粘贴的文字常带零宽字符，现在报「不能包含……看不见的特殊字符」，老师看不见在哪，无法自己改。
- 复现：**已复现**（直接调 `validateKpRows`，一行 note 为 `'a\nb'` 或名称含 `|`）整包 `bad_content`；`approveSuggestion` 无校验是**读源码核对**（没有 electron 无法起 `ipcMain`，**推断**其行为）。
- 建议：① 导出端对 kps 的名称 / 说明套 `flatKpText`（导出的包永远合规），或导入端对旧版 `appVersion` 的包把这几个字段折平而不是拒绝（`loadTaxonomy` 本来就折平，这样不降低防护）；② `approveSuggestion` 在 `INSERT` 前复用 `kpTextProblem` / `flatKpText`（名称含非法字符就折平）；③ 手工编辑输入框把零宽字符静默剔除，只对「可见的竖线、控制字符」报错。

### P2-2 NSIS 安装向导与指南 / 验收清单描述不符（两处）

- 位置：`electron-builder.config.cjs` `nsis`；`docs/安装指南.md` 第三部分；`docs/Windows验收清单.md` §1；`docs/M5-交付说明.md` §6 / §7.2。
- 问题（读 `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:549-556` 与 `templates/nsis/assistedInstaller.nsh:3-23`）：
  1. `oneClick: false` 且 `perMachine` 不是 `true` 时，向导里**会出现「为所有用户 / 仅为我安装」这一页**（默认选「仅为我」；选「所有用户」会弹 UAC 要管理员密码）。指南说「默认装在你自己的用户目录下，不需要管理员权限」本身没错，但没提这一页，老师选错就会碰上管理员密码。
  2. `createDesktopShortcut: true` 在这个向导里是**静默创建**，没有「创建桌面快捷方式」复选框；指南写「并选择是否建桌面快捷方式」、验收清单写「勾选『创建桌面快捷方式』」，都是照着不存在的界面写的。
  3. 交付说明 §7.2 说默认安装目录是 `…\Programs\英语校考分析工作台`。实际 `win.executableName` 是 ASCII，`getWindowsInstallationDirName` 取到的 `APP_FILENAME` 是 `EnglishExamWorkbench`（`targetUtil.js:40-42`），所以默认路径是 `%LOCALAPPDATA%\Programs\EnglishExamWorkbench`，并不含中文。§6 里「中文安装目录下 powershell -File 是否正常」那条担心对默认路径是多余的（用户自己选了中文目录才会遇到）。这一点反而是个好消息，但文档写反了。
- 复现：**推断**（读模板源码；没有 Windows 机器，也没法反编译 NSIS 脚本。可用 `7za l` 看到卸载器名 `Uninstall EnglishExamWorkbench.exe`，与 ASCII 的 `PRODUCT_FILENAME` 一致）。
- 建议：指南第三部分加一句「安装向导会问『为谁安装』，选『仅为我』就不需要管理员密码」，删掉「选择是否建桌面快捷方式」；验收清单 §1 的第 3 步同步改，并加一条「核对安装目录名」；交付说明 §6 / §7.2 改成 ASCII 路径。

### P2-3 应用里残留一句过期文案：「（完整正文在 M5 随安装包提供）」

- 位置：`src/renderer/pages/Settings.tsx:50`（关于卡片，「查看安装指南」按钮旁）；已进打包产物（`out/renderer/assets/index-*.js` 里有这句，已 grep 确认）。
- 问题：M5 把 `/guide` 换成了完整正文，但设置页的这句占位说明没删。老师点开就能看到完整正文，旁边却写着「完整正文在 M5 提供」。另外 `src/main/pipeline/extract.ts:310` 有一条用户会看到的试卷提示带 `（M2）` 开发标记（M2 起就有，M5 打包后才第一次面向老师）。
- 复现：**已复现**（读源码 + grep 打包后的 renderer bundle）。
- 建议：删掉这两处括号文字。`Settings.tsx` 不在本轮修改清单里，说明没人再看这页；交付说明 §8「修改（应用代码）」也没列它。

### P2-4 指南 / 验收清单里的界面文字有几处对不上应用

- 位置：`docs/安装指南.md` 第四部分、第一段引言、第九部分；`docs/Windows验收清单.md` §2、§4、§5。
- 问题（逐个 grep 过应用里的真实文字）：
  - 「页面会标成『需要识别』或『识别失败』」：应用里 `textSourceLabel` 是「待 OCR（当前平台不支持）」和「OCR 失败」（`src/renderer/status.ts`），根本没有「需要识别 / 识别失败」两个标签；其中「待 OCR（当前平台不支持）」在 Windows 缺语言包的场景下还容易让人误会成「这台电脑不支持」。验收清单 §4 的预期同样写错。
  - 引言写「软件的『设置 → 查看安装指南』」，实际在「设置 → 关于 → 查看安装指南」。
  - 验收清单 §2「有『首次使用』三步卡片」，实际标题是「开始使用：三步就能出第一份分析」；§5「黄色横幅『示例数据：不是任何真实考情』」，实际是「当前看的是示例数据（内置的合成演示卷，不是任何真实考情）」。
  - 启动恢复提示里写「设置 → 数据 里的备份」（`db.ts`、`journal.ts` 的文案），设置里没有叫「数据」的卡片，备份列表在「数据包（换电脑 / 备份）」卡片里。
- 建议：以应用里的字面为准改文档（或统一改应用里的标签）；老师和验收人是照字面找的。

### P2-5 指南里的隐私表述不完整

- 位置：`docs/安装指南.md` 第三部分末尾「只有在你配置了 AI 服务并点击解析时，才会把试卷**文字**发给你选择的 AI 服务商」。
- 问题：配了视觉模型时，OCR 失败 / 质量差的扫描页会把**页面图片**发给 AI 服务商（指南第四部分自己就写了「交给视觉模型读图」）。老师读这一句会以为图片不出本机。
- 建议：改成「试卷文字，以及（配了视觉模型、需要读图时）页面图片」。

### P2-6 CI：Windows 上的单测从未在 Windows 跑过，会先于打包 / 冒烟把整个作业拦住

- 位置：`.github/workflows/build.yml` 「单元测试」步骤（没有 `continue-on-error`，且在「构建并打包」之前）；`tests/unit/datadir.test.mjs`（`symlinkSync` 目录、`/etc`、`/PRIVATE` 路径写法）等。
- 问题：工作流的价值是第一次就能看到「Windows 打包版冒烟」的结果，但 27 组单测里有若干按 POSIX 路径写的（符号链接、`/etc`、大小写折叠），从未在 Windows 跑过；任何一个失败，Windows 作业在单测这一步就红了，后面的打包、OCR 现场检查、冒烟都不会执行，得到的信息反而最少。
- 复现：**推断**。
- 建议：Windows 作业的「类型检查」「单元测试」设 `continue-on-error: true`（或把它们拆成独立作业），让打包和冒烟必定执行；另外加 `permissions: contents: read`（目前用默认令牌权限，虽然没有用到任何 secret，也建议收紧）。

### P2-7 冒烟和产物检查里两条断言是空转 / 偏松

- 位置：`tests/e2e/smoke-packaged.cjs`：`leaks = mock.requests.filter(r => !/^http:\/\/127\.0\.0\.1/.test(mock.baseUrl))`、`CJK_FONT` 里的 `Microsoft`；`scripts/verify-artifacts.cjs`：两条 `spctl` 记录项算进了「40/40」。
- 问题：
  1. 「AI 请求只发给了本机 mock」那条里 `filter` 的回调用的是 `mock.baseUrl`，不是每个请求的目的地，所以 `leaks.length === 0` 只取决于 baseUrl 是不是 127.0.0.1，永远为真；真正起作用的只有 `mock.requests.length >= 3`。它不会发现「有请求发去别处」（发去别处的请求根本不会出现在 mock 里）。
  2. Windows 的 PDF 字体断言：`CJK_FONT` 含裸 `Microsoft`，会匹配 `MicrosoftSansSerif` 之类**不能画汉字**的字体；而文本断言用的是 pdf.js 取出来的 Unicode 文本（有 ToUnicode 映射即使字形是豆腐块也能取到汉字）。所以「Windows 导出 PDF 汉字成方块」这个最容易出的问题，冒烟可能抓不住（Mac 上读到 PingFang / Hiragino 是真断言）。
  3. `verify-artifacts` 的 `spctl` 两条永远 pass（设计如此，记录用），但被计进 40 条；另外 `hdiutil attach` 用了 `-noverify`（不校验镜像校验和）。我自己不加 `-noverify` 挂载两个 dmg 都通过了，所以现状没问题，只是脚本本身没有验。
- 建议：1 改成检查 `mock.baseUrl` 是回环地址且 `net` 层面没有其他出站（或干脆删掉这条，承认它只证明「用了 mock」）；2 把 `Microsoft` 改成 `MicrosoftYaHei|MicrosoftJhengHei`，并在 Windows 上额外把导出的 PDF 渲染一页、检查不是整页豆腐块（或至少截图留证）；3 verify 里去掉 `-noverify`，`spctl` 不计入通过数。

### P2-8 `app.setName('english-exam-workbench')` 对 macOS 菜单 / 窗口标题的副作用没人看过

- 位置：`src/main/index.ts:25-27`；`src/renderer/index.html` 的 `<title>`；`BrowserWindow({ title })`。
- 问题：为了让 userData 固定而把 `app.name` 改成了 ASCII 内部名。我核对了结论本身是成立的（打包后 `app.getName()` 固定、`userData` 与 productName 无关，见下面「核对过」；本机 `~/Library/Application Support` 下**没有**多出一个中文 productName 的目录，`Caches`/`Logs` 也没有）。副作用是**推断**：Electron 的默认应用菜单在 macOS 上的「关于 / 隐藏 / 退出 ……」项会用 `app.name`，老师可能看到「退出 english-exam-workbench」；窗口标题则是页面 `<title>`「小学英语校考知识点分析工作台」，与 Dock / 安装器里的「英语校考分析工作台」、侧栏里的「英语校考分析」是三个名字。Windows 上任务栏分组所用的 AppUserModelID 也没有调用 `app.setAppUserModelId(appId)`，NSIS 快捷方式写的是 appId（置顶后再启动可能出现两个任务栏图标，**推断**）。
- 建议：在真机上打开 Mac 菜单看一眼；若确实是内部名，改成只 `setPath('userData')` 不 `setName`（keychain 的名字另测），或自己建一个中文菜单；统一一下产品名；加 `app.setAppUserModelId('cn.edu.english-exam-workbench')`。不阻塞，但是老师第一眼会看到的东西。

---

## P3（顺手改）

- `docs/安装指南.md`：「（不收费、不联网，也就没有『公证』）」这句因果不对，公证需要付费的开发者账号，和是否联网无关，建议改成「软件没有购买苹果的开发者证书，所以没有『公证』」；「下错了……只是打不开」不准确，Intel 包在 Apple 芯片上能靠 Rosetta 打开（可能先提示安装 Rosetta），只有反过来才打不开；「设置 → 应用 → 已安装的应用」是 Win11 的写法，Win10 是「应用和功能」。
- 打包产物里 `Info.plist` 的 `NSHumanReadableCopyright`、exe 属性里的 `LegalCopyright` 是「占位版权信息」，macOS「关于」面板和 Windows 文件属性会直接显示给老师（交付说明已声明是占位）。
- `files` 排除规则把 `node_modules/**/LICENSE.md` 去掉了；多数依赖的许可证是无扩展名的 `LICENSE` 所以仍在，但有少量只给 `LICENSE.md` 的包，随包分发 MIT 软件时通常要带上许可证文本。`zod/src/**/*.ts`、`pdfjs-dist/legacy/build/pdf.min.mjs`、`pdf.sandbox*.mjs` 也在 asar 里（几百 KB，无害）。
- `release/` 在 exFAT 盘上会有 `._*.dmg` / `._*.exe` 这些 AppleDouble 小文件；整个文件夹网盘传给老师时别带上，或把 `dist.cjs` 拷贝完成后顺手清掉。
- 工作流里 `EWB_SMOKE_PREFIX: ''`：Windows 上空环境变量可能被当作未设置，产出文件名会带 `m5-` 前缀；不影响功能（上传的是整个目录）。

---

## 重点检查逐项结论

### 1. 打包正确性

- **asar 内容**（`asar list`：1622 个条目，与交付说明一致）：顶层只有 `out/`、`package.json`、`node_modules/`；没有 `tests/`、`docs/`、`.env`、`._*`、`.DS_Store`、`*.map`、`@napi-rs`、`antd`、`react`；`out/main/index.js` 里的 `require` 只有 `electron`、`node:*`、`zod`、`yazl`、`yauzl`（`mammoth`/`jszip` 是动态 `import()`），全在 `dependencies`；`out/preload/index.js` 只 `require('electron')`。`packaging-config` 单测的「主进程 import 必须是 dependencies」扫描逻辑我读过，覆盖 `src/main`、`src/preload`、`src/shared`。
- **运行时读文件的路径**：全 `src/` grep `__dirname|getAppPath|resourcesPath|import.meta|?raw|readFile`：`index.ts` 的 `__dirname`（`../renderer/index.html`、`../preload/index.js`，在 asar 内，`loadFile` / preload 原生支持）；`pdf-renderer.ts` / `protocol.ts` 用 `require.resolve('pdfjs-dist/package.json')` + `fs.readFile`（asar 感知），asar 里有 `legacy/build/pdf.mjs`、`pdf.worker.mjs`、169 个 cmap、16 个标准字体（与 `node_modules/pdfjs-dist/{cmaps,standard_fonts}` 数量一致）；`ocr.ts` 用 `process.resourcesPath/native/...`；提示词和示例数据是编译进 bundle 的（`?raw`），不读文件；安装指南 `?raw` 内联；数据目录 / 页面图走 `userData`，不在安装目录里。`path.join` / `path.sep` 的用法在 Windows 下成立（`protocol.ts` 用 `filesDir + path.sep` 判断越界）。
- `electron-builder` 对 `extraResources` 的位置：Mac `Contents/Resources/native/macos/bin/ewb-ocr`、Windows `resources/native/windows/ocr.ps1`（`verify-artifacts` 与我手工解包都确认，且 `ocr.ps1` 与源文件字节一致、BOM 在）。
- CRLF：`.gitattributes` 已把 `src/main/ai/prompts/*.txt`、`docs/prompts/*.md` 固定为 LF；安装指南在 Windows CI（`core.autocrlf=true`）下变成 CRLF，我用 `parseBlocks` 对比了 LF / CRLF 解析结果，完全一致。
- P1-1 是唯一一个与「资源能否用」相关的缺陷（执行位），见上。

### 2. Windows 交叉打包

- **resedit 没有破坏 exe**：我自己写脚本解析 `win-unpacked/EnglishExamWorkbench.exe` 和 Electron 官方 `electron.exe`（同一版本的原始包）：PE 头合法、15 个节、`SizeOfImage` = `.reloc` 的 VA + 对齐后的大小（自洽）、资源目录指向 `.rsrc`、重定位目录跟着移动、文件长度与原始相同（249,797,632 字节）、原始就没有签名区也没有校验和（都是 0），`resedit` 对「校验和为 0 不重算」的处理与原样一致；资源类型对比：图标 4→7（我们的 ico）、清单（RT_MANIFEST）、版本信息、字符串表都在，另有一条 `INTEGRITY` 资源（electron-builder 自己写的 asar 完整性项，`EnableEmbeddedAsarIntegrityValidation` 熔丝默认关，不生效）。`file` 命令识别为 `PE32+ executable (GUI) x86-64`。真正能不能在 Windows 上启动仍然没有运行证据（残余风险：低）。
- **NSIS 安装包里的 exe 也被处理**：`afterPack` 在 electron-builder 打 NSIS / portable 之前对 `win-unpacked` 里的 exe 动手，两个安装器里的 `app-64.7z` 解出来的 exe 都是改写后的（`verify-artifacts` 读回 ProductName / FileVersion / 7 个尺寸图标）。注意这个验证用的是同一个 resedit 读回，有点循环，上面的手工 PE 检查补足了结构这一面。
- **卸载是否删用户数据**：读了 `templates/nsis/uninstaller.nsh:216-243`：只有传 `--delete-app-data` 参数，或编译时定义了 `DELETE_APP_DATA_ON_UNINSTALL` 且不是升级，才会 `RMDir /r "$APPDATA\${APP_FILENAME}"` 以及 `"$APPDATA\${APP_PACKAGE_NAME}"`；`deleteAppDataOnUninstall: false` 时前者不会定义，默认不删。**注意**：`APP_PACKAGE_NAME` 就是 `english-exam-workbench`，也就是用户数据目录名，**以后千万别把 `deleteAppDataOnUninstall` 改成 true**；`packaging-config.test` 已断言它是 false。
- **安装位置**：`perMachine:false` + `oneClick:false` → 向导带「为谁安装」一页（见 P2-2）；默认 `%LOCALAPPDATA%\Programs\EnglishExamWorkbench`（ASCII）。
- **portable**：NSIS 自解压（`$PLUGINSDIR\app`，每次启动解压约 250 MB，退出时 `RMDir /r`；进程被强杀会残留在 `%TEMP%`）；数据目录同样固定在 `%APPDATA%\english-exam-workbench`（`app.setPath` 与 portable 无关），单实例锁按 userData，所以与安装版互斥——指南第九部分写的「同时只允许开一份」正好对得上。

### 3. Mac 签名与 helper

- 挂载两个 dmg（`-nobrowse -readonly`，带校验）：`.app` + `Applications` 快捷方式；`codesign -dv`：`Signature=adhoc`、`flags=0x2(adhoc)`、`Identifier=cn.edu.english-exam-workbench`、无 TeamIdentifier；`codesign --verify --deep --strict` 退出 0（两个包都过）；主程序分别是 arm64 / x86_64 thin；Info.plist：`LSMinimumSystemVersion=13.0`、版本 1.0.0、中文名。
- helper：`lipo -info` = `x86_64 arm64`；`otool` 两个切片 `minos 13.0`；独立 ad-hoc 签名（Identifier `ewb-ocr-<hash>`，已在 `--deep --strict` 范围内）；依赖的是系统自带的 Swift 运行时和 Vision / ImageIO / CoreGraphics，macOS 13 上都有。
- 没有开 hardened runtime（`flags` 里没有 `runtime`），所以 `node:sqlite`、V8 JIT 都不受限制；entitlements 里的 `allow-jit` 等是 electron-builder 默认带的，ad-hoc 下不起作用也不碍事。
- `spctl --assess` = `rejected`，与交付说明一致（未公证，预期）。
- 没法在本机验的：带隔离标记的 dmg 实际走一遍 Gatekeeper 放行后，应用内部 `execFile` 启动 helper 会不会被再拦一次（App Translocation、子进程的隔离属性）——交付说明 §6 已承认没走过，我这里同样无法验证，请在带隔离标记的真实下载件上走一遍（`xattr -w com.apple.quarantine` 只能模拟一部分）。

### 4. userData 一致

- `index.ts` 里 `app.setName('english-exam-workbench')` + `app.setPath('userData', <appData>/english-exam-workbench)`（可被 `EWB_USER_DATA_DIR` 覆盖）在 `app.whenReady` 之前执行，与 productName、是否打包都无关；打包版冒烟里断言了 `app.getName()` 和 userData；本机 `~/Library/Application Support/` 下只有 `english-exam-workbench`，没有中文 productName 的目录，也就没有「打包版悄悄新建一个空库」的痕迹。dev / Mac dmg / Windows 安装版 / portable 因此共用一个目录。
- 唯一的尾巴：API Key 密文由 `safeStorage`（Mac 钥匙串 / Windows DPAPI）保护，Mac 上 dev 版（Electron.app）和打包版（ad-hoc 签名）对同一钥匙串项的访问权限不是同一个主体，首次会弹授权框，且每次升级会再弹（交付说明 §5 已写、指南已写）。**没有实测**（冒烟用 `--use-mock-keychain`）。解密失败按「没有密钥」处理，不会损坏数据（读过 `ai/secret.ts`）。

### 5. CI workflow

- 语法：`@action-validator/cli` 通过（我另外喂了一个故意写错的 yml，确认校验器确实会报错）；`on`/`jobs`/`matrix`/`if` 表达式（`inputs.install_zh_ocr` 在 push 事件下为空，与 `github.event_name == 'workflow_dispatch'` 联合使用没问题）、`shell: pwsh` / `bash` 混用都合法。
- 逻辑：`npm ci`（`package-lock.json` 里有 `@rollup/rollup-win32-x64-msvc` 等全平台可选依赖，所有 `resolved` 都是 `registry.npmjs.org`）→ `dist:win` / `dist:mac`（`dist.cjs` 在非 darwin 或 APFS 上输出到 `release/`，与冒烟的 `findApp()`、OCR 现场检查里的 `release/win-unpacked/...` 路径一致）→ 冒烟。mock AI 随机端口、由冒烟自己启停，没有「等待服务就绪」的竞态。Windows 的 OCR 降级断言（缺语言包时页面必须是 `ocr_failed` / `needs_ocr` 且带原因；英文引擎时必须带提示）是真断言，不会空转；两处例外见 P2-7。
- 没有任何 secret 被使用或回显（`GITHUB_TOKEN` 只用于 checkout）；上传 artifact 的内容是截图、结果 JSON、`ocr-*.txt`、安装包，全部来自 mock 数据。
- 问题：P1-1（mac 作业必红）、P2-6（Windows 单测可能先红）。另外 `windows-latest` 上 `Add-WindowsCapability` 装 OCR 语言包有可能不可用，但已 `continue-on-error`，不碍事。

### 6. 安装指南与验收清单

- 与应用实际行为一致的：数据目录路径、「设置 → 数据存储 / 数据包 / 示例数据 / AI 服务」、按钮文字（保存、测试连接、导出 / 导入数据包、更改数据目录）、`连接成功`、`OCR 使用 en-US 引擎，中文可能识别不全` 的原话、卸载保留数据、数据包不含密钥、导入前磁盘空间检查的措辞。
- macOS 15 起「系统设置 → 隐私与安全性 →『仍要打开』」的流程描述准确；`xattr -cr` 作为兜底合理。
- 与实际不符 / 写过头的见 P2-2、P2-4、P2-5 和 P3。
- 验收清单的步骤本身可操作；建议在回传说明里加一条「核对安装目录名」，并说明 `samples/` 里的三个样本文件需要由提供软件的人一起发给验收的人（清单里写的是「项目 samples 文件夹」，老师电脑上没有项目）。

### 7. M4 转入项

- **P2-A**（导出失败等句柄 close 再删 `.part`）：读了新的 `fail()`：先 `unpipe`，再对写流和所有登记的读流 `destroy()` 并等 `close`（上限 3 秒），之后才 `reject`；`.part` 用 `withRetry` 删除。**变异实测**（在临时副本里改）：① `reject` 不等关闭 → 失败；② 去掉 `for (const rs of [...readers]) closeOf(rs)` → 失败（`write：reject 时所有读句柄都应已关闭，还开着：page-1.png`）。到位。
- **P2-B**（字符限制）：规则本身实现正确（见 P2-1 的两个口子）。变异：关掉名称检查（`edit.ts`）、竖线检查（`kp-rules.ts`）、控制字符放行制表 / 换行，`m5-carryover.test` 都失败。内置种子 145 节点全部合规，我独立跑过。
- **P2-C**（启动提示）：`recoverImportJournalDetailed` / `startupNoticeOf` 的对应关系读过：`apply.ts` 里先写 journal 再 `mkdir files` 后才把旧 `files` 改名进备份，所以「备份里没有 files、`files` 在」确实是「文件没动」，不会把已经换进来的新目录误报成没动；`committed_cleanup_failed` 不抛错、下次启动重试清理；`takeStartupNotice` 取走即清。变异：关掉 `.invalid-*` 清理 → 失败；新通道已进 `READONLY_CHANNELS`，`ipc-guard-audit` 通过。
- **小项**：`ai:test` 改归写入类（`recordUsage` 确实在 `testConnection` 里，且被 `ipc-guard-audit` 扫描断言）；`EIO` 文案方向（读端 / 写端 / 中性三种）；`.invalid-*` 只留最近 3 份。到位。
- **磁盘空间检查**：`declaredTotalBytes` 只读中央目录，`ensureFreeSpace(staging, 声明总量 + 256 MB)`；statfs 抛错放行。变异：把 `free < need` 改成 `false` → `pack-reader.test` 失败（`Missing expected rejection`；注意不是 `m5-carryover` 而是 `pack-reader` 那里守着）。
- P2-7 的 worker 化评估的实测数字我没有复核（不影响结论），决定「不做」我同意：原子性依赖同步段，拆线程风险大于收益。

### 8. 测试有效性

- 变异测试我自己做了 7 次（临时副本）：6 次被 `m5-carryover` 抓住（导出不等关闭、不销毁读句柄、名称检查关闭、竖线检查关闭、`.invalid-*` 不清理、放行制表 / 换行），1 次（去掉磁盘空间检查）被 `pack-reader` 抓住；交付说明里「回退修复测试应失败」的说法成立。
- 断言偏弱的地方见 P2-7；`verify-artifacts` / `packaging-config` 不检查可执行位（P1-1）；`smoke-packaged` 的 Mac 分支（OCR 行数 > 30、PDF 嵌入 PingFang / Hiragino、控制台无错误、docx / PDF / 数据包 / 看板数字）是实打实的，24/24 的两份结果 JSON 我读过（arm64 与 x64-Rosetta 各 24 条全过）。
- 交付说明里的 ✅ 与证据对应：产物 sha256 前 16 位（我复算：arm64 `77ac8d29…`、x64 `2777f10e…`、setup `acf3bd6a…`、portable `fafceb38…`）和大小都对得上；`package-lock.json` 「没有删除或降级任何依赖」我逐包对比过 `bc6174d` 的锁文件：removed 0、版本变化只有项目自己的 `0.1.0→1.0.0`、新增 275 个，77 个包的 `dev` 标志由 false 变 true（正是挪进 devDependencies 的渲染端依赖及其传递依赖）。

---

## 核对过、没问题的要点

- `npm run typecheck` 通过；`npm run test:unit` 27 组全过；`verify-artifacts` 40/40（含我的复核）。
- 两个 dmg 带校验可挂载、卸载干净；`codesign --verify --deep --strict` 过；helper 是 universal 并已签名。
- 打包后 asar 内容、运行期依赖、`out/` 结构、资源路径、`ocr.ps1` 字节一致且 BOM 在。
- Windows exe 的 PE 结构（节表、`SizeOfImage`、资源、重定位、校验和）自洽；安装器和 portable 里的 exe 都经过 afterPack。
- NSIS 卸载默认不删用户数据；portable 与安装版共用数据目录。
- userData 与 productName / 打包与否无关，本机没有多出中文目录。
- workflow YAML 合法（有反向校验），没有密钥泄露点。
- 锁文件对比、产物哈希、`.gitignore` 的 `release/`、`.gitattributes` 的 LF 固定均成立。
- 安装指南 Markdown 在 CRLF 下解析结果与 LF 一致；`/guide` 与文档同源。
- M4 转入的全部项修到位，且回退修复测试会失败；内置种子树 145 节点通过新规则。

## 建议的处理顺序

1. 修 P1-1（三层：入库模式 + afterPack chmod + verify / 单测断言），否则 CI 的 macOS 第一次必红。
2. P2-1（导出端折平 + `approveSuggestion` 校验 + 粘贴零宽字符静默剔除）：关系到数据包「能导出就一定能导回」。
3. P2-3（删两处过期括号文案）、P2-2 / P2-4 / P2-5（改文档）：都是几分钟的事，但老师会直接看到。
4. P2-6 / P2-7（让 CI 在 Windows 上即使单测红也能跑到冒烟；两条空转断言）。
5. P2-8 在真机上看一眼菜单和任务栏。
