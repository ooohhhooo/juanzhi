import React, { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useShowCodes } from '../hooks/useUiPrefs'
import { parseBlocks } from '../../shared/markdown'
import type { Inline } from '../../shared/markdown'
import CropImage from './CropImage'
import { MARK_CONFLICT, MARK_UNVERIFIED } from '../../shared/factcheck'
import type { ViewTarget } from './PageViewer'
import '../design/page-report.css'

type Ref = CitationRef & { missing?: boolean }

/** `[试卷标题 · 题号]` 引用渲染成可点击的截图卡片：小截图 + 标签，点开看整页原卷并高亮这道题。不在索引里的引用按普通文字显示。 */
function Cite({ token, refMap, onView }: { token: string; refMap: Map<string, Ref>; onView: (t: ViewTarget) => void }) {
  const r = refMap.get(token)
  if (!r) return <span>{token}</span>
  if (r.missing) return <span title="这道题已被删除" className="ewb-md__deleted">{token}</span>
  const open = r.pageRel ? () => onView({ paperId: r.paperId, paperTitle: r.paperTitle, no: r.no, pageRel: r.pageRel!, page_idx: r.page_idx, bbox: r.bbox }) : undefined
  // 「出自原卷」样式：卷名 + 第几题 + 完整截图（白纸）；标签允许换行、不截断；点一下放大整页原卷
  return (
    <span data-testid="cite-card" data-token={token} data-qid={r.questionId} role="button" tabIndex={0} className="ewb-cite" onClick={open} onKeyDown={e => { if (e.key === 'Enter') open?.() }}
      style={open ? undefined : { cursor: 'default' }}>
      <span data-testid="cite-label" className="ewb-cite__label">{r.paperTitle} · 第 {r.no} 题<span className="ewb-cite__type">（{r.qtypeName}）</span></span>
      <span className="ewb-cite__sheet"><CropImage q={{ paperId: r.paperId, pageRel: r.pageRel, pageW: r.pageW, pageH: r.pageH, bbox: r.bbox }} width={300} onOpen={open} /></span>
    </span>
  )
}

/** 事实核对写进正文的标记（〔未核实〕/〔与题目解释矛盾，请核对〕）画成小标签 */
function withMarks(text: string): React.ReactNode {
  if (!text.includes('〔')) return text
  const out: React.ReactNode[] = []
  let rest = text
  let k = 0
  for (;;) {
    const a = rest.indexOf(MARK_UNVERIFIED), b = rest.indexOf(MARK_CONFLICT)
    const hits = [[a, MARK_UNVERIFIED], [b, MARK_CONFLICT]].filter(h => (h[0] as number) >= 0).sort((x, y) => (x[0] as number) - (y[0] as number))
    if (!hits.length) break
    const [i, mark] = hits[0] as [number, string]
    if (i > 0) out.push(rest.slice(0, i))
    const conflict = mark === MARK_CONFLICT
    out.push(<Tooltip key={k++} title={conflict ? '这句英语规则和老师审核过的题目解释说的不一样，很可能写错了，请核对' : '这句英语规则在老师审核过的题目解释里找不到依据，请老师自己确认对不对'}>
      <span tabIndex={0} className={`ewb-etag ${conflict ? 'ewb-etag--mistake' : 'ewb-etag--thin'}`} data-testid={conflict ? 'mark-conflict' : 'mark-unverified'} style={{ marginInlineStart: 6, height: 20, verticalAlign: 'baseline' }}>{conflict ? '与题目解释矛盾' : '未核实'}</span>
    </Tooltip>)
    rest = rest.slice(i + mark.length)
  }
  if (rest) out.push(rest)
  return <>{out}</>
}

/** `### 代码｜名称` 的小标题：默认只显示名称（代码是程序内部编号） */
const headingText = (t: string, showCodes: boolean) => (showCodes ? t : t.replace(/^[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*\s*[｜|]\s*/, ''))

export default function MarkdownView({ markdown, refs, onView }: { markdown: string; refs: Ref[]; onView: (t: ViewTarget) => void }) {
  const [showCodes] = useShowCodes()
  const blocks = useMemo(() => parseBlocks(markdown), [markdown])
  const refMap = useMemo(() => new Map(refs.map(r => [r.token, r])), [refs])
  // 引用截图不夹在句子中间：句子里只留文字，这一块（段落 / 列表项 / 引用行 / 表格单元格）用到的截图集中放在它后面，做成一行缩略图
  const split = (items: Inline[]) => {
    const nodes: React.ReactNode[] = []
    const cites: string[] = []
    items.forEach((it, i) => {
      if (it.type === 'text') nodes.push(<React.Fragment key={i}>{withMarks(it.text)}</React.Fragment>)
      else if (it.type === 'bold') nodes.push(<b key={i}>{withMarks(it.text)}</b>)
      else if (refMap.get(it.token) && !refMap.get(it.token)!.missing) { if (!cites.includes(it.token)) cites.push(it.token) }
      else nodes.push(<Cite key={i} token={it.token} refMap={refMap} onView={onView} />)   // 不在索引里 / 已删除的引用：按文字显示，留在原位
    })
    return { nodes, cites }
  }
  const citeRow = (tokens: string[]) => tokens.length === 0 ? null : (
    <div className="ewb-citerow" data-testid="cite-row" aria-label="出自原卷">{tokens.map(t => <Cite key={t} token={t} refMap={refMap} onView={onView} />)}</div>
  )
  const inl = (items: Inline[]) => split(items).nodes
  return (
    <div data-testid="md" className="ewb-md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': return React.createElement(`h${Math.min(b.level + 2, 6)}`, { key: i, className: b.level <= 1 ? 'ewb-md__h1' : b.level === 2 ? 'ewb-md__h2' : 'ewb-md__h3' }, headingText(b.text, showCodes))
          case 'ul': return <ul key={i}>{b.items.map((it, j) => { const x = split(it); return <li key={j}>{x.nodes}{citeRow(x.cites)}</li> })}</ul>
          case 'ol': return <ol key={i}>{b.items.map((it, j) => { const x = split(it); return <li key={j}>{x.nodes}{citeRow(x.cites)}</li> })}</ol>
          case 'quote': return <blockquote key={i} className="ewb-md__quote">{b.lines.map((l, j) => { const x = split(l); return <div key={j}>{x.nodes}{citeRow(x.cites)}</div> })}</blockquote>
          case 'hr': return <hr key={i} className="ewb-md__hr" />
          case 'code': return <pre key={i} className="ewb-md__code">{b.text}</pre>
          case 'table': return (
            <div key={i} className="ewb-md__tablewrap">
              <table data-testid="md-table" className="ewb-md__table">
                <thead><tr>{b.header.map((c, k) => <th key={k} style={{ textAlign: b.align[k] ?? 'left' }}>{inl(c)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{b.header.map((_, k) => <td key={k} style={{ textAlign: b.align[k] ?? 'left' }}>{(() => { const x = split(r[k] ?? []); return <>{x.nodes}{citeRow(x.cites)}</> })()}</td>)}</tr>)}</tbody>
              </table>
            </div>)
          default: { const x = split(b.inline); return <React.Fragment key={i}><p>{x.nodes}</p>{citeRow(x.cites)}</React.Fragment> }
        }
      })}
    </div>
  )
}
