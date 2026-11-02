/**
 * 应用内更新的纯逻辑（不依赖 electron，单测直接加载）：更新源、版本比较、latest*.yml 解析与选包、sha512 校验、
 * 「不适合自动替换」的判断、替换用的小脚本。联网、下载、解压、重启在 service.ts。
 *
 * 设计：免费、不需要苹果开发者证书——更新包就是 GitHub Release 上的文件，校验靠 electron-builder 生成的 latest*.yml 里的 sha512。
 *  · Windows 安装版：electron-updater 的 NsisUpdater（见 service.ts）；
 *  · Mac 和 Windows 免安装版：自己下载、校验、解压，退出后由一个小脚本替换并重新打开。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const GITHUB_OWNER = 'ooohhhooo'
export const GITHUB_REPO = 'juanzhi'
/** 下载失败 / 不适合自动更新时，给老师的「手动下载」页 */
export const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
/** 小时：启动时静默检查的最短间隔 */
export const CHECK_INTERVAL_HOURS = 24

/**
 * 更新源（按顺序尝试，前一个连不上就换下一个）。以后要加国内镜像，只改这里：每一项是一个「目录地址」，
 * 下面直接放 latest.yml / latest-mac.yml / latest-portable.yml 和安装包。EWB_UPDATE_FEED 优先（自动化测试和排查用）。
 */
export function feedBases(env: Record<string, string | undefined> = process.env): string[] {
  const custom = env.EWB_UPDATE_FEED?.trim()
  if (custom) return [custom.replace(/\/+$/, '')]
  return [`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download`]
}

/** 启动时是否自动检查：命令行、测试（自定义数据目录）、开发版都不查，除非明确给了更新源 */
export function autoCheckEnabled(env: Record<string, string | undefined>, packaged: boolean): boolean {
  if (env.EWB_DISABLE_UPDATE_CHECK === '1') return false
  if (env.EWB_UPDATE_FEED?.trim()) return true
  if (env.EWB_USER_DATA_DIR) return false
  return packaged
}

// ───────────────────────── 版本比较 ─────────────────────────

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
export function parseVersion(v: string): { nums: [number, number, number]; pre: string[] } | null {
  const m = SEMVER.exec(String(v).trim())
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null
}
/** 返回 1 / 0 / -1；任何一边不是合法版本号就返回 null（调用方当作「不更新」） */
export function compareVersions(a: string, b: string): 1 | 0 | -1 | null {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1   // 正式版 > 预发布
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return +p > +q ? 1 : -1
    if (pn !== qn) return pn ? -1 : 1
    return p > q ? 1 : -1
  }
  return 0
}
export const isNewer = (latest: string, current: string): boolean => compareVersions(latest, current) === 1

// ───────────────────────── latest*.yml ─────────────────────────

export interface ManifestFile { url: string; sha512: string; size: number }
export interface UpdateManifest { version: string; files: ManifestFile[]; releaseDate?: string; releaseNotes?: string }

const unquote = (s: string): string => {
  const t = s.trim()
  return (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ? t.slice(1, -1).replace(/''/g, "'")
    : (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ? t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : t
}

/**
 * 解析 electron-builder 生成的 latest*.yml（只认它用到的那一小块 YAML：顶层键值、files 列表、releaseNotes 的 `|` 块）。
 * 缺 version / 没有任何带 sha512 的文件就抛错——宁可「检查失败」，也不拿一份残缺的清单去下载。
 */
export function parseManifest(text: string): UpdateManifest {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const top: Record<string, string> = {}
  const files: Array<Record<string, string>> = []
  let section: 'none' | 'files' | 'block' = 'none'
  let blockKey = ''
  let blockLines: string[] = []
  let cur: Record<string, string> | null = null
  const flushBlock = () => { if (blockKey) top[blockKey] = blockLines.join('\n').replace(/\s+$/, ''); blockKey = ''; blockLines = [] }
  for (const raw of lines) {
    if (section === 'block') {
      if (/^\s+\S/.test(raw) || raw.trim() === '') { blockLines.push(raw.replace(/^ {1,2}/, '')); continue }
      flushBlock(); section = 'none'
    }
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const itemStart = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
    if (section === 'files' && itemStart) { cur = { [itemStart[1]]: unquote(itemStart[2]) }; files.push(cur); continue }
    const kv = /^(\s*)([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
    if (!kv) continue
    const [, indent, key, rest] = kv
    if (indent.length === 0) {
      cur = null
      if (key === 'files' && rest === '') { section = 'files'; continue }
      section = 'none'
      if (/^[|>][-+]?$/.test(rest.trim())) { section = 'block'; blockKey = key; blockLines = []; continue }
      top[key] = unquote(rest)
    } else if (section === 'files' && cur) cur[key] = unquote(rest)
  }
  if (section === 'block') flushBlock()
  const version = top.version
  if (!version || !parseVersion(version)) throw new Error('更新清单里没有有效的版本号')
  const list: ManifestFile[] = files
    .filter(f => f.url && f.sha512)
    .map(f => ({ url: f.url, sha512: f.sha512, size: Number(f.size) || 0 }))
  // 老格式：只有顶层 path / sha512
  if (!list.length && top.path && top.sha512) list.push({ url: top.path, sha512: top.sha512, size: Number(top.size) || 0 })
  if (!list.length) throw new Error('更新清单里没有可下载的文件')
  for (const f of list) if (/[\\/]|^\.\.?$/.test(f.url) || /^[a-z]+:/i.test(f.url)) throw new Error('更新清单里的文件名不安全')
  return { version, files: list, releaseDate: top.releaseDate, releaseNotes: top.releaseNotes }
}

/** Mac：按本机 CPU 选 zip（文件名形如 Juanzhi-1.2.2-mac-arm64.zip）。清单里没有这个架构的 zip 就返回 null */
export function pickMacZip(m: UpdateManifest, arch: string): ManifestFile | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!a) return null
  return m.files.find(f => new RegExp(`(^|[-_.])${a}\\.zip$`, 'i').test(f.url)) ?? null
}
/** Windows 免安装版：latest-portable.yml 里的 exe */
export function pickPortableExe(m: UpdateManifest): ManifestFile | null {
  return m.files.find(f => /portable\.exe$/i.test(f.url)) ?? null
}

/** 清单里附带的更新说明压成几行：去掉 HTML 标签和 markdown 记号，最多 maxLines 行、maxChars 字 */
export function summarizeNotes(raw: string | undefined | null, maxLines = 6, maxChars = 400): string {
  if (!raw) return ''
  const lines = raw.replace(/\r/g, '').replace(/<[^>]+>/g, '').split('\n')
    .map(l => l.replace(/^\s*(#{1,6}\s*|[-*+]\s+|\d+\.\s+)/, '').replace(/[*_`]/g, '').trim()).filter(Boolean)
  let out = lines.slice(0, maxLines).join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + '…'
  else if (lines.length > maxLines) out += '…'
  return out
}

// ───────────────────────── 校验 ─────────────────────────

/** 流式算文件的 sha512（base64，和 electron-builder 的 latest*.yml 同格式） */
export function sha512OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512')
    const s = fs.createReadStream(file)
    s.on('data', d => h.update(d)); s.on('error', reject); s.on('end', () => resolve(h.digest('base64')))
  })
}
export async function verifyFile(file: string, expected: { sha512: string; size?: number }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const st = fs.statSync(file)
    if (expected.size && st.size !== expected.size) return { ok: false, reason: `文件大小不对（${st.size}，应为 ${expected.size}）` }
    const got = await sha512OfFile(file)
    return got === expected.sha512 ? { ok: true } : { ok: false, reason: 'sha512 校验不一致' }
  } catch (e) { return { ok: false, reason: (e as Error).message } }
}

// ───────────────────────── Mac：能不能原地替换 ─────────────────────────

export type BlockerCode = 'dev' | 'dmg' | 'translocation' | 'unwritable'
export interface Blocker { code: BlockerCode; message: string }

/** 从当前可执行文件推出 .app 包的位置：…/卷知.app/Contents/MacOS/卷知 → …/卷知.app；不是 .app 返回 null */
export function macBundleOf(execPath: string): string | null {
  const bundle = path.posix.dirname(path.posix.dirname(path.posix.dirname(execPath)))
  return bundle.endsWith('.app') && execPath.includes('.app/Contents/MacOS/') ? bundle : null
}

/**
 * Mac 上不适合「原地替换」的情况，给老师一句白话（界面上配「手动下载」按钮）：
 *  · 从磁盘映像（dmg）里直接运行 / 放在外接磁盘上（路径在 /Volumes 下）：映像是只读的，替换不了；
 *  · 被 macOS 的「应用转移」（App Translocation）隔离运行：真实位置看不到，替换的是临时副本；
 *  · 所在文件夹没有写权限（比如别的账户装的）。
 */
export function macInstallBlocker(execPath: string, parentWritable: (dir: string) => boolean): Blocker | null {
  const bundle = macBundleOf(execPath)
  if (!bundle) return { code: 'dev', message: '当前不是安装好的卷知应用（开发版），不能自动更新。' }
  if (bundle.includes('/AppTranslocation/')) return { code: 'translocation', message: '卷知现在是被系统「隔离」着运行的（直接从下载的位置打开会这样）。请先把卷知拖进「应用程序」文件夹，再从那里打开，之后就可以一键更新了。' }
  if (bundle.startsWith('/Volumes/')) return { code: 'dmg', message: '卷知现在是从磁盘映像或外接磁盘里直接运行的，没办法替换自己。请先把卷知拖进「应用程序」文件夹，再从那里打开，之后就可以一键更新了。' }
  const parent = path.posix.dirname(bundle)
  if (!parentWritable(parent)) return { code: 'unwritable', message: `卷知所在的文件夹（${parent}）当前账户没有写入权限，没办法替换自己。可以手动下载新版安装，或把卷知放到有权限的文件夹里。` }
  return null
}

// ───────────────────────── 替换脚本 ─────────────────────────

/**
 * Mac 替换脚本（/bin/sh）。所有路径都通过参数传入、全部加了引号，所以空格和中文都没问题；脚本正文里没有任何路径。
 * 参数：1=本进程 pid  2=新的 .app（已经复制到旧 .app 旁边、同一个磁盘，所以下面的 mv 是改名，瞬间完成）  3=旧 .app（要被替换的）  4=备份用的目录  5=日志文件
 * 步骤：等本进程退出（最多 60 秒）→ 旧的挪进备份目录 → 新的挪到原位（失败就把旧的挪回来）→ 去掉隔离标记 → open 重新打开 → 确认起来后清理备份。
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
PID="$1"; NEW="$2"; TARGET="$3"; BACKUP="$4"; LOG="$5"; WORK="$6"
log() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
STAGE=$(dirname "$BACKUP")
clean() { rm -rf "$NEW" "$BACKUP" "$WORK"; rmdir "$STAGE" 2>/dev/null; }
log "等待进程 $PID 退出"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 300 ]; then log "等了 60 秒进程还在，放弃替换"; clean; exit 1; fi
  sleep 0.2
done
mkdir -p "$BACKUP" || { log "建不了备份目录"; clean; open "$TARGET"; exit 1; }
if ! mv "$TARGET" "$BACKUP/old.app"; then
  log "旧版挪不开，保持原样"; clean; open "$TARGET"; exit 1
fi
if ! mv "$NEW" "$TARGET"; then
  log "新版挪不进去，恢复旧版"; rm -rf "$TARGET"; mv "$BACKUP/old.app" "$TARGET"; clean; open "$TARGET"; exit 1
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
log "已替换，重新打开"
open "$TARGET" || log "open 失败"
rm -rf "$WORK"
PAT=$(printf '%s' "$TARGET/Contents/MacOS/" | sed 's#[][\\.*^$(){}?+|/]#\\\\&#g')
j=0
while [ "$j" -lt 40 ]; do
  if pgrep -f "$PAT" >/dev/null 2>&1; then rm -rf "$BACKUP"; rmdir "$STAGE" 2>/dev/null; log "新版已运行，备份已清理"; exit 0; fi
  j=$((j+1)); sleep 0.5
done
log "20 秒内没看到新版运行，备份保留在 $BACKUP"
exit 0
`

/**
 * Windows 免安装版替换脚本（.cmd，纯 ASCII）。路径一律通过环境变量 EWB_NEW / EWB_TARGET / EWB_TARGET_NAME（文件名）/ EWB_LOG / EWB_PID / EWB_WORK（下载用的临时目录）传进来
 * （Windows 的环境变量是 UTF-16，中文路径没有编码问题）。
 * 步骤：先删掉上次可能留下的 .old → 等本进程退出（最多 60 秒）→ 把旧 exe 改名为 .old（外层启动器还占着它，但 Windows 允许给运行中的 exe 改名；改名失败就重试）→
 * 把新 exe 移到原位（失败就改回来）→ 重新启动 → 尽量删掉 .old。任何一条路径结束时：能重新打开的都重新打开旧版（等不到进程退出 / 改不了名 / 移不进去），并清掉 .new 和临时目录。
 */
export const WIN_SWAP_SCRIPT = `@echo off
setlocal
set RC=0
del /F /Q "%EWB_TARGET%.old" >nul 2>&1
set /a n=0
:waitpid
tasklist /FI "PID eq %EWB_PID%" 2>nul | find "%EWB_PID%" >nul
if errorlevel 1 goto rename
set /a n+=1
if %n% GEQ 60 goto giveup
ping -n 2 127.0.0.1 >nul
goto waitpid
:rename
set /a n=0
:retry
ren "%EWB_TARGET%" "%EWB_TARGET_NAME%.old" >nul 2>&1
if not errorlevel 1 goto swap
set /a n+=1
if %n% GEQ 60 goto giveup
ping -n 2 127.0.0.1 >nul
goto retry
:swap
move /Y "%EWB_NEW%" "%EWB_TARGET%" >nul 2>&1
if errorlevel 1 goto movefail
echo %date% %time% replaced>>"%EWB_LOG%"
start "" "%EWB_TARGET%"
set /a n=0
:cleanup
del /F /Q "%EWB_TARGET%.old" >nul 2>&1
if not exist "%EWB_TARGET%.old" goto finish
set /a n+=1
if %n% GEQ 30 goto finish
ping -n 2 127.0.0.1 >nul
goto cleanup
:movefail
echo %date% %time% move failed, restoring>>"%EWB_LOG%"
ren "%EWB_TARGET%.old" "%EWB_TARGET_NAME%" >nul 2>&1
set RC=1
start "" "%EWB_TARGET%"
goto finish
:giveup
echo %date% %time% target still in use, giving up and reopening the old version>>"%EWB_LOG%"
set RC=1
start "" "%EWB_TARGET%"
:finish
del /F /Q "%EWB_NEW%" >nul 2>&1
rmdir /s /q "%EWB_WORK%" >nul 2>&1
exit /b %RC%
`

/**
 * 启动时清理上次更新留在 .app 旁边的暂存目录（.juanzhi-update-<pid>）：本次进程自己的不动；
 * 别的 pid 留下的——里面没有备份（只是没复制完的新版）立刻删，有备份（旧版）的放满一天再删。返回删掉的目录名。
 */
export function sweepStages(parent: string, currentPid: number, now = Date.now()): string[] {
  const removed: string[] = []
  let names: string[] = []
  try { names = fs.readdirSync(parent) } catch { return removed }
  for (const n of names) {
    const m = /^\.juanzhi-update-(\d+)$/.exec(n)
    if (!m || Number(m[1]) === currentPid) continue
    const dir = path.join(parent, n)
    try {
      const old = now - fs.statSync(dir).mtimeMs > 24 * 3600_000
      if (old || !fs.existsSync(path.join(dir, 'backup'))) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(n) }
    } catch { /* 删不掉就留着，下次再说 */ }
  }
  return removed
}

/** 脚本参数 / 环境变量里不能有换行或空字符（会让脚本错位） */
export function safeArg(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error('路径里有不允许的字符')
  return s
}
