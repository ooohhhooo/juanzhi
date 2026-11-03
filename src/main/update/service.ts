/**
 * 应用内更新（联网、下载、解压、替换、重启）。纯逻辑在 core.ts。
 * 不会自己安装：检查 → 有新版 → 老师点「下载并更新」→ 下载并校验 → 老师点「重启并完成更新」→ 才退出替换。数据目录从头到尾不碰。
 */
import { app, net, shell, BrowserWindow } from 'electron'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  CHECK_INTERVAL_HOURS, RECHECK_HOURS, RELEASES_PAGE, sweepStages, MAC_SWAP_SCRIPT, WIN_SWAP_SCRIPT, GITHUB_OWNER, GITHUB_REPO,
  autoCheckEnabled, feedBases, isNewer, macBundleOf, macInstallBlocker, parseManifest, pickMacZip, pickPortableExe, safeArg, summarizeNotes, verifyFile,
  type Blocker, type ManifestFile, type UpdateManifest
} from './core'
import { busyReason } from '../busy'
import { activeDataOp } from '../ipc/data'
import { getExporting } from '../restart'

const run = promisify(execFile)

export type UpdateMode = 'mac-zip' | 'win-nsis' | 'win-portable' | 'manual'
export type UpdatePhase = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
export interface UpdateState {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  latestVersion?: string
  notes?: string
  progress?: { percent: number; transferred: number; total: number }
  /** 白话错误；manual = true 时界面给「手动下载」 */
  error?: { message: string; manual: boolean }
  /** 不适合自动替换的原因（界面给白话 + 「手动下载」） */
  blocker?: { code: string; message: string }
  /** 这次是启动时静默检查发现的、还没提示过（界面据此弹小提示） */
  announce?: boolean
}

/** 软件所在的真实可执行文件路径（装在符号链接后面也要找到真正的 .app） */
const realExec = (): string => { try { return fs.realpathSync(process.execPath) } catch { return process.execPath } }
const PORTABLE_FILE = (): string | undefined => process.env.PORTABLE_EXECUTABLE_FILE
const detectMode = (): UpdateMode => {
  if (process.platform === 'darwin') return 'mac-zip'
  if (process.platform === 'win32') return PORTABLE_FILE() ? 'win-portable' : 'win-nsis'
  return 'manual'
}

let state: UpdateState = { phase: 'idle', mode: detectMode(), currentVersion: '' }
let manifest: UpdateManifest | null = null
let chosen: ManifestFile | null = null
let feedBase = ''
let downloadedFile = ''     // Mac：解压出来的 .app；portable：下载好的 exe
let workDir = ''
let busyOp = false
let nsis: any = null
let nsisToken: any = null

// ───────────────────────── 持久状态（只放用户数据目录之外的一个小文件）─────────────────────────
interface Persist { lastCheckAt?: number; skippedVersion?: string }
const persistFile = () => path.join(app.getPath('userData'), 'update-state.json')
function readPersist(): Persist { try { return JSON.parse(fs.readFileSync(persistFile(), 'utf8')) } catch { return {} } }
function writePersist(p: Persist): void { try { fs.writeFileSync(persistFile(), JSON.stringify(p)) } catch { /* 写不了就算了：最多多检查一次 */ } }

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('update:state', state) } catch { /* 窗口正在关闭 */ } }
}
export const getUpdateState = (): UpdateState => ({ ...state, currentVersion: app.getVersion() })

/** 给老师看的话：一律是一句以「。」结尾的中文。我们自己写的中文提示原样给；其余（网络、系统命令、磁盘……）翻成白话，原始错误只写日志 */
const friendly = (e: unknown): string => {
  const m = (e as Error)?.message ?? String(e)
  if (/[\u4e00-\u9fff]/.test(m) && /。$/.test(m)) return m
  console.warn(`[update] ${(e as Error)?.stack ?? m}`)
  if ((e as Error)?.name === 'AbortError' || /aborted|timeout|ETIMEDOUT|ERR_TIMED_OUT/i.test(m)) return '连接更新服务器超时了。'
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_PROXY|fetch failed|ENOTFOUND|ECONN|ERR_/i.test(m)) return '连不上更新服务器（可能是网络不通，或需要科学上网）。'
  const http = /^HTTP (\d{3})/.exec(m)
  if (http) return http[1] === '404' ? '更新服务器上还没有找到这个版本的文件。' : `更新服务器返回了错误（${http[1]}）。`
  if (/ENOSPC/.test(m)) return '磁盘空间不够，没能完成更新。'
  if (/EACCES|EPERM|EROFS/.test(m)) return '没有写入权限，没能完成更新。'
  if (/Command failed|codesign|ditto|plutil|xattr/i.test(m)) return '更新包没能通过检查，已放弃。'
  return '更新没能完成，请稍后再试。'
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await net.fetch(url, { signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally { clearTimeout(t) }
}

const manifestName = (mode: UpdateMode): string => (mode === 'mac-zip' ? 'latest-mac.yml' : mode === 'win-portable' ? 'latest-portable.yml' : 'latest.yml')

/** 取更新清单：依次试每个更新源 */
async function loadManifest(mode: UpdateMode): Promise<{ m: UpdateManifest; base: string }> {
  let lastErr: unknown = null
  for (const base of feedBases()) {
    try { return { m: parseManifest(await fetchText(`${base}/${manifestName(mode)}`)), base } } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('没有可用的更新源')
}

/** GitHub 的发布说明（清单里没有时补一份；失败就不显示，不影响更新） */
async function fetchGithubNotes(version: string): Promise<string> {
  if (process.env.EWB_UPDATE_FEED) return ''
  try {
    const j = JSON.parse(await fetchText(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${version}`, 8000))
    return summarizeNotes(j.body)
  } catch { return '' }
}

export function currentBlocker(): Blocker | null {
  if (state.mode === 'mac-zip') return macInstallBlocker(realExec(), d => { try { fs.accessSync(d, fs.constants.W_OK); return true } catch { return false } })
  if (state.mode === 'win-portable') {
    const f = PORTABLE_FILE()!
    try { fs.accessSync(path.dirname(f), fs.constants.W_OK); return null } catch { return { code: 'unwritable', message: `免安装版所在的文件夹（${path.dirname(f)}）没有写入权限，没办法替换自己。可以手动下载新版。` } }
  }
  if (state.mode === 'manual') return { code: 'dev', message: '这个系统暂不支持自动更新。' }
  return null
}

// ───────────────────────── 检查 ─────────────────────────
export async function checkForUpdate(opts: { silent: boolean }): Promise<UpdateState> {
  if (busyOp || ['downloading', 'installing', 'ready'].includes(state.phase)) return getUpdateState()
  busyOp = true
  const mode = detectMode()
  set({ mode, phase: 'checking', error: undefined, announce: false, blocker: undefined })
  const persist = readPersist()
  const stamp = () => writePersist({ ...readPersist(), lastCheckAt: Date.now() })
  try {
    let latest: string, notes = ''
    if (mode === 'win-nsis') {
      const u = await nsisUpdater()
      const r = await u.checkForUpdates()
      latest = r?.updateInfo?.version ?? app.getVersion()
      notes = summarizeNotes(typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : '')
      manifest = null; chosen = null
    } else {
      const { m, base } = await loadManifest(mode)
      latest = m.version
      manifest = m; feedBase = base
      chosen = mode === 'mac-zip' ? pickMacZip(m, process.arch) : mode === 'win-portable' ? pickPortableExe(m) : null
      if (isNewer(latest, app.getVersion()) && !chosen) throw new Error('新版本里没有适合这台电脑的安装包。')
      notes = summarizeNotes(m.releaseNotes)
    }
    stamp()
    if (!isNewer(latest, app.getVersion())) { set({ phase: 'uptodate', latestVersion: latest, notes: undefined }); return getUpdateState() }
    if (!notes) notes = await fetchGithubNotes(latest)
    const blocker = currentBlocker()
    // 静默检查：老师以前点过「跳过这个版本」的不再提示（手动检查仍然显示）
    const skipped = opts.silent && persist.skippedVersion === latest
    set({ phase: 'available', latestVersion: latest, notes: notes || undefined, blocker: blocker ?? undefined, announce: opts.silent && !skipped })   // 需要手动更新（blocker）也提示：点「更新」会到设置页看到原因和「手动下载」
    return getUpdateState()
  } catch (e) {
    set(opts.silent ? { phase: 'idle', error: undefined } : { phase: 'error', error: { message: friendly(e), manual: true } })
    if (opts.silent) console.warn(`[update] 静默检查失败: ${(e as Error).message}`)
    return getUpdateState()
  } finally { busyOp = false }
}

// ───────────────────────── 下载 ─────────────────────────
/** 下载中的控制器：「取消下载」和「长时间没有数据」都靠它中断 */
let dlCtl: AbortController | null = null
let dlReason: 'cancel' | 'stall' | null = null
const STALL_MS = (): number => Number(process.env.EWB_UPDATE_STALL_MS) || 30_000

async function downloadTo(url: string, dest: string, expected: ManifestFile): Promise<void> {
  const ctl = new AbortController()
  dlCtl = ctl; dlReason = null
  let timer: NodeJS.Timeout | null = null
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { dlReason = 'stall'; ctl.abort() }, STALL_MS()) }
  arm()
  const out = fs.createWriteStream(dest)
  try {
    const r = await net.fetch(url, { signal: ctl.signal })
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
    const total = Number(r.headers.get('content-length')) || expected.size || 0
    let got = 0, lastSent = 0
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      if (!out.write(value)) await new Promise<void>(res => out.once('drain', () => res()))
      got += value.length
      const now = Date.now()
      if (now - lastSent > 150) { lastSent = now; set({ progress: { percent: total ? Math.min(99, Math.floor(got / total * 100)) : 0, transferred: got, total } }) }
    }
  } catch (e) {
    if (dlReason === 'cancel') throw new Error('已取消下载，当前版本没有任何改动。')
    if (dlReason === 'stall') throw new Error('下载中断了（很久没有收到数据，可能是网络不稳），当前版本没有任何改动。')
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    dlCtl = null
    await new Promise<void>(res => out.end(() => res()))
  }
}

/** 老师点「取消下载」 */
export function cancelDownload(): void {
  if (state.phase !== 'downloading') return
  dlReason = 'cancel'
  dlCtl?.abort()
  nsisToken?.cancel()
}

async function plist(app_: string, key: string): Promise<string> {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app_, 'Contents', 'Info.plist')])
  return stdout.trim()
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (busyOp || state.phase !== 'available') return getUpdateState()
  const blocker = currentBlocker()
  if (blocker) { set({ blocker }); return getUpdateState() }
  busyOp = true
  const mode = state.mode
  try {
    set({ phase: 'downloading', error: undefined, progress: { percent: 0, transferred: 0, total: 0 } })
    if (mode === 'win-nsis') {
      const u = await nsisUpdater()
      const { CancellationToken } = await import('electron-updater')
      nsisToken = new CancellationToken()
      await u.downloadUpdate(nsisToken)   // 进度、完成由事件回调更新状态
      set({ phase: 'ready', progress: { percent: 100, transferred: 0, total: 0 } })
      return getUpdateState()
    }
    if (!manifest || !chosen) throw new Error('没有找到要下载的文件，请重新检查更新。')
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juanzhi-update-'))
    const file = path.join(workDir, chosen.url)
    await downloadTo(`${feedBase}/${encodeURIComponent(chosen.url)}`, file, chosen)
    const v = await verifyFile(file, chosen)
    if (!v.ok) console.warn(`[update] 校验失败: ${v.reason}`)
    if (!v.ok) throw new Error('下载的文件不完整或被改动过，已放弃，当前版本没有任何改动。')
    if (mode === 'mac-zip') {
      const dest = path.join(workDir, 'unzipped')
      fs.mkdirSync(dest)
      await run('/usr/bin/ditto', ['-x', '-k', file, dest])
      const apps = fs.readdirSync(dest).filter(n => n.endsWith('.app'))
      if (apps.length !== 1) throw new Error('更新包里的内容不对（找不到应用）。')
      const newApp = path.join(dest, apps[0])
      const curBundle = macBundleOf(realExec())!
      const [ver, id, curId] = await Promise.all([plist(newApp, 'CFBundleShortVersionString'), plist(newApp, 'CFBundleIdentifier'), plist(curBundle, 'CFBundleIdentifier')])
      if (ver !== manifest.version) throw new Error(`更新包的版本（${ver}）和清单（${manifest.version}）对不上，已放弃。`)
      if (id !== curId) throw new Error('更新包不是卷知的安装包（标识不一致），已放弃。')
      // 签名完整性：ad-hoc 签名也要能通过验证，坏包不替换
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp])
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => undefined)
      downloadedFile = newApp
    } else downloadedFile = file
    set({ phase: 'ready', progress: { percent: 100, transferred: chosen.size, total: chosen.size } })
  } catch (e) {
    cleanupWork()
    const cancelled = dlReason === 'cancel' || /CancellationError|cancelled/i.test((e as Error)?.message ?? '')
    set({ phase: 'error', error: { message: cancelled ? '已取消下载，当前版本没有任何改动。' : friendly(e), manual: !cancelled }, progress: undefined })
  } finally { busyOp = false }
  return getUpdateState()
}

function cleanupWork(): void {
  if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  workDir = ''; downloadedFile = ''
}

// ───────────────────────── 安装（退出、替换、重启）─────────────────────────
/**
 * 不能现在安装的原因。hard = 硬拦截（正在导出 / 导入数据包、改数据目录：中途退出会损坏数据，没有「放弃」选项）；
 * 否则是 AI 解析 / 提取 / 报告在跑：由界面让老师等或放弃这些任务。
 */
export function installBusy(): { reason: string; hard: boolean } | null {
  const op = activeDataOp()
  if (op) return { reason: `正在${op}，等它完成后再更新。`, hard: true }
  if (getExporting()) return { reason: '正在导出数据包，等它完成后再更新。', hard: true }
  try { const r = busyReason(); return r ? { reason: r, hard: false } : null } catch { return null }
}

let stagePath = ''
export async function installUpdate(): Promise<{ ok: boolean; message?: string }> {
  if (state.phase !== 'ready' || busyOp) return { ok: false, message: '还没有准备好更新。' }
  busyOp = true
  try {
    const mode = state.mode
    const log = path.join(os.tmpdir(), 'juanzhi-update.log')
    const hard = installBusy()
    if (hard?.hard) { busyOp = false; return { ok: false, message: hard.reason } }
    set({ phase: 'installing' })
    if (mode === 'win-nsis') {
      const u = await nsisUpdater()
      setImmediate(() => { try { u.quitAndInstall(true, true) } catch (e) { set({ phase: 'error', error: { message: friendly(e), manual: true } }) } })
      return { ok: true }
    }
    if (mode === 'mac-zip') {
      const blocker = currentBlocker()
      if (blocker) throw new Error(blocker.message)
      const target = macBundleOf(realExec())!
      const parent = path.dirname(target)
      stagePath = path.join(parent, `.juanzhi-update-${process.pid}`)
      const stage = stagePath
      // 先把新版复制到旧版旁边（同一个磁盘）：退出后只剩改名，瞬间完成、不会半途出错留下一个不完整的应用
      fs.rmSync(stage, { recursive: true, force: true })
      fs.mkdirSync(stage)
      const staged = path.join(stage, 'new.app')
      await run('/usr/bin/ditto', [downloadedFile, staged])
      const scriptFile = path.join(workDir || os.tmpdir(), 'swap.sh')
      fs.writeFileSync(scriptFile, MAC_SWAP_SCRIPT, { mode: 0o755 })
      const child = spawn('/bin/sh', [scriptFile, String(process.pid), safeArg(staged), safeArg(target), safeArg(path.join(stage, "backup")), log, workDir], { detached: true, stdio: 'ignore' })
      child.unref()
    } else {
      const target = PORTABLE_FILE()!
      const scriptFile = path.join(os.tmpdir(), `juanzhi-swap-${process.pid}.cmd`)
      fs.writeFileSync(scriptFile, WIN_SWAP_SCRIPT.replace(/\n/g, '\r\n'))
      // 新 exe 先挪到旧 exe 旁边（同一个磁盘），退出后只剩改名
      const staged = `${target}.new`
      stagePath = staged
      fs.copyFileSync(downloadedFile, staged)
      const env: NodeJS.ProcessEnv = { ...process.env, EWB_NEW: safeArg(staged), EWB_TARGET: safeArg(target), EWB_TARGET_NAME: safeArg(path.basename(target)), EWB_LOG: log, EWB_PID: String(process.pid), EWB_WORK: safeArg(workDir) }
      for (const k of Object.keys(env)) if (k.startsWith('PORTABLE_EXECUTABLE') || k === 'ELECTRON_RUN_AS_NODE') delete env[k]
      const child = spawn('cmd.exe', ['/c', scriptFile], { detached: true, stdio: 'ignore', windowsHide: true, env })
      child.unref()
    }
    setImmediate(() => app.quit())
    return { ok: true }
  } catch (e) {
    // 复制到一半失败（磁盘满等）：把没复制完的新版清掉，旧版没动过
    if (stagePath) { try { fs.rmSync(stagePath, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    cleanupWork()
    set({ phase: 'error', error: { message: friendly(e), manual: true } })
    return { ok: false, message: friendly(e) }
  } finally { busyOp = false }
}

// ───────────────────────── Windows 安装版：electron-updater ─────────────────────────
async function nsisUpdater(): Promise<any> {
  if (nsis) return nsis
  const m: any = await import('electron-updater')
  const NsisUpdater = m.NsisUpdater ?? m.default?.NsisUpdater
  if (!NsisUpdater) throw new Error('没能加载更新组件。')
  const u = new NsisUpdater({ provider: 'generic', url: feedBases()[0] })
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.allowDowngrade = false
  u.disableDifferentialDownload = true   // 不依赖 .blockmap：整包下载
  if (!app.isPackaged) u.forceDevUpdateConfig = true
  u.on('error', (e: Error) => { if (['checking', 'downloading', 'installing'].includes(state.phase)) set({ phase: 'error', error: { message: friendly(e), manual: true }, progress: undefined }) })
  u.on('download-progress', (p: any) => set({ progress: { percent: Math.min(99, Math.floor(p.percent ?? 0)), transferred: p.transferred ?? 0, total: p.total ?? 0 } }))
  nsis = u
  return u
}

// ───────────────────────── 其他 ─────────────────────────
export function skipVersion(version: string): void {
  writePersist({ ...readPersist(), skippedVersion: version })
  if (state.latestVersion === version) set({ announce: false })
}
export const openReleasePage = (): Promise<void> => shell.openExternal(RELEASES_PAGE)

/** 启动后静默检查（距上次检查不到 1 小时就跳过），之后软件开着时每 4 小时再查一次 */
export function startAutoCheck(): void {
  if (!autoCheckEnabled(process.env, app.isPackaged)) return
  state = { ...state, mode: detectMode(), currentVersion: app.getVersion() }
  const last = readPersist().lastCheckAt ?? 0
  if (Date.now() - last >= CHECK_INTERVAL_HOURS * 3600_000) {
    const delay = Number(process.env.EWB_UPDATE_CHECK_DELAY_MS) || 8000
    setTimeout(() => { void checkForUpdate({ silent: true }) }, delay)
  }
  const every = Number(process.env.EWB_UPDATE_RECHECK_MS) || RECHECK_HOURS * 3600_000
  setInterval(() => { if (state.phase === 'idle' || state.phase === 'uptodate') void checkForUpdate({ silent: true }) }, every).unref?.()
}

/** 启动时清理上次更新留下的暂存目录（只在打包好的 Mac 版里） */
export function sweepStaleStages(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const bundle = macBundleOf(realExec())
  if (!bundle) return
  const removed = sweepStages(path.dirname(bundle), process.pid)
  if (removed.length) console.log(`[update] 清理了上次更新留下的暂存目录: ${removed.join(', ')}`)
}
