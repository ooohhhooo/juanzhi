/**
 * 覆盖导入的崩溃保护。
 *
 * 覆盖导入要同时换两样东西：数据库里的行（一个 SQLite 事务）和 files/ 目录（改名）。两者没法放进同一个事务，
 * 所以：先写 journal → 在事务里写库（不提交）→ 改名换目录 → 提交（提交的同一个事务里写了 settings.import_marker = <id>）→ 删 journal。
 * 如果在「换了目录」之后、「提交」之前崩溃：重启时数据库已回滚（没有 marker）、目录却是新的——这里按 journal 把目录换回去。
 * 如果在提交之后、删 journal 之前崩溃：数据库里有 marker，说明已经提交，只需要把 journal 删掉。
 * 判断「提交了没有」只看数据库里的 marker，不靠另一份可能与数据库不同步的记录。
 * 纯函数模块（不依赖 electron），单测直接加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { renameRetry } from './fsretry.ts'

export const JOURNAL_FILE = 'import-journal.json'
export const MARKER_KEY = 'import_marker'

export interface ImportJournal {
  id: string
  /** 活动的 files 目录（内存里是绝对路径，磁盘上存相对数据目录的路径） */
  filesDir: string
  /** 被换下来的旧 files 目录（备份里） */
  backupFilesDir: string
  startedAt: string
}

const journalPath = (dataDir: string) => path.join(dataDir, JOURNAL_FILE)

/** 磁盘上存相对数据目录的路径（把整个数据目录拷到别处、换盘之后，journal 也不会指向旧位置） */
export function writeJournal(dataDir: string, j: ImportJournal): void {
  const rel = (p: string) => path.relative(dataDir, p)
  const tmp = `${journalPath(dataDir)}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, JSON.stringify({ id: j.id, filesRel: rel(j.filesDir), backupFilesRel: rel(j.backupFilesDir), startedAt: j.startedAt })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, journalPath(dataDir))
}

const inside = (dataDir: string, p: string): boolean => {
  const rel = path.relative(path.resolve(dataDir), path.resolve(p))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}
const norm = (rel: string): string => rel.replace(/\\/g, '/').replace(/\/+$/, '')
/** 我们自己写的 journal 只会是这两个位置：活动的 files 目录，和 backups/pre-import-<时间>[-<4 位>]/files（M4 复审 P2-5：比「在数据目录里面」更严） */
const FILES_REL = 'files'
const BACKUP_FILES_REL_RE = /^backups\/pre-import-\d{8}-\d{6}(-[0-9a-f]{4})?\/files$/

export type JournalState = { state: 'none' } | { state: 'ok'; journal: ImportJournal } | { state: 'invalid'; reason: string }

/** 区分「没有 journal」和「有但不认」：后者不能静默忽略（可能是上次导入崩溃留下的，却被改坏 / 写坏了） */
export function inspectJournal(dataDir: string): JournalState {
  let raw: string
  try { raw = fs.readFileSync(journalPath(dataDir), 'utf8') } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'invalid', reason: '读不出来' }
  }
  let j: any
  try { j = JSON.parse(raw) } catch { return { state: 'invalid', reason: '内容不是有效的 JSON' } }
  if (!j || typeof j.id !== 'string' || !/^[0-9a-zA-Z-]{1,64}$/.test(j.id) || typeof j.filesRel !== 'string' || typeof j.backupFilesRel !== 'string') return { state: 'invalid', reason: '缺少必要的字段' }
  if (norm(j.filesRel) !== FILES_REL) return { state: 'invalid', reason: 'files 目录的位置不对' }
  if (!BACKUP_FILES_REL_RE.test(norm(j.backupFilesRel))) return { state: 'invalid', reason: '备份目录的位置不对' }
  const filesDir = path.resolve(dataDir, FILES_REL)
  const backupFilesDir = path.resolve(dataDir, norm(j.backupFilesRel))
  if (!inside(dataDir, filesDir) || !inside(dataDir, backupFilesDir)) return { state: 'invalid', reason: '路径不在数据目录里面' }
  return { state: 'ok', journal: { id: j.id, filesDir, backupFilesDir, startedAt: String(j.startedAt ?? '') } }
}

/** 读回来：只认我们自己写出来的那两种位置（被改过的 journal 不能让恢复动到别的东西） */
export function readJournal(dataDir: string): ImportJournal | null {
  const s = inspectJournal(dataDir)
  return s.state === 'ok' ? s.journal : null
}

export function clearJournal(dataDir: string): void {
  fs.rmSync(journalPath(dataDir), { force: true })
}

/** 把换进来的新 files 目录挪开、把备份里的旧目录换回去。新目录挪到 moveNewTo（让调用方还能重试）；没给就改名成 files.rejected-<id> 后删除 */
export function revertSwap(j: ImportJournal, moveNewTo?: string): string {
  const rejected = moveNewTo ?? `${j.filesDir}.rejected-${j.id}`
  const haveBackup = fs.existsSync(j.backupFilesDir)
  if (!haveBackup) return '备份目录已不存在，保持现状'
  if (fs.existsSync(j.filesDir)) {
    if (moveNewTo) fs.rmSync(moveNewTo, { recursive: true, force: true })
    renameRetry(j.filesDir, rejected)
  }
  renameRetry(j.backupFilesDir, j.filesDir)
  if (!moveNewTo) { try { fs.rmSync(rejected, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 留着也无妨 */ } }
  return '已把 files 目录换回导入之前的'
}

/**
 * 启动时调用（数据库已打开且迁移完成）。返回做了什么（没有未完成的导入时返回 null）。
 * journal 在但不认（内容不合规）→ 改名成 import-journal.invalid-<时间>.json 留作线索，然后抛错让启动流程提示用户；
 * 恢复动作本身失败（文件被占用等）→ 同样抛错，journal 原样留着，下次启动再试。
 */
export function recoverImportJournal(db: any, dataDir: string): string | null {
  const st = inspectJournal(dataDir)
  if (st.state === 'none') return null
  if (st.state === 'invalid') {
    const kept = `${journalPath(dataDir)}.invalid-${Date.now()}`
    try { fs.renameSync(journalPath(dataDir), kept) } catch { /* 留在原处 */ }
    throw new Error(`上次导入留下的恢复记录（import-journal.json）无法识别（${st.reason}），没有做任何自动恢复`)
  }
  const j = st.journal
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(MARKER_KEY) as { value_json: string } | undefined
  let committed = false
  try { committed = !!row && JSON.parse(row.value_json) === j.id } catch { /* 当作没提交 */ }
  let msg: string
  if (committed) {
    msg = '上次导入已提交，清理记录'
  } else {
    msg = `上次导入没有完成（数据库已回滚），${revertSwap(j)}`
  }
  clearJournal(dataDir)
  return msg
}
