/**
 * 「这次做的是哪类事」的指纹和分组（纯函数，不依赖 electron，可单测）。
 * 指纹 = 角色 + 用到的工具（去掉计划 / 提问 / 读 Skill 这类每次都有的）+ 去掉数字、班级、日期、学员代号后的请求关键词。
 * 只靠这些程序算，不问 AI；相似的几次对话分成一组，凑够 3 次就提示用户「要不要存成 Skill」。
 */

export interface Fp { tools: string[]; kw: string[] }
export interface TurnFp extends Fp { role: string }

/** 每次对话都有的基础工具，不算「这类事」的特征 */
export const INFRA_TOOLS = new Set(['update_plan', 'ask_user', 'load_playbook', 'session_state', 'history_search', 'history_read', 'delegate_tasks'])

export const WINDOW_DAYS = 60
export const MIN_SAMPLES = 3

/** 把请求里「每次都会变」的部分去掉：手机号 / 证件号 / 学员代号 / 日期 / 年级 / 班级 / 数量。纯字符串处理 */
export function stripVariables(text: string): string {
  let s = String(text ?? '')
  const rules: Array<[RegExp, string]> = [
    [/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g, ' '],
    [/(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g, ' '],
    [/\[\[[a-z]+:[^\]]*\]\]/g, ' '],
    [/\d{4}\s*[-/年.]\s*\d{1,2}(?:\s*[-/月.]\s*\d{1,2}\s*[日号]?)?/g, ' '],
    [/\d{1,2}\s*月\s*\d{0,2}\s*[日号]?/g, ' '],
    [/(?:学员|人员|老师|班级|手机)?[A-Z]?\d{3,}/g, ' '],
    [/(?:学员|人员|班级)[A-Z]\d*/g, ' '],
    [/[一二三四五六七八九十\d]+\s*年级/g, ' '],
    [/(?:高|中|低)年级/g, ' '],
    [/(?:[一-鿿]{0,3}[A-Za-z0-9一二三四五六七八九十]+|[一二三四五六七八九十]+)班(?!主任|级|长)/g, ' '],
    [/[本上下这近]\s*[一二三四五六七八九十\d]*\s*(?:个月|周|月|学期|学年|天)/g, ' '],
    [/最近|近期|当前|目前/g, ' '],
    [/[一二三四五六七八九十百零两]+\s*(?:个|份|道|名|位|次|周|天|人|月|号|日|年|节|课|期|套|张|条)/g, ' '],
    [/\d+(?:\.\d+)?\s*%?\s*(?:个|份|道|名|位|次|周|天|人|节|课|期|套|张|条)?/g, ' ']
  ]
  for (const [re, rep] of rules) s = s.replace(re, rep)
  return s.replace(/\s+/g, ' ').trim()
}

const STOP_CHARS = new Set([...'的了吗呢吧啊请帮我你把下哦嘛呀么'])

/** 请求关键词：去掉可变部分后的中文二字词 + 英文单词，排序去重，最多 40 个 */
export function keywordsOf(text: string): string[] {
  const s = stripVariables(text).toLowerCase()
  const out = new Set<string>()
  for (const seg of s.split(/[^一-鿿a-z]+/)) {
    if (!seg) continue
    if (/^[a-z]+$/.test(seg)) { if (seg.length >= 3) out.add(seg); continue }
    const chars = [...seg]
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i], b = chars[i + 1]
      if (!/[一-鿿]/.test(a) || !/[一-鿿]/.test(b)) continue
      if (STOP_CHARS.has(a) || STOP_CHARS.has(b)) continue
      out.add(a + b)
    }
  }
  return [...out].sort().slice(0, 40)
}

export function makeFp(role: string, toolNames: string[], request: string): TurnFp {
  const tools = [...new Set(toolNames.filter(t => t && !INFRA_TOOLS.has(t)))].sort()
  return { role, tools, kw: keywordsOf(request) }
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1
  const sb = new Set(b)
  let inter = 0
  for (const x of new Set(a)) if (sb.has(x)) inter++
  const union = new Set([...a, ...b]).size
  return union ? inter / union : 0
}

export const TOOL_SIM = 0.6
export const KW_SIM = 0.3
export const KW_SIM_NO_TOOLS = 0.45

/** 两次是不是「同一类事」：同角色 + 工具集合相近 + 关键词有重合 */
export function similar(a: TurnFp, b: TurnFp): boolean {
  if (a.role !== b.role) return false
  if (jaccard(a.tools, b.tools) < TOOL_SIM) return false
  const noTools = a.tools.length === 0 && b.tools.length === 0
  return jaccard(a.kw, b.kw) >= (noTools ? KW_SIM_NO_TOOLS : KW_SIM)
}

export interface TurnRec {
  sessionId: string
  answerSeq: number
  fp: TurnFp
  /** 毫秒时间戳 */
  at: number
  /** 去掉可变部分后的请求原文（给界面起名用） */
  label?: string
  rating?: number | null
}
export const turnKey = (t: { sessionId: string; answerSeq: number }): string => `${t.sessionId}#${t.answerSeq}`

/** 把窗口内的回答按相似度分组（单链：A 像 B、B 像 C 就是一组），最多处理最近 300 条 */
export function groupTurns(turns: TurnRec[], now: number, windowDays = WINDOW_DAYS): TurnRec[][] {
  const live = turns.filter(t => now - t.at <= windowDays * 86400_000 && now - t.at >= -86400_000).sort((a, b) => b.at - a.at).slice(0, 300)
  const parent = live.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) if (similar(live[i].fp, live[j].fp)) parent[find(i)] = find(j)
  const groups = new Map<number, TurnRec[]>()
  live.forEach((t, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), t]) })
  return [...groups.values()].map(g => g.sort((a, b) => a.at - b.at))
}

/** 一个 Skill 覆盖了哪类事：它的指纹 + 它是从哪几次对话来的 */
export interface Cover { name: string; fp: TurnFp; sources: Array<{ sessionId: string; answerSeq: number }> }

export function isCovered(group: TurnRec[], covers: Cover[]): boolean {
  return covers.some(c => {
    const src = new Set(c.sources.map(turnKey))
    return group.some(t => src.has(turnKey(t))) || group.some(t => similar(t.fp, c.fp))
  })
}

/** 给这一组起个白话名字：取和其他几次最像的那次请求，截短 */
export function groupLabel(group: TurnRec[]): string {
  let best = group[0], bestScore = -1
  for (const t of group) {
    const score = group.reduce((s, o) => s + (o === t ? 0 : jaccard(t.fp.kw, o.fp.kw)), 0)
    if (score > bestScore) { best = t; bestScore = score }
  }
  const raw = (best?.label ?? '').replace(/[，。！？,.!?、；;：:\s]+/g, '')
  return raw.length > 14 ? `${raw.slice(0, 13)}…` : raw || '这类事'
}

export interface Suggestion { members: TurnRec[]; label: string }

/**
 * 刚完成的这次回答，要不要提示「存成 Skill」：
 *  同一组 ≥ 3 次（60 天内）、还没有 Skill 覆盖、用户没点过「不用了」；
 *  shown = 已经提示过的组（同一类只提示一次，所以别的回答再来时不重复提示）。
 */
export function suggestFor(current: TurnRec, turns: TurnRec[], o: { now: number; covers: Cover[]; dismissed: TurnFp[]; shown: TurnFp[]; minCount?: number }): Suggestion | null {
  const all = turns.some(t => turnKey(t) === turnKey(current)) ? turns : [...turns, current]
  const group = groupTurns(all, o.now).find(g => g.some(t => turnKey(t) === turnKey(current)))
  if (!group || group.length < (o.minCount ?? MIN_SAMPLES)) return null
  if (isCovered(group, o.covers)) return null
  if (o.dismissed.some(d => group.some(t => similar(t.fp, d)))) return null
  if (o.shown.some(d => group.some(t => similar(t.fp, d)))) return null
  return { members: group, label: groupLabel(group) }
}
