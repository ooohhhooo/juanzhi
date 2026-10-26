/**
 * 数据目录：位置由 userData 下的 ewb-config.json 决定（不能存在数据库里——数据库本身就在数据目录里）。
 * 纯函数模块（不依赖 electron），单测直接加载。
 *
 * 更改数据目录的校验规则（设置页「更改数据目录」）：
 *  - 目标必须能写（真的建一个临时文件试）；
 *  - 不能就是当前目录；不能在当前数据目录内部（会把数据套进自己里面）；也不能是当前数据目录的上级
 *    （那样当前目录就在新目录里面，`files/` 和 `db.sqlite` 会和它的内容混在一起）；
 *  - 迁移到新目录：目标必须是空目录（或不存在）；
 *  - 选择已有数据目录：目标里必须有 db.sqlite 和 files/，数据库能打开、版本不比本程序新。
 * 路径比较先取真实路径（解开符号链接），并在 macOS / Windows 上不区分大小写。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const CONFIG_FILE = 'ewb-config.json'
export const DEFAULT_DIR_NAME = 'workbench-data'
/** 迁移进行中的标记：写在目标目录里，迁移成功后才删。进程被杀留下半截数据时，这个目录不会被当成「已有的数据目录」 */
export const MIGRATING_MARK = '.migrating'

export interface DataDirConfig { dataDir?: string }

export function readConfig(userData: string): DataDirConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userData, CONFIG_FILE), 'utf8'))
    if (raw && typeof raw === 'object' && typeof raw.dataDir === 'string' && path.isAbsolute(raw.dataDir)) return { dataDir: raw.dataDir }
  } catch { /* 没有或损坏：用默认位置 */ }
  return {}
}

/** 原子写：先写临时文件再改名，崩溃时不会留下半截配置 */
export function writeConfig(userData: string, cfg: DataDirConfig): void {
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, CONFIG_FILE)
  if (!cfg.dataDir) { fs.rmSync(file, { force: true }); return }
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ dataDir: cfg.dataDir }, null, 2))
  fs.renameSync(tmp, file)
}

export const defaultDataDir = (userData: string): string => path.join(userData, DEFAULT_DIR_NAME)

export function configuredDataDir(userData: string): string | null {
  return readConfig(userData).dataDir ?? null
}

/** 取真实路径：路径不存在时取最近的、存在的上级的真实路径，再接上剩下的部分 */
export function realish(p: string): string {
  const abs = path.resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

const foldCase = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)

/** a 是不是 b 本身或在 b 里面 */
export function isInside(a: string, b: string): boolean {
  const A = foldCase(realish(a)), B = foldCase(realish(b))
  if (A === B) return true
  const rel = path.relative(B, A)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function isSamePath(a: string, b: string): boolean {
  return foldCase(realish(a)) === foldCase(realish(b))
}

/** 能不能在目录里建文件（真的试一次；只读目录、没权限、磁盘满都会失败） */
export function isWritableDir(dir: string): { ok: boolean; reason?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.ewb-write-test-${crypto.randomBytes(4).toString('hex')}`)
    fs.writeFileSync(probe, 'x')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EROFS' ? '这个目录没有写入权限（可能是只读目录或系统保护的位置）' : `这个目录不能写入：${(e as Error).message}` }
  }
}

export type TargetKind = 'empty' | 'existing-data'
export type TargetCheck = { ok: true; kind: TargetKind } | { ok: false; reason: string }

/** 迁移 / 切换目标的位置校验（不含「已有数据目录」里数据库的检查，那个要打开数据库，在 hasDataLayout / 调用方做） */
export function checkTargetDir(currentDir: string, target: string): TargetCheck {
  if (!target || !path.isAbsolute(target)) return { ok: false, reason: '请选择一个完整的目录路径' }
  if (isSamePath(currentDir, target)) return { ok: false, reason: '这就是当前正在使用的数据目录' }
  if (isInside(target, currentDir)) return { ok: false, reason: '不能选当前数据目录里面的文件夹（数据会套进它自己里面）' }
  if (isInside(currentDir, target)) return { ok: false, reason: '不能选当前数据目录的上级文件夹（新目录会把当前目录包在里面，两边的内容会混在一起）' }
  let st: fs.Stats | null = null
  try { st = fs.statSync(target) } catch { /* 不存在：稍后会建 */ }
  if (st && !st.isDirectory()) return { ok: false, reason: '选中的路径是一个文件，不是文件夹' }
  const w = isWritableDir(target)
  if (!w.ok) return { ok: false, reason: w.reason! }
  if (fs.existsSync(path.join(target, MIGRATING_MARK))) return { ok: false, reason: '这个文件夹里有一次没有完成的数据迁移留下的半截数据，不能使用。请先把里面的内容清空（或换一个文件夹）' }
  if (hasDataLayout(target)) return { ok: true, kind: 'existing-data' }
  const entries = fs.readdirSync(target).filter(n => n !== '.DS_Store' && !n.startsWith('._') && n !== 'Thumbs.db')
  if (entries.length > 0) return { ok: false, reason: '这个文件夹不是空的，也不是本软件的数据目录。请新建一个空文件夹，或选择已有的数据目录' }
  return { ok: true, kind: 'empty' }
}

/** 目录里有没有本软件的数据（db.sqlite 与 files/） */
export function hasDataLayout(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, MIGRATING_MARK))) return false
    return fs.statSync(path.join(dir, 'db.sqlite')).isFile() && fs.statSync(path.join(dir, 'files')).isDirectory()
  } catch { return false }
}

/** 递归复制目录（迁移 files/ 用）；不跟随符号链接，遇到符号链接直接跳过（数据目录里本来不会有） */
export function copyDirSync(src: string, dest: string, onFile?: (bytes: number) => void): { files: number; bytes: number } {
  let files = 0, bytes = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name)
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory()) {
      const r = copyDirSync(s, d, onFile)
      files += r.files; bytes += r.bytes
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d)
      const n = fs.statSync(d).size
      files++; bytes += n
      onFile?.(n)
    }
  }
  return { files, bytes }
}

export function dirSizeSync(dir: string): number {
  let n = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) n += dirSizeSync(p)
      else if (ent.isFile()) n += fs.statSync(p).size
    }
  } catch { /* 目录不存在 */ }
  return n
}
