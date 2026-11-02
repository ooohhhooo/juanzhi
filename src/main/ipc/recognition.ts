/**
 * 识别方式与截图位置的只读查询（M9 beta.1 A 部分）：
 *  - papers:diag：每页用了什么识别、为什么、识别质量；有多少道题还没在原卷上框出位置（试卷详情、审核页、试卷库标签用）
 *  - os:openLanguageSettings：打开 Windows 语言设置（只允许这一个固定地址，不接受渲染端传入）
 */
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { OCR_TUTORIAL_URL } from '../../shared/recognizer-text'

const UuidSchema = z.string().uuid()

/** 唯一允许打开的系统地址 */
export const LANGUAGE_SETTINGS_URI = 'ms-settings:regionlanguage'

export interface PaperDiag {
  paperId: string
  /** 这台电脑的系统（win32 / darwin）：「怎么安装中文识别」只在 Windows 上出现 */
  platform: string
  pages: Array<{ idx: number; recognizer: string | null; ocrLang: string | null; reason: string | null; low: boolean; hasImage: boolean }>
  /** 有本机识别不好、又没改用 AI 读图的页 */
  incomplete: boolean
  /** 是否有页用的是非中文的 Windows 识别引擎（需要装中文语言包） */
  needsZhPack: boolean
  locate: {
    total: number
    located: number
    /** 还没框出位置的题（只算有页面图的页上的题） */
    missing: Array<{ id: string; no: string; page: number | null }>
    /** 这份卷子根本没有页面图（Word 渲染失败的旧数据），没法框 */
    noImage: boolean
  }
}

export function paperDiag(paperId: string): PaperDiag {
  const db = getDb()
  const pages = db.prepare('SELECT idx, image_rel, recognizer, ocr_lang, rec_reason, quality_json FROM pages WHERE paper_id = ? ORDER BY idx').all(paperId) as any[]
  const qs = db.prepare('SELECT id, no_label, no, page_idx, bbox_json FROM questions WHERE paper_id = ? ORDER BY ord').all(paperId) as any[]
  const out: PaperDiag['pages'] = pages.map(p => {
    // 只是置信度偏低（low-conf）不算「识别可能不完整」：macOS 的置信度整体偏低，只用来决定要不要读图
    let low = false
    try { const q = p.quality_json ? JSON.parse(p.quality_json) : null; low = !!(q && q.low && q.why !== 'low-conf') } catch { /* 损坏的记录当作没有 */ }
    return { idx: p.idx, recognizer: p.recognizer ?? null, ocrLang: p.ocr_lang ?? null, reason: p.rec_reason ?? null, low, hasImage: !!p.image_rel }
  })
  const withImage = new Set(out.filter(p => p.hasImage).map(p => p.idx))
  const noBox = (q: any) => { try { const b = q.bbox_json ? JSON.parse(q.bbox_json) : null; return !(Array.isArray(b) && b.length === 4 && b[2] > 0 && b[3] > 0) } catch { return true } }
  const missing = qs.filter(q => noBox(q) && q.page_idx != null && withImage.has(q.page_idx))
    .map(q => ({ id: q.id as string, no: String(q.no_label ?? q.no ?? ''), page: q.page_idx as number | null }))
  const zhPack = out.some(p => p.recognizer === 'win-ocr' && !!p.ocrLang && !/^zh/i.test(p.ocrLang))
  return {
    paperId, platform: process.platform, pages: out,
    incomplete: out.some(p => p.low && p.recognizer !== 'vision-model'),
    needsZhPack: zhPack,
    locate: { total: qs.length, located: qs.length - qs.filter(noBox).length, missing, noImage: pages.length > 0 && withImage.size === 0 }
  }
}

export function registerRecognitionIpc(): void {
  ipcMain.handle('papers:diag', async (_e, rawId: unknown) => paperDiag(UuidSchema.parse(rawId)))

  ipcMain.handle('os:openLanguageSettings', async () => {
    if (process.platform !== 'win32') return false
    await shell.openExternal(LANGUAGE_SETTINGS_URI)
    return true
  })

  // 打开「怎么安装中文识别」的完整教程（固定地址，不接受渲染端传入）
  ipcMain.handle('os:openOcrTutorial', async () => {
    await shell.openExternal(OCR_TUTORIAL_URL)
    return true
  })
}
