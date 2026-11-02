/**
 * 知识点 → 课次 的 AI 匹配：提示词输入的拼装、回答的校验、与已有人工结果的合并。纯函数模块。
 *
 * 防幻觉（M9 §1.6）：
 *  1. 回答里的课次必须是输入里出现过的 id，否则丢弃；
 *  2. quote（课次文本里的原文片段）必须逐字出现在该课次的文本里（忽略空白和大小写），找不到就降为 low 并标「仅凭主题推测」；
 *  3. 人工确认 / 否决过的（locked）永不被覆盖；被否决的 (知识点, 课次) 不会再被 AI 加回来。
 */
import crypto from 'node:crypto'
import { lessonName } from './map.ts'
import type { PointKind } from './map.ts'

export type Confidence = 'high' | 'medium' | 'low'
export type MapState = 'suggested' | 'confirmed' | 'rejected'

export interface LessonLite {
  id: number
  levelName: string
  seq: number
  noLabel: string
  title: string
  theme: string
  textbookRef: string
  points: Array<{ kind: PointKind; label: string; text: string }>
}

export interface KpLite { code: string; name: string; plain: string; exampleEn: string; hintWords: string }

const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

/** 课次的检索文本：匹配、quote 校验、搜索都用它 */
export function lessonSearchText(l: { levelName?: string; noLabel?: string; title?: string; theme?: string; textbookRef?: string; points?: Array<{ text: string }> }): string {
  return [l.levelName, l.noLabel, l.title, l.theme, l.textbookRef, ...(l.points ?? []).map(p => p.text)].map(x => (x ?? '').trim()).filter(Boolean).join(' ')
}

/** 紧凑的课程行：#12 | 基础级 | 第 5 课《Animals》 | 主题 | 词汇… | 句型… | 对标… */
export function outlineLine(l: LessonLite): string {
  const pts = ['phonics', 'word', 'pattern', 'expression', 'skill'] as const
  const parts = [`#${l.id}`, l.levelName, lessonName(l), cut(l.theme, 40)]
  for (const k of pts) { const t = l.points.filter(p => p.kind === k).map(p => p.text).join('；'); parts.push(t ? `${k === 'word' ? '词' : k === 'pattern' ? '句' : k === 'phonics' ? '音' : k === 'expression' ? '表' : '能'}:${cut(t, 80)}` : '') }
  parts.push(cut(l.textbookRef, 40) ? `对标:${cut(l.textbookRef, 40)}` : '')
  return parts.filter((p, i) => i < 3 || p).join(' | ')
}
export const outlineLines = (ls: LessonLite[]): string => ls.map(outlineLine).join('\n')

export const kpSig = (k: KpLite): string => crypto.createHash('sha1').update([k.name, k.plain, k.exampleEn, k.hintWords].join('\u0001')).digest('hex').slice(0, 12)

/** 一批知识点：K1 | 名称 | 白话释义 | 例词 | 例句（批内编号，不暴露内部代码） */
export function kpBatchBlock(kps: KpLite[]): { text: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>()
  const lines = kps.map((k, i) => {
    const t = `K${i + 1}`
    tokens.set(t, k.code)
    return [t, cut(k.name, 30), cut(k.plain, 60) || '—', cut(k.hintWords, 40) || '—', cut(k.exampleEn, 60) || '—'].join(' | ')
  })
  return { text: lines.join('\n'), tokens }
}

const norm = (s: string) => s.toLowerCase().replace(/[\s　]+/g, '')

export interface MatchEntry { code: string; none: boolean; maps: Array<{ lessonId: number; confidence: Confidence; quote: string; reason: string; quoteOk: boolean }> }
export interface MatchParse { entries: MatchEntry[]; problems: string[]; dropped: number }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

/**
 * 校验一批回答。回答格式：{"results":[{"kp":"K1","lesson":"#12","confidence":"high","quote":"…","reason":"…"}, {"kp":"K2","none":true}]}
 * 同一个 kp 出现多条 = 多个对应（最多 5 个）。批里没出现的 kp 不产生条目（保持「没检查过」）。
 */
export function parseMatchResponse(text: string, ctx: { tokens: Map<string, string>; lessons: Map<number, { searchText: string }> }): MatchParse {
  let j: any
  try { j = JSON.parse(stripFence(text)) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    try { j = m ? JSON.parse(m[0]) : null } catch { j = null }
  }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : []
  if (!list.length && !(j && typeof j === 'object')) return { entries: [], problems: ['AI 的回答不是有效的 JSON'], dropped: 0 }
  const byKp = new Map<string, MatchEntry>()
  let dropped = 0
  const problems: string[] = []
  for (const it of list) {
    const code = ctx.tokens.get(String(it?.kp ?? '').trim().toUpperCase())
    if (!code) { dropped++; continue }
    let e = byKp.get(code)
    if (!e) { e = { code, none: false, maps: [] }; byKp.set(code, e) }
    if (it.none === true) continue
    const m = /^#?(\d+)$/.exec(String(it.lesson ?? '').trim())
    const id = m ? parseInt(m[1], 10) : NaN
    const lesson = ctx.lessons.get(id)
    if (!lesson) { dropped++; continue }
    if (e.maps.some(x => x.lessonId === id)) continue
    if (e.maps.length >= 5) { dropped++; continue }
    let confidence: Confidence = it.confidence === 'high' || it.confidence === 'medium' ? it.confidence : 'low'
    const quote = typeof it.quote === 'string' ? it.quote.trim().slice(0, 120) : ''
    const quoteOk = !!quote && norm(lesson.searchText).includes(norm(quote))
    let reason = typeof it.reason === 'string' ? it.reason.trim().slice(0, 60) : ''
    if (!quoteOk) { confidence = 'low'; reason = reason ? `仅凭主题推测：${reason}` : '仅凭主题推测（没有找到课次里的原文依据）' }
    e.maps.push({ lessonId: id, confidence, quote: quoteOk ? quote : '', reason, quoteOk })
  }
  for (const e of byKp.values()) e.none = e.maps.length === 0
  if (dropped) problems.push(`有 ${dropped} 条回答对不上输入里的知识点或课次，已丢弃`)
  return { entries: [...byKp.values()], problems, dropped }
}

export interface ExistingMap { lessonId: number; locked: boolean; state: MapState; source: 'ai' | 'manual' }
export interface MergePlan {
  /** 要删掉的旧的 AI 建议（没锁定的） */
  deleteLessonIds: number[]
  insert: Array<{ lessonId: number; confidence: Confidence; quote: string; reason: string }>
  /** 写进 course_kp_check 的结果 */
  result: 'matched' | 'none'
}

/** 一个知识点的新结果与库里已有的合并：锁定的不动，被否决的不再加回，旧的 AI 建议整体换成新的 */
export function planMerge(existing: ExistingMap[], entry: MatchEntry): MergePlan {
  const lockedIds = new Set(existing.filter(e => e.locked || e.state !== 'suggested').map(e => e.lessonId))
  const deleteLessonIds = existing.filter(e => !lockedIds.has(e.lessonId)).map(e => e.lessonId)
  const insert = entry.maps.filter(m => !lockedIds.has(m.lessonId)).map(m => ({ lessonId: m.lessonId, confidence: m.confidence, quote: m.quote, reason: m.reason }))
  const keptConfirmed = existing.some(e => e.state === 'confirmed')
  return { deleteLessonIds, insert, result: insert.length > 0 || keptConfirmed ? 'matched' : 'none' }
}

/** 是否算「主要对应」：人工确认的，或者没被否决且把握是高 / 中 */
export const isMainMap = (m: { state: string; confidence: string }): boolean => m.state === 'confirmed' || (m.state !== 'rejected' && (m.confidence === 'high' || m.confidence === 'medium'))

/** 知识点列表按批切分：先按一级大类分组（codes 的第一段），每批不超过 size */
export function batchKps<T extends { code: string }>(kps: T[], size = 30): T[][] {
  const groups = new Map<string, T[]>()
  for (const k of kps) {
    const g = k.code.split('.')[0]
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(k)
  }
  const out: T[][] = []
  for (const list of groups.values()) for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** 课程很大、分成几段分别问的时候：同一个考点在各段的结果合并（有对应的并起来取前 5，全是 none 才算 none） */
export function mergeEntries(parts: MatchEntry[][]): MatchEntry[] {
  const by = new Map<string, MatchEntry>()
  const rank = { high: 0, medium: 1, low: 2 } as const
  for (const part of parts) {
    for (const e of part) {
      const cur = by.get(e.code)
      if (!cur) { by.set(e.code, { code: e.code, none: e.none, maps: [...e.maps] }); continue }
      for (const m of e.maps) if (!cur.maps.some(x => x.lessonId === m.lessonId)) cur.maps.push(m)
    }
  }
  for (const e of by.values()) {
    e.maps.sort((a, b) => rank[a.confidence] - rank[b.confidence])
    e.maps = e.maps.slice(0, 5)
    e.none = e.maps.length === 0
  }
  return [...by.values()]
}

/** 把课次行切成若干段，每段不超过 maxChars（超大课程才会超过一段） */
export function chunkLines(lines: string[], maxChars = 60000): string[][] {
  const out: string[][] = []
  let cur: string[] = [], n = 0
  for (const l of lines) {
    if (cur.length && n + l.length > maxChars) { out.push(cur); cur = []; n = 0 }
    cur.push(l); n += l.length + 1
  }
  if (cur.length) out.push(cur)
  return out.length ? out : [[]]
}
