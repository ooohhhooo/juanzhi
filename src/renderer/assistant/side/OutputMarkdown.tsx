import React, { useMemo } from 'react'
import { parseBlocks } from '../../../shared/markdown'
import type { Inline } from '../../../shared/markdown'
import { refText, splitRefTags } from '../../../shared/agent-outputs'
import type { RefTag } from '../../../shared/agent-outputs'
import '../../design/page-report.css'
import '../assistant.css'

/**
 * 产出文档的 Markdown 预览：沿用报告页的解析器（shared/markdown）和 .ewb-md 样式；
 * 正文里的出处标签 [[query:12]] 渲染成可点的小标签（点开看这个数字是怎么来的）。
 */
export default function OutputMarkdown({ markdown, onOpenRef }: { markdown: string; onOpenRef?: (r: RefTag) => void }) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown])
  const text = (s: string, key: string | number) => splitRefTags(s).map((p, i) => 'ref' in p
    ? <button key={`${key}-${i}`} type="button" className="ewb-ref-chip" data-testid="md-ref" data-ref={`${p.ref.type}:${p.ref.id}`} onClick={() => onOpenRef?.(p.ref)} title="看这个数字的出处">{refText(p.ref)}</button>
    : <React.Fragment key={`${key}-${i}`}>{p.text}</React.Fragment>)
  const inl = (items: Inline[], key: string | number = 0) => items.map((it, i) =>
    it.type === 'bold' ? <b key={i}>{text(it.text, `${key}b${i}`)}</b> : <React.Fragment key={i}>{text(it.type === 'text' ? it.text : it.token, `${key}t${i}`)}</React.Fragment>)
  return (
    <div className="ewb-md" data-testid="output-md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': return React.createElement(`h${Math.min(b.level + 2, 6)}`, { key: i, className: b.level <= 1 ? 'ewb-md__h1' : b.level === 2 ? 'ewb-md__h2' : 'ewb-md__h3' }, text(b.text, i))
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inl(it, `${i}.${j}`)}</li>)}</ul>
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}>{inl(it, `${i}.${j}`)}</li>)}</ol>
          case 'quote': return <blockquote key={i} className="ewb-md__quote">{b.lines.map((l, j) => <div key={j}>{inl(l, `${i}.${j}`)}</div>)}</blockquote>
          case 'hr': return <hr key={i} className="ewb-md__hr" />
          case 'code': return <pre key={i} className="ewb-md__code">{b.text}</pre>
          case 'table': return (
            <div key={i} className="ewb-md__tablewrap">
              <table className="ewb-md__table">
                <thead><tr>{b.header.map((c, k) => <th key={k} style={{ textAlign: b.align[k] ?? 'left' }}>{inl(c, `${i}h${k}`)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{b.header.map((_, k) => <td key={k} style={{ textAlign: b.align[k] ?? 'left' }}>{inl(r[k] ?? [], `${i}.${j}.${k}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>)
          case 'card': return <blockquote key={i} className="ewb-md__quote"><b>{b.title}</b>{b.lines.map((l, j) => <div key={j}>{inl(l, `${i}.${j}`)}</div>)}</blockquote>
          default: return <p key={i}>{inl(b.inline, i)}</p>
        }
      })}
    </div>
  )
}
