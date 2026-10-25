import React, { useState } from 'react'

export interface PageLike { paperId: string; pageRel: string | null; pageW: number; pageH: number; bbox: number[] | null }

/**
 * 原卷截图：（注意：容器不能有 border——绝对定位的子元素按「内边距盒」折算百分比，1px 边框会让裁切错位约一行，
 * 所以外框用 box-shadow）不在主进程裁图，直接用整页图加 CSS 定位——页面图放大到 1/bbox.w 倍，再平移让 bbox 的左上角对齐容器左上角。
 * 没有 bbox 时显示整页缩略图并注明；没有页面图（比如 Word 试卷）时给出说明。
 */
export default function CropImage({ q, width = 260, onOpen, testid }: { q: PageLike; width?: number; onOpen?: () => void; testid?: string }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  if (!q.pageRel) return <div data-testid={testid} style={{ fontSize: 12, color: '#999' }}>没有原卷页面图（Word 试卷或页面未生成），无法截图</div>
  // 图片一旦加载好就以它的自然尺寸为准（库里记的页面尺寸和图片宽高比对不上时，比如带 EXIF 旋转的照片，按库里的会变形）
  const pw = nat?.w || q.pageW || 0
  const ph = nat?.h || q.pageH || 0
  const src = `ewb://page/${q.paperId}/${q.pageRel}`
  const hasBox = !!q.bbox && q.bbox.length === 4 && q.bbox[2] > 0 && q.bbox[3] > 0
  if (!hasBox) {
    return (
      <div data-testid={testid} data-mode="page" style={{ width }}>
        <img src={src} alt="整页缩略图" onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onClick={onOpen} draggable={false}
          style={{ width: '100%', display: 'block', border: '1px solid #eee', cursor: onOpen ? 'zoom-in' : 'default' }} />
        <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>这道题没有定位框，显示的是整页缩略图</div>
      </div>
    )
  }
  const [x, y, w, h] = q.bbox!
  // 容器宽高比 = bbox 的真实像素宽高比；页面尺寸未知时先按图片自然尺寸，加载前占位
  const ratio = pw && ph ? (w * pw) / (h * ph) : 4
  return (
    <div data-testid={testid} data-mode="crop" data-bbox={JSON.stringify(q.bbox)} onClick={onOpen}
      style={{ position: 'relative', width, aspectRatio: String(ratio), overflow: 'hidden', boxShadow: '0 0 0 1px #e5e5e5', background: '#fafafa', cursor: onOpen ? 'zoom-in' : 'default' }}>
      <img src={src} alt="题目截图" draggable={false} onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={{ position: 'absolute', width: `${100 / w}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%`, maxWidth: 'none', userSelect: 'none' }} />
    </div>
  )
}
