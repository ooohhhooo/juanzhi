import React, { useState } from 'react'
import { padBox } from '../../shared/crop'
import '../design/page-analysis.css'

export interface PageLike { paperId: string; pageRel: string | null; pageW: number; pageH: number; bbox: number[] | null }

/**
 * 原卷截图：（注意：容器不能有 border——绝对定位的子元素按「内边距盒」折算百分比，1px 边框会让裁切错位约一行，
 * 所以外框用 box-shadow）不在主进程裁图，直接用整页图加 CSS 定位——页面图放大到 1/bbox.w 倍，再平移让 bbox 的左上角对齐容器左上角。
 * 没有 bbox 时显示整页缩略图并注明；没有页面图（比如 Word 试卷）时给出说明。
 */
export default function CropImage({ q, width = 260, onOpen, testid }: { q: PageLike; width?: number; onOpen?: () => void; testid?: string }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  if (!q.pageRel) return <div data-testid={testid} className="ewb-ana-nopage">没有原卷页面图（Word 试卷或页面未生成），无法截图</div>
  // 图片一旦加载好就以它的自然尺寸为准（库里记的页面尺寸和图片宽高比对不上时，比如带 EXIF 旋转的照片，按库里的会变形）
  const pw = nat?.w || q.pageW || 0
  const ph = nat?.h || q.pageH || 0
  const src = `ewb://page/${q.paperId}/${q.pageRel}`
  // 裁切框和导出截图（Markdown / PDF / Word）用同一个算法：左右留一点白、上下留半行白、右边不带出同一行的下一题
  const padded = padBox(q.bbox)
  const hasBox = !!padded
  if (!hasBox) {
    return (
      <div data-testid={testid} data-mode="page" className="ewb-ana-page" style={{ width }}>
        <img src={src} alt="整页缩略图" onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onClick={onOpen} draggable={false}
          style={{ cursor: onOpen ? 'zoom-in' : 'default' }} />
        <div className="ewb-ana-meta" style={{ marginTop: 2 }}>这道题没有定位框，显示的是整页缩略图</div>
      </div>
    )
  }
  const [x, y, w, h] = padded!
  // 容器宽高比 = bbox 的真实像素宽高比；页面尺寸未知时先按图片自然尺寸，加载前占位
  const ratio = pw && ph ? (w * pw) / (h * ph) : 4
  return (
    <div data-testid={testid} data-mode="crop" data-bbox={JSON.stringify(q.bbox)} onClick={onOpen} className={`ewb-ana-crop${onOpen ? ' ewb-ana-crop--click' : ''}`}
      style={{ position: 'relative', width, aspectRatio: String(ratio), overflow: 'hidden' }}>
      <img src={src} alt="题目截图" draggable={false} onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={{ position: 'absolute', width: `${100 / w}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%`, maxWidth: 'none', userSelect: 'none' }} />
      {onOpen && <span data-testid="zoom-hint" className="ewb-ana-crop__hint">点击放大</span>}
    </div>
  )
}
