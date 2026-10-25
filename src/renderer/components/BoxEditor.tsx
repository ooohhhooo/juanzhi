import React, { useRef, useState, useEffect } from 'react'

type Box = [number, number, number, number]

interface Props {
  bbox: Box
  /** 拖动过程中实时回调（只改界面状态） */
  onChange: (b: Box) => void
  /** 松开鼠标时回调（存库） */
  onCommit: (b: Box) => void
  color?: string
}

const MIN = 0.015
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
type Mode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

/**
 * 可拖动的题目框。位置/大小用 0–1 的归一化坐标，渲染成百分比，所以跟着图片缩放。
 * 父元素必须是 position: relative 且恰好包住图片。
 */
export function BoxEditor({ bbox, onChange, onCommit, color = '#fa8c16' }: Props) {
  const drag = useRef<{ mode: Mode; startX: number; startY: number; box: Box; rect: DOMRect } | null>(null)
  const latest = useRef<Box>(bbox)
  const [active, setActive] = useState(false)
  latest.current = bbox

  const begin = (mode: Mode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const parent = (e.currentTarget as HTMLElement).closest('[data-box-canvas]') as HTMLElement | null
    if (!parent) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mode, startX: e.clientX, startY: e.clientY, box: [...latest.current] as Box, rect: parent.getBoundingClientRect() }
    setActive(true)
  }

  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / d.rect.width
    const dy = (e.clientY - d.startY) / d.rect.height
    let [x, y, w, h] = d.box
    if (d.mode === 'move') {
      x = clamp(x + dx, 0, 1 - w)
      y = clamp(y + dy, 0, 1 - h)
    } else {
      let x0 = x, y0 = y, x1 = x + w, y1 = y + h
      if (d.mode.includes('w')) x0 = clamp(x + dx, 0, x1 - MIN)
      if (d.mode.includes('e')) x1 = clamp(x + w + dx, x0 + MIN, 1)
      if (d.mode.includes('n')) y0 = clamp(y + dy, 0, y1 - MIN)
      if (d.mode.includes('s')) y1 = clamp(y + h + dy, y0 + MIN, 1)
      x = x0; y = y0; w = x1 - x0; h = y1 - y0
    }
    const nb: Box = [round(x), round(y), round(w), round(h)]
    latest.current = nb
    onChange(nb)
  }

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
    drag.current = null
    setActive(false)
    onCommit(latest.current)
  }

  useEffect(() => () => { drag.current = null }, [])

  const handle = (mode: Mode, style: React.CSSProperties, cursor: string) => (
    <div
      data-testid={`box-handle-${mode}`}
      onPointerDown={begin(mode)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      style={{ position: 'absolute', width: 9, height: 9, background: '#fff', border: `2px solid ${color}`, borderRadius: 2, cursor, touchAction: 'none', ...style }}
    />
  )

  return (
    <div
      data-testid="bbox-current"
      data-bbox={bbox.join(',')}
      onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      style={{
        position: 'absolute', left: `${bbox[0] * 100}%`, top: `${bbox[1] * 100}%`, width: `${bbox[2] * 100}%`, height: `${bbox[3] * 100}%`,
        border: `2px solid ${color}`, background: active ? 'rgba(250,140,22,0.22)' : 'rgba(250,140,22,0.14)', borderRadius: 3,
        cursor: 'move', touchAction: 'none', boxSizing: 'border-box'
      }}
    >
      {/* 手柄全部放在框的外侧，框里面整块都是「拖动」区域（单行题的框只有十来个像素高，不能被手柄占满） */}
      {handle('nw', { left: -9, top: -9 }, 'nwse-resize')}
      {handle('ne', { right: -9, top: -9 }, 'nesw-resize')}
      {handle('sw', { left: -9, bottom: -9 }, 'nesw-resize')}
      {handle('se', { right: -9, bottom: -9 }, 'nwse-resize')}
      {handle('n', { left: 'calc(50% - 4px)', top: -9 }, 'ns-resize')}
      {handle('s', { left: 'calc(50% - 4px)', bottom: -9 }, 'ns-resize')}
      {handle('w', { left: -9, top: 'calc(50% - 4px)' }, 'ew-resize')}
      {handle('e', { right: -9, top: 'calc(50% - 4px)' }, 'ew-resize')}
    </div>
  )
}

const round = (v: number) => Math.round(v * 1000) / 1000
