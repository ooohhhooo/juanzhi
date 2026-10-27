// M7 命令行：短命令 juanzhi 的包装脚本内容和安装（Mac / Windows，环境用参数替换）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildShellShim, buildCmdShim, shQuote, installCliShim, shimPath, WINDOWS_PATH_SCRIPT } from '../../src/main/cli/shim.ts'

// ── shell 脚本 ──
{
  const exe = '/Applications/卷知.app/Contents/MacOS/卷知'
  const sh = buildShellShim(exe)
  assert.ok(sh.startsWith('#!/bin/sh\n')); assert.ok(sh.includes(`exec '${exe}' cli "$@"`))
  assert.equal(shQuote("a'b"), `'a'\\''b'`, '路径里的单引号也安全')
  // 真的能执行：用一个假的「程序」验证参数原样传递（含空格、引号）
  if (process.platform !== 'win32') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-shim-'))
    const fake = path.join(d, "fake app's.sh"); fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 })
    const shim = path.join(d, 'juanzhi'); fs.writeFileSync(shim, buildShellShim(fake), { mode: 0o755 })
    assert.equal(execFileSync(shim, ['status', 'a b', '--x=1']).toString(), '[cli][status][a b][--x=1]')
    fs.rmSync(d, { recursive: true, force: true })
  }
}
// ── cmd 脚本：同步等待、结果文件回读、退出码 ──
{
  const exe = 'C:\\Users\\张三\\AppData\\Local\\Programs\\EnglishExamWorkbench\\EnglishExamWorkbench.exe'
  const cmd = buildCmdShim(exe)
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), '换行是 CRLF')
  for (const must of ['chcp 65001', `set "JZ_EXE=${exe}"`, 'start "" /wait "%JZ_EXE%" cli %*', 'JUANZHI_RESULT_FILE', 'type "%JZ_OUT%"', 'exit /b %JZ_CODE%', 'findstr /C:"\\"ok\\":false"']) assert.ok(cmd.includes(must), `cmd 脚本里要有：${must}`)
  assert.ok(!cmd.includes('\ufeff'), '无 BOM')
}
assert.ok(/SetEnvironmentVariable\('Path', .*'User'\)/.test(WINDOWS_PATH_SCRIPT) && WINDOWS_PATH_SCRIPT.includes('$env:JZ_BIN_DIR'), '只改用户级 PATH，目录从环境变量读')

// ── 安装：Mac ──
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-home-'))
  const r = await installCliShim({ platform: 'darwin', home, exePath: '/Applications/卷知.app/Contents/MacOS/卷知', portable: false }, '/usr/bin:/bin')
  assert.equal(r.path, path.join(home, '.local/bin/juanzhi')); assert.ok(fs.existsSync(r.path))
  assert.equal(fs.statSync(r.path).mode & 0o777, 0o755)
  assert.equal(r.onPath, false); assert.match(r.hint, /export PATH=.*\.local\/bin/); assert.match(r.hint, /zshrc/)
  const r2 = await installCliShim({ platform: 'darwin', home, exePath: '/Applications/卷知.app/Contents/MacOS/卷知', portable: false }, `/usr/bin:${path.join(home, '.local/bin')}`)
  assert.equal(r2.onPath, true); assert.doesNotMatch(r2.hint, /还需要把/)
  await assert.rejects(() => installCliShim({ platform: 'darwin', home, exePath: '/Volumes/卷知 1.2.0/卷知.app/Contents/MacOS/卷知', portable: false }), /拖进「应用程序」/)
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
