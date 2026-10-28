// M7 命令行：短命令 juanzhi 的包装脚本内容和安装（Mac / Windows，环境用参数替换）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildShellShim, buildCmdShim, shQuote, installCliShim, shimPath, writeShimSafely, isOurShim, SHIM_MARK, WINDOWS_PATH_SCRIPT } from '../../src/main/cli/shim.ts'

// ── shell 脚本 ──
{
  const exe = '/Applications/卷知.app/Contents/MacOS/卷知'
  const sh = buildShellShim(exe)
  assert.ok(sh.startsWith('#!/bin/sh\n')); assert.ok(sh.includes(`exec '${exe}' cli "$@"`))
  assert.ok(sh.indexOf('\nunset ELECTRON_RUN_AS_NODE\n') > 0 && sh.indexOf('unset ELECTRON_RUN_AS_NODE') < sh.indexOf('exec '), 'exec 之前要清掉 ELECTRON_RUN_AS_NODE')
  assert.match(SHIM_MARK, /^JUANZHI-SHIM v3$/, '标记升到 v3')
  assert.equal(shQuote("a'b"), `'a'\\''b'`, '路径里的单引号也安全')
  // 真的能执行：用一个假的「程序」验证参数原样传递（含空格、引号）
  if (process.platform !== 'win32') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-shim-'))
    const fake = path.join(d, "fake app's.sh"); fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 })
    const shim = path.join(d, 'juanzhi'); fs.writeFileSync(shim, buildShellShim(fake), { mode: 0o755 })
    assert.equal(execFileSync(shim, ['status', 'a b', '--x=1']).toString(), '[cli][status][a b][--x=1]')
    // 环境里带着 ELECTRON_RUN_AS_NODE=1（WorkBuddy 之类）：包装脚本要把它清掉再启动程序
    const probe = path.join(d, 'probe.sh'); fs.writeFileSync(probe, '#!/bin/sh\nprintf "[%s]" "${ELECTRON_RUN_AS_NODE-unset}"\n', { mode: 0o755 })
    const shim2 = path.join(d, 'juanzhi2'); fs.writeFileSync(shim2, buildShellShim(probe), { mode: 0o755 })
    assert.equal(execFileSync(shim2, ['status'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).toString(), '[unset]', '程序拿到的环境里没有 ELECTRON_RUN_AS_NODE')
    fs.rmSync(d, { recursive: true, force: true })
  }
}
// ── cmd 脚本：同步等待、结果文件回读、退出码取自 .exit 文件；除 exe 路径外全是 ASCII ──
{
  const exe = 'C:\\Users\\张三\\100%\\AppData\\Local\\Programs\\EnglishExamWorkbench\\EnglishExamWorkbench.exe'
  const cmd = buildCmdShim(exe)
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), '换行是 CRLF')
  for (const must of ['chcp 65001', 'set "JZ_EXE=C:\\Users\\张三\\100%%\\AppData', 'start "" /wait "%JZ_EXE%" cli %*', 'JUANZHI_RESULT_FILE', 'type "%JZ_OUT%"', 'set /p JZ_FILECODE=<"%JZ_OUT%.exit"', 'exit /b %JZ_CODE%', 'DisableDelayedExpansion', 'set "ELECTRON_RUN_AS_NODE="', SHIM_MARK]) assert.ok(cmd.includes(must), `cmd 脚本里要有：${must}`)
  assert.ok(cmd.indexOf('set "ELECTRON_RUN_AS_NODE="') < cmd.indexOf('start "" /wait'), 'start 之前要清掉 ELECTRON_RUN_AS_NODE')
  assert.ok(cmd.indexOf('setlocal') < cmd.indexOf('set "ELECTRON_RUN_AS_NODE="'), '清变量在 setlocal 之内（不影响调用者的环境）')
  assert.ok(!cmd.includes('\ufeff'), '无 BOM')
  // 除了 exe 路径那一行，整个脚本是 ASCII（chcp 65001 下 goto 不会因为多字节字符跳错；JSON 错误信息用 \uXXXX 转义）
  const rest = cmd.split('\r\n').filter(l => !l.startsWith('set "JZ_EXE=')).join('\n')
  assert.ok(/^[\x00-\x7f]*$/.test(rest), 'cmd 脚本除 exe 路径外是纯 ASCII')
  assert.ok(!/findstr/.test(cmd), '不再用 findstr 猜退出码（会被数据里的 "ok":false 字样误触发）')
  // 脚本自己报错时输出的 JSON 能解析
  for (const l of cmd.split('\r\n').filter(l => l.startsWith('echo {'))) { const j = JSON.parse(l.slice(5)); assert.equal(j.ok, false); assert.equal(j.exit, 1); assert.match(j.message, /卷知/) }
}
// PATH 脚本：直接读写注册表，保留类型和 %变量%，备份原值，广播环境变量变更；不用 GetEnvironmentVariable / SetEnvironmentVariable（会展开 %变量% 并把 REG_EXPAND_SZ 改成 REG_SZ）
for (const must of ['OpenSubKey(\'Environment\', $true)', 'DoNotExpandEnvironmentNames', 'GetValueKind', '$k.SetValue(\'Path\', $new, $kind)', 'SendMessageTimeout', '0x1A', 'JZ_BACKUP_FILE', '$env:JZ_BIN_DIR']) assert.ok(WINDOWS_PATH_SCRIPT.includes(must), `PATH 脚本里要有 ${must}`)
assert.ok(!/SetEnvironmentVariable|GetEnvironmentVariable\('Path'/.test(WINDOWS_PATH_SCRIPT), 'PATH 脚本不能用会展开 %变量% 的 .NET 方法')

// ── 不覆盖别人的文件 / 不写穿符号链接；覆盖自己以前写的 ──
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-shim2-'))
  const f = path.join(d, 'juanzhi')
  fs.writeFileSync(f, '#!/bin/sh\necho 我自己写的\n')
  assert.throws(() => writeShimSafely(f, buildShellShim('/x'), 0o755), /不是卷知生成的/)
  assert.equal(fs.readFileSync(f, 'utf8'), '#!/bin/sh\necho 我自己写的\n', '别人的文件原样')
  fs.unlinkSync(f)
  writeShimSafely(f, buildShellShim('/x'), 0o755); assert.ok(fs.readFileSync(f, 'utf8').includes(SHIM_MARK))
  writeShimSafely(f, buildShellShim('/y'), 0o755); assert.ok(fs.readFileSync(f, 'utf8').includes("'/y'"), '自己写的可以重新安装（更新路径）')
  assert.deepEqual(fs.readdirSync(d), ['juanzhi'], '没有留下临时文件')
  // 旧开发版写的脚本（没有 JUANZHI-SHIM 标记）也认得出来，可以更新；用户自己的脚本不行
  const oldSh = path.join(d, 'old-juanzhi')
  fs.writeFileSync(oldSh, '#!/bin/sh\n# 由「卷知」生成：juanzhi 命令（设置 → 管理员设置 → 安装命令行工具）。卷知被移动或卸载后，请重新安装命令行工具。\nexec \'/Applications/卷知.app/Contents/MacOS/卷知\' cli "$@"\n')
  const v2 = path.join(d, 'v2-juanzhi'); fs.writeFileSync(v2, '#!/bin/sh\n# JUANZHI-SHIM v2：由「卷知」生成（设置 → 管理员设置 → 安装命令行工具）。\nexec \'/Applications/卷知.app/Contents/MacOS/卷知\' cli "$@"\n')
  assert.ok(isOurShim(fs.readFileSync(v2, 'utf8'))); writeShimSafely(v2, buildShellShim('/new'), 0o755); assert.ok(fs.readFileSync(v2, 'utf8').includes('JUANZHI-SHIM v3') && fs.readFileSync(v2, 'utf8').includes('unset ELECTRON_RUN_AS_NODE'), 'v2 脚本被更新成 v3')
  assert.ok(isOurShim(fs.readFileSync(oldSh, 'utf8'))); writeShimSafely(oldSh, buildShellShim('/new'), 0o755); assert.ok(fs.readFileSync(oldSh, 'utf8').includes(SHIM_MARK), '旧版脚本被更新')
  assert.ok(isOurShim('@echo off\r\nstart "" /wait "C:\\x\\EnglishExamWorkbench.exe" cli %*\r\n'), '旧版 cmd 脚本')
  assert.equal(isOurShim('#!/bin/sh\nexec /usr/local/bin/other-tool "$@"\n'), false)
  assert.equal(isOurShim('#!/bin/sh\n# my wrapper around 卷知.app\nopen -a 卷知.app\n'), false, '只是提到卷知、没有 cli 调用')
  // 符号链接：不跟随
  const real = path.join(d, 'other-real'); fs.writeFileSync(real, 'REAL CONTENT')
  const link = path.join(d, 'link-juanzhi'); fs.symlinkSync(real, link)
  assert.throws(() => writeShimSafely(link, buildShellShim('/x'), 0o755), /符号链接/)
  assert.equal(fs.readFileSync(real, 'utf8'), 'REAL CONTENT', '链接指向的文件没被改')
  fs.rmSync(d, { recursive: true, force: true })
}

// ── 安装：Mac ──
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-home-'))
  const r = await installCliShim({ platform: 'darwin', home, exePath: '/Applications/卷知.app/Contents/MacOS/卷知', portable: false, readShellPath: async () => '/usr/bin:/bin' })
  assert.equal(r.path, path.join(home, '.local/bin/juanzhi')); assert.ok(fs.existsSync(r.path))
  assert.equal(fs.statSync(r.path).mode & 0o777, 0o755)
  assert.equal(r.onPath, false); assert.match(r.hint, /export PATH=.*\.local\/bin/); assert.match(r.hint, /zshrc/); assert.match(r.hint, /已经加过这一行，可以忽略/)
  const r2 = await installCliShim({ platform: 'darwin', home, exePath: '/Applications/卷知.app/Contents/MacOS/卷知', portable: false, readShellPath: async () => `/usr/bin:${path.join(home, '.local/bin')}` })
  assert.equal(r2.onPath, true); assert.doesNotMatch(r2.hint, /还需要把/)
  await assert.rejects(() => installCliShim({ platform: 'darwin', home, exePath: '/Volumes/卷知 1.2.0/卷知.app/Contents/MacOS/卷知', portable: false }), /拖进「应用程序」/)
  await assert.rejects(() => installCliShim({ platform: 'darwin', home, exePath: '/private/var/folders/xx/AppTranslocation/ABC/d/卷知.app/Contents/MacOS/卷知', portable: false }), /临时的只读位置/)
  // 用户自己的 juanzhi 不被覆盖
  fs.writeFileSync(path.join(home, '.local/bin/juanzhi'), '#!/bin/sh\necho mine\n')
  await assert.rejects(() => installCliShim({ platform: 'darwin', home, exePath: '/Applications/卷知.app/Contents/MacOS/卷知', portable: false, readShellPath: async () => null }), /不是卷知生成的/)
  assert.deepEqual(shimPath({ platform: 'darwin', home }), { dir: path.join(home, '.local/bin'), file: path.join(home, '.local/bin/juanzhi') })
  fs.rmSync(home, { recursive: true, force: true })
}
// ── 安装：Windows（PowerShell 用假的）──
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-home-'))
  const calls = []
  const ps = async (script, env) => { calls.push({ script, env }); return 'added' }
  const r = await installCliShim({ platform: 'win32', home, localAppData: path.join(home, 'AppData', 'Local'), exePath: 'C:\\x\\EnglishExamWorkbench.exe', portable: false, runPowerShell: ps })
  assert.ok(r.path.endsWith(path.join('Juanzhi', 'bin', 'juanzhi.cmd'))); assert.ok(fs.readFileSync(r.path, 'utf8').includes('set "JZ_EXE=C:\\x\\EnglishExamWorkbench.exe"'))
  assert.equal(r.onPath, true); assert.equal(calls.length, 1); assert.equal(calls[0].env.JZ_BIN_DIR, r.dir); assert.deepEqual(r.warnings, [])
  // 广播失败（受限的 PowerShell）：PATH 已经写好，不能报成安装失败，只给警告
  const nb = await installCliShim({ platform: 'win32', home, exePath: 'C:\\x\\a.exe', portable: false, runPowerShell: async () => 'added-nobroadcast' })
  assert.equal(nb.onPath, true); assert.ok(nb.warnings.some(w => /没能通知系统刷新/.test(w)))
  assert.ok(WINDOWS_PATH_SCRIPT.indexOf('SendMessageTimeout') > WINDOWS_PATH_SCRIPT.indexOf('try {') && WINDOWS_PATH_SCRIPT.includes("'added-nobroadcast'"), '广播在 try 里')
  // 免安装版：写明限制
  const p = await installCliShim({ platform: 'win32', home, exePath: 'D:\\tools\\Juanzhi-1.2.0-win-x64-portable.exe', portable: true, runPowerShell: ps })
  assert.ok(p.warnings.some(w => /免安装版的限制/.test(w) && /退出码/.test(w)))
  // PowerShell 失败不致命：脚本照样写出，给出手动办法
  const f = await installCliShim({ platform: 'win32', home, exePath: 'C:\\x\\a.exe', portable: false, runPowerShell: async () => { throw new Error('受限的语言模式') } })
  assert.equal(f.onPath, false); assert.ok(f.warnings.some(w => /没能把/.test(w)) && fs.existsSync(f.path))
  fs.rmSync(home, { recursive: true, force: true })
}
await assert.rejects(() => installCliShim({ platform: 'linux', home: '/tmp', exePath: '/x', portable: false }), /只支持 Mac 和 Windows/)
console.log('cli-shim.test ✓')
