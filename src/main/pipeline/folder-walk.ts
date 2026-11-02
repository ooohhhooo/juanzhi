/**
 * 拖入 / 选择文件夹时的递归扫描（不依赖 electron，单测直接加载）。
 * 只收支持的试卷文件；跳过 macOS 的 ._ 临时文件、隐藏文件和隐藏文件夹、不支持的类型，并记下原因，导入前给用户确认。
 */
import fs from 'node:fs'
import path from 'node:path'

export const FOLDER_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.docx']
export const FOLDER_MAX_DEPTH = 8
export const FOLDER_MAX_FILES = 2000

export interface SkippedFile { name: string; reason: string }
export interface FolderScan {
  files: string[]
  skipped: SkippedFile[]
  /** 超过文件数上限而没继续扫描 */
  truncated: boolean
}

/** 隐藏文件：以 . 开头（包含 macOS 的 ._ 和 .DS_Store）；Windows 的 Thumbs.db 等系统文件也算 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name) || name.startsWith('~$')
}

export function walkFolder(root: string, opts: { maxDepth?: number; maxFiles?: number } = {}): FolderScan {
  const maxDepth = opts.maxDepth ?? FOLDER_MAX_DEPTH
  const maxFiles = opts.maxFiles ?? FOLDER_MAX_FILES
  const out: FolderScan = { files: [], skipped: [], truncated: false }

  const visit = (dir: string, depth: number): void => {
    if (out.truncated) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { out.skipped.push({ name: path.basename(dir), reason: '文件夹打不开' }); return }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    for (const e of entries) {
      if (out.truncated) return
      const full = path.join(dir, e.name)
      if (isHiddenName(e.name)) { if (!e.isDirectory()) out.skipped.push({ name: e.name, reason: e.name.startsWith('._') ? 'macOS 临时文件' : '隐藏或系统文件' }); continue }
      if (e.isSymbolicLink()) { out.skipped.push({ name: e.name, reason: '快捷方式 / 链接' }); continue }
      if (e.isDirectory()) {
        if (depth >= maxDepth) { out.skipped.push({ name: e.name, reason: `文件夹层级太深（最多 ${maxDepth} 层）` }); continue }
        visit(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (ext === '.doc') { out.skipped.push({ name: e.name, reason: '不支持 .doc，请先另存为 .docx' }); continue }
      if (!FOLDER_EXTS.includes(ext)) { out.skipped.push({ name: e.name, reason: `不支持的类型 ${ext || '（无扩展名）'}` }); continue }
      if (out.files.length >= maxFiles) { out.truncated = true; return }
      out.files.push(full)
    }
  }
  visit(root, 0)
  return out
}
