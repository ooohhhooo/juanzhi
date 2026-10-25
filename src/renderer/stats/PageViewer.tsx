import React, { useEffect, useRef } from 'react'
import { Modal } from 'antd'

export interface ViewTarget { paperId: string; paperTitle: string; no: string; pageRel: string; page_idx: number | null; bbox: number[] | null }

/** 整页原卷，当前这道题的位置用橙色框高亮并滚到可视区 */
export default function PageViewer({ target, onClose }: { target: ViewTarget | null; onClose: () => void }) {
  const hl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!target) return
    const t = setTimeout(() => hl.current?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }), 80)
    return () => clearTimeout(t)
  }, [target])
  return (
    <Modal open={!!target} onCancel={onClose} footer={null} width="min(900px, 92vw)" centered destroyOnHidden zIndex={1100}
      title={target ? `${target.paperTitle} · 第 ${target.no} 题${target.page_idx ? ` · 第 ${target.page_idx} 页` : ''}` : ''}>
      {target && (
        <div data-testid="page-viewer" style={{ maxHeight: '75vh', overflow: 'auto', background: '#f5f5f5' }}>
          <div data-box-canvas style={{ position: 'relative', width: '100%' }}>
            <img data-testid="page-viewer-img" src={`ewb://page/${target.paperId}/${target.pageRel}`} alt="原卷整页" draggable={false} style={{ width: '100%', display: 'block' }} />
            {target.bbox && target.bbox.length === 4 && (
              <div ref={hl} data-testid="page-highlight" data-bbox={JSON.stringify(target.bbox)}
                style={{ position: 'absolute', left: `${target.bbox[0] * 100}%`, top: `${target.bbox[1] * 100}%`, width: `${target.bbox[2] * 100}%`, height: `${target.bbox[3] * 100}%`,
                  border: '2px solid #fa8c16', background: 'rgba(250,140,22,0.15)', pointerEvents: 'none', boxSizing: 'border-box' }} />
            )}
          </div>
          {!target.bbox && <div style={{ padding: 8, fontSize: 12, color: '#999' }}>这道题没有定位框，无法高亮</div>}
        </div>
      )}
    </Modal>
  )
}
