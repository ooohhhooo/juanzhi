/**
 * 助手会话的记录（agent_sessions / agent_steps，v12）。数据库句柄由调用方传入，纯函数，单测用内存库。
 * 一次提问的每一步都落库：用户问题、模型的话、工具调用、工具结果、计划、提问、最终回答、出错。
 * 回看历史 = 把这些步骤按顺序重放；接着追问 = 把以前的「问题 + 最终回答」作为历史发给模型。
 */
import type { ChatMessage } from '../ai/client.ts'
import type { CiteChecker } from './citations.ts'
import type { AgentEvent, PlanItem, QueryRec, SessionState } from './types.ts'

type Db = any

export type StepKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'plan' | 'ask' | 'answer' | 'error'

export interface SessionRow {
  id: string; role: string; title: string; scene: string; status: string
  dataRev: number | null; tokensIn: number; tokensOut: number; createdAt: string; updatedAt: string
}
export interface SessionView extends SessionRow { stale: boolean }
export interface StepRow { sessionId: string; seq: number; parentId: number | null; branchId: string; kind: StepKind; payload: any; tokens: number; ms: number; createdAt: string }

const toSession = (r: any): SessionRow => ({
  id: r.id, role: r.role, title: r.title, scene: r.scene, status: r.status, dataRev: r.data_rev ?? null,
  tokensIn: r.tokens_in, tokensOut: r.tokens_out, createdAt: r.created_at, updatedAt: r.updated_at
})

export const currentDataRev = (db: Db): number => (db.prepare('SELECT rev FROM data_rev WHERE id = 1').get() as any)?.rev ?? 0

export function createSession(db: Db, o: { id: string; role: string; scene: string; title: string }): string {
  db.prepare('INSERT INTO agent_sessions (id, role, title, scene, data_rev) VALUES (?, ?, ?, ?, ?)').run(o.id, o.role, o.title.slice(0, 60), o.scene, currentDataRev(db))
  return o.id
}

/** branchId 不写 = 主线；parentId 不写 = 这个分支里的上一步（分支的第一步要写：挂在哪一步下面） */
export function appendStep(db: Db, sessionId: string, s: { kind: StepKind; payload: unknown; tokens?: number; ms?: number; branchId?: string; parentId?: number | null }): number {
  const next = ((db.prepare('SELECT MAX(seq) m FROM agent_steps WHERE session_id = ?').get(sessionId) as any).m ?? 0) + 1
  const branch = s.branchId ?? 'main'
  const parent = s.parentId !== undefined ? s.parentId : ((db.prepare('SELECT MAX(seq) m FROM agent_steps WHERE session_id = ? AND branch_id = ?').get(sessionId, branch) as any).m ?? null)
  db.prepare('INSERT INTO agent_steps (session_id, seq, parent_id, branch_id, kind, payload_json, tokens, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, next, parent, branch, s.kind, JSON.stringify(s.payload ?? {}), s.tokens ?? 0, s.ms ?? 0)
  db.prepare("UPDATE agent_sessions SET updated_at = datetime('now','localtime') WHERE id = ?").run(sessionId)
  return next
}

export function updateStepPayload(db: Db, sessionId: string, seq: number, patch: Record<string, unknown>): void {
  const row = db.prepare('SELECT payload_json FROM agent_steps WHERE session_id = ? AND seq = ?').get(sessionId, seq) as any
  if (!row) return
  let cur: any = {}
  try { cur = JSON.parse(row.payload_json) } catch { /* 坏的就覆盖 */ }
  db.prepare('UPDATE agent_steps SET payload_json = ? WHERE session_id = ? AND seq = ?').run(JSON.stringify({ ...cur, ...patch }), sessionId, seq)
}

export function updateSession(db: Db, id: string, p: { status?: string; title?: string; dataRev?: number; addIn?: number; addOut?: number }): void {
  db.prepare(`UPDATE agent_sessions SET status = COALESCE(?, status), title = COALESCE(?, title), data_rev = COALESCE(?, data_rev),
    tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(p.status ?? null, p.title ?? null, p.dataRev ?? null, p.addIn ?? 0, p.addOut ?? 0, id)
}

export function getSession(db: Db, id: string): { session: SessionView; steps: StepRow[] } | null {
  const r = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id)
  if (!r) return null
  const s = toSession(r)
  const steps = (db.prepare('SELECT * FROM agent_steps WHERE session_id = ? ORDER BY seq').all(id) as any[]).map(x => {
    let payload: any = {}
    try { payload = JSON.parse(x.payload_json) } catch { /* 空 */ }
    return { sessionId: x.session_id, seq: x.seq, parentId: x.parent_id ?? null, branchId: x.branch_id ?? 'main', kind: x.kind as StepKind, payload, tokens: x.tokens, ms: x.ms, createdAt: x.created_at }
  })
  return { session: { ...s, stale: s.dataRev !== null && s.dataRev !== currentDataRev(db) }, steps }
}

export function listSessions(db: Db, limit = 60): SessionView[] {
  const rev = currentDataRev(db)
  return (db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as any[]).map(r => {
    const s = toSession(r)
    return { ...s, stale: s.dataRev !== null && s.dataRev !== rev }
  })
}

export const deleteSession = (db: Db, id: string): boolean => (db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id) as any).changes > 0

/** 追问时发给模型的历史：以前每一轮的「用户问题 + 最终回答」（工具的中间过程不带，需要的话模型会重新查）；最多最近 maxTurns 轮 */
export function historyMessages(steps: StepRow[], maxTurns = 8): ChatMessage[] {
  const turns: ChatMessage[][] = []
  let cur: ChatMessage[] | null = null
  for (const s of steps) {
    if (s.kind === 'user') { cur = [{ role: 'user', content: String(s.payload.text ?? '') }]; turns.push(cur) }
    else if (s.kind === 'answer' && cur) { cur.push({ role: 'assistant', content: String(s.payload.text ?? '') }); cur = null }
  }
  // 没有回答的轮次（被中断 / 出错）：只留下问题会让两条 user 消息相邻，丢掉
  return turns.filter(t => t.length === 2).slice(-maxTurns).flat()
}

// ───────── 分支 ─────────
/** 从根到 seq 这一步的路径（含它自己），按先后排好。分支的上下文就是这条路径，兄弟分支的内容不在里面 */
export function pathTo(steps: StepRow[], seq: number): StepRow[] {
  const by = new Map(steps.map(s => [s.seq, s]))
  const out: StepRow[] = []
  let cur = by.get(seq)
  for (let i = 0; cur && i < 10000; i++) { out.push(cur); cur = cur.parentId == null ? undefined : by.get(cur.parentId) }
  return out.reverse()
}
/** 某个分支的最后一步（接着追问从这里挂） */
export function leafOf(steps: StepRow[], branchId: string): StepRow | null {
  const mine = steps.filter(s => s.branchId === branchId)
  return mine.length ? mine[mine.length - 1] : null
}
export function branchesOf(steps: StepRow[]): Array<{ id: string; fromSeq: number | null; title: string }> {
  const ids = [...new Set(steps.map(s => s.branchId))]
  return ids.map(id => {
    const first = steps.find(s => s.branchId === id)!
    const user = steps.find(s => s.branchId === id && s.kind === 'user')
    return { id, fromSeq: id === 'main' ? null : first.parentId, title: String(user?.payload?.text ?? '').slice(0, 30) }
  })
}
export const newBranchId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** 会话共享状态：所有分支一起算——查询记录（含编号）、用户在提问里做的选择；计划取这条路径上最后一份。兄弟分支的对话内容不进上下文，但这些状态在分支间可见 */
export function deriveState(all: StepRow[], path: StepRow[]): SessionState {
  const results = new Map(all.filter(s => s.kind === 'tool_result').map(s => [String(s.payload.id), s]))
  const queries: QueryRec[] = []
  for (const s of all) {
    if (s.kind !== 'tool_call' || !(s.payload.n > 0)) continue
    const r = results.get(String(s.payload.id))
    queries.push({ n: s.payload.n, id: String(s.payload.id), name: String(s.payload.name), args: JSON.stringify(s.payload.args ?? {}), ok: r ? r.payload.ok !== false : false, note: String(r?.payload.summary ?? ''), text: String(r?.payload.text ?? '') })
  }
  queries.sort((a, b) => a.n - b.n)
  const choices = all.filter(s => s.kind === 'ask' && !s.payload.planReview && s.payload.answer).map(s => ({ question: String(s.payload.question), answer: String(s.payload.answer) }))
  const lastPlan = [...path].reverse().find(s => s.kind === 'plan')
  return { plan: (lastPlan?.payload.items as PlanItem[]) ?? [], queries, choices }
}

/** 把 harness 的事件翻成要落库的步骤（delta / progress / 审批过程不落库） */
export function eventToStep(e: AgentEvent): { kind: StepKind; payload: unknown; tokens?: number; ms?: number } | null {
  switch (e.type) {
    case 'thought': return { kind: 'assistant', payload: { text: e.text } }
    case 'tool_call': return { kind: 'tool_call', payload: { id: e.id, n: e.n, name: e.name, args: e.args, level: e.level } }
    case 'tool_result': return { kind: 'tool_result', payload: { id: e.id, n: e.n, name: e.name, ok: e.ok, summary: e.summary, text: e.text, truncated: e.truncated }, ms: e.ms }
    case 'plan': return { kind: 'plan', payload: { items: e.items } }
    case 'ask': return { kind: 'ask', payload: { id: e.id, question: e.question, options: e.options, allowOther: e.allowOther, planReview: !!e.planReview, answer: null } }
    case 'answer': return { kind: 'answer', payload: { text: e.text, removedRefs: e.removedRefs, stop: e.stop } }
    case 'compacted': return { kind: 'assistant', payload: { compacted: true, by: e.by, text: '已整理前面的内容，以便继续', summary: e.summary } }
    case 'error': return { kind: 'error', payload: { code: e.code, message: e.message } }
    default: return null
  }
}

/** 引用校验：q = 题目存在；lesson = 课次存在；stu = 学员（后续接入学员数据时通过 extra.stu 提供，现在没有学员数据，一律不存在） */
export function makeCiteChecker(db: Db, extra: Partial<CiteChecker> = {}): CiteChecker {
  const qStmt = db.prepare('SELECT 1 FROM questions WHERE id = ?')
  const lStmt = db.prepare('SELECT 1 FROM course_lessons WHERE id = ?')
  return {
    q: extra.q ?? (id => !!qStmt.get(id)),
    lesson: extra.lesson ?? (id => /^\d{1,12}$/.test(id) && !!lStmt.get(Number(id))),
    stu: extra.stu ?? (() => false)
  }
}
