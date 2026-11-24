/**
 * 从会话记录（agent_steps）里切出「一次提问 → 一次回答」，并把它压成适合发给 AI 的样本（纯函数）。
 * 数据库里存的本来就是代号形式（学员A001 …），这里再用 scrubPII 去一遍手机号 / 证件号；不带工具结果原文，只带工具名、参数摘要和最终回答。
 */
import { scrubPII } from '../../analysis/scrub.ts'
import { INFRA_TOOLS } from './fingerprint.ts'

export interface StepLite { seq: number; branchId: string; kind: string; payload: any }
export interface CallLite { name: string; args: string; ok: boolean }
export interface Turn {
  branchId: string
  userSeq: number
  answerSeq: number
  request: string
  calls: CallLite[]
  /** 这次读取过的 Skill 名 */
  skills: string[]
  answer: string
  stop: string
}

/** 用户这句话像不像「对上一个回答提修改意见」 */
export const REVISE_CUE = /(改|修改|调整|重写|重做|换成|换个|换一|不要|去掉|删掉|太长|太短|简短|简单点|正式|口语|加上|补充|不对|不是|结尾|开头|再来|重新)/
export const isRevision = (text: string): boolean => text.trim().length <= 80 && REVISE_CUE.test(text)

const argsText = (a: unknown): string => { try { return JSON.stringify(a ?? {}) } catch { return '' } }

/** 按先后顺序切成回合：user → 若干工具调用 → answer。没有回答的（中断 / 出错）不算 */
export function extractTurns(steps: StepLite[]): Turn[] {
  const out: Turn[] = []
  let cur: { branchId: string; userSeq: number; request: string; calls: CallLite[]; skills: string[]; ids: string[] } | null = null
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (s.kind === 'user') cur = { branchId: s.branchId, userSeq: s.seq, request: String(s.payload?.text ?? ''), calls: [], skills: [], ids: [] }
    else if (!cur) continue
    else if (s.kind === 'tool_call') {
      const name = String(s.payload?.name ?? '')
      if (name === 'load_playbook') { const n = String(s.payload?.args?.name ?? ''); if (n && !cur.skills.includes(n)) cur.skills.push(n); continue }
      cur.calls.push({ name, args: argsText(s.payload?.args), ok: true })
      cur.ids.push(String(s.payload?.id ?? ''))
    } else if (s.kind === 'tool_result') {
      const i = cur.ids.indexOf(String(s.payload?.id ?? ''))
      if (i >= 0 && s.payload?.ok === false) cur.calls[i].ok = false
    } else if (s.kind === 'answer') {
      out.push({ branchId: cur.branchId, userSeq: cur.userSeq, answerSeq: s.seq, request: cur.request, calls: cur.calls, skills: cur.skills, answer: String(s.payload?.text ?? ''), stop: String(s.payload?.stop ?? 'answered') })
      cur = null
    }
  }
  return out
}

/** 这个回合里真正做事的工具名（按出现顺序，去重，不含基础工具） */
export function toolNamesOf(t: Pick<Turn, 'calls'>): string[] {
  const seen: string[] = []
  for (const c of t.calls) if (c.ok && !INFRA_TOOLS.has(c.name) && !seen.includes(c.name)) seen.push(c.name)
  return seen
}

export interface Signals { rating: number | null; exported: boolean; revised: boolean; reviseText: string }
export interface SampleIn { sessionId: string; answerSeq: number; turn: Turn; signals: Signals; /** 用户后来又要求修改，这是改完后的最终回答 */ finalAnswer?: string; revisions?: string[] }

/** 样本质量分：👍 > 导出过 > 没被要求修改；👎 不用 */
export function sampleScore(s: { signals: Signals; at?: number }): number {
  if (s.signals.rating === -1) return -100
  return (s.signals.rating === 1 ? 4 : 0) + (s.signals.exported ? 2 : 0) + (s.signals.revised ? 1 : 0) + (s.at ? s.at / 1e15 : 0)
}

/** 挑最多 n 个最好的样本（👍 优先，其次导出过 / 改过后的最终版，其次新的） */
export function pickBest<T extends { signals: Signals; at: number }>(list: T[], n = 5): T[] {
  return [...list].filter(s => s.signals.rating !== -1).sort((a, b) => sampleScore(b) - sampleScore(a)).slice(0, n)
}

export interface Condensed {
  n: number
  request: string
  steps: Array<{ tool: string; args: string }>
  answer: string
  signal: string
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const clean = (s: string) => scrubPII(String(s ?? '')).replace(/\s+/g, ' ').trim()

/** 压成给 AI 看的一份样本：请求、工具顺序（参数摘要）、最终回答（截短）、用户给过的信号。全部过一遍去个人信息 */
export function condense(s: SampleIn, n: number): Condensed {
  const sig: string[] = []
  if (s.signals.rating === 1) sig.push('用户点了「这次做得好」')
  if (s.signals.exported) sig.push('用户导出过这次的产出')
  if (s.revisions?.length) sig.push(`用户后来又要求：${s.revisions.map(r => cut(clean(r), 60)).join('；')}（下面的回答是改完后的最终版）`)
  return {
    n,
    request: cut(clean(s.turn.request), 300),
    steps: s.turn.calls.filter(c => !INFRA_TOOLS.has(c.name)).slice(0, 20).map(c => ({ tool: c.name, args: cut(clean(c.args), 120) })),
    answer: cut(clean(s.finalAnswer ?? s.turn.answer), 1200),
    signal: sig.join('；')
  }
}
