import React, { useEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen, FileText, LayoutDashboard, Sheet, Info, Download, Copy, FolderOpen, Image as ImageIcon, Send } from 'lucide-react'
import type { OutputContent, OutputEntry, OutputExportFormat } from '../../../shared/agent-outputs'
import type { CanvasAction, CanvasNode } from '../types'
import CardDetail from './CardDetail'
import type { OpenRef } from './CardDetail'
import OutputMarkdown from './OutputMarkdown'
import '../assistant.css'

export type SideMode = 'outputs' | 'card'

export interface SidePanelProps {
  mode: SideMode
  onModeChange: (m: SideMode) => void
  // ── 产出 ──
  outputs: OutputEntry[]
  activeOutputId: string | null
  onActiveOutputChange: (id: string) => void
  /** 当前选中产出的内容（由集成方用 window.api.agentOutputs.read 取，随 agent-outputs:changed 刷新） */
  content: OutputContent | null
  /** 看板插槽：看板模块的组件接在这里 */
  renderBoard?: (boardId: string) => React.ReactNode
  onExport: (id: string, format: OutputExportFormat) => void
  /** 不传则面板自己复制（文档复制 Markdown 源码，表格复制成制表符分隔） */
  onCopy?: (id: string) => void
  onReveal: (id: string) => void
  /** 图片产出（分享卡片）：复制图片 / 另存为 / 发到企业微信（后者交给助手走 wecom_send，需要用户同意） */
  onCopyImage?: (id: string) => void
  onSaveImage?: (id: string) => void
  onSendWecom?: (id: string) => void
  /** 卡片换模板（同样内容按另一个模板重画）；没给就不显示 */
  onRerenderCard?: (id: string, templateId: string) => Promise<void>
  /** 点引用标签 / 出处（打开查询详情等） */
  onOpenRef: (r: OpenRef) => void
  // ── 卡片详情 ──
  node: CanvasNode | null
  nodes: readonly CanvasNode[]
  /** 分支 id → 显示名；没给就叫「分支 1、2…」 */
  branchNames?: Record<string, string>
  onAskFrom: (id: string) => void
  onAction: (id: string, a: CanvasAction) => void
  /** 记住宽度 / 折叠状态用的键，默认 ewb-assistant-side */
  storageKey?: string
  title?: string
  /** 窗口宽度小于这个值、且用户没有手动展开 / 收起过时，默认收成一条竖栏（0 = 不自动收） */
  foldBelow?: number
}

const MIN_W = 300, MAX_W = 760, DEF_W = 400
const TYPE_ICON: Record<OutputEntry['type'], typeof FileText> = { md: FileText, board: LayoutDashboard, table: Sheet, note: Info, image: ImageIcon }

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}
export const formatsOf = (t: OutputEntry['type']): Array<[OutputExportFormat, string]> =>
  t === 'md' || t === 'note' ? [['docx', '导出 Word'], ['pdf', '导出 PDF']] : t === 'table' ? [['xlsx', '导出 Excel']] : []

function store(): Storage | null { try { return window.localStorage } catch { return null } }

function copyText(c: OutputContent | null): string {
  if (!c) return ''
  if (c.type === 'table') return [c.columns, ...c.rows].map(r => r.join('\t')).join('\n')
  if (c.type === 'board' || c.type === 'image') return ''
  return c.markdown
}

export default function AssistantSidePanel(p: SidePanelProps) {
  const key = p.storageKey ?? 'ewb-assistant-side'
  const [width, setWidth] = useState(() => { const v = Number(store()?.getItem(key + '-w')); return v >= MIN_W && v <= MAX_W ? v : DEF_W })
  const [folded, setFolded] = useState(() => { const v = store()?.getItem(key + '-fold'); if (v === '1') return true; if (v === '0') return false; return !!p.foldBelow && window.innerWidth < p.foldBelow })
  const setFoldedByUser = (f: boolean) => { try { store()?.setItem(key + '-fold', f ? '1' : '0') } catch { /* 忽略 */ } setFolded(f) }
  // 在画布上点了卡片：卡片详情要看得到，收起的话自动展开
  useEffect(() => { if (p.mode === 'card' && p.node) setFolded(false) }, [p.mode, p.node?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0)
  const [tpls, setTpls] = useState<{ student: Array<{ id: string; name: string }>; parent: Array<{ id: string; name: string }> } | null>(null)
  const [rerendering, setRerendering] = useState(false)
  useEffect(() => { if (p.onRerenderCard && !tpls) void window.api.cards.templates().then((r: any) => setTpls({ student: r.student, parent: r.parent })).catch(() => {}) }, [p.onRerenderCard, tpls])
  const widthRef = useRef(width); widthRef.current = width
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(t) }, [])

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const sx = e.clientX, w0 = widthRef.current
    const move = (ev: PointerEvent) => setWidth(Math.min(MAX_W, Math.max(MIN_W, w0 + (sx - ev.clientX))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { store()?.setItem(key + '-w', String(widthRef.current)) } catch { /* 忽略 */ } }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const w = Math.min(MAX_W, Math.max(MIN_W, widthRef.current + (e.key === 'ArrowLeft' ? 24 : -24)))
    setWidth(w); try { store()?.setItem(key + '-w', String(w)) } catch { /* 忽略 */ }
  }

  if (folded) {
    return (
      <aside className="ewb-side ewb-side--folded" data-testid="side-panel" data-folded="1" data-mode={p.mode} aria-label="右侧面板（已折叠）">
        <button type="button" className="ewb-side__fold" onClick={() => setFoldedByUser(false)} aria-label="展开右侧面板" data-testid="side-unfold"><PanelRightOpen size={16} strokeWidth={1.9} /></button>
        <span className="ewb-side__vert">{p.mode === 'card' ? '卡片详情' : `产出 ${p.outputs.length}`}</span>
      </aside>
    )
  }

  const active = p.outputs.find(o => o.id === p.activeOutputId) ?? null
  const showCard = p.mode === 'card' && p.node
  const doCopy = () => {
    if (!active) return
    if (p.onCopy) p.onCopy(active.id)
    else try { void navigator.clipboard.writeText(copyText(p.content)) } catch { /* 剪贴板不可用 */ }
  }
  const c = p.content
  const sections = active && p.content && (p.content.type === 'md' || p.content.type === 'note') ? p.content : null
  const writingText = active?.status === 'writing'
    ? (sections && (sections.total ?? active.total) ? `正在写 第 ${Math.min(sections.written + 1, (sections.total ?? active.total)!)}/${sections.total ?? active.total} 节` : `正在写 · 已写 ${sections?.written ?? active.written ?? 0} 节`)
    : null

  return (
    <aside className="ewb-side" style={{ width }} data-testid="side-panel" data-mode={p.mode} aria-label={p.title ?? '产出与卡片详情'}>
      <div className="ewb-side__resize" role="separator" aria-orientation="vertical" aria-label="拖动调整面板宽度" aria-valuenow={width} aria-valuemin={MIN_W} aria-valuemax={MAX_W} tabIndex={0}
        onPointerDown={startDrag} onKeyDown={onResizeKey} data-testid="side-resize" />
      <div className="ewb-side__head">
        <div className="ewb-side__seg" role="tablist" aria-label="面板内容">
          <button type="button" role="tab" aria-selected={p.mode === 'outputs'} data-testid="side-mode-outputs" onClick={() => p.onModeChange('outputs')}>产出</button>
          <button type="button" role="tab" aria-selected={p.mode === 'card'} data-testid="side-mode-card" disabled={!p.node} title={p.node ? undefined : '在画布上点一张卡片'} onClick={() => p.onModeChange('card')}>卡片详情</button>
        </div>
        <span className="ewb-side__grow" />
        <span className="ewb-side__meta">{p.mode === 'card' && p.node ? p.node.title.slice(0, 12) : `${p.outputs.length} 个文件`}</span>
        <button type="button" className="ewb-side__fold" onClick={() => setFoldedByUser(true)} aria-label="折叠右侧面板" data-testid="side-fold"><PanelRightClose size={16} strokeWidth={1.9} /></button>
      </div>

      {showCard ? (
        <>
          <div className="ewb-side__body"><CardDetail node={p.node!} nodes={p.nodes} branchNames={p.branchNames} onAskFrom={p.onAskFrom} onAction={p.onAction} onOpenRef={p.onOpenRef} /></div>
          <div className="ewb-side__files ewb-side__files--line" data-testid="side-card-outputs">
            <b>产出</b><span>{p.outputs.length ? p.outputs.map(o => o.name).join(' · ') : '还没有'}</span>
          </div>
        </>
      ) : (
        <>
          {p.outputs.length === 0 ? (
            <div className="ewb-side__body"><div className="ewb-side__empty" data-testid="side-empty">还没有产出。让助手写汇报、出看板或生成名单后，会出现在这里。</div></div>
          ) : (
            <>
              <div className="ewb-side__tabs" role="tablist" aria-label="产出文件">
                {p.outputs.map(o => (
                  <button key={o.id} type="button" role="tab" aria-selected={o.id === p.activeOutputId} data-testid={`out-tab-${o.id}`} data-status={o.status} onClick={() => p.onActiveOutputChange(o.id)} title={o.name}>
                    <em aria-hidden>{React.createElement(TYPE_ICON[o.type], { size: 13, strokeWidth: 1.9 })}</em><span>{o.name}</span>{o.status === 'writing' && <i className="ewb-cv-pulse" aria-label="正在写" />}
                  </button>
                ))}
              </div>
              <div className="ewb-side__body" data-testid="out-preview" data-output-id={active?.id}>
                {writingText && <div className="ewb-side__writing" data-testid="out-writing" role="status">{writingText}</div>}
                {!c ? <div className="ewb-side__empty">加载中…</div>
                  : c.type === 'board' ? (p.renderBoard ? p.renderBoard(c.boardId) : <div className="ewb-side__empty">看板在这里显示（{c.boardId}）</div>)
                  : c.type === 'image' ? <div className="ewb-side__imgwrap"><img src={c.dataUrl} alt={active?.name ?? '卡片'} data-testid="out-image" style={{ display: 'block', maxWidth: '100%', margin: '0 auto', borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,.15)' }} /></div>
                  : c.type === 'table' ? (
                    <div className="ewb-side__tablewrap">
                      <table className="ewb-md__table" data-testid="out-table">
                        <thead><tr>{c.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                        <tbody>{c.rows.map((r, i) => <tr key={i}>{c.columns.map((_, k) => <td key={k}>{r[k] ?? ''}</td>)}</tr>)}</tbody>
                      </table>
                      <div className="ewb-side__meta">共 {c.totalRows} 行{c.totalRows > c.rows.length ? `，预览前 ${c.rows.length} 行` : ''}</div>
                    </div>
                  ) : <OutputMarkdown markdown={c.markdown} onOpenRef={r => p.onOpenRef(r)} />}
              </div>
              <div className="ewb-side__files" data-testid="out-files">
                {p.outputs.map(o => (
                  <button key={o.id} type="button" className="ewb-side__file" data-active={o.id === p.activeOutputId ? '1' : undefined} onClick={() => p.onActiveOutputChange(o.id)}>
                    <b>{o.name}</b><span>{o.status === 'writing' ? '写作中' : '已完成'} · {relTime(o.updatedAt)}</span>
                  </button>
                ))}
              </div>
              <div className="ewb-side__foot" data-testid="out-actions">
                {active && formatsOf(active.type).map(([f, label], i) => <button key={f} type="button" className={`ewb-side__btn${i === 0 ? ' ewb-side__btn--pri' : ''}`} disabled={active.status === 'writing' && active.type !== 'table'} onClick={() => p.onExport(active.id, f)} data-testid={`out-export-${f}`}><Download size={12} strokeWidth={1.9} aria-hidden /> {label}</button>)}
                {active && active.type === 'image' && active.card && p.onRerenderCard && tpls && (
                  <label className="ewb-side__tpl" data-testid="out-card-template">
                    <span>模板</span>
                    <select value={active.card.templateId} disabled={rerendering} aria-label="换模板" data-testid="out-card-template-select"
                      onChange={e => { const tid = e.target.value; setRerendering(true); void p.onRerenderCard!(active.id, tid).finally(() => setRerendering(false)) }}>
                      {(active.card.audience === 'parent' ? tpls.parent : tpls.student).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    {rerendering && <span className="ewb-side__tplbusy">正在重画…</span>}
                  </label>
                )}
                {active && active.type === 'image' && <>
                  <button type="button" className="ewb-side__btn ewb-side__btn--pri" onClick={() => p.onCopyImage?.(active.id)} data-testid="out-copy-image"><Copy size={12} strokeWidth={1.9} aria-hidden /> 复制图片</button>
                  <button type="button" className="ewb-side__btn" onClick={() => p.onSaveImage?.(active.id)} data-testid="out-save-image"><Download size={12} strokeWidth={1.9} aria-hidden /> 保存图片</button>
                  <button type="button" className="ewb-side__btn" onClick={() => p.onSendWecom?.(active.id)} data-testid="out-send-wecom"><Send size={12} strokeWidth={1.9} aria-hidden /> 发到企业微信</button>
                </>}
                {active && active.type !== 'board' && active.type !== 'image' && <button type="button" className="ewb-side__btn" onClick={doCopy} data-testid="out-copy"><Copy size={12} strokeWidth={1.9} aria-hidden /> 复制</button>}
                {active && active.type !== 'board' && <button type="button" className="ewb-side__btn" onClick={() => p.onReveal(active.id)} data-testid="out-reveal"><FolderOpen size={12} strokeWidth={1.9} aria-hidden /> 在文件夹中显示</button>}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  )
}
