import React, { useMemo, useState } from 'react'
import { App, Segmented, Spin } from 'antd'
import { Download } from 'lucide-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import Treemap from '../../stats/Treemap'
import type { TreeCell } from '../../stats/Treemap'
import { CoverageNote, Est, EmptyStats, NotCounted } from '../../stats/Parts'
import { LEVEL_LABEL, clean, pct } from '../../stats/format'
import { useScopeGuide, useStatsFilter } from '../../stats/StatsFilter'
import KpDetailDrawer from '../../stats/KpDetailDrawer'
import { appearText } from '../../../shared/plain-text'
import { Btn, categoryOfCode, CATEGORY_BY_KEY, PageTurn, Panel, ThumbIndex, CATEGORIES, UsageNote } from '../../design'
import type { CategoryKey } from '../../design'
import '../../design/page-analysis.css'

export default function DistributionTab() {
  const { filter } = useStatsFilter()
  const { message } = App.useApp()
  const { data: d, isLoading } = useQuery({ queryKey: ['stats', 'distribution', filter], queryFn: () => window.api.stats.distribution(filter), placeholderData: keepPreviousData })
  const [path, setPath] = useState<string[]>([])
  const [metric, setMetric] = useState<'score' | 'count'>('score')
  const [freqLevel, setFreqLevel] = useState(2)
  const [mxLevel, setMxLevel] = useState(1)
  const [cat, setCat] = useState<CategoryKey | null>(null)
  const [order, setOrder] = useState(0)
  const [openCode, setOpenCode] = useState<string | null>(null)
  const { data: mx } = useQuery({ queryKey: ['stats', 'matrix', filter, mxLevel], queryFn: () => window.api.stats.matrix(filter, mxLevel), placeholderData: keepPreviousData })

  const nodes = d?.nodes ?? []
  const byCode = useMemo(() => new Map(nodes.map(n => [n.code, n])), [nodes])
  // 路径里的节点若因筛选变化已不存在，退回到仍然存在的最深一层
  const validPath = useMemo(() => { const out: string[] = []; for (const c of path) { if (byCode.has(c)) out.push(c); else break } return out }, [path, byCode])
  const cur = validPath.length ? validPath[validPath.length - 1] : null

  const cells: TreeCell[] = useMemo(() => {
    const kids = nodes.filter(n => (n.parent_code ?? null) === cur)
    const hasKids = (code: string) => nodes.some(n => n.parent_code === code)
    const val = (s: { score: number; primQuestions: number }) => (metric === 'score' ? s.score : s.primQuestions)
    const out: TreeCell[] = kids.map(k => ({ id: k.code, label: k.name, value: val(k), rate: k.rate, drillable: hasKids(k.code) }))
    const me = cur ? byCode.get(cur) : null
    if (me) {
      const own = metric === 'score' ? me.ownScore : me.ownPrim
      if (own > 0) out.push({ id: `${cur}#own`, label: `${me.name}（本级直接标注）`, value: own, rate: null, drillable: false, own: true })
    }
    return out.filter(c => c.value > 0)
  }, [nodes, cur, metric, byCode])

  const levelNodes = useMemo(() => nodes.filter(n => n.level === freqLevel).sort((a, b) => b.rate - a.rate || b.questions - a.questions || (a.code < b.code ? -1 : 1)), [nodes, freqLevel])
  const catCounts = useMemo(() => { const m: Partial<Record<CategoryKey, number>> = {}; for (const n of levelNodes) { const k = categoryOfCode(n.code); if (k) m[k] = (m[k] ?? 0) + 1 } return m }, [levelNodes])
  const freq = useMemo(() => levelNodes.filter(n => cat === null || categoryOfCode(n.code) === cat).slice(0, 15), [levelNodes, cat])

  // 书眉：本页第一个和最后一个知识点
  useScopeGuide(freq[0]?.name, freq.length > 1 ? freq[freq.length - 1].name : undefined)

  if (isLoading || !d) return <Spin style={{ margin: 40 }} />
  if (d.papers === 0) return <EmptyStats pending={d.pendingReviewing} />

  const exportCsv = async () => {
    try {
      const r = await window.api.stats.exportMatrix(filter, mxLevel)
      if (r.saved) message.success(`已导出：${r.path}`)
    } catch (e) { message.error(`导出失败：${clean(e)}`) }
  }
  const mxCell = (row: string, col: string) => mx?.cells.find(c => c.row === row && c.col === col)
  const maxQ = Math.max(1, ...d.qtypes.map(q => q.questions))
  const maxD = Math.max(1, ...d.difficulty.map(x => x.questions))
  const pick = (k: CategoryKey) => { if (k === cat) { setCat(null); return } setCat(k); setOrder(CATEGORIES.findIndex(c => c.key === k)) }

  // 卷子少于 5 份时，「考了几份」的条几乎一样长，没有信息量：不画条形，按几份卷子考到分组列出
  const small = d.papers < 5
  const groups = (() => {
    const m = new Map<number, typeof freq>()
    for (const n of freq) m.set(n.papers, [...(m.get(n.papers) ?? []), n])
    return [...m.entries()].sort((a, b) => b[0] - a[0])
  })()

  return (
    <div className={`ewb-ana-dist-layout${small ? ' ewb-ana-dist-layout--flat' : ''}`}>
    <div className="ewb-ana-dist-main">
      <NotCounted />
      <div className="ewb-ana-pills" data-testid="dist-summary">
        <span className="ewb-ana-pill ewb-ana-pill--primary" data-testid="dist-papers">试卷 {d.papers} 份</span>
        <span className="ewb-ana-pill" data-testid="dist-questions">题目 {d.questions} 道</span>
        <span className="ewb-ana-pill" data-testid="dist-total-score">总分合计 {d.totalScore}（仅含有分值的题）</span>
        <CoverageNote c={d.coverage} />
        {d.coverage.tagged < d.questions && <span className="ewb-ana-pill ewb-ana-pill--warn">{d.questions - d.coverage.tagged} 道题没有标“主要考的知识点”</span>}
      </div>

      <Panel title="哪些知识点考得多（考了几份卷子）" aside={<Segmented data-testid="freq-level" value={freqLevel} onChange={v => { setFreqLevel(v as number); setCat(null) }} options={[1, 2, 3].map(l => ({ label: LEVEL_LABEL[l], value: l }))} />}>
        <PageTurn pageKey={`${freqLevel}-${cat ?? 'all'}`} order={order}>
          {freq.length === 0 ? <div className="ewb-ana-muted">这一层级{cat ? `的${CATEGORY_BY_KEY[cat].label}类` : ''}没有知识点</div> : small ? (
            <div data-testid="freq-flat">
              <UsageNote kind="tip">只有 {d.papers} 份卷子，“考了几份”的条几乎一样长，没有信息量，所以不画条形，按“几份卷子考到”分组列出。多导入几份卷子再比较。</UsageNote>
              {groups.map(([p, items]) => (
                <section key={p} className="ewb-ana-flatgroup">
                  <h4 className="ewb-ana-groupname">{p === d.papers ? `每份都考（${d.papers} 份都有）` : `${p}/${d.papers} 份卷子考到`}<span className="ewb-ana-muted">　{items.length} 个</span></h4>
                  <ul className="ewb-ana-flatlist" aria-label="知识点出现情况">
                    {items.map(n => {
                      const k = categoryOfCode(n.code)
                      return <li key={n.code} data-testid={`freq-${n.code}`} data-papers={n.papers} data-rate={n.rate} className={k ? `ewb-cat-${k}` : ''}><button type="button" className="ewb-ana-flatbtn" onClick={() => setOpenCode(n.code)}><i aria-hidden />{n.name}</button><span className="ewb-ana-flatlist__cat">{k ? CATEGORY_BY_KEY[k].label : ''}</span></li>
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <ul className="ewb-bars ewb-ana-bars" aria-label="知识点出现情况">
              {freq.map(n => {
                const k = categoryOfCode(n.code)
                return (
                  <li key={n.code} data-testid={`freq-${n.code}`} data-papers={n.papers} data-rate={n.rate} className={`ewb-bars__row ${k ? 'ewb-cat-' + k : 'ewb-ana-bar-primary'}`}>
                    <span className="ewb-bars__label" title={n.name}>{n.name}</span>
                    <span className="ewb-bars__track" aria-hidden><span className="ewb-bars__fill" style={{ width: `${Math.max(2, n.rate * 100)}%` }} /></span>
                    <span className="ewb-bars__note" title={`${n.papers}/${d.papers} 份 · ${pct(n.rate)}`}>{appearText(n.papers, d.papers)}</span>
                    <span className="ewb-bars__cat">{k ? CATEGORY_BY_KEY[k].label : ''}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </PageTurn>
        <p className="ewb-ana-meta" style={{ margin: '12px 0 0' }}>{cat ? `只看${CATEGORY_BY_KEY[cat].label}类，再点一次右边的索引回到全部。` : '点右边的索引按知识大类看；颜色就是大类的颜色。'}</p>
      </Panel>

      <div className="ewb-ana-section" />
      <Panel title="知识点分布（可下钻）" aside={
        <span className="ewb-ana-toolbar" style={{ margin: 0 }}>
          <span className="ewb-ana-toolbar__label">方块大小看</span>
          <Segmented size="small" data-testid="treemap-metric" value={metric} onChange={v => setMetric(v as 'score' | 'count')} options={[{ label: '分值（主要考的）', value: 'score' }, { label: '题数（主要考的）', value: 'count' }]} />
        </span>}>
        <div data-testid="treemap-crumbs" className="ewb-ana-crumbs">
          <button type="button" className="ewb-ana-link" data-testid="crumb-root" onClick={() => setPath([])}>全部知识点</button>
          {validPath.map((c, i) => <span key={c}> › <button type="button" className="ewb-ana-link" data-testid={`crumb-${c}`} onClick={() => setPath(validPath.slice(0, i + 1))}>{byCode.get(c)?.name}</button></span>)}
          <span className="ewb-ana-crumbs__hint">颜色越深，考的卷子越多；点带「›」的格子往下一层</span>
        </div>
        {cells.length === 0
          ? <div data-testid="treemap-empty" className="ewb-ana-emptycat" style={{ textAlign: 'center' }}>{metric === 'score' ? '这一层没有分值数据（题目的分值为空），请切换为按题数' : '这一层没有题目'}</div>
          : <Treemap cells={cells} onDrill={id => setPath([...validPath, id])} />}
      </Panel>

      <div className="ewb-ana-section" />
      <div className="ewb-ana-grid2">
        <Panel title="题型分布">
          <ul className="ewb-bars ewb-ana-bars ewb-ana-bars--3" aria-label="题型分布">
            {d.qtypes.map(q => (
              <li key={q.code} data-testid={`qtype-${q.code}`} data-questions={q.questions} data-score={q.score} className="ewb-bars__row ewb-ana-bar-primary">
                <span className="ewb-bars__label" title={q.name}>{q.name}</span>
                <span className="ewb-bars__track" aria-hidden><span className="ewb-bars__fill" style={{ width: `${Math.max(2, (q.questions / maxQ) * 100)}%` }} /></span>
                <span className="ewb-bars__note">{q.questions} 题 · {q.scored > 0 ? `${q.score} 分 (${pct(q.scoreShare)})` : '分值缺失'}</span>
              </li>))}
          </ul>
        </Panel>
        <Panel title={<span>难度分布 <Est /></span>}>
          <ul className="ewb-bars ewb-ana-bars ewb-ana-bars--3" aria-label="难度分布">
            {d.difficulty.map(x => (
              <li key={x.level} data-testid={`diff-${x.level}`} data-questions={x.questions} className="ewb-bars__row ewb-ana-bar-primary">
                <span className="ewb-bars__label">{x.level} 星（{['', '很容易', '较容易', '中等', '较难', '很难'][x.level]}）</span>
                <span className="ewb-bars__track" aria-hidden><span className="ewb-bars__fill" style={{ width: `${Math.max(2, (x.questions / maxD) * 100)}%` }} /></span>
                <span className="ewb-bars__note">{x.questions} 题 · {pct(x.share)}</span>
              </li>))}
          </ul>
          {d.difficultyUnrated > 0 && <p className="ewb-ana-meta" style={{ margin: '8px 0 0' }}>另有 {d.difficultyUnrated} 题未评难度</p>}
          <p className="ewb-ana-meta" style={{ margin: '4px 0 0' }}>难度是 AI/老师的估计，不是学生得分率。</p>
        </Panel>
      </div>

      <div className="ewb-ana-section" />
      <Panel title="知识点 × 题型表" aside={
        <span className="ewb-ana-toolbar" style={{ margin: 0 }}>
          <Segmented size="small" data-testid="matrix-level" value={mxLevel} onChange={v => setMxLevel(v as number)} options={[{ label: '一级知识点', value: 1 }, { label: '二级知识点', value: 2 }]} />
          <Btn tone="secondary" size="small" icon={Download} data-testid="matrix-export" onClick={exportCsv}>导出 CSV</Btn>
        </span>}>
        {!mx ? <Spin /> : (
          <div className="ewb-ana-matrix-wrap">
            <table data-testid="matrix" data-level={mx.level} className="ewb-ana-matrix">
              <thead>
                <tr>
                  <th className="is-first">知识点</th>
                  {mx.cols.map(c => <th key={c.code} data-testid={`matrix-col-${c.code}`} title={c.name}>{c.name}</th>)}
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {mx.rows.map(r => (
                  <tr key={r.code} data-testid={`matrix-row-${r.code}`}>
                    <td className="is-first" style={{ fontWeight: r.level === 1 ? 700 : 500 }} title={r.path}>{r.level > 1 && '　'}{r.name}</td>
                    {mx.cols.map(c => {
                      const cell = mxCell(r.code, c.code)
                      if (!cell) return <td key={c.code} />
                      // 分值只按主知识点计：只作为次知识点出现的格子没有分值（写「仅次」，免得被读成 0 分）；
                      // 主知识点题里只有一部分有分值时，显示的是那一部分的和，并注明「x/y 题有分值」
                      const scoreText = cell.prim === 0 ? '只是顺带考到' : cell.scored === 0 ? '分值缺失' : cell.scored < cell.prim ? `${cell.score} 分（${cell.scored}/${cell.prim} 题有分值）` : `${cell.score} 分`
                      return <td key={c.code} className="is-heat" data-testid={`matrix-cell-${r.code}-${c.code}`} data-q={cell.questions} data-score={cell.score} data-scored={cell.scored} data-prim={cell.prim} style={{ background: `color-mix(in srgb, var(--ewb-primary) ${Math.min(44, cell.questions * 8)}%, var(--ewb-page))` }}>{cell.questions} 题 / {scoreText}</td>
                    })}
                    <td className="is-total" data-testid={`matrix-total-${r.code}`} data-q={r.questions} data-score={r.score}>{r.questions} 题 / {r.score} 分</td>
                  </tr>
                ))}
                <tr className="is-foot">
                  <td className="is-first">全部题目合计</td>
                  {mx.cols.map(c => <td key={c.code} data-testid={`matrix-foot-${c.code}`} data-q={c.allQuestions} data-score={c.allScore}>{c.allQuestions} 题 / {c.allScore} 分</td>)}
                  <td>{mx.cols.reduce((s, c) => s + c.allQuestions, 0)} 题 / {mx.cols.reduce((s, c) => s + c.allScore, 0)} 分</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="ewb-ana-meta" style={{ margin: '8px 0 0' }}>一道题顺带考了几个知识点，就会在几行里各算一道题，所以各行加起来会比全卷题数多；分值只算在“主要考的”那一行。表尾是全卷真实合计。「分值缺失」= 这些题都没填分值；「只是顺带考到」= 这些题只是顺带考到它，分值不算在这里；「x/y 题有分值」= 显示的是有分值那部分的和。格子越深，题越多。</p>
      </Panel>
    </div>
    <KpDetailDrawer code={openCode} filter={filter} onClose={() => setOpenCode(null)} />
    <div className="ewb-ana-dist-side"><ThumbIndex responsive counts={catCounts} value={cat} onChange={pick} aria-label="按知识大类看考得多的知识点" /></div>
    </div>
  )
}