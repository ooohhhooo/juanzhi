/**
 * 短命令 `juanzhi` 的安装（M7）：Mac 写 shell 包装脚本，Windows 写 juanzhi.cmd 并把目录加进用户级 PATH（不需要管理员权限）。
 * 脚本内容是纯函数（单测核对）；写文件 / 改 PATH 的部分把环境（平台、家目录、PowerShell 执行器）作为参数传入，单测可以替换。
 * 不依赖 electron。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** 单引号包起来的 shell 字符串（路径里有单引号也安全） */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Mac / Linux：~/.local/bin/juanzhi */
export function buildShellShim(exePath: string): string {
  return [
    '#!/bin/sh',
    '# 由「卷知」生成：juanzhi 命令（设置 → 管理员设置 → 安装命令行工具）。卷知被移动或卸载后，请重新安装命令行工具。',
    `exec ${shQuote(exePath)} cli "$@"`,
    ''
  ].join('\n')
}

/**
 * Windows：juanzhi.cmd。
 * Electron 是 GUI 子系统程序：cmd / PowerShell 直接运行它既不等它结束，也拿不到 stdout 和退出码。
 * 所以这里用 `start /wait` 同步等待，让程序把 JSON 结果写到临时文件（环境变量 JUANZHI_RESULT_FILE），再 `type` 到 stdout，并返回退出码。
 * 免安装版的外层启动器不一定传递退出码：结果里有 "ok":false 而进程码是 0 时，按 1 返回。
 * 文件按 UTF-8（无 BOM）保存，开头 chcp 65001，路径里有中文（用户名）也能用；结束时把代码页恢复回去。
 */
export function buildCmdShim(exePath: string): string {
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'rem 由「卷知」生成：juanzhi 命令（设置 - 管理员设置 - 安装命令行工具）。卷知被移动或卸载后，请重新安装命令行工具。',
    'for /f "tokens=2 delims=:." %%a in (\'chcp\') do set "JZ_CP=%%a"',
    'chcp 65001 >nul',
    `set "JZ_EXE=${exePath}"`,
    'if not exist "%JZ_EXE%" goto :missing',
    'set "JZ_OUT=%TEMP%\\juanzhi-%RANDOM%%RANDOM%.json"',
    'del "%JZ_OUT%" >nul 2>nul',
    'set "JUANZHI_RESULT_FILE=%JZ_OUT%"',
    'start "" /wait "%JZ_EXE%" cli %*',
    'set "JZ_CODE=%ERRORLEVEL%"',
    'if not exist "%JZ_OUT%" goto :noresult',
    'type "%JZ_OUT%"',
    'if "%JZ_CODE%"=="0" findstr /C:"\\"ok\\":false" "%JZ_OUT%" >nul && set "JZ_CODE=1"',
    'del "%JZ_OUT%" >nul 2>nul',
    'goto :done',
    ':missing',
    'echo {"ok":false,"code":"internal","message":"找不到卷知程序，请在卷知里重新点「安装命令行工具」","exit":1}',
    'set "JZ_CODE=1"',
    'goto :done',
    ':noresult',
    'echo {"ok":false,"code":"internal","message":"卷知没有返回结果（命令没有正常结束）","exit":1}',
    'set "JZ_CODE=1"',
    ':done',
    'if defined JZ_CP chcp %JZ_CP% >nul',
    'endlocal & exit /b %JZ_CODE%',
    ''
  ]
  return lines.join('\r\n')
}

/** 把目录加进「用户级」PATH 的 PowerShell 脚本（目录从环境变量 JZ_BIN_DIR 读，不拼进脚本里，避免引号问题）；已经在 PATH 里就不动 */
export const WINDOWS_PATH_SCRIPT = [
  "$d = $env:JZ_BIN_DIR",
  "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "if (-not $p) { $p = '' }",
  "$parts = $p -split ';' | Where-Object { $_ -ne '' }",
  "if ($parts -contains $d) { Write-Output 'already'; exit 0 }",
  "[Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User')",
  "Write-Output 'added'"
].join('; ')

export interface InstallEnv {
  platform: NodeJS.Platform
  home: string
  localAppData?: string
  /** 要执行的程序：安装版 = 当前可执行文件；免安装版 = PORTABLE_EXECUTABLE_FILE */
  exePath: string
  portable: boolean
  /** 允许程序在 /Volumes 下（测试用；正常使用时从 dmg / 外接磁盘里直接运行不允许安装） */
  allowVolumes?: boolean
  /** 运行 PowerShell 脚本（单测里替换）；返回 stdout */
  runPowerShell?: (script: string, env: Record<string, string>) => Promise<string>
}

export interface InstallResult {
  ok: boolean
  platform: string
  /** 写出的脚本路径 */
  path: string
  /** 脚本所在目录 */
  dir: string
  /** 目录是否已经在 PATH 里（Mac 上是检查当前进程的 PATH；Windows 上是写入用户级 PATH 之后） */
  onPath: boolean
  /** 白话说明：接下来要做什么 */
  hint: string
  warnings: string[]
}

function defaultPowerShell(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? '：' + String(stderr).trim() : ''}`))
      else resolve(String(stdout).trim())
    })
  })
}

/** 当前命令行工具安装在哪（不安装，只看；界面显示「已安装」用） */
export function shimPath(env: Pick<InstallEnv, 'platform' | 'home' | 'localAppData'>): { dir: string; file: string } {
  if (env.platform === 'win32') {
    const dir = path.join(env.localAppData || path.join(env.home, 'AppData', 'Local'), 'Juanzhi', 'bin')
    return { dir, file: path.join(dir, 'juanzhi.cmd') }
  }
  const dir = path.join(env.home, '.local', 'bin')
  return { dir, file: path.join(dir, 'juanzhi') }
}

export async function installCliShim(env: InstallEnv, currentPath: string = process.env.PATH ?? ''): Promise<InstallResult> {
  const { dir, file } = shimPath(env)
  const warnings: string[] = []
  if (env.platform === 'darwin' && !env.allowVolumes && /^\/Volumes\//.test(env.exePath)) {
    throw new Error('卷知现在是从安装盘（dmg）或外接磁盘里直接运行的，请先把它拖进「应用程序」文件夹，再从那里打开并安装命令行工具')
  }
  if (env.platform !== 'darwin' && env.platform !== 'win32') throw new Error('命令行工具目前只支持 Mac 和 Windows')
  fs.mkdirSync(dir, { recursive: true })
  if (env.platform === 'win32') {
    fs.writeFileSync(file, buildCmdShim(env.exePath), 'utf8')
    let added = false
    try {
      const out = await (env.runPowerShell ?? defaultPowerShell)(WINDOWS_PATH_SCRIPT, { JZ_BIN_DIR: dir })
      added = /added|already/.test(out)
    } catch (e) { warnings.push(`没能把 ${dir} 加进用户 PATH：${(e as Error).message}。可以手动加，或直接用完整路径运行 ${file}`) }
    if (env.portable) warnings.push('免安装版的限制：短命令指向免安装版文件本身（移动或删除它会失效）；每次运行都要先解压，慢几秒；它的外层启动器不一定传递退出码（以返回的 JSON 里 ok / exit 为准）。长期给 Agent 用建议装安装版。')
    return { ok: true, platform: 'win32', path: file, dir, onPath: added, warnings,
      hint: `已写入 ${file}${added ? '，并加进了你的用户 PATH。重新打开 PowerShell / 命令提示符后，就可以直接输入 juanzhi status' : '。请把这个目录加进 PATH，或用完整路径运行'}` }
  }
  fs.writeFileSync(file, buildShellShim(env.exePath), { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  const onPath = currentPath.split(':').some(p => p && path.resolve(p) === path.resolve(dir))
  return { ok: true, platform: 'darwin', path: file, dir, onPath, warnings,
    hint: onPath
      ? `已写入 ${file}，${dir} 已经在你的 PATH 里，重新打开终端后可以直接输入 juanzhi status`
      : `已写入 ${file}。还需要把 ${dir} 加进 PATH：在终端里运行 echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc，然后重新打开终端，就可以输入 juanzhi status` }
}
