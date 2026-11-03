import React, { useMemo } from 'react'
import { CornerDownRight } from 'lucide-react'
import { KIND_LABEL } from '../types'
import type { CanvasAction, CanvasNode, CanvasRef } from '../types'

export type OpenRef = Pick<CanvasRef, 'type' | 'id'> & { label?: string }

const REF_KIND: Record<CanvasRef['type'], string> = { query: '查询', q: '样本题', lesson: '课程', stu: '学员' }

/** 这张卡片在会话树里的位置：主线 / 第几条分支，第几轮（路径上问题与追问的个数） */
export function sourceOf(node: CanvasNode, nodes: readonly CanvasNode[], branchNames?: Record<string, string>): { branch: string; round: number } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  let round = 0, cur: CanvasNode | undefined = node, root = node
  const guard = new Set<string>()
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id)
    if (cur.kind === 'question' || cur.kind === 'followup') round++
    root = cur
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  const main = root.branchId
  if (node.branchId === main || node.branchId === 'main') return { branch: '主线', round: Math.max(round, 1) }
  const order: string[] = []
  for (const n of [...nodes].sort((a, b) => a.createdAt - b.createdAt)) if (n.branchId !== main && n.branchId !== 'main' && !order.includes(n.branchId)) order.push(n.branchId)
  return { branch: branchNames?.[node.branchId] ?? `分支 ${order.indexOf(node.branchId) + 1}`, round: Math.max(round, 1) }
}

/** 这张卡片下的追问：沿子树往下找到的第一层追问，附上它的回答标题 */
export function followUpsOf(node: CanvasNode, nodes: readonly CanvasNode[]): Array<{ id: string; title: string; answer?: string }> {
  const kids = new Map<string, CanvasNode[]>()
  for (const n of nodes) if (n.parentId) { const a = kids.get(n.parentId) ?? []; a.push(n); kids.set(n.parentId, a) }
  for (const a of kids.values()) a.sort((x, y) => x.createdAt - y.createdAt)
  const out: Array<{ id: string; title: string; answer?: string }> = []
  const queue = [...(kids.get(node.id) ?? [])]
  const seen = new Set<string>()
  while (queue.length) {
    const n = queue.shift()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    if (n.kind === 'followup') {
      const sub = [...(kids.get(n.id) ?? [])]; let ans: CanvasNode | undefined
      while (sub.length && !ans) { const s = sub.shift()!; if (s.kind === 'answer' || s.kind === 'finding') ans = s; else sub.push(...(kids.get(s.id) ?? [])) }
      out.push({ id: n.id, title: n.title, answer: ans?.title })
    } else queue.push(...(kids.get(n.id) ?? []))
  }
  return out
}

export default function CardDetail({ node, nodes, branchNames, onAskFrom, onAction, onOpenRef }: {
  node: CanvasNode; nodes: readonly CanvasNode[]; branchNames?: Record<string, string>
  onAskFrom: (id: string) => void; onAction: (id: string, a: CanvasAction) => void; onOpenRef: (r: OpenRef) => void
}) {
  const src = useMemo(() => sourceOf(node, nodes, branchNames), [node, nodes, branchNames])
  const fups = useMemo(() => followUpsOf(node, nodes), [node, nodes])
  const wantsRefs = node.kind === 'finding' || node.kind === 'answer'
  return (
    <div className="ewb-side__card" data-testid="card-detail" data-node-id={node.id}>
      <h3 className="ewb-side__h1" data-testid="card-title">{node.title}</h3>
      <div className="ewb-side__meta" data-testid="card-source">{KIND_LABEL[node.kind]} · 来自{src.branch} · 第 {src.round} 轮{node.status === 'running' ? ' · 进行中' : ''}</div>
      {node.body && <p className="ewb-side__p">{node.body}</p>}

      {(wantsRefs || !!node.refs?.length) && (
        <section>
          <h4 className="ewb-side__h2">数字从哪来</h4>
          {node.refs?.length ? (
            <ul className="ewb-side__refs" data-testid="card-refs">
              {node.refs.map(r => (
                <li key={r.type + r.id}>
                  <button type="button" className="ewb-ref-chip" onClick={() => onOpenRef(r)} data-testid="card-ref" data-ref={`${r.type}:${r.id}`}>{r.label}</button>
                  <span className="ewb-side__refdesc"><b>{REF_KIND[r.type]}</b>{r.summary ? `：${r.summary}` : ''}</span>
                </li>
              ))}
            </ul>
          ) : <div className="ewb-side__empty">这张卡片没有记录出处，数字请谨慎使用。</div>}
        </section>
      )}

      <section>
        <h4 className="ewb-side__h2">这张卡片下的追问</h4>
        {fups.length ? (
          <ul className="ewb-side__fups" data-testid="card-followups">
            {fups.map(f => <li key={f.id}><CornerDownRight size={12} strokeWidth={1.9} aria-hidden />{f.title}{f.answer ? <span className="ewb-side__ans"> · {f.answer}</span> : <span className="ewb-side__ans"> · 进行中</span>}</li>)}
          </ul>
        ) : <div className="ewb-side__empty">还没有追问。</div>}
      </section>

      <section>
        <h4 className="ewb-side__h2">操作</h4>
        <div className="ewb-side__btns">
          <button type="button" className="ewb-side__btn ewb-side__btn--pri" onClick={() => onAskFrom(node.id)} data-testid="card-askfrom"><CornerDownRight size={12} strokeWidth={1.9} aria-hidden /> 从这里追问</button>
          <button type="button" className="ewb-side__btn" onClick={() => onAction(node.id, 'add-to-report')} data-testid="card-act-report">加到汇报</button>
          <button type="button" className="ewb-side__btn" onClick={() => onAction(node.id, 'add-to-board')} data-testid="card-act-board">加到看板</button>
          {wantsRefs && <button type="button" className="ewb-side__btn" onClick={() => onAction(node.id, 'make-list')} data-testid="card-act-list">生成名单</button>}
          <button type="button" className="ewb-side__btn" onClick={() => onAction(node.id, 'copy')} data-testid="card-act-copy">复制</button>
        </div>
      </section>
    </div>
  )
}
