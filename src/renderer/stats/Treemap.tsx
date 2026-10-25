import React, { useMemo } from 'react'
import { squarify } from '../../shared/treemap'

export interface TreeCell { id: string; label: string; value: number; rate: number | null; drillable: boolean; own?: boolean }

const heat = (rate: number | null) => {
  // 出现率越高颜色越深（蓝）。没有出现率（本级直接标注）用灰
  if (rate === null) return '#e8e8e8'
  const t = Math.max(0, Math.min(1, rate))
  const l = 92 - t * 48
  return `hsl(215, 70%, ${l}%)`
}

/** 知识点 treemap：面积 = 所选口径（分值 / 题数），颜色深浅 = 出现率。纯 DOM，方便断言每个格子的位置与大小 */
export default function Treemap({ cells, aspect = 2.2, onDrill }: { cells: TreeCell[]; aspect?: number; onDrill: (id: string) => void }) {
  const rects = useMemo(() => squarify(cells.map(c => ({ id: c.id, value: c.value })), aspect), [cells, aspect])
  const byId = new Map(cells.map(c => [c.id, c]))
  return (
    <div data-testid="treemap" style={{ position: 'relative', width: '100%', aspectRatio: String(aspect), background: '#fafafa', border: '1px solid #eee' }}>
      {rects.map(r => {
        const c = byId.get(r.id)!
        const dark = (c.rate ?? 0) > 0.55
        return (
          <div key={r.id} title={`${c.label}：${c.value}${c.rate !== null ? `，出现率 ${Math.round(c.rate * 1000) / 10}%` : ''}`} data-testid={`treemap-cell-${r.id}`} data-value={c.value} data-rate={c.rate ?? ''} data-drillable={c.drillable ? '1' : '0'}
            role={c.drillable ? 'button' : undefined} onClick={c.drillable ? () => onDrill(r.id) : undefined}
            style={{ position: 'absolute', left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, padding: 1, boxSizing: 'border-box' }}>
            <div style={{ width: '100%', height: '100%', background: heat(c.rate), color: dark ? '#fff' : '#1f1f1f', padding: '4px 6px', overflow: 'hidden', fontSize: 12, lineHeight: 1.35,
              cursor: c.drillable ? 'pointer' : 'default', borderRadius: 3, boxSizing: 'border-box', outline: c.drillable ? undefined : '1px dashed #bbb' }}>
              <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{c.label}{c.drillable ? ' ›' : ''}</div>
              {c.rate !== null && r.w * r.h > 0.012 && <div style={{ opacity: 0.85 }}>出现率 {Math.round(c.rate * 1000) / 10}%</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
