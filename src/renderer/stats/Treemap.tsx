import React, { useMemo } from 'react'
import { squarify } from '../../shared/treemap'
import '../design/page-analysis.css'

export interface TreeCell { id: string; label: string; value: number; rate: number | null; drillable: boolean; own?: boolean }

/** 出现率越高，主色混得越多（上限 52%：浅色、深色下配墨色文字对比度都 ≥ 4.5:1）。没有出现率（本级直接标注）用信息框底色 */
const heat = (rate: number | null) => {
  if (rate === null) return 'var(--ewb-note)'
  const t = Math.max(0, Math.min(1, rate))
  return `color-mix(in srgb, var(--ewb-primary) ${Math.round(8 + t * 44)}%, var(--ewb-page))`
}

/** 知识点 treemap：面积 = 所选口径（分值 / 题数），颜色深浅 = 出现率。纯 DOM，方便断言每个格子的位置与大小 */
export default function Treemap({ cells, aspect = 2.2, onDrill }: { cells: TreeCell[]; aspect?: number; onDrill: (id: string) => void }) {
  const rects = useMemo(() => squarify(cells.map(c => ({ id: c.id, value: c.value })), aspect), [cells, aspect])
  const byId = new Map(cells.map(c => [c.id, c]))
  return (
    <div data-testid="treemap" className="ewb-ana-tm" style={{ aspectRatio: String(aspect) }}>
      {rects.map(r => {
        const c = byId.get(r.id)!
        return (
          <div key={r.id} className="ewb-ana-tm__cell" title={`${c.label}：${c.value}${c.rate !== null ? `，${Math.round(c.rate * 1000) / 10}% 的卷子考了` : ''}`} data-testid={`treemap-cell-${r.id}`} data-value={c.value} data-rate={c.rate ?? ''} data-drillable={c.drillable ? '1' : '0'}
            role={c.drillable ? 'button' : undefined} onClick={c.drillable ? () => onDrill(r.id) : undefined}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>
            <div className={`ewb-ana-tm__inner${c.drillable ? ' ewb-ana-tm__inner--drill' : ''}${c.drillable ? '' : ' ewb-ana-tm__inner--own'}`} style={{ background: heat(c.rate) }}>
              <div className="ewb-ana-tm__name">{c.label}{c.drillable ? ' ›' : ''}</div>
              {c.rate !== null && r.w * r.h > 0.012 && <div className="ewb-ana-tm__rate">{Math.round(c.rate * 1000) / 10}% 的卷子考了</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
