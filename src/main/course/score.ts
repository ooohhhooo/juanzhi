/**
 * 「课 ↔ 知识点」的匹配分（0–100，程序算，可解释）与「主要匹配」的判定。纯函数，不依赖 electron。
 *
 * 不加数据库列：分数由已有字段推算（source / confidence / state / quote / reason），老数据打开时就能算出来。
 *  · 老师确认 = 100，否决 = 0；
 *  · 规则命中（source = 'rule'）：由 quote 里的命中词按强弱、个数算（单个强词 ≥ 72，见 rules.ts）；
 *  · AI（source = 'ai'）：quote 核对通过且和知识点有关（confidence = high）65；核对通过但关联不明显（medium）50；核对不上（low）25；
 *  · 对标教材单元也对得上（reason 里带「教材桥」）+15；单靠教材桥（source = 'bridge'）70；
 *  · 内置教材目录（source = 'builtin'）100。
 * 低于 MATCH_THRESHOLD 不算主要匹配；每节机构课最多 MAX_MAIN_PER_LESSON 个「主知识点」，其余是「顺带」。
 */
import { ruleScoreFromQuote } from './rules.ts'

/** 主要匹配的最低分 */
export const MATCH_THRESHOLD = 60
/** 每节课最多几个主知识点（学校教材的单元不限） */
export const MAX_MAIN_PER_LESSON = 3
/** 教材桥加分 */
export const BRIDGE_BONUS = 15
export const BRIDGE_TAG = '教材桥'

export interface MapLike {
  kp_code: string
  lesson_id: number
  confidence: string
  state: string
  source?: string | null
  quote?: string | null
  reason?: string | null
  /** 所在体系的类型；'textbook' 不限制每课的主知识点个数 */
  kind?: string | null
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export function scoreOf(m: MapLike): number {
  if (m.state === 'rejected') return 0
  if (m.state === 'confirmed') return 100
  const src = m.source ?? 'ai'
  const bridged = (m.reason ?? '').includes(BRIDGE_TAG)
  if (src === 'builtin') return 100
  if (src === 'bridge') return 70
  if (src === 'manual') return 100
  let base: number
  if (src === 'rule') base = ruleScoreFromQuote(m.kp_code, m.quote ?? '') || (m.confidence === 'high' ? 80 : m.confidence === 'medium' ? 62 : 35)
  else if (m.kind === 'textbook') base = (m.quote ?? '').trim() && (m.confidence === 'high' || m.confidence === 'medium') ? 65 : 25   // 教材整理有自己的核对
  else base = m.confidence === 'high' ? 65 : m.confidence === 'medium' ? 50 : 25
  return clamp(base + (bridged ? BRIDGE_BONUS : 0))
}

/** 单条是否过了线（不看每课 3 个的上限；上限见 classifyMaps） */
export const isMainMap = (m: MapLike): boolean => m.state === 'confirmed' || (m.state !== 'rejected' && scoreOf(m) >= MATCH_THRESHOLD)

export type MapRole = 'main' | 'side' | 'weak' | 'rejected'
export type Classified<T extends MapLike> = T & { score: number; role: MapRole }

/**
 * 给一批匹配分角色：
 *  main = 老师确认的，或过了线并排在本课前 3；side（顺带）= 过了线但本课已有 3 个更强的；weak = 没过线（把握不高，不列入对照）；rejected = 否决的。
 * 同一节课里按分数从高到低排，同分取更具体（层级更深）的。教材（kind = textbook）不限个数。
 */
export function classifyMaps<T extends MapLike>(rows: T[], cap = MAX_MAIN_PER_LESSON): Array<Classified<T>> {
  const scored = rows.map(r => ({ ...r, score: scoreOf(r), role: 'weak' as MapRole }))
  const byLesson = new Map<string, Array<Classified<T>>>()
  for (const r of scored) {
    if (r.state === 'rejected') { r.role = 'rejected'; continue }
    if (r.state === 'confirmed') { r.role = 'main'; continue }
    if (r.score < MATCH_THRESHOLD) continue
    if (r.kind === 'textbook') { r.role = 'main'; continue }
    const key = `${r.lesson_id}`
    if (!byLesson.has(key)) byLesson.set(key, [])
    byLesson.get(key)!.push(r)
  }
  const confirmed = new Map<string, number>()
  for (const r of scored) if (r.role === 'main' && r.state === 'confirmed') confirmed.set(`${r.lesson_id}`, (confirmed.get(`${r.lesson_id}`) ?? 0) + 1)
  for (const [key, list] of byLesson) {
    list.sort((a, b) => b.score - a.score || b.kp_code.split('.').length - a.kp_code.split('.').length || (a.kp_code < b.kp_code ? -1 : 1))
    const room = Math.max(0, cap - (confirmed.get(key) ?? 0))
    list.forEach((r, i) => { r.role = i < room ? 'main' : 'side' })
  }
  return scored
}

/** 只取主要匹配 */
export const selectMain = <T extends MapLike>(rows: T[]): Array<Classified<T>> => classifyMaps(rows).filter(r => r.role === 'main')

/** 依据（命中词 / 原文 / 教材单元，三选一或几个并列）；说不出依据的返回空串 */
export function evidenceOf(m: Pick<MapLike, 'source' | 'quote' | 'reason' | 'state'>): string {
  const parts: string[] = []
  const q = (m.quote ?? '').trim()
  const bridge = /教材桥[：:]([^｜|]*)/.exec(m.reason ?? '')?.[1]?.trim()
  if (m.source === 'rule' && q) parts.push(`命中词：${q}`)
  else if (m.source === 'ai' && q) parts.push(`原文：“${q}”`)
  else if (m.source === 'builtin') parts.push('教材目录')
  else if (m.source === 'manual' || m.state === 'confirmed') parts.push(m.source === 'manual' ? '老师手工指定' : '老师确认')
  if (m.source === 'bridge' || bridge) parts.push(`对标教材：${bridge || (m.reason ?? '')}`)
  return parts.join('；')
}

/** 给老师看的把握说法（界面不摆 0–100 的数字） */
export const scoreLabel = (score: number): string => (score >= 80 ? '很像' : score >= MATCH_THRESHOLD ? '比较像' : '有点像')
