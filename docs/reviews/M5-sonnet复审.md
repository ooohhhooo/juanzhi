# M5 复审报告（Sonnet 5.5，新上下文，未参与编码）

> 审核对象：返工后的工作区（相对 `bc6174d` 的未提交改动 + 新产物），对照首轮 `docs/reviews/M5-sonnet审核.md` 与 `docs/M5-交付说明.md` §10。
> 实际运行：`npm run typecheck`（通过）、`npm run test:unit`（28 组全过）、`node scripts/verify-artifacts.cjs`（40/40）；重新打出的两个 dmg 用 `hdiutil attach -nobrowse -readonly` 挂载后 `codesign --verify --deep --strict`、`codesign -dv`、`lipo`、`ls -l`、`PlistBuddy`（看完已卸载）；`@electron/asar list`；在临时目录复制项目做了 9 次变异（回退修复，看测试是否失败）；另写了一个合并导入的复现脚本、一个只读 dmg 上的 helper 执行位实测。
> **没有**跑 E2E、没有跑打包版冒烟、没有重新打包、没有安装到 `/Applications`、没有碰 `~/Library/Application Support` 下本应用的数据、没有调真实 AI、没有改任何项目文件（只写了本报告）、没有 git 写操作。临时脚本在 `$TMPDIR` 与会话 scratchpad，不入库。冒烟 28/28 的两份结果 JSON 只读过。

## 结论

**通过。P0 = 0，P1 = 0。** 首轮的 P1 和 8 条 P2 全部修到位；P3 除「占位版权」（需要用户给文字）外也都处理了。返工引入了 1 条 P2（合并导入时，本机还留着旧的含非法字符的自建节点，会重复出一个节点）和几条 P3，都不阻塞。

---

## 一、首轮问题逐条核实

### P1-1 OCR helper 无执行位 —— **已修到位**

三层防线我都看了、也都验了：
- **入库模式**：`git ls-files -s native/macos/bin/ewb-ocr` → `100755`（`git status` 显示 `M ` 已暂存，协调会话改的）。
- **打包时**：`scripts/after-pack.cjs` 对 `.app/Contents/Resources/native/macos/bin/ewb-ocr` 无条件 `chmod 0o755`，helper 缺失就让打包失败。afterPack 在签名之前执行（electron-builder 的顺序），所以签名覆盖的是已带执行位的文件。**新产物**：两个 dmg 挂载后 helper 都是 `-rwxr-xr-x`，universal（`x86_64 arm64`），ad-hoc 签名；`codesign --verify --deep --strict` 两个包都退出 0；主程序分别是 arm64 / x86_64。
- **运行时兜底**（`pipeline/exec-bit.ts`）：`X_OK` 不过才 `chmod 755`，再不行返回中文原因，`ocr.ts` 的识别、图片转换、设置页状态三处都走它。**我实测了只读位置**：用 `hdiutil create -format UDRO` 造了一个只读 dmg，里面放一个 644 的 helper，挂载后调 `ensureExecutable`，返回 `{ok:false, reason:"OCR 组件没有执行权限，自动修复也没有成功（EROFS）……chmod +x …"}`，没有抛异常；helper 本身带执行位时（正常情况）`accessSync(X_OK)` 一次通过、不会去 chmod，所以从 dmg 里直接运行、或 `/Applications` 里属主不是当前用户的情况下也只是多一次 `access` 调用。我还直接从挂载的 dmg 里运行了新的 helper（对一个不存在的图片），能正常启动并给出「无法读取图片」。
- **回退即失败**（临时副本里变异）：afterPack 去掉 chmod → `packaging-config` 失败；`ensureExecutable` 去掉 chmod → `exec-bit` 失败。`verify-artifacts` 已加执行位断言（`(mode & 0o111) === 0o111`，两个 dmg 都过）。
- 说明：在 exFAT 盘上 `chmod` 无效、`stat` 总是 `rwx`，所以「afterPack 里的二次确认」在这块盘上不会触发；这靠的是单测里造的假 `.app`（644 的 helper）来证明 afterPack 确实起作用，我变异验证了，OK。

### P2-1 字符限制的口子 —— **已修到位**（但引入一条新 P2，见下）

- 导出端折平：`makeCleanSnapshot` 在快照里对所有节点名称 / 说明套 `flatKpText`（名称折完为空用代码顶上）；导入端 `prepareStagedDb` 在严格校验之前折平并返回 `kpTextFolded`，导入对话框里有提示（`DataSettings.tsx:191`，`info` 经 `pickPack` 原样返回，我核对了）；`approveSuggestion` 现在用 `cleanSuggestedName`（折平，折完为空 / 超 30 字拒绝）并把题号折平后再拼进说明；手工编辑对零宽字符静默剔除（`stripInvisible`），可见的竖线、控制字符仍报错。
- **回退即失败**：导出端不折 → `m5-carryover` 失败；导入端不折 → 失败（整包被拒）；`stripInvisible` 变成空操作 → 失败；`approveSuggestion` 不调 `cleanSuggestedName` → 失败（它是源码断言，不是行为断言——`ipcMain` 起不来，交付说明 §10 已如实说明）。
- 折平**不会改节点代码**：三处都只 `UPDATE ... SET name, note WHERE code`；代码字符集校验（`KP_CODE_RE`）未放宽。
- 折平对内置种子无影响（上轮已验 145 节点全合规）。

### P2-2 NSIS 向导与文档不符 —— **已修到位**

指南和清单已写明「为谁安装」页、桌面 / 开始菜单快捷方式自动创建（无复选框）、默认目录是 `C:\Users\你的用户名\AppData\Local\Programs\EnglishExamWorkbench`（ASCII，和我读源码得出的一致），验收清单 §1 加了「请核对目录名」。`guide-doc` 单测断言了这些文字，也禁止旧写法再现。（向导真实表现仍只有读源码的证据，没有 Windows 实机，这一点交付说明已如实标 ⚠️。）

### P2-3 残留文案 —— **已修到位**

`Settings.tsx` 的「完整正文在 M5……」、`extract.ts` 的「（M2）」已删；新增的 `packaging-config` 第 7 节会扫描 `src/` 下的字符串字面量和 JSX 文字，我把「完整正文在 M5」放回去变异，测试在 `Settings.tsx:33` 处失败。新的渲染端 bundle 同理（我没有重新 grep bundle，但源码和单测都守着）。

### P2-4 指南 / 清单界面文字 —— **已修到位**

我抽查了 grep 对照：「设置 → 关于 → 查看安装指南」、「OCR 失败」（`status.ts`）和红色提示「这一页的 OCR 没有成功：……」（`PaperDetail.tsx:167`）、「开始使用：三步就能出第一份分析」、Windows 10「应用和功能」。`guide-doc` 单测现在要求文档点名的 28 个界面文字都能在源码里找到原文，并禁止 9 个旧的错误写法。

### P2-5 隐私表述 —— **已修到位**

指南第三、四部分和验收清单第 6 项都写明「配了视觉模型、需要读图时，扫描页的页面图片会发给 AI 服务商」，并给了不想发图片时的做法。

### P2-6 CI —— **已修到位**

`permissions: contents: read`；Windows 作业的单测 `continue-on-error: ${{ runner.os == 'Windows' }}`，步骤显式 `shell: bash`（GitHub 对显式 bash 用 `-eo pipefail`，所以 `| tee` 不会吞掉 macOS 上的失败，macOS 仍硬失败）；日志 tee 进 `smoke-artifacts/unit-tests.log`，artifact 照常上传；`EWB_SMOKE_PREFIX` 改成 `ci-`。上轮用的 `@action-validator/cli` 我没有再跑（改动小，YAML 结构未变），请第一次推送后看真实结果。

### P2-7 空转断言 —— **已修到位，残余已如实标注**

- 「AI 请求」那条改成：从应用里读回保存的 AI 地址，主机必须是回环地址，且 mock 收到 ≥ 3 个请求（P1 ≥ 2、P3 ≥ 1）；名字也不再声称「没有请求发去别处」。mock 服务端确实暴露了 `p1Requests` / `p3Requests`（`tests/mock-ai/server.cjs:227,238`）。
- `CJK_FONT` 去掉了裸 `Microsoft`、`Hei` / `Song` / `Kai`。
- `verify-artifacts` 去掉 `-noverify`、`spctl` 改为只记录（`note`）、不计入通过数；40/40 是真断言的 40 条。
- 残余：Windows 上「PDF 汉字不是整页豆腐块」仍然没有渲染级断言，交付说明已写明并留给真机验收清单第 7 项人工目视。接受。

### P2-8 `app.setName` 副作用 —— **已修到位**

- macOS 自建中文应用菜单（`menu-template.ts`）：应用菜单（关于 / 隐藏 / 隐藏其他 / 全部显示 / 退出，都带产品名）、编辑菜单（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选）、窗口菜单（最小化 / 缩放 / 前置全部窗口 / 关闭窗口）；开发版另有视图菜单。**标准菜单项和快捷键**：每个项都是 Electron 的 `role`，快捷键（Cmd+Q / H / C / V / X / A / Z / W / M）由 role 自带，不是手写 accelerator，所以文字改成中文不影响；`docs/screenshots/m5-menu-darwin.json`（打包版里读出的真实菜单）里编辑菜单齐全、整个菜单没有 `english-exam-workbench`、没有视图菜单。我没有实机按快捷键（不允许运行应用），这一条是读代码 + 读冒烟留下的 JSON 得出的结论。
- 窗口标题和 `<title>` 统一为 `PRODUCT_NAME`；`app.setAboutPanelOptions` 设置名称和版本；Windows 在 `app.whenReady` 之前 `app.setAppUserModelId('cn.edu.english-exam-workbench')`，与 electron-builder 写进 NSIS 快捷方式的 appId 一致（`brand.ts` 与 `package.json` / builder 配置由单测核对；我把 `setAppUserModelId` 调用去掉变异，`packaging-config` 失败）。菜单模板被改坏（编辑菜单标签变掉）同样会被单测发现。
- 新产物 `Info.plist`：`CFBundleName` = `CFBundleDisplayName` = 产品名。

### P3

- 指南因果 / Rosetta / Win10 措辞：已改（第 16、23、116 行我读过）。
- `LICENSE` 不再被排除：新 asar 里 `LICENSE*` 有 30 个文件；pdf.js 的 `*.min.mjs` / `pdf.sandbox*` / `zod/src/**` 已排除（asar 1622 → 1361 条）。
- 占位版权：**未改**，需要用户给文字（新 `Info.plist` 仍是「占位版权信息」），交付说明已说明。
- `release/` 里的 `._*`：这次 `ls release` 没有，已清。
- `EWB_SMOKE_PREFIX`：已改。

---

## 二、返工引入的新问题

### 新 P2-A 合并导入时，本机留着旧的含非法字符的自建节点，会重复出一个节点并改号

- 位置：`src/main/pack/apply.ts:116-121`（`mergeKps` 的「同一个节点」判断 `d.name === k.name && 上级相同`）与 `exporter.ts` 导出端折平 / `stage-db.ts` 导入端折平。
- 问题：返工后包里的名称是折平后的，但**本机库里的旧节点名称没有被折平**（只折导出的快照、提示词里临时折）。于是本机还留着 `名称='a|b'` 的旧自建节点时，把自己导出的包「合并」导回本机（正常的备份 / 还原 / 换电脑后再合并都会这样）：包里是 `a b`，本机是 `a|b`，名字对不上，被当成「同一代码、含义不同」，包里这个节点被改号成 `GR.TENSE.U2`（标注一起改号），树里出现两个只差一个字符的节点。
- 复现（**已复现**，临时副本里的 `rv-merge.mjs`：造一个名称为 `a|b` 的自建节点并标到一道题上 → `buildPack` → `extractPack` → `prepareStagedDb` → `applyMerge` 回本机）：输出 `before: [U1 'a|b']`，`after: [U1 'a|b', U2 'a b']`，`kpsAdded:1, kpsRemapped:1`。
- 影响：只在本机有 M5 之前输入过换行 / 竖线 / 零宽字符的自建节点时才发生（这类数据只可能来自开发期的试用库）；后果是多一个重复节点，不丢数据。老师发现后可以在知识点编辑里合并。
- 建议：`mergeKps` 的比较改成 `flatKpText(d.name) === k.name`（本机名称也折平再比）；更彻底的做法是 v10 迁移（或启动时一次性）把本机所有 kps 的名称 / 说明折平。

---

## P3（新发现，顺手改）

- 导入端折平：一个旧包里名称只有 `|` 或零宽字符的节点，折完是空串，随后 `validateKpRows` 报「没有名称」整包拒绝——和「对这类字符宽容」的说法不完全一致（导出端有「用代码顶上」，导入端没有）。同理说明折完是空串会写成 `''` 而不是 `NULL`。建议导入端也用代码顶上空名称、空说明写 `NULL`。
- `approveSuggestion` 里 `cleanSuggestedName` 抛的是普通 `Error`，渲染端会看到「Error invoking remote method……」前缀，和其他错误一样不够友好；不影响数据。
- Windows / Linux 的菜单栏仍是 Electron 默认的英文菜单（含「View → Toggle Developer Tools」），交付说明 §6 已写明；老师能打开开发者工具，不会损坏数据，但建议后续也用一份中文菜单（并去掉开发者工具）。
- 冒烟里的「菜单」断言读的是 `Menu.getApplicationMenu()` 的结构，没有实机按过快捷键；真机验收时在 Mac 上试一次 Cmd+C / V（输入框里）和 Cmd+Q 即可。

---

## 核对过、没问题的要点

- typecheck、28 组单测、`verify-artifacts` 40/40 全部通过（新产物上）。
- 新 dmg（arm64、x64）：签名完整、helper 755 + universal + 已签名、`Info.plist` 名称正确、无 `._*`。
- 新 asar：1361 条，无 tests / docs / `.env` / `._*` / `.map` / `zod/src`；`pdfjs-dist/legacy/build` 只剩 `pdf.mjs`、`pdf.worker.mjs`（和 `.d.mts`），cmaps / standard_fonts 仍在；`zod/index.cjs`、`v3/*.cjs` 在（zod 的 `package.json` 里 `./src/*.ts` 只是 `zshy` 构建元数据，运行时走 `index.cjs`）；`pdf.mjs` 里没有对被排除文件的引用（只有一处 `pdf.worker.mjs` 字样）、`getDocument` 用 `isEvalSupported: false`、PDF 脚本未启用；冒烟两份 28/28（含 PDF 文字层提取）也证明没有缺文件，我只读了结果，没有重跑。
- 9 次变异全部被抓到（afterPack 去 chmod、`ensureExecutable` 去 chmod、导出端不折、导入端不折、`stripInvisible` 空操作、`approveSuggestion` 不清洗、残留里程碑文案、去掉 AppUserModelID、编辑菜单被改）。
- 折平不碰节点代码，也没有放宽代码字符集；内置种子树不受影响。
- 从 dmg 直接运行 helper、只读卷上 chmod 失败时的降级，都不会崩溃或卡死。

## 残余 / 未验证（沿用首轮，交付说明已如实标注）

Windows 上运行任何东西；工作流从未真正运行；Mac 菜单快捷键没有实机按；带隔离标记的 dmg 走 Gatekeeper 后 helper 是否被再次拦截（运行时兜底只能给出中文说明，不能绕过）；真实钥匙串授权；Intel 实机。
