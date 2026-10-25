import React, { useState } from 'react'
import { Alert, Segmented, Space, Spin, Table, Tag, Tooltip } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { CoverageNote, Est, EmptyStats, NotCounted } from '../../stats/Parts'
import { LEVEL_LABEL, pct } from '../../stats/format'
import { useStatsFilter } from '../../stats/StatsFilter'

export default function HotTab() {
  const { filter } = useStatsFilter()
  const [level, setLevel] = useState(2)
  const [view, setView] = useState<ViewTarget | null>(null)
  const { data: h, isLoading } = useQuery({ queryKey: ['stats', 'hot', filter, level], queryFn: () => window.api.stats.hot(filter, level), placeholderData: keepPreviousData })
  if (isLoading || !h) return <Spin style={{ margin: 40 }} />
  if (h.papers === 0) return <EmptyStats />
  return (
    <div style={{ padding: '12px 20px 40px' }}>
      <NotCounted />
      <Space wrap style={{ marginBottom: 10 }}>
        <Segmented data-testid="hot-level" value={level} onChange={v => setLevel(v as number)} options={[2, 3].map(l => ({ label: `${LEVEL_LABEL[l]}知识点`, value: l }))} />
        <CoverageNote c={h.coverage} />
        <Tag color="blue" data-testid="hot-formula">{h.formula.text}</Tag>
        <Tooltip title="出现率高、分值占比大的是重点；乘上 (1 + 易错率) 把 AI 估计易错的知识点往前提。详见「口径说明」。"><span style={{ fontSize: 12, color: '#888' }}>排序公式</span></Tooltip>
      </Space>
      {h.higher.questions > 0 && <Alert type="info" showIcon style={{ marginBottom: 10 }} data-testid="hot-higher" message={`另有 ${h.higher.questions} 道题（${h.higher.score} 分）的主知识点标在更高一级的节点上，不属于本视图的任何一行（要看它们请切到上一级，或在审核里把知识点标到更细的节点）。`} />}
      {h.total > h.rows.length && <div data-testid="hot-total" style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>本层级共 {h.total} 个知识点出现，只列综合得分最高的前 {h.rows.length} 个。只作为次知识点出现的知识点没有分值占比，综合得分为 0，排在最后。</div>}
      {h.basis === 'count' && <Alert type="warning" showIcon style={{ marginBottom: 10 }} data-testid="hot-basis-count" message="当前范围内没有任何题目带分值，「分值占比」已改用「主知识点题数 ÷ 总题数」参与排序。" />}
      <Table<HotRow> data-testid="hot-table" size="small" pagination={false} rowKey="code" dataSource={h.rows}
        expandable={{
          expandedRowRender: r => (
            <div data-testid={`hot-detail-${r.code}`}>
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                易错原因（<Est />按出现次数）：{r.reasons.length ? r.reasons.map(x => <Tag key={x.reason} color="red">{x.reason} ×{x.count}</Tag>) : <span style={{ color: '#999' }}>无</span>}
              </div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>典型题（优先易错、难度高的）：</div>
              {r.typical.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}
            </div>)
        }}
        onRow={r => ({ 'data-testid': `hot-row-${r.code}`, 'data-priority': r.priority } as any)}
        columns={[
          { title: '#', dataIndex: 'rank', width: 44 },
          { title: '知识点', render: (_, r) => <span title={r.path}>{r.name}</span> },
          { title: '出现率', render: (_, r) => `${r.papers}/${h.papers} 份 · ${pct(r.rate)}` },
          { title: h.basis === 'score' ? '分值占比' : '题数占比', render: (_, r) => pct(h.basis === 'score' ? r.scoreShare : r.share) },
          { title: <span>易错率 <Est /></span>, render: (_, r) => `${r.errorCount}/${r.questions} · ${pct(r.errorRate)}` },
          { title: <span>平均难度 <Est /></span>, render: (_, r) => r.avgDifficulty ?? '—' },
          { title: '综合得分', render: (_, r) => <b>{(Math.round(r.priority * 10000) / 10000).toString()}</b> }
        ]} />
      <PageViewer target={view} onClose={() => setView(null)} />
    </div>
  )
}
