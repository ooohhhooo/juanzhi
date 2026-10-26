/**
 * 导出数据包（.ewb.zip）：
 *   manifest.json   —— 格式 / schema 版本 / 导出时间 / 卷数等
 *   db.sqlite       —— `VACUUM INTO` 做出的一致快照，再去掉不该带走的东西
 *   files/<paperId>/{original.*, page-n.png, media/n.*}
 *
 * 不进包的东西：
 *   · API 密钥和 safeStorage 的密文，以及 AI 服务配置（地址 / 模型）、数据目录、首次启动状态——settings 表只留白名单里的几项（manifest.ts）；
 *     删完之后再 VACUUM INTO 一次（并开 secure_delete），保证被删的内容不会还留在数据库文件的空闲页里；
 *   · 示例数据：is_sample = 1 的试卷和它们的文件，以及基于示例数据筛选生成的报告和 P2 分析缓存；
 *   · 「上次核对结论」（属于这台电脑当时的数据修订号，带走没有意义）。
 * zip 用纯 JS 的 yazl，流式写出（不把整个数据包读进内存）；先写 .part 再改名，失败不会留下半截的数据包；写完用 yauzl 重新打开核对条目数。
 */
import fs from 'node:fs'
import path from 'node:path'
import yazl from 'yazl'
import yauzl from 'yauzl'
import { PackError } from './errors.ts'
import { classifyEntry } from './names.ts'
import { PACK_FORMAT, PACK_FORMAT_VERSION, PACK_SETTING_KEYS } from './manifest.ts'
import type { Manifest } from './manifest.ts'
import type { OpenDb } from './stage-db.ts'

export interface ExportDeps {
  db: any
  openDb: OpenDb
  filesDir: string
  /** 输出文件；先写 <outPath>.part 再改名 */
  outPath: string
  tmpDir: string
  appVersion: string
  platform?: string
  now?: Date
  onProgress?: (p: { phase: 'snapshot' | 'zip' | 'verify'; bytes: number; total: number }) => void
}

export interface ExportResult { manifest: Manifest; bytes: number; entries: number; path: string }

const rmAll = (...files: string[]) => { for (const f of files) for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(f + suffix, { force: true }) } catch { /* 忽略 */ } } }

/** 做出「干净」的数据库快照（不含密钥 / 示例数据），返回路径和统计 */
export function makeCleanSnapshot(deps: Pick<ExportDeps, 'db' | 'openDb' | 'tmpDir'>): { file: string; papers: number; questions: number; pages: number; schemaVersion: number; paperIds: string[] } {
  fs.mkdirSync(deps.tmpDir, { recursive: true })
  const step1 = path.join(deps.tmpDir, 'snapshot-1.sqlite')
  const final = path.join(deps.tmpDir, 'snapshot.sqlite')
  rmAll(step1, final)
  deps.db.prepare('VACUUM INTO ?').run(step1)
  let info: { papers: number; questions: number; pages: number; schemaVersion: number; paperIds: string[] }
  const s = deps.openDb(step1)
  try {
    s.exec('PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE')
    s.exec('DELETE FROM papers WHERE is_sample = 1')
    // 示例数据派生的东西也不带走：基于示例筛选生成的 P3 报告、P2 分析缓存（它们引用的是示例卷的题目）
    s.exec(`DELETE FROM reports WHERE COALESCE(filter_json, '') LIKE '%"sample":true%'`)
    s.exec(`DELETE FROM ai_analyses WHERE COALESCE(scope_json, '') LIKE '%"sample":true%'`)
    const keep = PACK_SETTING_KEYS.map(k => `'${k}'`).join(',')
    s.exec(`DELETE FROM settings WHERE key NOT IN (${keep})`)
    s.exec('UPDATE ai_analyses SET checked_rev = NULL, checked_sig = NULL, checked_json = NULL')
    s.exec('UPDATE reports SET checked_rev = NULL, checked_sig = NULL, checked_json = NULL')
    const c = (sql: string) => (s.prepare(sql).get() as any).c as number
    info = {
      papers: c('SELECT COUNT(*) c FROM papers'), questions: c('SELECT COUNT(*) c FROM questions'), pages: c('SELECT COUNT(*) c FROM pages'),
      schemaVersion: (s.prepare('PRAGMA user_version').get() as any).user_version,
      paperIds: (s.prepare('SELECT id FROM papers').all() as any[]).map(r => r.id as string)
    }
    s.prepare('VACUUM INTO ?').run(final)   // 重新整理一份：被删掉的行不会残留在空闲页里
  } finally {
    try { s.close() } catch { /* 已关闭 */ }
  }
  rmAll(step1)
  return { file: final, ...info }
}

interface FileItem { abs: string; name: string; size: number }

/** 某份试卷的文件（只收白名单里的：原件、页面图、docx 附件） */
function listPaperFiles(filesDir: string, paperId: string): FileItem[] {
  const out: FileItem[] = []
  const base = path.join(filesDir, paperId)
  const add = (rel: string) => {
    const name = `files/${paperId}/${rel}`
    if (!classifyEntry(name)) return
    const abs = path.join(base, ...rel.split('/'))
    try { const st = fs.statSync(abs); if (st.isFile()) out.push({ abs, name, size: st.size }) } catch { /* 刚被删掉 */ }
  }
  let top: string[] = []
  try { top = fs.readdirSync(base) } catch { return out }
  for (const f of top) add(f)
  try { for (const f of fs.readdirSync(path.join(base, 'media'))) add(`media/${f}`) } catch { /* 没有 media */ }
  return out
}

export async function buildPack(deps: ExportDeps): Promise<ExportResult> {
  const now = deps.now ?? new Date()
  const snap = makeCleanSnapshot(deps)
  deps.onProgress?.({ phase: 'snapshot', bytes: 0, total: 0 })
  const files: FileItem[] = []
  for (const id of snap.paperIds) files.push(...listPaperFiles(deps.filesDir, id))
  const dbSize = fs.statSync(snap.file).size
  const manifest: Manifest = {
    format: PACK_FORMAT, formatVersion: PACK_FORMAT_VERSION, schemaVersion: snap.schemaVersion, appVersion: deps.appVersion,
    exportedAt: now.toISOString(), paperCount: snap.papers, questionCount: snap.questions, pageCount: snap.pages, fileCount: files.length,
    platform: deps.platform ?? process.platform
  }
  const total = dbSize + files.reduce((n, f) => n + f.size, 0)
  const part = `${deps.outPath}.part`
  fs.mkdirSync(path.dirname(deps.outPath), { recursive: true })
  try {
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json')
    zip.addFile(snap.file, 'db.sqlite', { compress: true })
    // 原件 / 页面图本身已经是压缩格式（pdf、png、jpg、docx、heic），再压一遍没收益只费时间
    for (const f of files) zip.addFile(f.abs, f.name, { compress: false })
    zip.end()
    let written = 0
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(part)
      let failed = false
      // 任何一路出错都要：只 reject 一次、拆掉管道、销毁写出流（否则 .part 的句柄不释放，Windows 上删不掉）
      const fail = (e: unknown) => {
        if (failed) return
        failed = true
        try { zip.outputStream.unpipe(out) } catch { /* 忽略 */ }
        out.destroy()
        reject(e)
      }
      // 读文件失败（被占用 / 刚被删 / 权限）是发在 ZipFile 上的 'error'，不在 outputStream 上；漏掉它会变成主进程未捕获异常 + 这个 Promise 永不结束
      zip.on('error', fail)
      zip.outputStream.on('data', (c: Buffer) => { written += c.length; deps.onProgress?.({ phase: 'zip', bytes: Math.min(written, total), total }) })
      zip.outputStream.on('error', fail)
      out.on('error', fail)
      out.on('close', () => { if (!failed) resolve() })
      zip.outputStream.pipe(out)
    })
    fs.renameSync(part, deps.outPath)
  } catch (e) {
    try { fs.rmSync(part, { force: true }) } catch { /* 忽略 */ }
    rmAll(snap.file)
    const code = (e as NodeJS.ErrnoException).code
    throw new PackError('io', code === 'ENOSPC' ? '磁盘空间不足，数据包没有导出' : code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ? '没有写入权限，或文件正被其他程序占用，数据包没有导出' : `导出失败：${(e as Error).message}`)
  }
  rmAll(snap.file)

  // 核对：重新打开写出的 zip，条目数 = manifest + db + 文件数
  deps.onProgress?.({ phase: 'verify', bytes: total, total })
  const entries = await countEntries(deps.outPath)
  if (entries !== 2 + files.length) {
    try { fs.rmSync(deps.outPath, { force: true }) } catch { /* 忽略 */ }
    throw new PackError('io', `导出的数据包没通过核对（应有 ${2 + files.length} 个文件，实际 ${entries} 个），已删除，请重试`)
  }
  return { manifest, bytes: fs.statSync(deps.outPath).size, entries, path: deps.outPath }
}

function countEntries(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) => {
      if (err || !z) { reject(new PackError('io', '导出的数据包无法重新打开')); return }
      let n = 0
      z.on('entry', () => { n++; z.readEntry() })
      z.on('end', () => resolve(n))
      z.on('error', () => reject(new PackError('io', '导出的数据包无法重新读取')))
      z.readEntry()
    })
  })
}
