import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut, ListFilter, ChevronDown, ChevronRight, Send, CornerDownRight } from 'lucide-react'
import { KIND_LABEL } from '../types'
import type { CanvasAction, CanvasNode, CanvasProps } from '../types'
import { fitView, layoutTree, neighbor, zoomAt, GAP_Y, MAX_K, MIN_K } from './layout'
import type { Box, View } from './layout'
import '../assistant.css'

const ACTIONS: Array<[string, CanvasAction | 'ask']> = [['追问', 'ask'], ['加到看板', 'add-to-board'], ['加到汇报', 'add-to-report'], ['生成名单', 'make-list']]
const MM_W = 168, MM_H = 104
/** 默认缩放下限；适应窗口时给右下角小地图、底部追问框留出的空间 */
const GAP_Y_HALF = GAP_Y / 2
const MIN_DEFAULT_K = 0.8
const ASK_SPACE = 72
const FIT_EXTRA = { right: MM_W + 28, bottom: ASK_SPACE }

interface NodeProps {
  node: CanvasNode; box: Box; depth: number; selected: boolean; fresh: boolean
  childCount: number; collapsed: boolean
  onPick: (id: string) => void; onAsk: (id: string) => void; onAct: (id: string, a: CanvasAction) => void; onToggle: (id: string) => void
}

const NodeCard = React.memo(function NodeCard({ node, box, depth, selected, fresh, childCount, collapsed, onPick, onAsk, onAct, onToggle }: NodeProps) {
  const canAct = node.kind === 'finding' || node.kind === 'answer'
  const mini = node.mini
  const max = mini ? Math.max(1, ...mini.values.map(Math.abs)) : 1
  return (
    <div className="ewb-cv-node" data-node-id={node.id} data-testid={`cv-node-${node.id}`} data-kind={node.kind} data-status={node.status ?? 'done'} data-selected={selected ? '1' : undefined} data-fresh={fresh ? '1' : undefined}
      role="treeitem" aria-selected={selected} aria-level={depth} aria-label={`${KIND_LABEL[node.kind]}：${node.title}${node.status === 'running' ? '（进行中）' : ''}`}
      style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }} onClick={() => onPick(node.id)}>
      <div className="ewb-cv-node__k">{KIND_LABEL[node.kind]}{node.status === 'running' && <><i className="ewb-cv-pulse" aria-hidden /> 进行中</>}{node.status === 'error' && ' · 出错'}</div>
      <b className="ewb-cv-node__t">{node.title}</b>
      {node.body && <div className="ewb-cv-node__b">{node.body}</div>}
      {!!node.refs?.length && <div className="ewb-cv-node__refs">{node.refs.slice(0, 4).map(r => <span key={r.type + r.id} className="ewb-cv-ref" title={r.summary}>{r.label}</span>)}</div>}
      {mini && <div className="ewb-cv-node__bar" aria-hidden>{mini.values.map((v, i) => <i key={i} data-hi={i === mini.highlightIndex ? '1' : undefined} style={{ height: Math.max(3, Math.round(Math.abs(v) / max * 32)) }} />)}</div>}
      {canAct && (
        <div className="ewb-cv-node__act">
          {ACTIONS.map(([label, a]) => (
            <button key={a} type="button" data-testid={`cv-act-${a}-${node.id}`} data-nopan
              onClick={e => { e.stopPropagation(); if (a === 'ask') onAsk(node.id); else onAct(node.id, a) }}>{a === 'ask' && <CornerDownRight size={11} strokeWidth={1.9} aria-hidden />}{label}</button>
          ))}
        </div>
      )}
      {childCount > 0 && (
        <button type="button" className="ewb-cv-node__fold" data-nopan data-testid={`cv-fold-${node.id}`} aria-expanded={!collapsed} aria-label={collapsed ? `展开 ${childCount} 项` : '折叠子树'}
          onClick={e => { e.stopPropagation(); onToggle(node.id) }}>
          {collapsed ? <ChevronRight size={11} strokeWidth={1.9} /> : <ChevronDown size={11} strokeWidth={1.9} />}{collapsed ? `${childCount}` : ''}
        </button>
      )}
    </div>
  )
})

const MiniNodes = React.memo(function MiniNodes({ boxes, kinds, tf, ms }: { boxes: Map<string, Box>; kinds: Map<string, string>; tf: (x: number, y: number) => [number, number]; ms: number }) {
  return <>{[...boxes].map(([id, b]) => { const [x, y] = tf(b.x, b.y); return <i key={id} data-kind={kinds.get(id)} style={{ left: x, top: y, width: Math.max(2, b.w * ms), height: Math.max(2, b.h * ms) }} /> })}</>
})

export default function AssistantCanvas({ nodes, selectedId, onSelect, onFollowUp, onAction, showAskBar = true, placeholder = '比如：新生里哪些年级最低？', focusSignal, className }: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [mode, setMode] = useState<'all' | 'conclusions'>('all')
  const [folded, setFolded] = useState<Set<string>>(new Set())     // 用户手动折叠的
  const [opened, setOpened] = useState<Set<string>>(new Set())     // 用户手动展开的 step-group（默认折叠）
  const [text, setText] = useState('')
  const fitted = useRef(false)
  const dragged = useRef(false)
  const viewRef = useRef(view); viewRef.current = view
  const [fresh, setFresh] = useState(false)

  const collapsed = useMemo(() => {
    const s = new Set(folded)
    for (const n of nodes) if (n.kind === 'step-group' && !opened.has(n.id)) s.add(n.id)
    return s
  }, [nodes, folded, opened])
  const L = useMemo(() => layoutTree(nodes, { mode, collapsed }), [nodes, mode, collapsed])
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const kinds = useMemo(() => new Map(nodes.map(n => [n.id, n.kind])), [nodes])

  useLayoutEffect(() => {
    const el = rootRef.current; if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  // 第一次有内容时适应窗口；之后新节点用淡入，不动视角
  useEffect(() => {
    if (!fitted.current && size.w > 0 && size.h > 240 && L.boxes.size > 0) { fitted.current = true
      // 树太宽时「完整适应」会小到看不清：第一次进来至少 80%，以选中的（没选就是最新的）节点为中心；想看全貌点「适应窗口」或看小地图
      const f = fitView(L.bounds, size.w, size.h, 48, FIT_EXTRA)
      let focus = selectedId ? L.boxes.get(selectedId) : undefined
      if (!focus) { let t = -Infinity; for (const id of L.order) { const nd = byId.get(id); const c = nd?.kind === 'output' ? -1 : (nd?.createdAt ?? 0); if (c >= t) { t = c; focus = L.boxes.get(id) } } }
      const k = MIN_DEFAULT_K
      setView(f.k >= k || !focus ? f : { k, x: size.w / 2 - (focus.x + focus.w / 2) * k, y: (size.h - ASK_SPACE) / 2 - (focus.y + focus.h / 2) * k }); requestAnimationFrame(() => setFresh(true)) }
  }, [size, L])   // eslint-disable-line react-hooks/exhaustive-deps

  // 滚轮缩放（以鼠标为中心）；要 preventDefault，所以用非被动的原生监听
  useEffect(() => {
    const el = rootRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const dy = Math.max(-120, Math.min(120, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY))
      setView(v => zoomAt(v, Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016)), e.clientX - r.left, e.clientY - r.top))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 拖动平移：在窗口上监听移动 / 抬起，点击节点的 click 事件不受影响
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nopan], input, button')) return
    dragged.current = false
    const sx = e.clientX, sy = e.clientY, v0 = viewRef.current
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (!dragged.current && Math.hypot(dx, dy) < 4) return
      dragged.current = true
      setView({ ...v0, x: v0.x + dx, y: v0.y + dy })
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); rootRef.current?.removeAttribute('data-panning') }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    rootRef.current?.setAttribute('data-panning', '1')
  }

  const zoomBy = useCallback((f: number) => setView(v => zoomAt(v, f, size.w / 2, size.h / 2)), [size])
  const fit = useCallback(() => setView(fitView(L.bounds, size.w, size.h, 48, FIT_EXTRA)), [L, size])

  // 追问目标：选中的节点；没选中时是最后一个回答
  const target = useMemo(() => {
    if (selectedId && byId.has(selectedId)) return byId.get(selectedId)!
    const answers = nodes.filter(n => n.kind === 'answer')
    const pool = answers.length ? answers : nodes
    return pool.reduce<CanvasNode | null>((a, n) => (!a || n.createdAt >= a.createdAt ? n : a), null)
  }, [selectedId, byId, nodes])

  const focusAsk = useCallback(() => { requestAnimationFrame(() => inputRef.current?.focus()) }, [])
  useEffect(() => { if (focusSignal) focusAsk() }, [focusSignal, focusAsk])
  const pick = useCallback((id: string) => { if (dragged.current) { dragged.current = false; return } onSelect(id) }, [onSelect])
  const ask = useCallback((id: string) => { onSelect(id); focusAsk() }, [onSelect, focusAsk])
  const toggle = useCallback((id: string) => {
    const n = byId.get(id)
    if (n?.kind === 'step-group') setOpened(s => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t })
    else setFolded(s => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t })
  }, [byId])

  const send = () => {
    const t = text.trim()
    if (!t || !target) return
    onFollowUp(target.id, t); setText('')
  }

  const reveal = (id: string) => {
    const b = L.boxes.get(id); if (!b) return
    setView(v => {
      const sx = b.x * v.k + v.x, sy = b.y * v.k + v.y, m = 40
      if (sx > m && sy > m && sx + b.w * v.k < size.w - m && sy + b.h * v.k < size.h - 90) return v
      return { ...v, x: size.w / 2 - (b.x + b.w / 2) * v.k, y: size.h / 2 - (b.y + b.h / 2) * v.k }
    })
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') {
      if (e.key === 'Escape') { (e.target as HTMLInputElement).blur(); rootRef.current?.focus() }
      return
    }
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    if (dirs[e.key]) {
      e.preventDefault()
      let cur = selectedId && L.boxes.has(selectedId) ? selectedId : null
      if (!cur) { onSelect(L.order[0] ?? null); if (L.order[0]) reveal(L.order[0]); return }
      const nx = neighbor(L, cur, dirs[e.key])
      if (nx) { onSelect(nx); reveal(nx) }
    } else if (e.key === 'Enter') { e.preventDefault(); if (!selectedId && target) onSelect(target.id); focusAsk() }
    else if (e.key === 'Escape') onSelect(null)
    else if (e.key === '+' || e.key === '=') zoomBy(1.25)
    else if (e.key === '-') zoomBy(0.8)
    else if (e.key === '0') fit()
  }

  // 小地图
  const pad = 40
  const bw = Math.max(L.bounds.w, 1) + pad * 2, bh = Math.max(L.bounds.h, 1) + pad * 2
  const ms = Math.min(MM_W / bw, MM_H / bh)
  const ox = (MM_W - bw * ms) / 2, oy = (MM_H - bh * ms) / 2
  const tf = useCallback((x: number, y: number): [number, number] => [ox + (x - L.bounds.x + pad) * ms, oy + (y - L.bounds.y + pad) * ms], [ox, oy, ms, L.bounds.x, L.bounds.y])
  const [vx, vy] = tf(-view.x / view.k, -view.y / view.k)
  const jump = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const wx = (e.clientX - r.left - ox) / ms - pad + L.bounds.x, wy = (e.clientY - r.top - oy) / ms - pad + L.bounds.y
    setView(v => ({ ...v, x: size.w / 2 - wx * v.k, y: size.h / 2 - wy * v.k }))
  }

  // 父底部中点 → 子顶部中点：先竖直下来、在两排之间圆角拐弯、再竖直接到子顶部。横向那一段只在兄弟范围内，不会拉出长线
  const edgeD = (a: Box, b: Box, side?: boolean) => {
    if (side) { // 产出卡片：从父节点右侧中点接到卡片左侧中点
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = x2 - 28, r = Math.min(14, (y2 - y1) / 2, 14)
      return `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + r} V${y2 - r} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`
    }
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = y2 - GAP_Y_HALF
    const dx = x2 - x1, r = Math.min(16, Math.abs(dx) / 2), sg = Math.sign(dx)
    if (!r) return `M${x1} ${y1} V${y2}`
    return `M${x1} ${y1} V${my - r} Q${x1} ${my} ${x1 + sg * r} ${my} H${x2 - sg * r} Q${x2} ${my} ${x2} ${my + r} V${y2}`
  }

  return (
    <div ref={rootRef} className={`ewb-cv ${className ?? ''}`} data-testid="canvas" tabIndex={0} role="tree" aria-label="任务画布：方向键在卡片间移动，Enter 追问，Esc 取消选中"
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} onClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('ewb-cv-world')) { if (dragged.current) dragged.current = false; else onSelect(null) } }}>
      <div className="ewb-cv-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="ewb-cv-edges" width="1" height="1" aria-hidden>
          {L.edges.map(e => { const a = L.boxes.get(e.from), b = L.boxes.get(e.to); if (!a || !b) return null; const d = edgeD(a, b, e.side); return <path key={e.to} data-testid="cv-edge" d={d} style={{ d: `path("${d}")` } as React.CSSProperties} /> })}
        </svg>
        {L.order.map(id => {
          const n = byId.get(id)!
          return <NodeCard key={id} node={n} box={L.boxes.get(id)!} depth={L.depth.get(id)!} selected={id === selectedId} fresh={fresh}
            childCount={L.childCount.get(id) ?? 0} collapsed={collapsed.has(id)} onPick={pick} onAsk={ask} onAct={onAction} onToggle={toggle} />
        })}
      </div>

      <div className="ewb-cv-tool" role="toolbar" aria-label="画布工具" data-nopan>
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="放大" data-testid="cv-zoom-in" disabled={view.k >= MAX_K}><ZoomIn size={14} strokeWidth={1.9} />放大</button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label="缩小" data-testid="cv-zoom-out" disabled={view.k <= MIN_K}><ZoomOut size={14} strokeWidth={1.9} />缩小</button>
        <button type="button" onClick={fit} aria-label="适应窗口" data-testid="cv-fit"><Maximize2 size={14} strokeWidth={1.9} />适应窗口</button>
        <button type="button" onClick={() => setMode(m => (m === 'all' ? 'conclusions' : 'all'))} aria-pressed={mode === 'conclusions'} data-testid="cv-conclusions" title="隐藏计划、查询步骤和待确认"><ListFilter size={14} strokeWidth={1.9} />只看结论</button>
        <span className="ewb-cv-zoom" data-testid="cv-zoom" aria-live="off">{Math.round(view.k * 100)}%</span>
      </div>

      <div className="ewb-cv-mini" data-testid="cv-minimap" data-nopan role="img" aria-label="小地图，点击跳转" style={{ width: MM_W, height: MM_H }}
        onPointerDown={e => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); jump(e) }}
        onPointerMove={e => { if (e.buttons === 1) jump(e) }}>
        <MiniNodes boxes={L.boxes} kinds={kinds} tf={tf} ms={ms} />
        <i className="ewb-cv-mini__vp" data-testid="cv-minimap-vp" style={{ left: vx, top: vy, width: size.w / view.k * ms, height: size.h / view.k * ms }} />
      </div>

      {showAskBar && (
        <form className="ewb-cv-ask" data-nopan data-testid="cv-ask" onSubmit={e => { e.preventDefault(); send() }}>
          <span className="ewb-cv-ask__to" data-testid="cv-ask-to" title={target?.title}>{target ? `追问「${target.title.length > 14 ? target.title.slice(0, 14) + '…' : target.title}」` : '还没有可追问的内容'}</span>
          <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} aria-label="追问内容" data-testid="cv-ask-input" disabled={!target} />
          <button type="submit" disabled={!text.trim() || !target} data-testid="cv-ask-send"><Send size={13} strokeWidth={1.9} />发送</button>
        </form>
      )}
    </div>
  )
}
