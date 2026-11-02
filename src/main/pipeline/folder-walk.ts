/**
 * 拖入 / 选择文件夹时的递归扫描（不依赖 electron，单测直接加载）。
 * 只收支持的试卷文件；跳过 macOS 的 ._ 临时文件、隐藏文件和隐藏文件夹、不支持的类型，并记下原因，导入前给用户确认。
 */
import fs from 'node:fs'
import path from 'node:path'

export const FOLDER_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.docx']
export const FOLDER_MAX_DEPTH = 8
export const FOLDER_MAX_FILES = 2000
/** 一次最多看多少个条目（文件和文件夹），防止扫到整个磁盘 */
export const FOLDER_MAX_VISITED = 50000
/** 跳过清单最多记多少条，其余只给个数 */
export const FOLDER_MAX_SKIPPED = 200

export interface SkippedFile { name: string; reason: string }
export interface FolderScan {
  files: string[]
  skipped: SkippedFile[]
  /** 超出清单上限、没有逐条记下的跳过个数 */
  skippedMore: number
  /** 超过文件数上限而没继续扫描 */
  truncated: boolean
}

/** 隐藏文件：以 . 开头（包含 macOS 的 ._ 和 .DS_Store）；Windows 的 Thumbs.db 等系统文件也算 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name) || name.startsWith('~$')
}

export function walkFolder(root: string, opts: { maxDepth?: number; maxFiles?: number; maxVisited?: number } = {}): FolderScan {
  const maxDepth = opts.maxDepth ?? FOLDER_MAX_DEPTH
  const maxFiles = opts.maxFiles ?? FOLDER_MAX_FILES
  const maxVisited = opts.maxVisited ?? FOLDER_MAX_VISITED
  const out: FolderScan = { files: [], skipped: [], skippedMore: 0, truncated: false }
  let visited = 0
  const skip = (name: string, reason: string) => { if (out.skipped.length < FOLDER_MAX_SKIPPED) out.skipped.push({ name, reason }); else out.skippedMore++ }

  const visit = (dir: string, depth: number): void => {
    if (out.truncated) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { skip(path.basename(dir), '文件夹打不开'); return }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    for (const e of entries) {
      if (out.truncated) return
      if (++visited > maxVisited) { out.truncated = true; return }
      const full = path.join(dir, e.name)
      if (isHiddenName(e.name)) { if (!e.isDirectory()) skip(e.name, e.name.startsWith('._') ? 'macOS 临时文件' : '隐藏或系统文件'); continue }
      if (e.isSymbolicLink()) { skip(e.name, '快捷方式 / 链接'); continue }
      if (e.isDirectory()) {
        if (depth >= maxDepth) { skip(e.name, `文件夹层级太深（最多 ${maxDepth} 层）`); continue }
        visit(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (ext === '.doc') { skip(e.name, '不支持 .doc，请先另存为 .docx'); continue }
      if (!FOLDER_EXTS.includes(ext)) { skip(e.name, `不支持的类型 ${ext || '（无扩展名）'}`); continue }
      if (out.files.length >= maxFiles) { out.truncated = true; return }
      out.files.push(full)
    }
  }
  visit(root, 0)
  return out
}
