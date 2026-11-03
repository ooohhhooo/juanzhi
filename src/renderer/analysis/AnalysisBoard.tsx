/**
 * 分析看板：按规格（src/main/analysis/report/spec.ts）渲染。
 * 顶部「核心发现」，下面是章节（解读 + 图表 / 表格 / 文字 / 指标卡），最后「口径说明」。
 * 图表是纯函数 renderChartSvg 生成的 SVG（和网页导出同一套），容器宽度变化时按实际宽度重画，窄窗口文字不会缩得看不清。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { markdownToHtml } from '../../shared/mdhtml'
import { CHART_CSS, renderChartSvg } from '../../main/analysis/report/chart-svg'
import { formatCell, isHighlighted, type Block, type BoardSpec, type Chart, type TableBlock } from '../../main/analysis/report/spec'
import './analysis-board.css'

export interface AnalysisBoardProps {
  spec: BoardSpec
  /** 点「出处」标签时回调（参数是查询记录 id）；不传则只显示标签 */
  onSource?: (queryId: string) => void
  /** 有这个回调才显示「导出」按钮 */
  onExport?: (format: 'xlsx' | 'html' | 'docx') => void
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [w, setW] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const set = (): void => { const x = Math.round(el.clientWidth / 20) * 20; if (x > 0) setW(prev => (prev === x ? prev : x)) }
    set()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function ChartView({ chart }: { chart: Chart }): React.ReactElement {
  const [ref, w] = useWidth<HTMLDivElement>()
  const svg = useMemo(() => renderChartSvg(chart, { width: Math.min(960, Math.max(320, w)) }), [chart, w])
  return <div ref={ref} className="rb-chartbox" data-testid="rb-chart" data-kind={chart.kind} dangerouslySetInnerHTML={{ __html: svg }} />
}

function SourceTag({ id, onSource }: { id: string; onSource?: (q: string) => void }): React.ReactElement {
  return onSource
    ? <button type="button" className="rb-src" data-testid="rb-source" onClick={() => onSource(id)} title="点开看这个数字是怎么查出来的">出处</button>
    : <span className="rb-src rb-src--static" data-testid="rb-source" title={`查询记录 ${id}`}>出处</span>
}

export function TableView({ block, onSource }: { block: TableBlock; onSource?: (q: string) => void }): React.ReactElement {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const rows = useMemo(() => {
    if (!sort) return block.rows
    const k = sort.key
    return [...block.rows].sort((a, b) => {
      const x = a[k], y = b[k]
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh')) * sort.dir
    })
  }, [block.rows, sort])
  return (
    <div className="rb-block">
      {(block.title || block.source) && <h4 className="rb-h4">{block.title}{block.source && <SourceTag id={block.source.queryId} onSource={onSource} />}</h4>}
      <div className="rb-tablewrap">
        <table className="rb-table" data-testid="rb-table">
          <thead><tr>{block.columns.map(c => {
            const num = !!c.format && c.format !== 'text'
            const on = sort?.key === c.key
            return (
              <th key={c.key} className={num ? 'rb-num' : ''} aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="rb-th" onClick={() => setSort(on ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                  {c.label}<span aria-hidden className="rb-sortmark">{on ? (sort!.dir === 1 ? '↑' : '↓') : ''}</span>
                </button>
              </th>
            )
          })}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} className={isHighlighted(r, block.columns, block.highlight) ? 'rb-hi' : ''}>
              {block.columns.map(c => <td key={c.key} className={typeof r[c.key] === 'number' ? 'rb-num' : ''}>{formatCell(r[c.key], c.format)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

function BlockView({ b, onSource }: { b: Block; onSource?: (q: string) => void }): React.ReactElement {
  switch (b.type) {
    case 'chart':
      return (
        <figure className="rb-block rb-figure">
          <h4 className="rb-h4">{b.chart.title}{b.source && <SourceTag id={b.source.queryId} onSource={onSource} />}</h4>
          <ChartView chart={b.chart} />
          {b.chart.notes && <figcaption className="rb-note">{b.chart.notes}</figcaption>}
        </figure>
      )
    case 'table': return <TableView block={b} onSource={onSource} />
    case 'text': return <div className="rb-block rb-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(b.markdown) }} />
    case 'kpi':
      return (
        <div className="rb-block">
          <div className="rb-kpis" data-testid="rb-kpis">{b.items.map((k, i) => {
            const down = !!k.delta && /^[-−↓]/.test(k.delta)
            const good = k.deltaGood ? (down === (k.deltaGood === 'down')) : null
            return (
              <div key={i} className="rb-kpi">
                <span className="rb-kpi__label">{k.label}</span>
                <b className="rb-kpi__value">{k.value}</b>
                {k.delta && <span className={`rb-kpi__delta${good === null ? '' : good ? ' rb-good' : ' rb-bad'}`}>{k.delta}</span>}
              </div>
            )
          })}</div>
          {b.source && <SourceTag id={b.source.queryId} onSource={onSource} />}
        </div>
      )
  }
}

export function AnalysisBoard({ spec, onSource, onExport }: AnalysisBoardProps): React.ReactElement {
  return (
    <article className="rb-board" data-testid="analysis-board">
      <style>{CHART_CSS}</style>
      <header className="rb-head">
        <div>
          <h1 className="rb-title">{spec.title}</h1>
          {spec.subtitle && <p className="rb-sub">{spec.subtitle}</p>}
          {spec.dataNote && <p className="rb-note">数据范围：{spec.dataNote}</p>}
        </div>
        {onExport && (
          <div className="rb-actions">
            <button type="button" className="rb-btn" data-testid="rb-export-xlsx" onClick={() => onExport('xlsx')}>导出 Excel</button>
            <button type="button" className="rb-btn" data-testid="rb-export-html" onClick={() => onExport('html')}>导出网页</button>
            <button type="button" className="rb-btn" data-testid="rb-export-docx" onClick={() => onExport('docx')}>导出 Word</button>
          </div>
        )}
      </header>
      {spec.findings.length > 0 && (
        <section className="rb-findings" data-testid="rb-findings" aria-label="核心发现">
          {spec.findings.map((f, i) => (
            <div key={i} className="rb-finding"><span className="rb-finding__no">{i + 1}</span><h3>{f.title}</h3><p>{f.body}</p></div>
          ))}
        </section>
      )}
      {spec.sections.map(s => (
        <section key={s.id} id={s.id} className="rb-section" data-testid="rb-section">
          <h2 className="rb-h2">{s.title}</h2>
          {s.intro && <p className="rb-intro">{s.intro}</p>}
          {s.blocks.map((b, i) => <BlockView key={i} b={b} onSource={onSource} />)}
        </section>
      ))}
      {spec.caliber.length > 0 && (
        <section className="rb-section rb-caliber" data-testid="rb-caliber">
          <h2 className="rb-h2">口径说明</h2>
          <ol>{spec.caliber.map((c, i) => <li key={i}>{c}</li>)}</ol>
        </section>
      )}
    </article>
  )
}

export default AnalysisBoard
