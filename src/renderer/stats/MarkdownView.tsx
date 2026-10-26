import React, { useMemo } from 'react'
import { parseBlocks } from '../../shared/markdown'
import type { Inline } from '../../shared/markdown'
import CropImage from './CropImage'
import type { ViewTarget } from './PageViewer'

type Ref = CitationRef & { missing?: boolean }

/** `[试卷标题 · 题号]` 引用渲染成可点击的截图卡片：小截图 + 标签，点开看整页原卷并高亮这道题。不在索引里的引用按普通文字显示。 */
function Cite({ token, refMap, onView }: { token: string; refMap: Map<string, Ref>; onView: (t: ViewTarget) => void }) {
  const r = refMap.get(token)
  if (!r) return <span>{token}</span>
  if (r.missing) return <span title="这道题已被删除" style={{ color: '#999', textDecoration: 'line-through' }}>{token}</span>
  const open = r.pageRel ? () => onView({ paperId: r.paperId, paperTitle: r.paperTitle, no: r.no, pageRel: r.pageRel!, page_idx: r.page_idx, bbox: r.bbox }) : undefined
  return (
    <span data-testid="cite-card" data-token={token} data-qid={r.questionId} role="button" tabIndex={0} onClick={open} onKeyDown={e => { if (e.key === 'Enter') open?.() }}
      style={{ display: 'inline-block', verticalAlign: 'top', margin: '2px 4px', padding: 4, border: '1px solid #d6e4ff', borderRadius: 6, background: '#f7faff', cursor: open ? 'pointer' : 'default', maxWidth: 190 }}>
      <span style={{ display: 'block', fontSize: 11, color: '#1d39c4', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.paperTitle} · {r.no}（{r.qtypeName}）</span>
      <CropImage q={{ paperId: r.paperId, pageRel: r.pageRel, pageW: r.pageW, pageH: r.pageH, bbox: r.bbox }} width={170} />
    </span>
  )
}

export default function MarkdownView({ markdown, refs, onView }: { markdown: string; refs: Ref[]; onView: (t: ViewTarget) => void }) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown])
  const refMap = useMemo(() => new Map(refs.map(r => [r.token, r])), [refs])
  const inl = (items: Inline[]) => items.map((it, i) => it.type === 'text' ? <React.Fragment key={i}>{it.text}</React.Fragment>
    : it.type === 'bold' ? <b key={i}>{it.text}</b> : <Cite key={i} token={it.token} refMap={refMap} onView={onView} />)
  return (
    <div data-testid="md" style={{ fontSize: 14, lineHeight: 1.75 }}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': return React.createElement(`h${Math.min(b.level + 2, 6)}`, { key: i, style: { margin: '14px 0 6px', fontSize: b.level <= 2 ? 16 : 14 } }, b.text)
          case 'ul': return <ul key={i} style={{ paddingInlineStart: 22, margin: '4px 0' }}>{b.items.map((it, j) => <li key={j}>{inl(it)}</li>)}</ul>
          case 'ol': return <ol key={i} style={{ paddingInlineStart: 22, margin: '4px 0' }}>{b.items.map((it, j) => <li key={j}>{inl(it)}</li>)}</ol>
          case 'quote': return <blockquote key={i} style={{ margin: '8px 0', padding: '4px 12px', borderLeft: '3px solid #faad14', background: '#fffbe6', color: '#614700' }}>{b.lines.map((l, j) => <div key={j}>{inl(l)}</div>)}</blockquote>
          case 'hr': return <hr key={i} style={{ border: 0, borderTop: '1px solid #eee' }} />
          case 'code': return <pre key={i} style={{ background: '#f6f6f6', padding: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0' }}>{b.text}</pre>
          case 'table': return (
            <div key={i} style={{ overflowX: 'auto', margin: '6px 0' }}>
              <table data-testid="md-table" style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: '60%' }}>
                <thead><tr>{b.header.map((c, k) => <th key={k} style={{ border: '1px solid #d9d9d9', background: '#f5f7fb', padding: '3px 8px', textAlign: b.align[k] ?? 'left' }}>{inl(c)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{b.header.map((_, k) => <td key={k} style={{ border: '1px solid #e5e5e5', padding: '3px 8px', verticalAlign: 'top', textAlign: b.align[k] ?? 'left' }}>{inl(r[k] ?? [])}</td>)}</tr>)}</tbody>
              </table>
            </div>)
          default: return <p key={i} style={{ margin: '6px 0' }}>{inl(b.inline)}</p>
        }
      })}
    </div>
  )
}
