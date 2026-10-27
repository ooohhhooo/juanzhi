/**
 * 「未完成草稿」（M6）：P2 / P3 失败（AI 没写完等）时，已经生成的部分存下来，界面里可以查看。
 * 它不是有效结果：不进缓存比对、不进历史报告、不能导出；下次生成成功后自动清掉。
 */
import { getDb } from '../db'
import type { CitationRef } from '../../shared/citation'

export interface Draft {
  key: string
  kind: string
  markdown: string
  refs: CitationRef[]
  message: string
  detail: string
  model: string | null
  createdAt: string
}

const MAX_CHARS = 200_000

export function saveDraft(d: { key: string; kind: string; markdown: string; refs: CitationRef[]; message: string; detail: string; model: string | null }): void {
  const text = d.markdown.slice(0, MAX_CHARS)
  if (!text.trim()) { clearDraft(d.key); return }
  getDb().prepare(`INSERT OR REPLACE INTO ai_drafts (key, kind, markdown, refs_json, message, detail, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
    .run(d.key, d.kind, text, JSON.stringify(d.refs), d.message, d.detail.slice(0, 1000), d.model)
}

export function getDraft(key: string): Draft | null {
  const r = getDb().prepare('SELECT * FROM ai_drafts WHERE key = ?').get(key) as any
  if (!r) return null
  let refs: CitationRef[] = []
  try { refs = JSON.parse(r.refs_json) } catch { /* 忽略 */ }
  return { key: r.key, kind: r.kind, markdown: r.markdown, refs, message: r.message ?? '', detail: r.detail ?? '', model: r.model, createdAt: r.created_at }
}

export function clearDraft(key: string): void {
  getDb().prepare('DELETE FROM ai_drafts WHERE key = ?').run(key)
}
