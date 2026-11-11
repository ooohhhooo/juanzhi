import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { App } from 'antd'
import { Btn, UsageNote } from '../../design'
import { KpMultiSelect } from '../../components/KpTreeSelect'
import { clean } from '../../components/CourseMatch'
import type { SubjectId } from '../../../shared/subject'

/** 一个单元里的一个知识点（来自 AI，或老师手工加的） */
export interface UnitKpRow { code: string; confidence: string; quote: string; reason: string; manual: boolean }
export type UnitKpState = Record<number, UnitKpRow[]>

const CONF_LABEL: Record<string, string> = { high: '把握高', medium: '把握中', low: '推测' }
const pages = (u: { pageStart: number; pageEnd: number }) => (u.pageStart === u.pageEnd ? `第 ${u.pageStart} 页` : `第 ${u.pageStart}–${u.pageEnd} 页`)

/** 一个单元的整体把握：没有知识点，或全是低 = 需要核对 */
export const needsReview = (kps: UnitKpRow[]): boolean => kps.length === 0 || kps.every(k => k.confidence === 'low')

/**
 * 教材核对：每个单元一行（单元名、页码、选中的知识点、把握程度），默认折叠，把握低的单元展开并标出。
 * 点开一个单元可以增删知识点（只能从当前学科的知识点树里选）、对照原书那一页的缩略图和文字、确认或删除这个单元。
 */
export default function TextbookReview({ sessionId, subject, units, kpState, setKpState, confirmed, setConfirmed, keep, onDelete }: {
  sessionId: string
  subject: SubjectId
  units: CourseTextbookUnit[]
  kpState: UnitKpState
  setKpState: (fn: (s: UnitKpState) => UnitKpState) => void
  confirmed: Set<number>
  setConfirmed: (fn: (s: Set<number>) => Set<number>) => void
  /** 还在表里的单元序号（老师删掉的不显示） */
  keep: Set<number>
  onDelete: (id: number) => void
}) {
  const { message } = App.useApp()
  const { data: tree } = useQuery({ queryKey: ['taxonomy', 'tree', subject], queryFn: () => window.api.taxonomy.tree({ subject }) })
  const nameOf = new Map((tree?.kps ?? []).map(k => [k.code, k.name]))
  const list = units.filter(u => keep.has(u.id))
  const reviewIds = list.filter(u => needsReview(kpState[u.id] ?? [])).map(u => u.id)
  const [open, setOpen] = useState<Set<number>>(() => new Set(reviewIds))
  const [preview, setPreview] = useState<Record<number, { text: string; image: string | null } | 'loading'>>({})
  const toggle = (id: number) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const okIds = list.filter(u => !needsReview(kpState[u.id] ?? []) && !confirmed.has(u.id)).map(u => u.id)

  const setCodes = (id: number, codes: string[]) => setKpState(st => {
    const old = st[id] ?? []
    const byCode = new Map(old.map(k => [k.code, k]))
    return { ...st, [id]: codes.map(c => byCode.get(c) ?? { code: c, confidence: 'high', quote: '', reason: '老师手工指定', manual: true }) }
  })
  const loadPage = async (u: CourseTextbookUnit) => {
    if (preview[u.id]) return
    setPreview(p => ({ ...p, [u.id]: 'loading' }))
    try { const r = await window.api.course.textbookPage(sessionId, u.pageStart); setPreview(p => ({ ...p, [u.id]: r })) } catch (e) { setPreview(p => { const { [u.id]: _x, ...rest } = p; return rest }); message.error(clean(e)) }
  }

  return (
    <div data-testid="textbook-review">
      <div className="ewb-rep-row" style={{ margin: '8px 0', justifyContent: 'space-between' }}>
        <span data-testid="textbook-summary">共 {list.length} 个单元；{reviewIds.length ? <b>{reviewIds.length} 个把握不高，已展开，请重点核对</b> : '都有明确的依据'}。已确认 {list.filter(u => confirmed.has(u.id)).length} 个。</span>
        <Btn tone="secondary" size="small" disabled={!okIds.length} data-testid="textbook-confirm-rest" onClick={() => setConfirmed(s => new Set([...s, ...okIds]))}>其余全部确认（{okIds.length} 个）</Btn>
      </div>
      <UsageNote kind="tip">每个单元只列 2–8 个知识点，都来自当前学科的知识点树。点单元名展开：可以增删知识点、看原书那几页。确认过的单元保存后锁定，之后重新匹配不会改动它们。</UsageNote>
      <div className="ewb-tb-list" data-testid="textbook-units">
        {list.map(u => {
          const kps = kpState[u.id] ?? []
          const review = needsReview(kps)
          const isOpen = open.has(u.id)
          const pv = preview[u.id]
          return (
            <section key={u.id} className="ewb-tb-unit" data-testid={`textbook-unit-${u.id}`} data-review={review} data-open={isOpen} data-confirmed={confirmed.has(u.id)}>
              <button type="button" className="ewb-tb-unit__head" aria-expanded={isOpen} data-testid={`textbook-unit-toggle-${u.id}`} onClick={() => toggle(u.id)}>
                <span className="ewb-tb-unit__no">{u.id}</span>
                <span className="ewb-tb-unit__title">{u.title}</span>
                <span className="ewb-rep-note">{pages(u)}</span>
                <span className="ewb-tb-unit__kps">{kps.length ? kps.slice(0, 3).map(k => nameOf.get(k.code) ?? k.code).join('、') + (kps.length > 3 ? ` 等 ${kps.length} 个` : '') : '（没有挑出知识点）'}</span>
                {review ? <span className="ewb-ana-pill ewb-ana-pill--warn" data-testid={`textbook-unit-flag-${u.id}`}>需核对</span> : confirmed.has(u.id) ? <span className="ewb-ana-pill ewb-ana-pill--primary">已确认</span> : <span className="ewb-ana-pill ewb-ana-pill--quiet">{CONF_LABEL[kps.find(k => k.confidence !== 'low')?.confidence ?? 'low']}</span>}
              </button>
              {isOpen && (
                <div className="ewb-tb-unit__body">
                  <div className="ewb-crs-field">
                    <span className="ewb-crs-field__label">这个单元的知识点（最多 8 个）</span>
                    <KpMultiSelect kps={tree?.kps} value={kps.map(k => k.code)} max={8} placeholder="从知识点树里选，可以直接打字搜" onChange={codes => setCodes(u.id, codes)} />
                  </div>
                  <ul className="ewb-tb-kps">
                    {kps.map(k => (
                      <li key={k.code}><b>{nameOf.get(k.code) ?? k.code}</b>　<span className="ewb-ana-pill ewb-ana-pill--quiet">{k.manual ? '老师指定' : CONF_LABEL[k.confidence] ?? k.confidence}</span>{k.quote ? <span className="ewb-rep-note">　依据：「{k.quote}」</span> : k.reason ? <span className="ewb-rep-note">　{k.reason}</span> : null}</li>
                    ))}
                  </ul>
                  {u.headings.length > 0 && <p className="ewb-rep-note">这个单元读到的小节标题：{u.headings.slice(0, 12).join(' / ')}{u.headings.length > 12 ? ' ……' : ''}</p>}
                  <div className="ewb-rep-row">
                    <Btn tone="quiet" size="small" data-testid={`textbook-unit-page-${u.id}`} loading={pv === 'loading'} disabled={u.pageStart < 1} onClick={() => void loadPage(u)}>看原书{pages(u).replace(/–.*页/, ' 页')}</Btn>
                    <Btn tone={confirmed.has(u.id) ? 'secondary' : 'primary'} size="small" data-testid={`textbook-unit-confirm-${u.id}`} onClick={() => setConfirmed(s => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n })}>{confirmed.has(u.id) ? '取消确认' : '确认这个单元'}</Btn>
                    <Btn tone="danger" size="small" data-testid={`textbook-unit-delete-${u.id}`} onClick={() => onDelete(u.id)}>删除这个单元</Btn>
                  </div>
                  {pv && pv !== 'loading' && (
                    <div className="ewb-tb-page" data-testid={`textbook-unit-preview-${u.id}`}>
                      {pv.image && <img src={pv.image} alt={`原书${pages(u)}`} />}
                      {pv.text && <pre>{pv.text.slice(0, 1200)}</pre>}
                      {!pv.image && !pv.text && <span className="ewb-rep-note">这一页读不出内容。</span>}
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
