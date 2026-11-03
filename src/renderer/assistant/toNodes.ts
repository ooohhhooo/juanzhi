/**
 * 会话树（agent_steps：parent_id / branch_id）→ 画布节点 CanvasNode[]。纯函数，不依赖 React / electron，单测直接跑。
 *
 * 映射：
 *  - user（没有父步骤）→ question；其余 user → followup
 *  - 每一轮最后一份 plan → plan；连续的查询 / 统计工具步骤 → 一个 step-group；ask → ask
 *  - answer → answer；回答里的小节（## 标题）→ 挂在回答下的 finding（至少两节才拆），没有小节就只有 answer
 *  - 看板里的核心发现（boardFindings）→ 也作为 finding 挂在最后一条回答下
 *  - 会话的产出（汇报、看板、名单）→ output，挂在最后一条回答下
 * seqOf：节点 id → 它对应的步骤 seq（在这个节点上追问时，内核要的是 seq）。
 */
import type { CanvasNode, CanvasRef } from './types.ts'

export interface StepLike { seq: number; parentId: number | null; branchId: string; kind: string; payload: any; createdAt?: string }
export interface OutputLike { id: string; type: string; name: string; updatedAt: number }

const HIDDEN_TOOLS = new Set(['update_plan', 'ask_user', 'session_state'])
const REF_RE = /\[\[(query|q|lesson|stu):([A-Za-z0-9_.-]{1,64})\]\]/g

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const stripMd = (s: string): string => s.replace(/\[\[[^\]]*\]\]/g, '').replace(/[*_`#>]/g, '').trim()
const stamp = (s: StepLike): number => { const t = s.createdAt ? Date.parse(s.createdAt.replace(' ', 'T')) : NaN; return Number.isFinite(t) ? t : s.seq * 1000 }

export function refsOfText(text: string, summaryOf?: (n: number) => string | undefined): CanvasRef[] {
  const seen = new Set<string>()
  const out: CanvasRef[] = []
  for (const m of text.matchAll(REF_RE)) {
    const k = `${m[1]}:${m[2]}`
    if (seen.has(k)) continue
    seen.add(k)
    const type = m[1] as CanvasRef['type']
    out.push({ type, id: m[2], label: type === 'query' ? `#${m[2]}` : m[2], ...(type === 'query' && summaryOf ? { summary: summaryOf(Number(m[2])) } : {}) })
  }
  return out.slice(0, 12)
}

/** 回答按「## 标题」拆小节；少于两节不拆 */
export function sectionsOf(md: string): Array<{ title: string; body: string }> {
  const parts = md.split(/\n(?=#{2,3}\s)/).map(s => s.trim()).filter(Boolean)
  const secs = parts.filter(p => /^#{2,3}\s/.test(p)).map(p => { const [h, ...rest] = p.split('\n'); return { title: stripMd(h), body: rest.join('\n').trim() } })
  return secs.length >= 2 ? secs.slice(0, 6) : []
}

export function sessionToNodes(steps: StepLike[], o: { outputs?: OutputLike[]; boardFindings?: string[]; running?: boolean; toolLabel?: (name: string) => string } = {}): { nodes: CanvasNode[]; seqOf: Record<string, number> } {
  const label = o.toolLabel ?? ((n: string) => n)
  const by = new Map(steps.map(s => [s.seq, s]))
  const ordered = [...steps].sort((a, b) => a.seq - b.seq)
  const turnOf = (s: StepLike): number => { let cur: StepLike | undefined = s; for (let i = 0; cur && i < 10000; i++) { if (cur.kind === 'user') return cur.seq; cur = cur.parentId == null ? undefined : by.get(cur.parentId) } return 0 }
  // 每一轮只留最后一份计划
  const lastPlan = new Map<number, number>()
  for (const s of ordered) if (s.kind === 'plan') lastPlan.set(turnOf(s), s.seq)
  const resultOf = new Map<string, StepLike>()
  for (const s of ordered) if (s.kind === 'tool_result') resultOf.set(String(s.payload?.id), s)
  const queryInfo = new Map<number, string>()
  for (const s of ordered) if (s.kind === 'tool_result' && Number(s.payload?.n) > 0) queryInfo.set(Number(s.payload.n), `${label(String(s.payload.name))}：${clip(String(s.payload.summary ?? ''), 40)}`)
  const callOf = new Map<string, StepLike>()
  for (const s of ordered) if (s.kind === 'tool_call') callOf.set(String(s.payload?.id), s)

  const nodeOfSeq = new Map<number, string>()
  const nodes = new Map<string, CanvasNode>()
  const seqOf: Record<string, number> = {}
  const add = (n: CanvasNode, seq: number) => { nodes.set(n.id, n); seqOf[n.id] = seq }
  const resolve = (seq: number | null): string | null => {
    let cur = seq
    for (let i = 0; cur != null && i < 10000; i++) {
      const hit = nodeOfSeq.get(cur)
      if (hit) return hit
      const s = by.get(cur)
      cur = s ? s.parentId : null
    }
    return null
  }
  /** 查询与统计组在画布上是挂在旁边的小节点：后面的计划、提问、回答接到它的上一级 */
  const parentFor = (seq: number | null): string | null => {
    let id = resolve(seq)
    for (let i = 0; id && nodes.get(id)?.kind === 'step-group' && i < 1000; i++) id = nodes.get(id)!.parentId
    return id
  }
  const isVisibleTool = (s: StepLike | undefined): boolean => !!s && (s.kind === 'tool_call' || s.kind === 'tool_result') && !HIDDEN_TOOLS.has(String(s.payload?.name))
  /** 工具步骤所在的组：沿父链往上跳过看不见的步骤，遇到可见工具步骤就并进它的组 */
  const groupOfParent = (s: StepLike): string | null => {
    let cur = s.parentId
    for (let i = 0; cur != null && i < 10000; i++) {
      const p = by.get(cur)
      if (!p) return null
      if (isVisibleTool(p)) return nodeOfSeq.get(p.seq) ?? null
      if (p.kind === 'plan' || p.kind === 'assistant' || (p.kind === 'tool_call' || p.kind === 'tool_result')) { cur = p.parentId; continue }
      return null
    }
    return null
  }

  for (const s of ordered) {
    const t = stamp(s)
    if (s.kind === 'user') {
      const parent = parentFor(s.parentId)
      const id = `u${s.seq}`
      add({ id, parentId: parent, kind: parent ? 'followup' : 'question', title: clip(String(s.payload?.text ?? ''), 80), branchId: s.branchId, createdAt: t, status: 'done' }, s.seq)
      nodeOfSeq.set(s.seq, id)
    } else if (s.kind === 'plan') {
      if (lastPlan.get(turnOf(s)) !== s.seq) continue
      const items = (s.payload?.items ?? []) as Array<{ content: string; status: string }>
      const done = items.filter(i => i.status === 'done').length
      const id = `p${s.seq}`
      add({ id, parentId: parentFor(s.parentId), kind: 'plan', title: '计划', body: items.map(i => `${i.status === 'done' ? '✓' : '·'} ${i.content}`).join('\n'), branchId: s.branchId, createdAt: t, status: done === items.length ? 'done' : 'running' }, s.seq)
      nodeOfSeq.set(s.seq, id)
    } else if (isVisibleTool(s)) {
      let gid = groupOfParent(s)
      if (!gid) {
        gid = `g${s.seq}`
        add({ id: gid, parentId: parentFor(s.parentId), kind: 'step-group', title: '查询与统计', body: '', branchId: s.branchId, createdAt: t, status: 'done' }, s.seq)
      }
      nodeOfSeq.set(s.seq, gid)
      const g = nodes.get(gid)!
      if (s.kind === 'tool_call') {
        const r = resultOf.get(String(s.payload?.id))
        const line = `${s.payload?.n ? '#' + s.payload.n + ' ' : ''}${label(String(s.payload?.name))}${r ? '' : '（进行中）'}`
        g.body = g.body ? `${g.body}\n${line}` : line
        if (!r) g.status = 'running'
      } else if (s.payload?.ok === false) g.status = 'error'
      const count = (g.body ?? '').split('\n').filter(Boolean).length
      g.title = `查询与统计 · ${count} 步`
    } else if (s.kind === 'ask') {
      const id = `k${s.seq}`
      const planReview = !!s.payload?.planReview
      add({ id, parentId: parentFor(s.parentId), kind: 'ask', title: clip(String(s.payload?.question ?? ''), 60), body: s.payload?.answer ? `你选了：${clip(String(s.payload.answer), 60)}` : planReview ? '等你确认计划' : '等你回答', branchId: s.branchId, createdAt: t, status: s.payload?.answer ? 'done' : 'running' }, s.seq)
      nodeOfSeq.set(s.seq, id)
    } else if (s.kind === 'answer') {
      const text = String(s.payload?.text ?? '')
      const id = `a${s.seq}`
      const lines = stripMd(text).split('\n').map(x => x.trim()).filter(Boolean)
      add({ id, parentId: parentFor(s.parentId), kind: 'answer', title: clip(lines[0] ?? '回答', 60), body: clip(lines.slice(1).join(' '), 160), refs: refsOfText(text, n => queryInfo.get(n)), branchId: s.branchId, createdAt: t, status: 'done' }, s.seq)
      nodeOfSeq.set(s.seq, id)
      sectionsOf(text).forEach((sec, i) => {
        const fid = `f${s.seq}-${i}`
        add({ id: fid, parentId: id, kind: 'finding', title: clip(sec.title, 60), body: clip(stripMd(sec.body), 160), refs: refsOfText(sec.body, n => queryInfo.get(n)), branchId: s.branchId, createdAt: t + i + 1, status: 'done' }, s.seq)
      })
    }
  }

  // 看板核心发现、产出：挂在最后一条回答下（没有回答就挂最后一个节点）
  const all = [...nodes.values()]
  const lastAnswer = [...all].reverse().find(n => n.kind === 'answer') ?? all[all.length - 1]
  if (lastAnswer) {
    const seq = seqOf[lastAnswer.id]
    ;(o.boardFindings ?? []).slice(0, 6).forEach((f, i) => add({ id: `bf${i}`, parentId: lastAnswer.id, kind: 'finding', title: clip(f, 60), branchId: lastAnswer.branchId, createdAt: lastAnswer.createdAt + 100 + i, status: 'done' }, seq))
    for (const out of o.outputs ?? []) add({ id: `o:${out.id}`, parentId: lastAnswer.id, kind: 'output', title: clip(out.name, 40), body: out.type === 'board' ? '看板' : out.type === 'table' ? '名单' : '汇报', branchId: lastAnswer.branchId, createdAt: out.updatedAt || lastAnswer.createdAt + 200, status: 'done' }, seq)
  }
  if (o.running) { const last = [...nodes.values()].sort((a, b) => b.createdAt - a.createdAt)[0]; if (last && last.kind !== 'answer') last.status = last.status === 'error' ? 'error' : 'running' }
  void callOf
  return { nodes: [...nodes.values()], seqOf }
}
