/**
 * 数据相关的 IPC：数据包导出 / 导入（.ewb.zip）、更改数据目录、示例数据、备份、关于信息。
 * 导入的路径只来自系统对话框（渲染端传不进任意路径）；数据包是不可信输入，处理见 pack/*。
 */
import { app, dialog, ipcMain, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { LATEST_SCHEMA, configuredDir, defaultDir, getDataDir, getDb, getFilesDir, takeStartupNotice, openSqlite, runMigrations } from '../db'
import { getMainWindow } from '../window'
import { notifyDataChanged } from '../events'
import { busyReason } from '../busy'
import { PackError } from '../pack/errors'
import { extractPack } from '../pack/reader'
import { prepareStagedDb } from '../pack/stage-db'
import { applyMerge, applyOverwrite, backupsRoot, listBackups, summarizePack } from '../pack/apply'
import { buildPack } from '../pack/exporter'
import { PACK_FORMAT_VERSION } from '../pack/manifest'
import type { Manifest } from '../pack/manifest'
import { MIGRATING_MARK, checkTargetDir, copyDirSync, dirSizeSync, hasDataLayout, isInside, writeConfig } from '../datadir'
import { clearSample, loadSample, sampleStatus } from '../sample/load'
import { renderSamplePapers } from '../sample/render'
import { getRestartPending, setExporting, setRestartPending } from '../restart'

// 一次只做一件「动整个数据」的事
let opActive: string | null = null
async function withOp<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (opActive) throw new Error(`正在${opActive}，请等它结束再操作`)
  opActive = name
  try { return await fn() } finally { opActive = null }
}

const stagingRoot = () => path.join(getDataDir(), '.import-staging')
interface Pending { token: string; dir: string; dbPath: string; filesDir: string; manifest: Manifest; fileName: string }
let pending: Pending | null = null
let dirChoice: { token: string; path: string } | null = null

function discardPending(): void {
  if (!pending) return
  try { fs.rmSync(pending.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 尽力而为 */ }
  pending = null
}

// 进度事件：同一类事件至少隔 150ms 才发一条（解包时每个文件都会报一次，不能把 IPC 淹了）；阶段切换时一定发
let lastProgress = { key: '', at: 0 }
const progress = (payload: Record<string, unknown>) => {
  const key = `${payload.op}:${payload.phase ?? ''}`
  const now = Date.now()
  if (key === lastProgress.key && now - lastProgress.at < 150) return
  lastProgress = { key, at: now }
  getMainWindow()?.webContents.send('data:progress', payload)
}
const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` }
const bytesOf = (f: string) => { try { return fs.statSync(f).size } catch { return 0 } }

const toError = (e: unknown): Error => {
  if (e instanceof PackError) return new Error(e.message)
  return e instanceof Error ? e : new Error(String(e))
}

export function registerDataIpc(): void {
  // 上次没清理的暂存目录（崩溃 / 强杀）启动时一并清掉
  try { fs.rmSync(stagingRoot(), { recursive: true, force: true }) } catch { /* 忽略 */ }

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch, schema: LATEST_SCHEMA, dataDir: getDataDir(),
    // 状态在主进程里：渲染端启动 / 窗口重建时据此重新显示「需要重启」的拦截
    restartPending: !!getRestartPending(), restartTarget: getRestartPending()?.target ?? '', restartOldDir: getRestartPending()?.oldDir ?? ''
  }))
  // 启动时恢复的提示只给一次：取走就在主进程里清掉（页面重载 / 关窗后从 Dock 重开窗口都不会再弹）
  ipcMain.handle('app:takeStartupNotice', async () => takeStartupNotice())
  ipcMain.handle('app:restart', async () => { app.relaunch(); app.exit(0); return true })

  ipcMain.handle('data:info', async () => {
    const dir = getDataDir()
    return {
      dataDir: dir, defaultDir: defaultDir(), custom: !!configuredDir(), restartPending: !!getRestartPending(),
      dbBytes: bytesOf(path.join(dir, 'db.sqlite')), filesBytes: dirSizeSync(getFilesDir()),
      papers: (getDb().prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 0').get() as any).c as number,
      backups: listBackups(dir).map(b => ({ ...b, bytes: dirSizeSync(b.dir) }))
    }
  })

  // ───────── 导出 ─────────
  ipcMain.handle('data:exportPack', async () => withOp('导出数据包', async () => {
    // 后台还在提取 / 解析的试卷，文件可能写到一半：等处理完再导，保证数据包里的页面图和库是一致的
    const busy = busyReason()
    if (busy) throw new Error(busy)
    const win = getMainWindow()
    const opts: Electron.SaveDialogOptions = {
      title: '导出数据包', defaultPath: `英语校考数据包-${stamp()}.ewb.zip`, filters: [{ name: '数据包（.ewb.zip）', extensions: ['zip'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { saved: false }
    let out = r.filePath
    if (!/\.ewb\.zip$/i.test(out)) out = out.replace(/\.zip$/i, '') + '.ewb.zip'
    if (isInside(out, getDataDir())) throw new Error('不能把数据包保存在应用的数据目录里面，请换一个位置')
    const tmpDir = path.join(os.tmpdir(), `ewb-export-${crypto.randomBytes(5).toString('hex')}`)
    setExporting(true)   // 导出期间主进程拒绝会改写试卷文件的请求
    try {
      const res = await buildPack({
        db: getDb(), openDb: openSqlite, filesDir: getFilesDir(), outPath: out, tmpDir, appVersion: app.getVersion(),
        onProgress: p => progress({ op: 'export', ...p })
      })
      return { saved: true, path: res.path, bytes: res.bytes, entries: res.entries, manifest: res.manifest }
    } catch (e) {
      throw toError(e)
    } finally {
      setExporting(false)
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }))

  // ───────── 导入：第一步，选择数据包、安全解包、校验、给出摘要 ─────────
  ipcMain.handle('data:pickPack', async () => withOp('读取数据包', async () => {
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择数据包', filters: [{ name: '数据包（.ewb.zip）', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }], properties: ['openFile'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { picked: false }
    discardPending()
    const token = crypto.randomUUID()
    const dir = path.join(stagingRoot(), token)
    try {
      const ex = await extractPack(r.filePaths[0], dir, { onProgress: p => progress({ op: 'import', phase: 'extract', ...p }) })
      if (ex.manifest.formatVersion > PACK_FORMAT_VERSION || ex.manifest.schemaVersion > LATEST_SCHEMA) {
        throw new PackError('too_new', `这个数据包来自更新版本的软件（数据包格式 v${ex.manifest.formatVersion}、数据库 v${ex.manifest.schemaVersion}，当前软件支持到 v${PACK_FORMAT_VERSION}、v${LATEST_SCHEMA}）。请先把本软件升级到最新版，再导入`)
      }
      progress({ op: 'import', phase: 'check' })
      const info = prepareStagedDb(ex.dbPath, { openDb: openSqlite, migrate: runMigrations, latest: LATEST_SCHEMA })
      const summary = summarizePack({ db: getDb(), dataDir: getDataDir(), filesDir: getFilesDir() }, { dbPath: ex.dbPath, filesDir: ex.filesDir })
      pending = { token, dir, dbPath: ex.dbPath, filesDir: ex.filesDir, manifest: ex.manifest, fileName: path.basename(r.filePaths[0]) }
      return { picked: true, token, fileName: pending.fileName, manifest: ex.manifest, info, summary }
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      throw toError(e)
    }
  }))

  ipcMain.handle('data:discardPack', async (_e, rawToken: unknown) => {
    if (pending && pending.token === z.string().uuid().parse(rawToken)) discardPending()
    return true
  })

  // ───────── 导入：第二步，确认后写入 ─────────
  ipcMain.handle('data:importPack', async (_e, rawToken: unknown, rawMode: unknown) => withOp('导入数据包', async () => {
    const token = z.string().uuid().parse(rawToken)
    const mode = z.enum(['merge', 'overwrite']).parse(rawMode)
    if (!pending || pending.token !== token) throw new Error('这个数据包的读取结果已经失效，请重新选择数据包')
    const busy = busyReason()
    if (busy) throw new Error(busy)
    const deps = { db: getDb(), dataDir: getDataDir(), filesDir: getFilesDir(), fault: process.env.EWB_TEST_FAULT || null }
    const staged = { dbPath: pending.dbPath, filesDir: pending.filesDir }
    try {
      const report = mode === 'merge' ? applyMerge(deps, staged) : applyOverwrite(deps, staged)
      discardPending()
      notifyDataChanged('papers', 'questions', 'pages', 'materials', 'assets', 'taxonomy', 'analysis', 'reports', 'prompts', 'usage', 'queue')
      return report
    } catch (e) {
      discardPending()   // 失败后暂存目录可能处于半用过的状态，不留着；老师重新选一次即可
      throw toError(e)
    }
  }))

  ipcMain.handle('data:deleteBackup', async (_e, rawName: unknown) => {
    const name = z.string().regex(/^pre-import-\d{8}-\d{6}(-[0-9a-f]{4})?$/).parse(rawName)
    fs.rmSync(path.join(backupsRoot(getDataDir()), name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  })
  ipcMain.handle('data:openBackup', async (_e, rawName: unknown) => {
    const name = z.string().regex(/^pre-import-\d{8}-\d{6}(-[0-9a-f]{4})?$/).parse(rawName)
    await shell.openPath(path.join(backupsRoot(getDataDir()), name))
    return true
  })

  // ───────── 更改数据目录 ─────────
  ipcMain.handle('data:chooseDir', async () => {
    const win = getMainWindow()
    const opts: Electron.OpenDialogOptions = { title: '选择新的数据目录（空文件夹，或已有的数据目录）', properties: ['openDirectory', 'createDirectory'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { picked: false }
    // 路径只来自对话框：主进程记下「这个 token 对应哪个目录」，changeDir 只认 token，页面脚本传不进任意路径
    const info = inspectTarget(r.filePaths[0])
    dirChoice = info.ok ? { token: crypto.randomUUID(), path: r.filePaths[0] } : null
    return { picked: true, ...info, token: dirChoice?.token }
  })

  ipcMain.handle('data:changeDir', async (_e, rawToken: unknown, rawMode: unknown) => withOp('更改数据目录', async () => {
    const token = z.string().uuid().parse(rawToken)
    if (!dirChoice || dirChoice.token !== token) throw new Error('这个目录的选择结果已经失效，请重新选择目录')
    const target = dirChoice.path
    const mode = z.enum(['move', 'use']).parse(rawMode)
    const busy = busyReason()
    if (busy) throw new Error(busy)
    const chk = checkTargetDir(getDataDir(), target)
    if (!chk.ok) throw new Error(chk.reason)
    const userData = app.getPath('userData')
    if (mode === 'use') {
      if (chk.kind !== 'existing-data') throw new Error('这个文件夹里没有本软件的数据（需要有 db.sqlite 和 files 文件夹）')
      const bad = existingDirProblem(target)
      if (bad) throw new Error(bad)
      writeConfig(userData, { dataDir: target })
      setRestartPending({ target, oldDir: getDataDir() })
      dirChoice = null
      return { restartRequired: true, mode, target, oldDir: getDataDir() }
    }
    if (chk.kind !== 'empty') throw new Error('要把现有数据迁移过去，目标必须是一个空文件夹（里面已有数据的话请选「使用这个已有数据目录」）')
    const dbFile = path.join(target, 'db.sqlite')
    const filesTarget = path.join(target, 'files')
    const backupsTarget = path.join(target, 'backups')
    try {
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, MIGRATING_MARK), new Date().toISOString())   // 进程在迁移中途被杀时，这个目录不会被当成「已有的数据目录」
      progress({ op: 'move', phase: 'db' })
      getDb().prepare('VACUUM INTO ?').run(dbFile)
      if (process.env.EWB_TEST_FAULT === 'move-after-db') throw new Error('测试注入的故障：复制库之后')   // 仅供自动化测试验证"迁移中途失败不留半截"
      progress({ op: 'move', phase: 'files' })
      const copied = copyDirSync(getFilesDir(), filesTarget, () => { /* 文件多时界面靠阶段文字，不逐个推送 */ })
      // 覆盖导入前的备份也一起带走（M4 复审 P2-8）：否则换了目录就找不到「导入前」的数据了
      const oldBackups = path.join(getDataDir(), 'backups')
      let backupFiles = 0, backupBytes = 0
      if (fs.existsSync(oldBackups)) {
        progress({ op: 'move', phase: 'backups' })
        const b = copyDirSync(oldBackups, backupsTarget, () => undefined)
        backupFiles = b.files; backupBytes = b.bytes
      }
      // 核对：新库能打开、试卷数一致
      const t = openSqlite(dbFile, { readOnly: true })
      try {
        const n = (t.prepare('SELECT COUNT(*) c FROM papers').get() as any).c as number
        const live = (getDb().prepare('SELECT COUNT(*) c FROM papers').get() as any).c as number
        if (n !== live) throw new Error(`迁移后的试卷数（${n}）和现在的（${live}）不一致`)
      } finally { t.close() }
      fs.rmSync(path.join(target, MIGRATING_MARK), { force: true })
      writeConfig(userData, { dataDir: target })
      setRestartPending({ target, oldDir: getDataDir() })
      dirChoice = null
      return { restartRequired: true, mode, target, oldDir: getDataDir(), files: copied.files, bytes: copied.bytes, backupFiles, backupBytes }
    } catch (e) {
      // 失败：把已经写进目标目录的东西清掉（目标原来是空的），配置没有改，继续用原来的目录
      try { fs.rmSync(dbFile, { force: true }); fs.rmSync(`${dbFile}-wal`, { force: true }); fs.rmSync(`${dbFile}-shm`, { force: true }); fs.rmSync(filesTarget, { recursive: true, force: true }); fs.rmSync(backupsTarget, { recursive: true, force: true }); fs.rmSync(path.join(target, MIGRATING_MARK), { force: true }) } catch { /* 尽力而为 */ }
      throw new Error(`迁移没有完成，原来的数据目录没有变化：${(e as Error).message}`)
    }
  }))

  ipcMain.handle('data:resetDir', async () => withOp('恢复默认数据目录', async () => {
    const busy = busyReason()
    if (busy) throw new Error(busy)
    writeConfig(app.getPath('userData'), {})
    setRestartPending({ target: defaultDir(), oldDir: getDataDir() })
    return { restartRequired: true, target: defaultDir(), hasData: hasDataLayout(defaultDir()) }
  }))

  // ───────── 示例数据 ─────────
  ipcMain.handle('data:sampleStatus', async () => sampleStatus(getDb()))
  ipcMain.handle('data:loadSample', async () => withOp('加载示例数据', async () => {
    const r = await loadSample(getDb(), getFilesDir(), renderSamplePapers)
    notifyDataChanged('papers', 'questions', 'pages', 'analysis')
    return r
  }))
  ipcMain.handle('data:clearSample', async () => withOp('清除示例数据', async () => {
    const r = clearSample(getDb(), getFilesDir())
    notifyDataChanged('papers', 'questions', 'pages', 'analysis', 'reports')
    return r
  }))
}

/** 选中的目录能做什么：迁移到这里（空目录）/ 直接使用（已有数据）/ 不行（原因） */
function inspectTarget(target: string): { path: string; ok: boolean; kind?: 'empty' | 'existing-data'; reason?: string; existing?: { papers: number; version: number } } {
  const chk = checkTargetDir(getDataDir(), target)
  if (!chk.ok) return { path: target, ok: false, reason: chk.reason }
  if (chk.kind === 'existing-data') {
    const bad = existingDirProblem(target)
    if (bad) return { path: target, ok: false, reason: bad }
    const t = openSqlite(path.join(target, 'db.sqlite'), { readOnly: true })
    try {
      return { path: target, ok: true, kind: 'existing-data', existing: { papers: (t.prepare('SELECT COUNT(*) c FROM papers').get() as any).c, version: (t.prepare('PRAGMA user_version').get() as any).user_version } }
    } finally { t.close() }
  }
  return { path: target, ok: true, kind: 'empty' }
}

/** 已有数据目录里的数据库能不能用：能打开、没损坏、版本不比本程序新。返回问题说明（没问题返回 null） */
function existingDirProblem(dir: string): string | null {
  let t: any
  try {
    t = openSqlite(path.join(dir, 'db.sqlite'), { readOnly: true })
    const ver = (t.prepare('PRAGMA user_version').get() as any).user_version as number
    if (ver > LATEST_SCHEMA) return `这个数据目录里的数据库来自更新版本的软件（v${ver}，当前软件只支持到 v${LATEST_SCHEMA}），请先升级本软件`
    if (ver < 1) return '这个文件夹里的 db.sqlite 不是本软件的数据库'
    const rows = t.prepare('PRAGMA quick_check').all() as any[]
    if (rows.length !== 1 || String(Object.values(rows[0])[0]) !== 'ok') return '这个数据目录里的数据库没有通过完整性检查，可能已损坏'
    return null
  } catch {
    return '这个数据目录里的数据库无法打开，可能已损坏'
  } finally { try { t?.close() } catch { /* 忽略 */ } }
}
