import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb, getDataDir, getFilesDir } from '../db'
import { extractPaper, findOriginal, removeDerivedFiles } from './extract'
import { notifyDataChanged, sendProgress } from '../events'
import { isPathAllowed } from '../allowedPaths'
import type { ImportResult } from '../types'

const SUPPORTED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.docx']
// PDF 整本以 base64 塞进 executeJavaScript 字符串，V8 字符串有上限，所以不能放太大的文件
const MAX_FILE_BYTES = 150 * 1024 * 1024

const waiting: string[] = []
let running = false
let importChain: Promise<unknown> = Promise.resolve()

function removePaperFiles(paperId: string): void {
  try {
    fs.rmSync(path.join(getFilesDir(), paperId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (e) {
    console.warn(`[queue] 清理文件失败: ${(e as Error).message}`)
  }
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (waiting.length > 0) {
      const paperId = waiting.shift()!
      try {
        await extractPaper(paperId, sendProgress)
      } catch (e) {
        console.warn(`[queue] 提取失败 ${paperId}: ${(e as Error).message}`)
      }
      notifyDataChanged('papers', 'pages', 'assets')
    }
  } finally {
    running = false
  }
}

export function isQueued(paperId: string): boolean {
  return waiting.includes(paperId)
}

async function checkImportable(filePath: string): Promise<string> {
  const fileName = path.basename(filePath)
  if (fileName.startsWith('._')) throw new Error('已跳过 AppleDouble 临时文件')
  if (!path.isAbsolute(filePath)) throw new Error('文件路径无效')

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.doc') throw new Error('不支持 .doc 格式，请先用 Word 另存为 .docx')
  if (!SUPPORTED_EXT.includes(ext)) throw new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`)

  if (!isPathAllowed(filePath)) {
    throw new Error('该文件未经授权：只能导入通过「导入试卷」对话框选择、或拖入窗口的文件')
  }

  const resolved = path.resolve(filePath)
  if (resolved.startsWith(path.resolve(getDataDir()) + path.sep)) throw new Error('不能导入应用数据目录内的文件')

  const st = await fsp.stat(resolved).catch(() => null)
  if (!st || !st.isFile()) throw new Error('文件不存在或不是普通文件')
  if (st.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，已拒绝`)
  return ext
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('data', c => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

async function registerOne(filePath: string, allowDup: boolean): Promise<ImportResult> {
  const db = getDb()
  const fileName = path.basename(filePath)
  try {
    const ext = await checkImportable(filePath)
    const hash = await hashFile(filePath)

    const same = db.prepare('SELECT id, title, file_name, status FROM papers WHERE file_hash = ?').all(hash) as any[]
    // 上次提取失败的同一文件：清掉旧记录，允许直接重新导入
    for (const f of same.filter(r => r.status === 'failed')) {
      db.prepare('DELETE FROM papers WHERE id = ?').run(f.id)
      removePaperFiles(f.id)
    }
    const live = same.find(r => r.status !== 'failed')
    if (live && !allowDup) {
      return {
        path: filePath, fileName, code: 'duplicate',
        error: `内容与已有试卷「${live.title || live.file_name}」完全相同`,
        duplicateOf: { id: live.id, title: live.title || live.file_name }
      }
    }

    const paperId = crypto.randomUUID()
    const paperDir = path.join(getFilesDir(), paperId)
    await fsp.mkdir(paperDir, { recursive: true })
    try {
      await fsp.copyFile(filePath, path.join(paperDir, `original${ext}`))
      db.prepare(`INSERT INTO papers (id, title, file_name, file_hash, status, duplicate_of) VALUES (?, ?, ?, ?, 'imported', ?)`)
        .run(paperId, fileName.replace(/\.[^.]+$/, ''), fileName, hash, live ? live.id : null)
    } catch (e) {
      removePaperFiles(paperId)
      throw e
    }

    waiting.push(paperId)
    return { path: filePath, fileName, paperId }
  } catch (err) {
    return { path: filePath, fileName, error: (err as Error).message }
  }
}

/**
 * 登记一批文件：复制原件、写入 imported 行并入队，登记完就返回；真正的提取在后台串行执行。
 * 内容相同的文件默认不导入，返回 code='duplicate'，由界面确认后用 allowDuplicates 重新调用。
 */
export function registerImports(paths: string[], opts?: { allowDuplicates?: string[] }): Promise<ImportResult[]> {
  const allow = new Set(opts?.allowDuplicates ?? [])
  const job = importChain.then(async () => {
    const results: ImportResult[] = []
    for (const p of paths) results.push(await registerOne(p, allow.has(p)))
    notifyDataChanged('papers')
    void drain()
    return results
  })
  importChain = job.catch(() => undefined)
  return job
}

/** 重新提取：清掉旧页面、附件与渲染图，从原件重来 */
export function reprocessPaper(paperId: string): void {
  const db = getDb()
  const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(paperId)
  if (!paper) throw new Error('试卷不存在')
  if (paper.status === 'extracting' || isQueued(paperId)) throw new Error('试卷正在处理中')
  const paperDir = path.join(getFilesDir(), paperId)
  if (!findOriginal(paperDir)) throw new Error('找不到原始文件，请删除后重新导入')

  db.prepare('DELETE FROM pages WHERE paper_id = ?').run(paperId)
  db.prepare('DELETE FROM paper_assets WHERE paper_id = ?').run(paperId)
  removeDerivedFiles(paperDir)
  db.prepare(`UPDATE papers SET status = 'imported', error = NULL, warning = NULL, page_count = 0, extracted_at = NULL WHERE id = ?`).run(paperId)
  waiting.push(paperId)
  notifyDataChanged('papers', 'pages', 'assets')
  void drain()
}

/** 启动时：上次被强杀/崩溃留下的 extracting / imported 一律标成失败，用户可点「重试」 */
export function recoverInterruptedPapers(): void {
  const db = getDb()
  const r = db.prepare(
    "UPDATE papers SET status = 'failed', error = '上次提取被中断，请点击「重试」' WHERE status IN ('extracting', 'imported')"
  ).run()
  if (r.changes > 0) console.log(`[queue] 已把 ${r.changes} 份中断的试卷标记为失败`)
}
