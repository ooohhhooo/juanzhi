# M7 命令行接口（CLI）审核

审核范围：`git diff main..m7-cli`（33 个文件）。只读审核：没有改源码，没有跑 build / E2E / dist，没有碰真实数据目录，没有调用真实 AI。
做过的验证：`npx tsc --noEmit -p tsconfig.node.json` 无报错；`cli-args / cli-lock / cli-shim / packaging-config / ipc-guard-audit / ocr-ps1` 单测通过；锁的竞态用多进程脚本复现（在临时目录里，不涉及真实数据）；Mac 的 shim 覆盖问题用临时 HOME 复现。
**Windows 部分没有 Windows 真机可跑，凡标「需真机确认」的是读代码和对 cmd / PowerShell 已知行为的推断。**

## 结论：不通过

没有 P0（没找到密钥泄露、家长版草稿标记被绕过、删除能力）。有 7 个 P1：锁的竞态和陈旧锁（P1-1、P1-2，设计要求 5）、安装命令行工具覆盖已有文件和弄坏 Windows 用户 PATH（P1-3、P1-4，设计要求 7）、结果文件能覆盖数据库（P1-5，设计要求 4 的精神）、Windows 输出中文可能乱码（P1-6，设计要求 8）、打包版命令行冒烟没传数据目录（P1-7，设计要求 10）。P1 修完后需要复审。P2 的编号是 P2 一节里的连续序号（1~27），正文里写的「P2-5」指第 5 条。

---

## P1

### P1-1 运行锁有竞态：两个命令行（或窗口 + 命令行）可以同时拿到锁
`src/main/cli/lock.ts:33-52`

- 触发场景 A（陈旧锁清理）：锁文件里的 pid 已经死了，A、B 两个进程同时启动。A 读到陈旧锁 → `unlink` → `wx` 创建成功；B 之前也读到了同一份陈旧锁，这时才执行 `unlink`（删掉的是 A 刚创建的新锁）→ `wx` 也成功。两个进程都认为自己持有锁。注释写的「wx 保证只有一个成功」只管创建，管不了「删了别人的新锁」。
- 触发场景 B（空文件窗口）：`writeFileSync(..., {flag:'wx'})` 是先创建空文件、再写内容。这一瞬间别的进程 `readLock` 读到空文件 → `JSON.parse` 失败 → 当成「损坏」→ 直接 `unlink`（第 48 行），把对方刚抢到的锁删了。已验证：对一个空锁文件调 `acquireRunLock`，返回 `ok:true`。
- 复现：4 个进程同时抢一个预置的陈旧锁，各自持锁 150ms，重复 30 轮，其中 21 轮出现持锁时间重叠（最多 4 个进程同时持有）；预置「没有锁」的情况 40 轮没出现。脚本在 scratchpad：`/private/tmp/claude-501/-Volumes-Elements-Claude/4290fca5-2e96-4c22-a1f7-0e6ee99f1125/scratchpad/race/`（`run.mjs stale 30`）。
- 后果：两个命令行同时跑 `recoverInterruptedPapers()` + 导入，互相把对方在途的卷子标成失败；GUI 与 CLI 同时写同一个库。E2E 的「同时运行」用例（`run-m7.cjs`「M7 同时运行」）只跑 `papers list` + `status` 两个只读命令，并且允许「两个都成功」，所以抓不到这个问题。
- Windows 语义补充：`unlink` 一个别的进程刚打开过的文件，会让文件处于「待删除」状态，此时 `wx` 创建会返回 `EPERM`（不是 `EEXIST`），第 42 行会直接 `throw`，CLI 变成 `internal` 退出码 1，而不是重试或报 4。Defender 扫描文件时同理。（需真机确认）
- 修法（任选其一）：
  1. 最稳：不用文件存在性，改用「进程活着才持有」的内核机制——监听一个命名管道（Windows）/ unix socket（Mac）或回环端口；进程死了系统自动释放，既没有竞态，也没有陈旧锁和 pid 复用问题（见 P1-2）。
  2. 保留文件锁的话：先写临时文件（内容写完整），再用 `fs.linkSync(tmp, lock)` 原子地「带内容创建」（EEXIST 才算被占）；清理陈旧锁时不要直接 `unlink`，先 `rename` 成带随机后缀的文件，并在 rename 之后再读一遍确认内容仍是自己判断过的那份；`EPERM / EBUSY` 当作「稍等重试」处理（重试 3~5 次，每次间隔几十毫秒）。
  3. 补一个多进程并发的单测（上面那个脚本可直接改成单测），断言同一时刻最多一个持有者。

### P1-2 崩溃 / 断电 / 重启后，锁可能永远不过期，窗口打不开且提示是错的
`src/main/cli/lock.ts:15-18, 45`；`src/main/index.ts:130-136`

- 触发场景：窗口或命令行被强杀 / 断电 / 蓝屏，锁文件留下，里面的 pid 在新的一次开机后恰好被一个无关的活进程占用（Windows pid 回收很快、数字小，重启后很容易撞上；Mac 概率低一点但存在）。`isProcessAlive` 只做 `kill(pid, 0)`，没有进程启动时间、没有超时，所以这把锁被当成有效锁，直到那个无关进程退出。已验证：构造一份 `startedAt: 2020-01-01`、pid 是任意活进程的锁，`acquireRunLock` 返回 `ok:false`。
- 窗口这边更糟：第 130 行只要没拿到锁就弹「卷知命令行正在使用数据」然后 `app.exit(3)`，不区分持有者是 `gui` 还是 `cli`。能走到这一步说明 Electron 单实例锁已经拿到了，也就是说不可能有别的活着的窗口，`mode:'gui'` 的持有者一定是陈旧锁；老师看到的是一个莫名其妙的提示，也没有办法自己清掉（不知道文件在哪）。
- 设计要求 5 里写的「锁文件过期后要能清掉」：现在实际上只有「进程不存在」这一种过期，没有时间过期。
- 修法：
  1. 窗口拿到 `requestSingleInstanceLock()` 之后，遇到 `mode:'gui'` 的锁直接接管（覆盖），只对 `mode:'cli'` 且活着的持有者才拒绝。
  2. 锁里记 `startedAt`，判断陈旧时加一条：`startedAt` 早于本次开机时间（`Date.now() - os.uptime()*1000`）就一定是陈旧锁。这条几乎没有成本，能挡掉「重启后 pid 撞上」的绝大多数情况。
  3. 或者直接采用 P1-1 的方案 1（命名管道 / socket），这几个问题一起消失。
  4. 窗口提示里写清楚锁文件位置，方便手动清理。

### P1-3 「安装命令行工具」会静默覆盖用户已有的同名文件，包括符号链接指向的真实文件
`src/main/cli/shim.ts:130, 140-141`

- 触发场景：`~/.local/bin/juanzhi` 已经存在（用户自己写的脚本、别的工具装的、或者指向别处的符号链接）。`writeFileSync` 直接写，没有任何检查。已验证：`~/.local/bin/juanzhi` 是指向 `other/real-juanzhi` 的符号链接时，安装之后 `other/real-juanzhi` 的内容被换成了卷知的脚本（符号链接被写穿）。Windows 的 `juanzhi.cmd` 同理，另外该目录里 PATH 靠前的其他 `juanzhi` 会遮住新装的，现在也没有检测。
- 界面上的按钮名字是「重新安装命令行工具」，用户有「会覆盖我自己装的」的预期，但没有预期会覆盖不是卷知写的文件。
- 修法：
  1. 写之前 `lstat`：是符号链接就拒绝（或只在它指向的目标就是卷知写的脚本时才继续）；文件已存在且内容里没有「由「卷知」生成」这个标记，拒绝并提示「已有一个不是卷知生成的 juanzhi，请先改名或删除」，或先备份成 `juanzhi.bak-<时间>`。
  2. 用临时文件 + `rename` 原子替换，避免半截脚本。
  3. 单测加：已有同名文件 / 符号链接时不覆盖。

### P1-4 Windows 修改用户 PATH 会把原有的 `%变量%` 条目永久展开并改成固定字符串
`src/main/cli/shim.ts:65-73`

- 没用 `setx`，所以 1024 字符截断的老问题不存在，这点是对的。但 `[Environment]::GetEnvironmentVariable('Path','User')` 在 .NET Framework 里读注册表时**会把 `REG_EXPAND_SZ` 里的 `%USERPROFILE%`、`%JAVA_HOME%`、`%NVM_HOME%` 这类引用展开**，而 `SetEnvironmentVariable('Path', …, 'User')` 写回去时类型变成 `REG_SZ`。结果：用户原来的 `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps` 之类全部被换成当时展开出来的固定路径，以后改 `JAVA_HOME` 之类 PATH 不再跟着变；展开不出来的变量（当时没定义）会留成字面的 `%X%` 并且永远不再展开。这属于「弄坏原有 PATH」。（需真机确认；这是 .NET 的已知行为。）
- 修法：直接读写注册表，保留原类型：
  `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`；
  `$p = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`；
  只在末尾追加目录；`$k.SetValue('Path', $new, 'ExpandString')`；
  然后广播一次环境变量变更，让新开的终端立刻生效，例如调用 `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", …)`，或者再用 `[Environment]::SetEnvironmentVariable('JZ_DUMMY', $null, 'User')` 触发广播。
  追加前先备份原值到 `%LOCALAPPDATA%\Juanzhi\path-backup.txt`，出问题时用户可以恢复。
- 单测里 `runPowerShell` 是假的，只验证了「调用了」，没有覆盖 REG_EXPAND_SZ，应在 Windows CI 里加一个真实用例：先写入一个带 `%USERPROFILE%` 的用户 PATH，装完后断言原值逐字符不变，只多一个目录。

### P1-5 `--result-file` / `--out` / `JUANZHI_RESULT_FILE` 可以覆盖任意文件，包括数据库
`src/main/cli/run.ts:48-56`；`src/main/cli/args.ts:170-175`

- 触发场景：`juanzhi status --result-file <数据目录>/db.sqlite`（或 `--out`、环境变量），CLI 在结束时直接 `writeFileSync` 把一行 JSON 写进去，没有任何限制：不限扩展名、不限目录、不怕已存在、不检查是不是数据目录或 `userData`。Agent 手误、或被不可信文本诱导，都能一条命令毁掉整个库（`writeFiles` 在第 62 行，早于 `closeDatabase()`，数据库还开着的时候就被覆盖）。设计要求第 4 条是「CLI 也不提供删除功能」；覆盖数据库在效果上等于删除，只是换了个入口。
- 同类：`report export --out` 会静默覆盖已存在的 `.md / .docx / .pdf`（扩展名强制补齐，不会写到 `~/.zshrc` 上，这一点是好的），界面上的「另存为」会提示覆盖，命令行没有。
- 修法：
  1. 结果文件和 `--out`（JSON 副本）：拒绝落在数据目录、`userData`、`files/` 之内的路径（`path.resolve` 后做前缀比较，注意符号链接用 `realpath`）；扩展名限定 `.json` / `.txt` 或无扩展名；目标已存在且不是由本程序上次写的 JSON 时拒绝。
  2. `report export`：目标已存在时默认拒绝，加 `--overwrite` 才覆盖。
  3. E2E 加用例：`--result-file <db.sqlite>` 得到退出码 2。

### P1-6 Windows 上通过 `juanzhi.cmd` 读到的 stdout 在 PowerShell 里中文会乱码（需真机确认）
`src/main/cli/shim.ts:35-36, 45, 57`；`src/main/cli/run.ts:73`

- 输出始终是 UTF-8 字节（`type` 输出的是文件原始字节，`chcp 65001` 对 `type` 没影响）。PowerShell 5.1 / 7 抓取原生命令输出时，按它启动时缓存的 `[Console]::OutputEncoding`（中文系统是 GBK 936，英文系统是 437）解码，所以 `juanzhi report generate … | ConvertFrom-Json` 拿到的 `message`、卷子标题、报告 `markdown` 里的中文都会是乱码。Codex 在 Windows 上默认用 PowerShell，这正是主要使用场景；设计要求第 8 条问的「chcp 有没有处理」，这里 `chcp 65001` 只解决了 .cmd 文件自己读中文路径的问题，没有解决输出被读取的问题。
- CI 的 PowerShell 步骤只校验了 `ok / version`（ASCII），`cli-smoke.cjs` 是 Node 按 UTF-8 读，所以都发现不了。
- 修法（最省事、一劳永逸）：stdout / 结果文件里的 JSON 把所有非 ASCII 字符转成 `\uXXXX`（`JSON.stringify(x).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))`），这仍然是合法 JSON，任何编码的终端都不会乱。同时 `.cmd` 里的 `echo` 错误提示也改成 ASCII（`\u` 转义）。`--result-file` / `--out` 写给文件的版本保留 UTF-8 原文也可以，两者分开。
- 另外，这样也顺带规避了下面 P2-9 提到的「cmd 里中文 + goto 标签」问题。

### P1-7 `cli-smoke.cjs` 没有把 `EWB_USER_DATA_DIR` 传给命令行，打包版命令行冒烟一定会失败，在开发机上还会碰真实数据目录
`tests/e2e/smoke-packaged.cjs:299-302`；`tests/e2e/cli-smoke.cjs:41-42`

- 窗口是用 `{ ...process.env, EWB_USER_DATA_DIR: userData }` 启动的（第 122 行），mock AI 配置、测试数据都在这个临时目录里；调用 `cliSmoke` 时传的是 `env: {}`，命令行子进程用的是默认的 `~/Library/Application Support/english-exam-workbench`（或 Windows 的 `%APPDATA%\english-exam-workbench`）。
- 后果：① CI 上默认目录是空的，`ai.configured === true` 这条断言一定失败，导入 / 确认 / 报告 / 导出全部跟着失败（会报错，不是静默通过，但冒烟没法用）；② 开发机上跑，会对真实资料库执行 `initDatabase`（可能触发升级迁移）、创建 `ewb-run.lock`，真实窗口开着就是退出码 3；如果真实库里配了 AI 并且钥匙串能解密（没有 `--use-mock-keychain` 的 Windows），会用真实密钥调真实 AI，并往真实库里导入样张、确认、生成报告，违反 `smoke-packaged.cjs` 文件头「全程用临时 userData、不调用真实 AI」的承诺。
- 修法：`env: { EWB_USER_DATA_DIR: userData }` 传下去，并在 `cliSmoke` 里断言 `status.data.dataDir` 在临时目录下。

---

（P1 到此为止。下面的 P2 建议在同一轮改掉，不阻塞，但 P2-1 到 P2-3 属于「测试自己没在测」，建议一起修。）

## P2

### 测试有效性
1. **`.github/workflows/build.yml:155-163` cmd 步骤里直接运行 `.cmd` 没有加 `call`**：批处理里不加 `call` 运行另一个 `.cmd`，执行完不会回到调用者，所以 GitHub 的 `shell: cmd` 这一步只执行第一行 `juanzhi.cmd status > cli-status.json`，之后的 `type`、`findstr`、`bogus` 的退出码判断、写 `cli-windows-cmd.txt` 全部不会执行，步骤的结果只取决于第一条命令的退出码。「`cmd` 里能拿到退出码」这个关键点（设计要求第 8 条）因此在 CI 里没有被真正验证。修法：每个调用前加 `call`。（需真机确认；这是 cmd 的固定行为。）
2. **`tests/e2e/cli-smoke.cjs:82-85`**：`run('cmd.exe', ['/d','/c', `"${shim}" status`])` 会被 Node 加转义反斜杠 `\"` 后传给 cmd，cmd 不认识 `\"`，大概率启动失败；用 `windowsVerbatimArguments: true` 或 `spawn(process.env.ComSpec, ['/d','/s','/c', `""${shim}" status"`], { windowsVerbatimArguments: true })`。
3. **`cli-smoke.cjs:25` 和 `run-m7.cjs:27` 监听的是 `exit` 事件而不是 `close`**：`exit` 触发时 stdout 管道里的数据可能还没读完，偶发读到截断的 JSON（会误报失败，不是误报通过）。改成 `close`。
4. **`run-m7.cjs`「M7 同时运行」不能验证互斥**：见 P1-1，两个只读命令且允许两个都成功。应改成两个会拿锁并持有一段时间的命令（例如 `import` + `import`，或用 `EWB_CLI_DEBUG` 加一个测试用的 sleep），断言「恰好一个成功、另一个退出码 4」。
5. **密钥检查太窄**：`cli-smoke.cjs:70` 只在 status / import / 报告的输出里搜 `sk-smoke-key`；`run-m7.cjs` 的最后一项也只搜 stdout/stderr。没有检查导出的 md / docx / pdf 文件、`--result-file` 文件、`ai_key_enc` 字样。建议把导出文件的文本和所有结果文件也并进搜索，并搜 `ai_key_enc`。
6. **`ocr-diagnose.ps1:114-117` 判定有漏洞**：① 把 `-1`（脚本崩溃、没有输出）和 `0 行` 一样当成「读不出来」，所以 ocr.ps1 整体崩溃、而极简代码在同一台机器上也失败时，会被判成 `ENV`（只警告）；② 如果极简代码能读对照图而 ocr.ps1 连对照图都读不出来（脚本整体坏了），样张和拍平的样张都读不出，会落到最后的 `else` 判成 `IMAGE`（只警告）。`SCRIPT` 只在「拍平的样张能读」时触发。建议：`ENV` 要求 ocr.ps1 的 `exitCode` 是 2 或 3（引擎 / 语言包问题）或者「跑成功了但 0 行」；极简代码读对照图成功、而 ocr.ps1 读对照图失败（exitCode ≠ 0 或 0 行）直接判 `SCRIPT`。好在 `smoke-packaged.cjs` 里 `IMAGE` 情况不会跳过，OCR 项还是会失败，所以整体仍能拦住，这里是降级到 P2 的原因。
7. **`smoke-packaged.cjs:192-195` 新增了 `skip()`**：被跳过的项 `pass:false, skipped:true`，不计入失败，进程退出码为 0。只在 `ocr-diagnose.json` 的结论是 `ENV` 且识别行数不足时才跳过，并且在输出里明确写「不算通过」，这个取舍可以接受；同时 Windows 阈值从 `> 0` 收紧到 `>= 15`，整体不是放宽。但 `>= 15` 是推测值（注释里写「样张里的英文行只有 20 多行」，没有实测依据），首次 CI 可能误报失败。原有断言没有被删除或放宽（`git diff` 里 tests/unit 没有被删除的行）。
8. **`smoke-packaged.cjs:294-296`**：Windows 上不管是不是 CI 都执行 `cli:install`，在开发者的 Windows 机器上跑冒烟会真的改他的用户 PATH 和 `%LOCALAPPDATA%\Juanzhi`。注释写的是「CI 机器上无所谓」。建议和 Mac 一样加开关。

### Windows 细节
9. **`shim.ts:35-60` .cmd 里中文 + `goto` 标签**：`chcp 65001` 之后文件里还有中文（`:missing`、`:noresult` 两段 `echo`）和 `goto :标签`。早期 Windows（7/8 和部分旧 Win10）上，cmd 在 65001 下按字符而不是按字节算文件偏移，含多字节字符的批处理里 `goto` 会跳错行。Win10 较新版本据说已修，但没法在这里验证（需真机确认）。按 P1-6 把 echo 改成纯 ASCII 后，只有 `set "JZ_EXE=…"` 一行含中文（用户名），而且在 `goto` 之前，风险基本消除。
10. **`shim.ts:37`**：`exePath` 里的 `%` 没有转成 `%%`（用户目录里有 `%` 时 `set` 会展开）；没有显式 `DisableDelayedExpansion`（注册表里默认开了延迟展开时 `!` 会被吃）。
11. **`shim.ts:46`**：注释和文档（`docs/M7-命令行接口设计.md` §7）写的是「按结果文件里的 `exit` 字段补退出码」，代码实际是固定改成 `1`。免安装版启动器不传退出码时，`app_running(3)`、`cli_busy(4)`、`ai_not_configured(5)` 等都会变成 `1`，Agent 无法区分。应当从结果文件里取出 `"exit":N`（例如用 `findstr /R` 或者 `for /f` 解析），或者把文档改成「固定返回 1」。同一行的 `findstr /C:"\"ok\":false"` 也会被数据里碰巧出现的 `"ok":false` 字样误触发（例如报告正文里引用的 JSON），成功结果被改成退出码 1；改成只匹配以 `{"ok":false` 开头的行（`/B`）。
12. **PowerShell 传参**：PowerShell 5.1 对不含空格但含 `&`、`|` 的参数不加引号，经 `%*` 传给 cmd 后会被当成命令分隔符（如 `--textbook "A&B"`）。这是个边缘情况，值得在文档里提一句「含 `&` 的参数请用 `--textbook='A&B'` 或直接调用 exe」。

### 命令行本身
13. **Mac 窗口关掉≠退出**：`src/main/index.ts:197-199` 在 macOS 关最后一个窗口不退出应用，锁和数据库一直占着。老师按文档「先关闭卷知窗口」操作之后，命令行仍然返回 3（`app_running`），要按 Cmd+Q。`run.ts:91`、`docs/命令行.md`、`skills/juanzhi/SKILL.md` 的措辞都应改成「退出卷知（Mac 上按 Cmd+Q，只关窗口不行）」。这是主平台上最容易遇到的一个坑。
14. **`args.ts:143-144` 用 `COMMANDS[word]` 查命令**：`constructor`、`toString`、`__proto__` 会命中 `Object.prototype` 上的函数，进入 `[...spec.flags]` 抛 `TypeError`，最后变成 `internal`（退出码 1）而不是 `usage`（2）。已验证。改成 `Object.hasOwn(COMMANDS, key)` 或 `Map`。
15. **`run.ts:80` 把 `unhandledRejection` 当致命错误**：GUI 里一个多余的未处理 Promise 只是一条警告；命令行里会让整个命令以 `internal` 结束（还会在导入途中中断）。队列代码里有不少 `void drain()` / `void runJob()`。建议只写 stderr 日志，不终止。
16. **`status` / `import` 在 Mac 上可能卡在钥匙串授权框**：`status` 会调 `isAiReady()` → `getApiKey()` → `safeStorage.decryptString`。打包版是 ad-hoc 签名（`verify-artifacts.cjs` 里 `Signature=adhoc`），`docs/安装指南.md` 也写着更新后会弹钥匙串提示。命令行（尤其是 Agent 后台跑）遇到这个系统弹窗会一直等，且除 `import` 外其他命令没有超时。建议：SKILL.md / 命令行文档写明「更新后先在窗口里打开一次并选『始终允许』」，并让 `status` 的 AI 检查不阻塞（超时返回 `configured: null`）。
17. **`commands.ts:85-95` `import` 等待循环只以 `DONE_STATES` 判断结束**：如果队列已经空了，但某份卷子停在 `extracted` / `imported`（例如自动解析因故没被入队），会一直等到 `--timeout`（默认 3600 秒）。建议加一条「提取队列和解析队列都空闲且仍有未完成状态」就按 `failed` 处理。
18. **`commands.ts:74-77` `import` 绕过了 `papers:import` 的 `PathsSchema`**（最多 100 个文件）：命令行一次可以传任意多个。功能上没问题，只是和界面的限制不一致，文档里没说。
19. **覆盖「历史上限」**：`report generate` 内部会 `DELETE` 掉超过 100 条之外的最旧报告（`service.ts:377`），包括已经核对过的家长版。界面里也是如此，但命令行 Agent 反复生成会更快触发。文档里「不能删除」的说法需要加一句注释，或者对已核对的报告豁免。
20. **`report export` 返回的 `draft` 只对家长版有意义**：`exportReportTo` 里 `draft` 仅在家长版且未核对时为 true，其余版本（老板版 / 老师版 / 完整版）一律 `false`，而 `report show / generate` 里 `draft: !confirmedAt`（这些也是未经老师核对的 AI 草稿）。Agent 可能把 `draft:false` 读成「已核对」。建议导出结果里 `draft` 统一用 `!confirmedAt`，家长版另外保留 `parentDraft`；`reviewed` 字段已经有了。
21. **文档与实现不一致**：`docs/M7-命令行接口设计.md` §2 说「不注册的模块：数据包导入导出（data:*）、知识点编辑（taxonomy:*）、设置写入」，实际 `registerQuestionIpc()` 会注册 `taxonomy:tree / approveSuggestion / rejectSuggestion`，`registerSettingsIpc()` 会注册 `settings:set`，`registerReportIpc()` 会注册 `report:delete / report:confirm / report:removeSentence`，`registerPaperIpc()` 会注册 `papers:remove / update`，`registerQuestionIpc()` 会注册 `questions:remove / merge / split / update / reopen`。它们都在内存表里，只是没有命令会调用。现在的安全性靠「`commands.ts` 里通道名全是写死的字面量」，没有白名单。建议在 `run.ts` 的 `call` 里加一个 `CLI_ALLOWED_CHANNELS` 集合（`ocr:status, papers:list, papers:get, questions:list, questions:confirmPaper, stats:overview, stats:hot, stats:compare, report:generate, report:list`），其余通道直接 `internal` 报错；文档同步改成「注册了但不可调用」。
22. **`ipc-guard` 方面的核对结论**（设计要求 6）：本项目的 IPC 处理函数里**没有**来源（`senderFrame`）校验；`restart.ts` 的 `installIpcGuards` 只管「需要重启」和「导出中」两个主进程状态，命令行进程里这两个状态不会出现，所以没有注册它是对的。参数校验（zod）在各 `ipcMain.handle` 内部，命令行按通道调用时原样生效，我读过 `papers:list / papers:get / questions:list / questions:confirmPaper / stats:* / report:generate` 的入口，参数都经过 `parse`。`busy.ts` 只被 `data:*` 用，命令行不调用它们，所以「busy 守卫生效」在命令行里是没有对象的（`report:generate` 自己的 `inflight` 互斥会生效，映射为退出码 12）。`allowPath()` 是导入路径授权的「真边界」，命令行进程里没有渲染进程，所以由 CLI 自己登记路径是合理的，不影响窗口。
23. **`ipc/cli.ts` / `shim.ts` Mac 提示不准确**：`onPath` 用的是窗口进程自己的 `PATH`（从 Dock 启动时通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`），所以几乎总是 `false`，提示「再加一次 `~/.zshrc`」，反复点会重复追加。可以改成读用户 shell 的 PATH（`zsh -ilc 'echo $PATH'`，带超时），或者提示文案改成「如果已经加过可以忽略」。另外 App Translocation（从下载目录直接打开）时 `process.execPath` 是随机的只读路径，重启就失效，现在只拦截了 `/Volumes/`；建议同时拦 `/AppTranslocation/` 并提示拖进「应用程序」。
24. **启动提示被吞**：`initDatabase()` 在命令行里也会执行「覆盖导入恢复」，结果存在内存里的 `startupNotice`，命令行不读也不输出，进程退出就丢了，下一次打开窗口老师不会再看到这条提示。建议命令行在 stderr 打出，并且把这条结果带进下一次 `status` 的输出。
25. **`redirectConsole`（`run.ts:30`）里非字符串参数用 `JSON.stringify`**：`Error` 对象会变成 `{}`，错误信息丢了；`BigInt` 会抛异常被吞掉。改用 `util.format`。
26. **Mac 启动瞬间 Dock 会闪一下**：`app.dock.hide()` 在 ready 之后才执行，进程刚启动那几百毫秒 Dock 里会有图标。E2E 只在命令结束时检查了 `dock=false`。如果要完全不出现，需要在 `Info.plist` 里设 `LSUIElement`（会同时影响正常窗口模式，不可取），所以文档里「Dock 里没有图标」可以改成「运行期间没有可见的 Dock 图标」。
27. **PowerShell 与 `ocr.ps1` 小问题**：
    - `ocr.ps1:172-176` 铺白底后 `Open-Decoder $flatFile` 如果失败，会走到外层 `catch` 以退出码 1 结束，而原图其实是能识别的；应该包一层 try，失败就回退到原图继续。
    - `Convert-ToOpaquePng` 里 `DrawImage` 抛异常时 `$g`、`$bmp` 没有释放（只在进程退出时释放，影响很小）。
    - 空白页 / 无字页会连续做三遍识别（Bgra8 → Gray8 → 放大 2 倍），每页多花几秒，上限仍受 60 秒的 `OCR_TIMEOUT_MS` 约束；大图放大 2 倍占内存。可以只在第一遍行数为 0 且页面不是全白时才重试，或者放大前先判断像素是否全白。
    - 以上都不影响核心修复。**铺白底的逻辑本身是对的**：用 `BitmapAlphaMode != Ignore` 判断有无透明通道（RGBA / 灰度 + alpha / 带透明的调色板都会被识别），24 位不透明 PNG 重新打开，临时文件放在 `Temp`、`finally` 里先 `Dispose` 流再删除（顺序正确，`exit 1` 也会进 finally），坐标按送入引擎的位图宽高归一化（放大后也对得回原图），错误统一走 `exit 1`，2 / 3 的含义没变。

---

## 逐条核对设计要求

| # | 要求 | 结果 |
|---|---|---|
| 1 | stdout 只有一段 JSON；进度写 stderr；退出码与文档一致 | 做到。`console.log/info/debug/warn` 全部改写到 stderr（`console.error` 本来就是 stderr）；`finish` 只写一行；14 个错误码与文档、SKILL 三处一致且单测核对。注意 Windows 中文编码见 P1-6，非 ASCII 字符建议转义。 |
| 2 | 不能设置 / 读取 API Key，输出里没有密钥或 `ai_key_enc` | 做到。`status` 只输出 `configured` 和模型名；没有读写密钥的命令或参数（`--api-key` 等是退出码 2）；`ai_failed` 的 message / detail 来自已脱敏的 `friendlyAiError`。E2E 的检查偏窄，见 P2-5。 |
| 3 | 家长版未核对必带草稿标记；`papers confirm` 要 `--i-reviewed` | 做到。`exportReportTo` 中 `draft = allowParentDraft && parent && !confirmedAt`，三种格式开头都有标记，页脚保留「AI 草稿」，未核实标记保留；`report:confirm` 没有对应命令；矛盾句 / 内容太少 / 超长仍拒绝（退出码 11）；`--i-reviewed` 只接受布尔写法，`=值` 会被拒绝。`draft` 字段的语义见 P2-20。 |
| 4 | 不能用参数改数据目录；不提供删除 | 数据目录：参数里没有，环境变量 `EWB_USER_DATA_DIR` 仍然有效（文档已承认是测试用）。删除：没有删除命令，但 P1-5 的覆盖写入绕开了这个限制。 |
| 5 | 并发 | **有 P1**：P1-1（竞态）、P1-2（陈旧锁 / pid 复用 / 窗口提示）。Windows 文件锁语义见 P1-1 末尾。 |
| 6 | 复用 IPC 处理函数后守卫是否生效 | 见 P2-22 和 P2-21：zod 参数校验生效；本项目没有来源校验；`busy.ts` 不在命令行调用路径上；没有通道白名单，靠命令里写死的字面量，建议加白名单。 |
| 7 | 安装命令行工具 | **有 P1**：P1-3（覆盖）、P1-4（PATH）。没有使用 `setx`，1024 截断问题不存在；Mac 脚本的 `shQuote` 对空格、中文、单引号正确（单测里真的执行过）；Windows 路径带空格 / 中文时 `set "JZ_EXE=…"` 引号正确，`%` 见 P2-10。 |
| 8 | Windows 拿结果的方案 | `start "" /wait` + `JUANZHI_RESULT_FILE` + `type` 方案可行：`start /wait` 会把 GUI 程序的退出码放进 `ERRORLEVEL`，结果文件绕开了 GUI 子系统拿不到 stdout 的问题；`endlocal & exit /b %JZ_CODE%` 写法正确；缺失 exe / 没有结果文件时给出 JSON 并返回 1。问题：输出编码（P1-6）、免安装版退出码（P2-11）、CI 没有真正验证（P2-1、P2-2）。chcp：开头的中文只出现在 `rem` 行，且用 CRLF 结尾，GBK 误读不会吃掉换行，处理得当；之后 65001 能正确读中文路径。 |
| 9 | `ocr.ps1` / `ocr-diagnose.ps1` | 铺白底逻辑、临时文件清理、退出码都合理（见 P2-27）；诊断脚本判定的缺口见 P2-6。 |
| 10 | 测试 | 没有删除或放宽原有断言；`run-m7.cjs` 的 63 项在失败时都会让进程以非零退出（`L.finish`）；`cli-smoke.cjs` 的检查大多是真断言，但有 P1-7 的环境问题，另有 P2-1 ~ P2-5、P2-7、P2-8。 |

## 复审时请重点看的
1. 新的锁实现加一个真正的多进程并发单测（P1-1），以及「锁文件早于开机时间 / pid 被无关进程占用」的用例（P1-2）。
2. 安装命令行工具：已有文件 / 符号链接 / 带 `%变量%` 的用户 PATH 三种用例（P1-3、P1-4）。
3. `--result-file` 指向数据目录的拒绝用例，以及非 ASCII 转义后的输出（P1-5、P1-6）。
4. `cli-smoke.cjs` 把临时 `userData` 传下去（P1-7），workflow 的 cmd 步骤加 `call`（P2-1）。
5. 首次 CI 在 Windows 上的结果要看：`ocr-diagnose.json` 的结论、`cli-windows-pwsh.txt`、`cli-windows-cmd.txt`（不存在就说明 cmd 步骤没有跑完）。

---

## 复审

复审对象：`git show HEAD`（`7c657b9`，M7 返工）。仍然是只读：没有改源码，没有 git 写操作，没有跑 build / E2E / dist。做过的验证：`cli-lock / cli-args / cli-shim / cli-outfile / packaging-config` 单测通过；用多进程脚本重新压测新锁（socket 路径：起点是「没有锁」和「被 kill -9 留下的陈旧 sock 文件」各 25~30 轮，每轮 4 个进程同时抢，都是恰好 1 个赢家、没有重叠；文件锁退路：陈旧 / 全新各 30 轮同样 0 次重叠）；用临时 HOME 复测了 shim 的符号链接 / 外来文件 / 旧版脚本。**Windows 部分（命名管道、注册表 PATH、.cmd）没法在这台 Mac 上跑，是读代码推断，凡写「需真机 / CI 确认」的就是这个意思。** 复审本身用到的沙箱外运行只限于本地 unix 套接字压测（沙箱里禁止监听套接字，见下面 N-P1-1）。

### 结论：仍然不通过——还剩 1 个 P1（N-P1-1），没有 P0

原来 7 个 P1 全部已修（P1-1 ~ P1-7）。新实现引入了 1 个 P1：锁的「退路」（文件锁）和主路径（套接字）互相看不见，而且退路在它自己要用的那类沙箱里会抛异常。另有若干新的 P2。

### 一、原 P1 逐条复核

| 条目 | 状态 | 复核结果 |
|---|---|---|
| P1-1 锁竞态 | **已修** | 主路径改成监听套接字，抢锁 / 清陈旧 sock 在 `ewb-run.guard` 目录（mkdir 原子）里串行，守卫里每个竞争者都重新 `listen → probe → unlink → listen`，不再拿旧判断删别人新建的东西。压测 0 次重叠（socket 路径起点是 kill -9 留下的陈旧 sock，precondition 已断言存在）。单测 `cli-lock.test.mjs` 现在包含多进程并发。理论上还剩两处很小的窗口，见 N-P2-2、N-P2-3。Windows 命名管道：libuv 的 `listen` 用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，第二个监听者得到 `EADDRINUSE`，我认为语义成立，需真机 / CI 确认；「待删除文件」的 `EPERM` 问题不再存在（主路径不再删文件）。 |
| P1-2 陈旧锁 / pid 复用 / 窗口提示 | **已修** | 套接字由内核在进程死亡时释放，没有陈旧锁、没有 pid 复用；Mac 上 kill -9 留下的 sock 文件下一次抢锁会被探测为陈旧并清掉（实测，见上）。窗口提示按持有者写，带进程号。退路文件锁加了「启动时间早于开机」判断（但见 N-P1-1(b)）。 |
| P1-3 shim 覆盖 | **已修** | 实测：符号链接拒绝且目标文件不变；外来文件拒绝；写入用临时文件 + 改名。遗留：N-P2-5（旧开发版写的脚本没有标记，会被误判为外来文件）。 |
| P1-4 Windows PATH | **已修（需 CI 确认）** | 改为直接读写 `HKCU\Environment` 的 `Path`：`DoNotExpandEnvironmentNames` 读取、`GetValueKind` 保留类型、只在末尾追加、追加前备份、已存在（比较时展开）则不动。通过 `-EncodedCommand` 传脚本（UTF-16LE base64），目录和备份路径走环境变量，我逐行检查了脚本里的 PowerShell 转义（`TrimEnd('\')`、`-f` 格式串、``r`n、Add-Type 的 C# 成员里的双引号）都正确。CI 新增了「先写入带 `%USERPROFILE%` 的 REG_EXPAND_SZ 值，装完核对类型和原值逐字不变、只多一个目录、有备份」的真实用例，这正是需要的验证。遗留：N-P2-6（广播失败会让整个安装被报成失败）。 |
| P1-5 结果文件覆盖 | **已修** | `outfile.ts`：禁止落在 userData / 数据目录（`realpath` 解析，符号链接绕不过去）、扩展名限制为 `.json / .txt / 无`、已存在必须是以 `{"ok":` 开头的卷知结果文件、不跟随符号链接、原子写；写入移到 `closeDatabase()` 之后；`report export` 目标已存在要 `--overwrite`，同样禁止落进数据目录。`--result-file` 在命令写错时也能写（`scanOutputFlags`）。我看过的边角：解析失败的早期路径里 `forbidden` 还是空数组，但此时靠扩展名 + 「已存在必须是卷知结果」两条仍挡得住数据库和 `ewb-config.json`。 |
| P1-6 中文乱码 | **已修（需真机确认）** | stdout 和所有结果文件的 JSON 用 `asciiJson` 转成 `\uXXXX`（代理对按两个 `\u` 写，仍是合法 JSON）；`.cmd` 里除 exe 路径外全是 ASCII，包装脚本自己的错误 JSON 也是 ASCII，同时顺带消除了「含中文 + goto」问题。 |
| P1-7 冒烟没传临时数据目录 | **已修** | `smoke-packaged.cjs` 传 `EWB_USER_DATA_DIR`；`cli-smoke.cjs` 没带就直接 `throw`，并核对每次 `status` 的 `dataDir` 在临时目录下；Windows 本机不再默认安装短命令（只在 CI 或 `EWB_SMOKE_INSTALL_CLI=1`）。 |

### 二、原 P2 逐条复核

- **已修**：P2-1（workflow cmd 步骤加 `call`）、P2-2（`windowsVerbatimArguments`，`/d /s /c ""…" …"` 的写法正确）、P2-3（`close`，`cli-smoke.cjs` 和 `run-m7.cjs` 都改了）、P2-4（E2E 现在用会写数据的 `import` 持锁，断言第二个命令行 / 第二个 import / 窗口都被拒绝，并加了 kill -9 之后马上能用）、P2-5（密钥检查覆盖导出文件、`ai_key_enc`）、P2-8、P2-9、P2-10、P2-11（退出码改取 `.exit` 文件，去掉了 findstr）、P2-13（提示 / 文档 / SKILL 都改成「退出卷知，Mac 上按 Cmd+Q」）、P2-14（`Object.hasOwn`）、P2-15（`unhandledRejection` 只记日志）、P2-17（队列空闲 3 秒后判定「没被处理」）、P2-20（`draft = !confirmedAt`，另有 `parentDraft`）、P2-21（`CLI_ALLOWED_CHANNELS` 白名单，我对照 `commands.ts` 里实际调用的通道：`ocr:status / papers:list / papers:get / questions:list / questions:confirmPaper / stats:overview / stats:hot / stats:compare / report:generate / report:list`，不多不少）、P2-23（问登录 shell 的 PATH、拦 `AppTranslocation`）、P2-24（启动提示写 stderr；没做「带进下一次 status」，可以接受）、P2-25（`util.format`）。
- **部分修**：P2-6（`ocr-diagnose.ps1` 判定重写，崩溃与「0 行」已分开；但新增的一支有误判，见 N-P2-7）、P2-12（文档补了，但建议的写法对 PowerShell 不对，见 N-P2-8）、P2-27（铺白底失败退回原图、释放位图已修；空白页三遍识别没动，保持原样可以接受）。
- **没修，理由可接受**：P2-7（≥15 行：你们说首次 CI 实测 45 行，保留即可）、P2-16（钥匙串弹窗：文档写明「更新后先在窗口里打开一次选始终允许」，同意）、P2-18、P2-19、P2-26（只改文档）。P2-22 本来就是说明项。
- **文档与代码不一致**（小）：`docs/M7-命令行接口设计.md` §13 说「不再给 stdout 挂会触发退出的错误监听」，但 `run.ts:97` 仍然 `process.stdout.on('error', () => exit())`；因为 `exit()` 现在幂等（`exiting` 标志 + 30ms 后调用一次 `app.exit`），行为没问题，改文档即可。退出路径的重入修复我读了一遍：`finish` 只执行一次，`exit` 只调一次 `app.exit`，信号 / `uncaughtException` / 3 秒保底定时器都走同一个入口。是不是 0xC0000005 的真正原因要看下一次 Windows CI。

### 三、新代码的问题

#### N-P1-1 锁的退路（文件锁）与套接字互相看不见；退路在同类沙箱里会抛异常
`src/main/cli/lock.ts:94-129, 134-168`

这个问题是我在复审环境里亲眼看到的：本复审用的沙箱就是「`net.Server.listen(unix 路径)` 返回 `EPERM`，`os.uptime()` 抛 `EPERM`」（已验证），而设计里要服务的 Agent（Codex、Claude Code 的沙箱）正是这类环境。

- (a) 互相看不见：沙箱里的命令行 `listen` 失败 → 直接 `acquireFileLock`，**不去探测套接字**；窗口（或没有沙箱的命令行）只持有套接字、不写锁文件。结果：窗口开着时，沙箱里的命令行会拿到文件锁并开始写同一份数据；两个都在沙箱里时互斥靠文件锁，没问题；只有「一边沙箱、一边没沙箱」才漏。设计要求 5 的第一条（窗口开着 CLI 必须拒绝）在这种组合下失效。
- (b) 陈旧文件锁会让命令永远 `internal`：`fileLockAlive()` 里 `bootTimeMs()` 调 `os.uptime()`，在上面那种沙箱里抛 `ERR_SYSTEM_ERROR`，没有 try/catch。Agent 的工具超时会直接杀掉命令行进程（这是最常见的情况），留下 `ewb-run.lock`；之后每次命令都在 `readFileLock → fileLockAlive` 里抛异常，退出码 1，直到有人手动删文件——正好是第一轮 P1-2 想消灭的「崩溃后永远打不开」，只是换到了退路上。我用 `os.uptime` 打桩后跑通了文件锁路径的并发压测（0/30 重叠），说明除了这个异常，退路本身的串行化是对的。
- 修法：
  1. 所有持有者（窗口也一样）**同时**写锁文件：套接字监听成功后再用 `linkSync` 写一份锁文件（退出时删），退路的检查就能看见窗口；或者退路里先 `probe()` 套接字（连接被禁就当「未知」，再看锁文件）。推荐前者，简单且对称。
  2. `bootTimeMs()` 包 `try/catch`，拿不到就当「不能判断」，只用 `pidAlive`。
  3. 补两个单测：「套接字持有者活着时，退路不能拿到锁」「`os.uptime` 抛异常时陈旧锁文件仍能被清掉」。

#### N-P2（新增，均不阻塞）
1. **「结束命令行任务并打开」可能误杀无关进程**（`src/main/index.ts:~140-146`）。pid 来自探测时对方回的那一行（未经验证），而 `showMessageBoxSync` 是阻塞的：弹框一直开着，命令行自己做完退出、pid 被别的程序复用之后（Windows 很快，Mac 要几小时），用户再点「结束」就会 `kill` 一个无关进程（Windows 上 `SIGTERM` 就是 `TerminateProcess`）。另外 sock 在 `/tmp` 退路路径时别的本地用户可以抢占并回一个任意 pid。修法：点击后先重新 `inspectRunLock` 一次，确认持有者还在、`pid` 和 `startedAt` 与弹框时一致，再杀；有条件的话再核对进程名（Mac：`ps -p <pid> -o command=` 含应用路径；Windows：`tasklist /FI "PID eq <pid>"` 含 `EnglishExamWorkbench.exe`）。我把它放在 P2 里是因为触发需要「弹框长时间不处理 + pid 被复用」，但后果是杀掉用户别的程序，建议这一轮顺手修。
2. **`release()` 在 `s.close()` 之后又 `unlinkSync(endpoint)`**（`lock.ts:153-158`）。Node 关闭 unix 套接字时已经替你删了文件，这条多余的 `unlink` 理论上可能删掉下一个持有者刚建的 sock（窗口是微秒级）。删掉这一行即可。
3. **守卫的陈旧清理有同样的理论竞态**（`lock.ts:86`）：只发生在「守卫目录是崩溃留下的、且恰好有两个竞争者同时判定它过期」时。概率极低，记一笔。
4. **`withGuard` 超时 / 其他异常会让窗口卡死**（`index.ts` 的 `await acquireRunLock(...)` 没有 try/catch）：抛异常后 `whenReady` 的 Promise 被拒绝，窗口不会创建，进程却占着 Electron 单实例锁，用户看到的是点图标没反应。建议 `catch` 后写日志并放行（锁子系统故障不应该让窗口打不开），或者弹一个明确的对话框。
5. **旧版开发版写的短命令没有 `JUANZHI-SHIM` 标记，会被当成外来文件拒绝**（已验证：旧脚本里只有「由「卷知」生成」）。README 里提到 Codex 在 Mac 上实测过安装流程，那台机器上很可能就有这样一份。建议 `writeShimSafely` 同时认旧标记「由「卷知」生成：juanzhi 命令」。
6. **PATH 脚本里广播失败会把整个安装报成失败**（`shim.ts:94-96`）：`SetValue` 已经写成功之后才 `Add-Type`，受限语言模式 / AppLocker 下 `Add-Type` 抛异常 → 脚本以非零退出 → 界面提示「没能把…加进用户 PATH」，其实已经加了（再点一次会得到 `already`）。把广播部分单独包 `try/catch`，失败只提示「新开的终端可能要重新登录才生效」。
7. **`ocr-diagnose.ps1` 新增的一支会误判**：「极简代码读不出对照图、但 ocr.ps1 读得出」（极简代码自己出问题时）会落到 `elseif (-not $minimalReadsControl) { SCRIPT }`，直接让构建失败，而 ocr.ps1 其实是好的。这一支应该是警告（`ENV` 或新增 `HARNESS`），不该判 `SCRIPT`。
8. **文档 `docs/命令行.md:97` 建议的 `--textbook=A^&B`** 只对 cmd 有效；PowerShell 里 `^&` 会原样传过去，且裸 `&` 是语法错误。建议写成「在 PowerShell 里给参数加引号 `'--textbook=A&B'`；通过 `juanzhi.cmd` 转发含 `&` 的参数不可靠，请直接调用 exe 并用 `--result-file`」。
9. **`/tmp/juanzhi-<uid>-<hash>.sock` 退路路径**可以被同机其他用户抢先占位（拒绝服务）。只在 userData 路径超过约 100 字节时才会用到，影响很小。
10. **`defaultReadShellPath` 跑的是交互登录 shell**（`$SHELL -ilc`），用户的 rc 文件里如果有 `exec tmux`、提示输入、输出一堆欢迎信息，最多等 4 秒超时；输出被污染时 PATH 判断大多还是对的。接受，但可以只取输出的最后一行。
11. **holder 为 `null`（对方忙到没回信息）时错误提示不准**：`run.ts` 里 `got.holder?.mode === 'gui'` 为假就报「另一个卷知命令行任务」，实际上可能是窗口在忙。可以在 holder 未知时用中性措辞（「卷知（窗口或命令行）正在使用数据」）。

### 四、本次复审想特别回答的几个问题

- **串行化是否真的成立？** 成立。socket 主路径和文件锁退路各自在守卫里串行，我用起点最苛刻的场景（kill -9 留下陈旧 sock / 陈旧锁文件，4 进程同时抢）压了 25~30 轮，都是 1 个赢家、0 次重叠；原来的复现脚本（陈旧锁 30 轮 21 次重叠）现在是 0/30。要补的是两条路径之间的互相可见性（N-P1-1）。
- **Mac 上 sock 文件残留会不会导致无法监听？** 不会。`listen` 得到 `EADDRINUSE` → `probe` 得到 `ECONNREFUSED` → 在守卫里 `unlink` → 重新 `listen`；实测 25 轮、起点都有陈旧 sock，全部正常。唯一的异常情况是残留物删不掉（权限 / 是个目录），此时 4 次尝试后返回 `holder: null`，被报成「命令行任务正在使用」（见 N-P2-11）。
- **「结束命令行任务并打开」会不会误杀不相干的进程？** 有可能，条件是弹框放着不处理、持有者退出后 pid 被复用（N-P2-1）。杀之前没有重新确认持有者，也没有核对进程名。
- **注册表读写 PATH 与转义**：类型保留、不展开、先备份、追加、比较时展开，实现正确；`-EncodedCommand` 把引号转义问题整个绕开；唯一的缺口是广播失败的误报（N-P2-6）。需要 CI 上那条真实用例跑过才算验证完。

### 五、复审结论与下一步

1. 修 N-P1-1（锁文件同时写 / 或退路先探测；`bootTimeMs` 容错；两条单测）。
2. 建议同时修 N-P2-1（杀进程前重新确认）、N-P2-4（锁异常不能让窗口打不开）、N-P2-5（认旧标记），其余按需。
3. 下一次 CI 要看：Windows 的 `ci-smoke-result-win32.json` 里「CLI 没有崩溃」「CLI Windows 输出编码」两项、PATH 核对步骤是否通过、cmd 步骤是否真的执行到最后（`smoke-artifacts/cli-windows-cmd.txt` 存在）。
4. 说明：HEAD 提交里带进去的是我第一版审核报告；这一节「复审」是新追加的，还没有被提交。

---

## 三审复核

复核对象：`git show HEAD`（`37fc5dc`，第三轮）。仍然只读：没有改源码，没有 git 写操作，没有跑 build / E2E / dist。做过的验证：`cli-lock / cli-shim / cli-args / cli-outfile / packaging-config` 单测通过（锁的单测要能监听本地套接字，所以在沙箱外跑）；并用**真实**的受限环境复现了 N-P1-1：本次复审的沙箱里 `listen(unix 套接字)` 和 `os.uptime()` 都真的返回 EPERM，正好是命令行要面对的那类环境。Windows 部分（命名管道、注册表、.cmd、tasklist）仍是读代码推断，需要 CI 确认。

### 结论：仍然不通过——没有 P0，还剩 1 个 P1（N3-P1-1，第三轮新引入）

N-P1-1 本身已修好；但「套接字持有者同时写锁文件」这个办法让锁文件的陈旧判断（只看 pid）重新进了主路径，带回了一个窄版的「崩溃后 pid 被复用就打不开」。

### 一、N-P1-1 与上轮建议本轮修的 P2

| 条目 | 状态 | 复核 |
|---|---|---|
| N-P1-1(a) 退路与套接字互相看不见 | **已修** | 套接字持有者监听成功后原子地（`linkSync`）写一份锁文件（`writeCompanionLock`），释放时删；监听不了的命令行先 `probe` 套接字，再看锁文件。实测（真实沙箱，不是模拟）：沙箱外进程以 `gui` 持有，沙箱里的 `acquireRunLock` 返回 `ok:false, holder:{mode:'gui', pid:…}`，`inspectRunLock` 也能看见。反方向（沙箱命令行持有、窗口来抢）由单测覆盖，通过。 |
| N-P1-1(b) `os.uptime()` 抛异常 | **已修** | `bootTimeMs()` 加了 try/catch，拿不到就只用 pid。实测（真实 EPERM）：预置一份持有者已死的锁文件，沙箱里 `acquireRunLock` 返回 `ok:true`（之前会抛异常）。单测里还有「启动时间早于开机 = 陈旧」「uptime 抛异常时活着的持有者仍被识别」。 |
| N-P2-1 「结束命令行任务」误杀 | **已修** | 点击后先 `inspectRunLock` 重新确认：pid 和 `startedAt` 都要与弹框时一致，再用 `processLooksLikeJuanzhi` 核对进程名（Mac：`ps` 的命令行含卷知 / english-exam-workbench / Electron 且带 `cli`；Windows：`tasklist` 含 `EnglishExamWorkbench.exe`），判断不了就当不是；对不上就弹说明并退出，不杀；探测时命令行已结束就直接再抢一次锁。只有 `mode:'cli'` 的持有者才显示这个按钮。三样核对都在，单测覆盖了进程名判断。残留的小点见 N3-P2-2。 |
| N-P2-2 `release()` 多余的 unlink | **已修** | 删掉了；实测释放后目录里 `ewb-run.sock` 和 `ewb-run.lock` 都没了。 |
| N-P2-3 守卫陈旧清理的理论竞态 | **未修（接受）** | 触发条件是「守卫目录由崩溃留下、且两个竞争者同时判定过期」，概率极低，同意不修。 |
| N-P2-4 抢锁异常让窗口打不开 | **已修** | `index.ts` 整段包在 try/catch 里，出错只写日志，窗口照常打开。代价是此时命令行互斥暂时失效，已在日志里写明，可以接受。 |
| N-P2-5 旧开发版 shim | **已修** | `isOurShim`：带 `JUANZHI-SHIM`、或旧版的「由「卷知」生成」、或指向卷知 / EnglishExamWorkbench.exe 且带 `cli` 参数且小于 4000 字节。单测覆盖旧版 sh / cmd 脚本，以及「只是提到卷知、没有 cli 调用」的用户脚本仍被拒绝。第三个条件略宽，见 N3-P2-1。 |
| N-P2-6 广播失败误报 | **已修** | 广播部分单独 `try/catch`，失败输出 `added-nobroadcast`，`installCliShim` 把它当成功并给一条警告；PowerShell 转义我又读了一遍，没问题。 |
| N-P2-7 ocr-diagnose 误判 | **已修** | 逻辑逐支推演过：「极简读不出、ocr.ps1 读得出」只加一条说明继续往下判；「两边都读不出且 ocr.ps1 退出码 2/3 或 0 行」= ENV；「极简读得出、ocr.ps1 读不出」= SCRIPT；「极简读不出且 ocr.ps1 也以别的方式失败」= SCRIPT。诊断步骤 `continue-on-error: true`，最后一步 `if: always()` 统一判，只有 SCRIPT 才 `throw`；`ocr-diagnose.json` 不存在只发警告。 |
| N-P2-8 `&` 参数的文档 | **已修** | 改成「PowerShell 里加引号；经 `juanzhi.cmd` 转发含 `&` 的参数不可靠，请直接调用 exe 并用 `--result-file`」。 |
| N-P2-9 /tmp 退路路径可被占位 | **未修（接受）** | 只在 userData 路径超过约 100 字节时才用，影响很小。 |
| N-P2-10 读用户 shell PATH | **已修** | 输出前加换行、只取最后一行。 |
| N-P2-11 持有者未知时的措辞 | **部分修** | 命令行一侧改成了中性措辞（「卷知（窗口或另一个命令行任务）正在使用数据」）；窗口一侧 `h?.mode === 'cli' \|\| !h` 时仍写「卷知命令行正在使用数据」。小问题。 |
| §13 里「不再给 stdout 挂 error 监听」与代码不一致 | **未修（只是文档）** | `run.ts:97` 仍然挂了，因为 `exit()` 幂等，行为没问题；§14 没提，改文档即可。 |

### 二、第三轮新增代码的问题

#### N3-P1-1 套接字持有者写的「伴随锁文件」只按 pid 判活，崩溃后 pid 被复用会重新把窗口 / 命令行挡在主路径外
`src/main/cli/lock.ts:111-116, 158-159, 176-190`

- 问题：第三轮让每个套接字持有者（窗口、不在沙箱里的命令行）都写一份 `ewb-run.lock`。持有者被强杀 / 崩溃 / 工具超时杀掉后，这份文件留下；之后**任何**抢锁（包括能监听套接字的）都先走 `acquireRunLock` 开头的 `fl && fl.pid !== pid && fileLockAlive(fl)` 检查，只要锁里的 pid 现在被某个无关进程占用（且启动时间晚于本次开机），就直接返回「被占用」，根本不会去试套接字。套接字本来就是为了消灭「陈旧锁 + pid 复用」，现在这个问题从主路径的后门回来了：不再是重启后几乎必撞（开机时间判断挡住了那种），但同一次开机内 pid 被复用就会撞（Windows 上 pid 回收很快，Agent 工具超时杀命令行是最常见的触发方式）。
- 复现（沙箱外）：预置一份 `{"pid": <一个无关的活进程>, "mode": "gui", "startedAt": <现在>}` 的 `ewb-run.lock`，没有任何套接字持有者，能监听套接字的命令行 `acquireRunLock` 返回 `ok:false, holder:{pid:…, mode:'gui'}`；窗口这边弹的是「卷知已经在运行（锁被另一个窗口进程持有）」，只有一个「好」按钮（`canKill` 只对 `mode:'cli'` 开），用户没有出路，只能重启电脑或自己找到并删除文件。
- 修法（小改动）：
  1. 伴随锁文件里多记一个字段，例如 `socket: true`（只有套接字持有者写的才有）。
  2. 能监听套接字的进程：**先试套接字**（在守卫里 `listen`）。`listen` 成功 = 没有活着的套接字持有者，此时如果锁文件带 `socket:true`，它一定是陈旧的，直接清掉（`writeCompanionLock` 本来就会覆盖）；只有锁文件**不带** `socket:true`（沙箱里的命令行写的、没有套接字）时才用 pid 判活并拒绝。
  3. 沙箱里（`listen` 不了）的进程：看到带 `socket:true` 的锁文件，先 `probe`：`alive:false`（连得上套接字路径但被拒绝）→ 陈旧；`alive:null`（连接也被禁）→ 只能按 pid 判，这是信息不足时的保守选择，可以接受。
  4. 补一个单测：「锁文件带 `socket:true`、pid 是无关的活进程、没有套接字持有者 → 能监听的进程拿到锁并覆盖锁文件」。

#### N3-P2（新增，均不阻塞）
1. **`isOurShim` 第三个条件偏宽**（`shim.ts:isOurShim`）：用户自己写的、里面有 `卷知.app` 路径和 `cli` 字样的小脚本（比如加了代理环境变量的包装）会被认作卷知的并被覆盖。可以接受，但安装前最好把旧文件备份成 `juanzhi.bak-<时间>`。
2. **杀进程的第二阶段没有再核对**（`index.ts` 里 `SIGTERM` → 等 5 秒 → `SIGKILL`）：到 `SIGKILL` 时进程一般还活着（否则锁已经拿到、循环已经 break），风险很小；严格做的话 `SIGKILL` 前再 `inspectRunLock` 一次确认 pid 没变。
3. **窗口一侧持有者未知时措辞**（见上表 N-P2-11）。
4. **`writeCompanionLock` 失败是静默的**（目录只读之类）：这时沙箱里的命令行看不到窗口，互斥退化为只靠套接字。可以接受，但最好 `console.warn` 一行，方便排查。

### 三、下一步
1. 修 N3-P1-1（锁文件带 `socket:true`，能监听的进程先试套接字、认定带这个标记的陈旧锁文件可以清；补单测）。
2. N3-P2 按需；顺手把 §13 那句文档改一下。
3. 下一次 CI 要看的清单不变：Windows 的「CLI 没有崩溃」「CLI Windows 输出编码」、PATH 核对步骤、`smoke-artifacts/cli-windows-cmd.txt` 是否存在、最后一步「OCR 诊断结论」。

---

## 四审复核

复核对象：`git show HEAD`（`24ffb5f`，第四轮）。仍然只读：没有改源码，没有 git 写操作，没有跑 build / E2E / dist。验证方式：重跑上次的复现（见下），`cli-lock`、`packaging-config` 单测通过（在沙箱外跑，因为要监听本地套接字），另写了一个临时脚本模拟「仍要打开」。Windows 部分仍是读代码推断。

### 结论：仍然不通过——没有 P0，还剩 1 个 P1（N4-P1-1，「仍要打开」之后窗口不持锁，命令行互斥在整个窗口会话里失效）

N3-P1-1 已修好。

### 一、N3-P1-1 复现结果（已修）

预置一份 `ewb-run.lock`，pid 指向一个无关但还活着的进程（真实的 `sleep 60`），`startedAt` 为现在；带 / 不带 `socket` 标记、`mode` 为 gui / cli 各试一遍：

| 环境 | 带 `socket:true` | 不带标记 |
|---|---|---|
| 能监听套接字（沙箱外，`ps` 可用） | 4 种组合全部 `acquire.ok = true`，`inspect = free` | 同样全部 `ok = true`（不带标记的也因为 `ps` 查到进程名不是卷知，判为 pid 被复用） |
| 真实受限沙箱（`listen` EPERM、`os.uptime` EPERM、`ps` 也被禁止） | `inspect = free`，但 `acquire.ok = false` | `inspect = HELD`，`acquire.ok = false` |

- 主路径（能监听的进程）：**已修**。带标记的文件在 `listen` 成功后一定被当作陈旧文件换掉，不再先按 pid 判；不带标记的文件还会用 `pidIsJuanzhi` 看进程名。单测新增的用例也通过。
- 受限沙箱里（`ps` 被禁止，进程名判断不了 → 保守当作被占用）：不带标记的文件仍然挡住，这是信息不足时的合理选择；但带 `socket:true` 的文件在这里也挡住了，而 `inspectRunLock` 对同一份文件却说「没人持有」，两处不一致（见 N4-P2-1）。窄场景，不阻塞。

### 二、新增的「仍要打开（有风险）」路径

位置：`src/main/index.ts` 的锁对话框分支，`clearLockFile` 之后再抢一次锁，抢不到就**不带锁**打开窗口。

#### N4-P1-1 不带锁打开窗口之后，命令行的互斥在整个窗口会话里都失效
- 问题：点「仍要打开」时，如果命令行真的还在运行（这是现在几乎唯一会走到这个对话框的情况：陈旧锁已经由套接字自动处理掉了），`clearLockFile` 只是删了伴随锁文件，套接字还被那个命令行占着，窗口抢不到锁，于是**不带锁**继续启动，只写了一条 `console.warn`。之后即使那个命令行结束，窗口也不会重新去拿锁，**这个窗口开着的整个期间，任何新启动的命令行都能顺利拿到锁并和窗口同时写数据**。
- 复现（沙箱外）：命令行 A 持锁 → 窗口被挡 → `clearLockFile` + 再抢仍失败（窗口不带锁）→ A 结束 → 新的命令行 B `acquireRunLock` 返回 `ok:true`。这正好是设计要求 5 要防的事（窗口开着 CLI 必须拒绝），而且发生在 Agent 自动调用、老师在窗口里改审核的典型场景里，对用户完全不可见。
- 数据损坏吗：SQLite 本身有 WAL 和 `busy_timeout`，不太会把库文件写坏，但应用层的东西会互相干扰：每次命令行启动都会 `recoverInterruptedPapers()`，把窗口里正在提取 / 解析的卷子标成失败或退回；命令行 `import` 和窗口里的审核、重新解析同时进行；窗口的启动恢复也会反过来打断还在跑的命令行（见下面「提示是否清楚」）。所以后果是「在途任务被打断、状态错乱、需要重新导入」，而不是整库损坏。
- 修法：窗口不带锁打开时，**在后台持续重试抢锁**（比如每 2~3 秒一次，抢到就挂上 `releaseRunLock`，之后命令行就会被挡住），直到成功或窗口退出；同样的重试也应用在「抢锁异常 → 照常打开窗口」的 catch 分支（目前也是整个会话都没有锁）。再加一条单测：「窗口不带锁 → 持有者退出 → 重试之后窗口拿到锁，新的命令行被拒绝」。

#### 风险提示写得够不够清楚（N4-P2-2）
当前文案：「如果你确定现在没有命令行在运行（比如上一次异常退出留下了记录），可以点『仍要打开』。风险：要是命令行其实还在写数据，同时打开窗口可能损坏数据。」按钮名「仍要打开（有风险）」，默认按钮是「好」，取消 / Esc 也是「好」。

- 好的地方：风险用独立一段、放在最后；按钮名带「有风险」；默认是最安全的选项；只有在「确定没有命令行」的前提下才建议点。
- 不够清楚的地方：① 「可能损坏数据」说得太轻也不够具体——实际上窗口启动会立刻把命令行正在导入的卷子标成失败（`recoverInterruptedPapers`），几乎必然打断那个任务；建议写成「命令行正在导入 / 生成的内容会被打断，需要重新导入」。② 完全没有说「点了之后命令行不再被挡住，直到重新打开卷知」，用户不知道后果会持续整个会话（修了 N4-P1-1 之后这句可以去掉，改成「窗口会在命令行结束后自动恢复保护」）。③ 「比如上一次异常退出留下了记录」这句现在基本不成立了（套接字锁崩溃后会自动释放），反而会诱导用户在命令行真的在跑时误点；建议删掉这个例子，只在持有者未知、且 `ps` / `tasklist` 查不到时才展示这个选项，或者把这个按钮藏进二次确认。④ 持有者明确是活着的命令行（`canKill`）时，已经有「结束命令行任务并打开」这个更安全的选项，「仍要打开」对这种情况的价值很小，可以只在持有者未知（`!h`）时才显示。
- 结论：提示本身不算错，但不是「够清楚」。配合 N4-P1-1 的重试一起改。

### 三、其他新增代码的 P2（不阻塞）
1. **N4-P2-1**：`acquireFileLock` 在沙箱里应该和 `inspectRunLock` 一样，利用 `probe` 的结果：探测得到「确定没人监听」（`alive:false`）时，带 `socket:true` 的锁文件直接视为陈旧；只有探测不了（`alive:null`）时才按 pid + 进程名判。目前二者不一致（上表第二行）。
2. **N4-P2-3**：`pidIsJuanzhi` 的正则太松：`Electron`、`english-exam-workbench` 会匹配到开发者机器上任何命令行里带项目路径的进程（比如 `node …/english-exam-workbench/…`）。后果只是「保守当作活着」，影响小；Windows 免安装版里层 exe 的名字如果不是 `EnglishExamWorkbench.exe` / 不含 `Juanzhi`，会被误判为陈旧，导致沙箱里命令行的互斥失效，需要在 CI 或真机上用免安装版确认一次。
3. **N4-P2-4**：`pidIsJuanzhi` 里是同步的 `execFileSync('tasklist' | 'ps')`（最多 4 秒），在抢锁的守卫里调用，会阻塞事件循环；只在文件锁退路上才走，影响小。
4. 上轮遗留的小项仍在：窗口在「抢锁异常」分支只写日志（见 N4-P1-1 的修法）、`isOurShim` 的第三个条件偏宽、§13 里关于 stdout error 监听的文档句子。

### 四、下一步
1. 修 N4-P1-1（不带锁打开时后台重试抢锁；catch 分支同样处理；补单测）。
2. 按 N4-P2-2 改风险提示（建议只在持有者未知时给「仍要打开」，写清后果）。
3. N4-P2-1 顺手改；其余按需。
