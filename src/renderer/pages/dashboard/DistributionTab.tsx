import React, { useMemo, useState } from 'react'
import { App, Button, Card, Col, Row, Segmented, Space, Spin, Tag } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import Treemap from '../../stats/Treemap'
import type { TreeCell } from '../../stats/Treemap'
import { CoverageNote, Est, EmptyStats, NotCounted } from '../../stats/Parts'
import { LEVEL_LABEL, clean, pct } from '../../stats/format'
import { useStatsFilter } from '../../stats/StatsFilter'

const Bar = ({ ratio, color = '#4c6ef5' }: { ratio: number; color?: string }) => (
  <div style={{ background: '#f0f2f5', height: 14, borderRadius: 3, flex: 1, minWidth: 40 }}>
    <div style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
  </div>
)

export default function DistributionTab() {
  const { filter } = useStatsFilter()
  const { message } = App.useApp()
  const { data: d, isLoading } = useQuery({ queryKey: ['stats', 'distribution', filter], queryFn: () => window.api.stats.distribution(filter), placeholderData: keepPreviousData })
  const [path, setPath] = useState<string[]>([])
  const [metric, setMetric] = useState<'score' | 'count'>('score')
  const [freqLevel, setFreqLevel] = useState(2)
  const [mxLevel, setMxLevel] = useState(1)
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

  const freq = useMemo(() => nodes.filter(n => n.level === freqLevel).sort((a, b) => b.rate - a.rate || b.questions - a.questions || (a.code < b.code ? -1 : 1)).slice(0, 15), [nodes, freqLevel])

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

  return (
    <div style={{ padding: '12px 20px 40px' }}>
      <NotCounted />
      <Space wrap style={{ marginBottom: 12 }} data-testid="dist-summary">
        <Tag color="blue" data-testid="dist-papers">试卷 {d.papers} 份</Tag>
        <Tag data-testid="dist-questions">题目 {d.questions} 道</Tag>
        <Tag data-testid="dist-total-score">总分合计 {d.totalScore}（仅含有分值的题）</Tag>
        <CoverageNote c={d.coverage} />
        {d.coverage.tagged < d.questions && <Tag color="orange">{d.questions - d.coverage.tagged} 道题没有标主知识点</Tag>}
      </Space>

      <Card size="small" title="知识点分布（可下钻）" style={{ marginBottom: 16 }} extra={
        <Space>
          <span style={{ fontSize: 12, color: '#888' }}>面积按</span>
          <Segmented size="small" data-testid="treemap-metric" value={metric} onChange={v => setMetric(v as any)} options={[{ label: '分值（主知识点）', value: 'score' }, { label: '题数（主知识点）', value: 'count' }]} />
        </Space>}>
        <div data-testid="treemap-crumbs" style={{ marginBottom: 8, fontSize: 13 }}>
          <a data-testid="crumb-root" onClick={() => setPath([])}>全部知识点</a>
          {validPath.map((c, i) => <span key={c}> › <a data-testid={`crumb-${c}`} onClick={() => setPath(validPath.slice(0, i + 1))}>{byCode.get(c)?.name}</a></span>)}
          <span style={{ color: '#999', marginLeft: 12 }}>颜色越深出现率越高；点带「›」的格子往下一层</span>
        </div>
        {cells.length === 0
          ? <div data-testid="treemap-empty" style={{ padding: 24, color: '#999', textAlign: 'center' }}>{metric === 'score' ? '这一层没有分值数据（题目的分值为空），请切换为按题数' : '这一层没有题目'}</div>
          : <Treemap cells={cells} onDrill={id => setPath([...validPath, id])} />}
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card size="small" title="考频（出现率）" style={{ marginBottom: 16 }} extra={<Segmented size="small" data-testid="freq-level" value={freqLevel} onChange={v => setFreqLevel(v as number)} options={[1, 2, 3].map(l => ({ label: LEVEL_LABEL[l], value: l }))} />}>
            {freq.length === 0 ? <div style={{ color: '#999' }}>这一层级没有知识点</div> : freq.map(n => (
              <div key={n.code} data-testid={`freq-${n.code}`} data-papers={n.papers} data-rate={n.rate} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}>
                <span style={{ width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${n.name}（${n.code}）`}>{n.name}</span>
                <Bar ratio={n.rate} />
                <span style={{ width: 96, textAlign: 'right', flexShrink: 0 }}>{n.papers}/{d.papers} 份 · {pct(n.rate)}</span>
              </div>))}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="题型分布" style={{ marginBottom: 12 }}>
            {d.qtypes.map(q => (
              <div key={q.code} data-testid={`qtype-${q.code}`} data-questions={q.questions} data-score={q.score} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}>
                <span style={{ width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.name}>{q.name}</span>
                <Bar ratio={q.questions / maxQ} color="#37a2da" />
                <span style={{ width: 150, textAlign: 'right', flexShrink: 0 }}>{q.questions} 题 · {q.scored > 0 ? `${q.score} 分 (${pct(q.scoreShare)})` : '分值缺失'}</span>
              </div>))}
          </Card>
          <Card size="small" title={<span>难度分布 <Est /></span>}>
            {d.difficulty.map(x => (
              <div key={x.level} data-testid={`diff-${x.level}`} data-questions={x.questions} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}>
                <span style={{ width: 70, flexShrink: 0 }}>难度 {x.level}</span>
                <Bar ratio={x.questions / maxD} color="#f5a623" />
                <span style={{ width: 90, textAlign: 'right', flexShrink: 0 }}>{x.questions} 题 · {pct(x.share)}</span>
              </div>))}
            {d.difficultyUnrated > 0 && <div style={{ fontSize: 12, color: '#999' }}>另有 {d.difficultyUnrated} 题未评难度</div>}
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>难度是 AI/老师的估计，不是学生得分率。</div>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="双向细目表（知识点 × 题型）" extra={
        <Space>
          <Segmented size="small" data-testid="matrix-level" value={mxLevel} onChange={v => setMxLevel(v as number)} options={[{ label: '一级知识点', value: 1 }, { label: '二级知识点', value: 2 }]} />
          <Button size="small" icon={<DownloadOutlined />} data-testid="matrix-export" onClick={exportCsv}>导出 CSV</Button>
        </Space>}>
        {!mx ? <Spin /> : (
          <div style={{ overflow: 'auto', maxHeight: 520 }}>
            <table data-testid="matrix" data-level={mx.level} style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={th(true)}>知识点</th>
                  {mx.cols.map(c => <th key={c.code} data-testid={`matrix-col-${c.code}`} style={th()} title={c.name}>{c.name}</th>)}
                  <th style={th()}>合计</th>
                </tr>
              </thead>
              <tbody>
                {mx.rows.map(r => (
                  <tr key={r.code} data-testid={`matrix-row-${r.code}`}>
                    <td style={{ ...td(true), fontWeight: r.level === 1 ? 600 : 400 }} title={r.path}>{r.level > 1 && '　'}{r.name}</td>
                    {mx.cols.map(c => {
                      const cell = mxCell(r.code, c.code)
                      if (!cell) return <td key={c.code} style={td()} />
                      // 分值只按主知识点计：只作为次知识点出现的格子没有分值（写「仅次」，免得被读成 0 分）；
                      // 主知识点题里只有一部分有分值时，显示的是那一部分的和，并注明「x/y 题有分值」
                      const scoreText = cell.prim === 0 ? '仅次知识点' : cell.scored === 0 ? '分值缺失' : cell.scored < cell.prim ? `${cell.score} 分（${cell.scored}/${cell.prim} 题有分值）` : `${cell.score} 分`
                      return <td key={c.code} data-testid={`matrix-cell-${r.code}-${c.code}`} data-q={cell.questions} data-score={cell.score} data-scored={cell.scored} data-prim={cell.prim} style={{ ...td(), background: `rgba(76,110,245,${Math.min(0.5, cell.questions * 0.08)})` }}>{cell.questions} 题 / {scoreText}</td>
                    })}
                    <td style={{ ...td(), fontWeight: 600 }} data-testid={`matrix-total-${r.code}`} data-q={r.questions} data-score={r.score}>{r.questions} 题 / {r.score} 分</td>
                  </tr>
                ))}
                <tr style={{ background: '#fafafa' }}>
                  <td style={{ ...td(true), fontWeight: 600 }}>全部题目合计</td>
                  {mx.cols.map(c => <td key={c.code} style={{ ...td(), fontWeight: 600 }} data-testid={`matrix-foot-${c.code}`} data-q={c.allQuestions} data-score={c.allScore}>{c.allQuestions} 题 / {c.allScore} 分</td>)}
                  <td style={{ ...td(), fontWeight: 600 }}>{mx.cols.reduce((s, c) => s + c.allQuestions, 0)} 题 / {mx.cols.reduce((s, c) => s + c.allScore, 0)} 分</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>一道题标了多个知识点会在多行各计一次题数，分值只在主知识点所在的行计；表尾是全卷真实合计（含没标知识点的题）。「分值缺失」= 主知识点题都没有分值；「仅次知识点」= 这些题只把它当次知识点，分值不算在这里；「x/y 题有分值」时显示的是有分值那部分的和。</div>
      </Card>
    </div>
  )
}

const th = (first = false): React.CSSProperties => ({ position: 'sticky', top: 0, ...(first ? { left: 0, zIndex: 2 } : {}), background: '#f5f7ff', border: '1px solid #e8e8e8', padding: '4px 8px', whiteSpace: 'nowrap', textAlign: first ? 'left' : 'center', zIndex: 1 })
const td = (first = false): React.CSSProperties => ({ ...(first ? { position: 'sticky', left: 0, background: '#fff' } : {}), border: '1px solid #eee', padding: '3px 8px', whiteSpace: 'nowrap', textAlign: first ? 'left' : 'center' })
