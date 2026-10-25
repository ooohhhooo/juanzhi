import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb, getDataDir, getFilesDir } from '../db'
import { extractPaper, findOriginal, removePageImages } from './extract'
import { notifyDataChanged, sendProgress } from '../events'
import type { ImportResult } from '../types'

const SUPPORTED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.docx']
const MAX_FILE_BYTES = 500 * 1024 * 1024

const waiting: string[] = []
let running = false

function removePaperFiles(paperId: string): void {
  try {
    fs.rmSync(path.join(getFilesDir(), paperId), { recursive: true, force: true })
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
      notifyDataChanged('papers', 'pages')
    }
  } finally {
    running = false
  }
}

export function isQueued(paperId: string): boolean {
  return waiting.includes(paperId)
}

function checkImportable(filePath: string): string {
  const fileName = path.basename(filePath)
  if (fileName.startsWith('._')) throw new Error('已跳过 AppleDouble 临时文件')
  if (!path.isAbsolute(filePath)) throw new Error('文件路径无效')

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.doc') throw new Error('不支持 .doc 格式，请先用 Word 另存为 .docx')
  if (!SUPPORTED_EXT.includes(ext)) throw new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`)

  const resolved = path.resolve(filePath)
  if (resolved.startsWith(path.resolve(getDataDir()) + path.sep)) throw new Error('不能导入应用数据目录内的文件')

  const st = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!st || !st.isFile()) throw new Error('文件不存在或不是普通文件')
  if (st.size > MAX_FILE_BYTES) throw new Error('文件超过 500MB，已拒绝')
  return ext
}

/** 登记一批文件：复制原件、写入 imported 行并入队，立即返回；真正的提取在后台串行执行。 */
export function registerImports(paths: string[]): ImportResult[] {
  const db = getDb()
  const results: ImportResult[] = []

  for (const filePath of paths) {
    const fileName = path.basename(filePath)
    try {
      const ext = checkImportable(filePath)
      const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

      const dup = db.prepare('SELECT id, title, file_name, status FROM papers WHERE file_hash = ?').get(hash)
      if (dup) {
        if (dup.status !== 'failed') {
          throw new Error(`重复导入：该文件已存在（${dup.title || dup.file_name}）`)
        }
        // 上次提取失败的同一文件：清掉旧记录，允许重新导入
        db.prepare('DELETE FROM papers WHERE id = ?').run(dup.id)
        removePaperFiles(dup.id)
      }

      const paperId = crypto.randomUUID()
      const paperDir = path.join(getFilesDir(), paperId)
      fs.mkdirSync(paperDir, { recursive: true })
      try {
        fs.copyFileSync(filePath, path.join(paperDir, `original${ext}`))
        db.prepare(`INSERT INTO papers (id, title, file_name, file_hash, status) VALUES (?, ?, ?, ?, 'imported')`)
          .run(paperId, fileName.replace(/\.[^.]+$/, ''), fileName, hash)
      } catch (e) {
        removePaperFiles(paperId)
        throw e
      }

      waiting.push(paperId)
      results.push({ path: filePath, fileName, paperId })
    } catch (err) {
      results.push({ path: filePath, fileName, error: (err as Error).message })
    }
  }

  notifyDataChanged('papers')
  void drain()
  return results
}

/** 重新提取：清掉旧页面与渲染图，从原件重来 */
export function reprocessPaper(paperId: string): void {
  const db = getDb()
  const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(paperId)
  if (!paper) throw new Error('试卷不存在')
  if (paper.status === 'extracting' || isQueued(paperId)) throw new Error('试卷正在处理中')
  const paperDir = path.join(getFilesDir(), paperId)
  if (!findOriginal(paperDir)) throw new Error('找不到原始文件，请删除后重新导入')

  db.prepare('DELETE FROM pages WHERE paper_id = ?').run(paperId)
  removePageImages(paperDir)
  db.prepare("UPDATE papers SET status = 'imported', error = NULL, page_count = 0, extracted_at = NULL WHERE id = ?").run(paperId)
  waiting.push(paperId)
  notifyDataChanged('papers', 'pages')
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
