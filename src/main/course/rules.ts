/**
 * 标志词规则引擎（纯函数）：课次文字里出现了某个知识点的标志词，程序就直接挂上，并记下命中了哪个词。
 * 规则数据在 seed/course-kp-rules.ts（数据和逻辑分开）。
 *
 * 打分（0–100，可解释）：
 *  · 有强标志词：单个 72，每多一个不同的强词 +8，最多 92；再每个弱词 +2（最多 +6），不超过 95；
 *  · 只有弱标志词：1 个 35，2 个 50，3 个 62，4 个及以上 68——要好几个不同的弱词一起出现才够得上「主要匹配」。
 */
import { KP_RULES } from '../seed/course-kp-rules.ts'
import type { KpRule, RulePattern } from '../seed/course-kp-rules.ts'

export interface RuleHit { word: string; strong: boolean }
export interface RuleMatch { code: string; score: number; strongN: number; weakN: number; hits: RuleHit[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const compiled = new Map<RulePattern, RegExp>()
function reOf(p: RulePattern): RegExp {
  if (p instanceof RegExp) return new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g')
  let re = compiled.get(p)
  if (!re) {
    // 纯英文字母 / 空格 / 撇号 / 斜杠的按单词边界，其余原样子串匹配（中文、符号）
    re = /^[A-Za-z][A-Za-z' ]*$/.test(p) ? new RegExp(`(?<![A-Za-z])${escapeRe(p).replace(/ /g, '\\s+')}(?![A-Za-z])`, 'gi') : new RegExp(escapeRe(p), 'gi')
    compiled.set(p, re)
  }
  re.lastIndex = 0
  return re
}

/** 一个模式在文字里命中了什么（原文片段，去重，最多 3 个） */
function findAll(text: string, p: RulePattern): string[] {
  const re = reOf(p)
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.size < 3) { if (m[0]) out.add(m[0].trim().toLowerCase()); if (m.index === re.lastIndex) re.lastIndex++ }
  return [...out]
}

export function ruleScore(strongN: number, weakN: number): number {
  if (strongN > 0) return Math.min(95, Math.min(92, 72 + 8 * (strongN - 1)) + Math.min(6, weakN * 2))
  if (weakN <= 0) return 0
  return [0, 35, 50, 62, 68][Math.min(4, weakN)]
}

export function matchRule(text: string, rule: KpRule): { strong: string[]; weak: string[] } {
  const strong = new Set<string>(), weak = new Set<string>()
  for (const p of rule.strong ?? []) for (const w of findAll(text, p)) strong.add(w)
  for (const p of rule.weak ?? []) for (const w of findAll(text, p)) if (!strong.has(w)) weak.add(w)
  return { strong: [...strong], weak: [...weak] }
}

/** 一段课次文字 → 命中的知识点（codes 缺省 = 全部有规则的；按分数从高到低，同分更具体的在前） */
export function matchLessonRules(text: string, codes?: Iterable<string>, rules: Record<string, KpRule> = KP_RULES): RuleMatch[] {
  const t = (text ?? '').normalize('NFKC')
  if (!t.trim()) return []
  const out: RuleMatch[] = []
  for (const code of codes ?? Object.keys(rules)) {
    const rule = rules[code]
    if (!rule) continue
    const r = matchRule(t, rule)
    const strongN = r.strong.length, weakN = r.weak.length
    const score = ruleScore(strongN, weakN)
    if (score <= 0) continue
    out.push({ code, score, strongN, weakN, hits: [...r.strong.map(word => ({ word, strong: true })), ...r.weak.map(word => ({ word, strong: false }))] })
  }
  return out.sort((a, b) => b.score - a.score || b.code.split('.').length - a.code.split('.').length || (a.code < b.code ? -1 : 1))
}

/** 命中词的存储写法（course_kp_map.quote）：「was、yesterday」 */
export const hitsToQuote = (hits: RuleHit[]): string => hits.map(h => h.word).join('、').slice(0, 120)

/**
 * 从库里存的命中词（quote）还原强弱数，算出分数——老数据 / 打开时补算都用它，不需要额外的列。
 * 每个命中词原样再套一次这个知识点的规则：落在强模式里就算强，其余算弱。
 */
export function ruleScoreFromQuote(code: string, quote: string, rules: Record<string, KpRule> = KP_RULES): number {
  const rule = rules[code]
  const words = (quote ?? '').split('、').map(w => w.trim()).filter(Boolean)
  if (!rule || !words.length) return 0
  let s = 0, w = 0
  for (const word of words) {
    const isStrong = (rule.strong ?? []).some(p => findAll(word, p).length > 0)
    if (isStrong) s++; else w++
  }
  return ruleScore(s, w)
}

/** 给界面 / 提示词看的例词（没有 hint_words 的语文、数学知识点用它补）：规则里的前几个纯文字标志词 */
export function hintWordsOf(code: string, max = 6, rules: Record<string, KpRule> = KP_RULES): string {
  const rule = rules[code]
  if (!rule) return ''
  const words = [...(rule.strong ?? []), ...(rule.weak ?? [])].filter((p): p is string => typeof p === 'string')
  return [...new Set(words)].slice(0, max).join(' / ')
}

export const hasRule = (code: string, rules: Record<string, KpRule> = KP_RULES): boolean => !!rules[code]
