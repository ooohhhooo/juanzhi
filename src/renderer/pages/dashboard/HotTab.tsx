import React, { useState } from 'react'
import { Collapse, Segmented, Spin, Table } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { CoverageNote, Est, EmptyStats, NotCounted } from '../../stats/Parts'
import { LEVEL_LABEL, pct } from '../../stats/format'
import { useScopeGuide, useStatsFilter } from '../../stats/StatsFilter'
import { appearText, difficultyText, hotLabel } from '../../../shared/plain-text'
import type { HotLabel } from '../../../shared/plain-text'
import { Term } from '../../components/Plain'
import KpDetailDrawer from '../../stats/KpDetailDrawer'
import { NoticeStack, UsageNote } from '../../design'
import '../../design/page-analysis.css'

const LABEL_CLASS: Record<HotLabel, string> = {
  重点: 'ewb-ana-pill--primary',
  难点: 'ewb-ana-pill--red',
  又重又难: 'ewb-ana-pill--red ewb-ana-pill--strong',
  个例: 'ewb-ana-pill--quiet',
  一般: 'ewb-ana-pill--quiet'
}

export default function HotTab() {
  const { filter } = useStatsFilter()
  const [level, setLevel] = useState(2)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [openCode, setOpenCode] = useState<string | null>(null)
  const { data: h, isLoading } = useQuery({ queryKey: ['stats', 'hot', filter, level], queryFn: () => window.api.stats.hot(filter, level), placeholderData: keepPreviousData })
  useScopeGuide(h?.rows[0]?.name, h && h.rows.length > 1 ? h.rows[h.rows.length - 1].name : undefined)
  if (isLoading || !h) return <Spin style={{ margin: 40 }} />
  if (h.papers === 0) return <EmptyStats />
  const shares = h.rows.map(r => (h.basis === 'score' ? r.scoreShare : r.share) ?? 0).sort((a, b) => a - b)
  const median = shares.length ? shares[Math.floor(shares.length / 2)] : 0
  const labelOf = (r: HotRow): HotLabel => hotLabel({ papers: r.papers, rate: r.rate, share: (h.basis === 'score' ? r.scoreShare : r.share) ?? 0, errorRate: r.errorRate, avgDifficulty: r.avgDifficulty }, h.papers, median)
  return (
    <div>
      <div className="ewb-ana-toolbar">
        <Segmented data-testid="hot-level" value={level} onChange={v => setLevel(v as number)} options={[2, 3].map(l => ({ label: `${LEVEL_LABEL[l]}知识点`, value: l }))} />
        <CoverageNote c={h.coverage} />
      </div>
      <Collapse size="small" ghost style={{ marginBottom: 6 }} data-testid="hot-how" items={[{
        key: 'how', forceRender: true,
        label: <span className="ewb-ana-meta"><Term term="怎么算的">怎么算的</Term>（点开看排序方法）</span>,
        children: <div className="ewb-ana-hot-how">
          表里的顺序 = 常考 × 占分多 × 容易错，越靠前越值得先练。标签：<span className="ewb-ana-pill ewb-ana-pill--primary">重点</span> 常考、占分又多；<span className="ewb-ana-pill ewb-ana-pill--red">难点</span> 题目偏难或估计容易错；<span className="ewb-ana-pill ewb-ana-pill--red ewb-ana-pill--strong">又重又难</span>；<span className="ewb-ana-pill ewb-ana-pill--quiet">个例</span> 只在 1 份卷子里出现，不算规律。
          <div style={{ marginTop: 4 }}>具体公式（给想细究的人看）：<span className="ewb-ana-pill ewb-ana-pill--primary" data-testid="hot-formula">{h.formula.text}</span></div>
        </div>
      }]} />
      <NoticeStack>
      <NotCounted />
      <div className="ewb-ana-notes">
        {h.papers < 3 && <UsageNote kind="caution" data-testid="hot-small-sample">样本不足：卷子少于 3 份，“重点”“难点”只能说“这几份卷子里是这样”，不能当规律。只出现在 1 份卷子里的知识点不会被当成难点。</UsageNote>}
        {h.higher.questions > 0 && <UsageNote kind="tip" data-testid="hot-higher">{`另有 ${h.higher.questions} 道题（${h.higher.score} 分）主要考的知识点标在更大的一类上，不属于下面表里的任何一行（要看它们请切到上一级，或在审核里把知识点标到更细的一级）。`}</UsageNote>}
        {h.basis === 'count' && <UsageNote kind="caution" data-testid="hot-basis-count">当前范围内没有任何题目带分值，「占总分多少」已改用「主要考这个知识点的题数 ÷ 总题数」参与排序。</UsageNote>}
      </div>
      </NoticeStack>
      {h.total > h.rows.length && <div data-testid="hot-total" className="ewb-ana-meta" style={{ margin: '12px 0 6px' }}>本层级共 {h.total} 个知识点出现，只列排在最前面的 {h.rows.length} 个。只是顺带考到的知识点没有占分，排在最后。</div>}
      <Table<HotRow> data-testid="hot-table" size="middle" pagination={false} rowKey="code" dataSource={h.rows}
        expandable={{
          expandedRowRender: r => (
            <div data-testid={`hot-detail-${r.code}`} className="ewb-ana-hot-detail">
              {r.reasons.length
                ? (
                  <UsageNote kind="mistake" title="为什么容易错">
                    <span className="ewb-ana-meta">（<Est />按出现次数）</span> <span className="ewb-ana-chips" style={{ display: 'inline-flex' }}>{r.reasons.map(x => <span key={x.reason} className="ewb-ana-pill ewb-ana-pill--red">{x.reason} ×{x.count}</span>)}</span>
                  </UsageNote>
                )
                : <div className="ewb-ana-meta">易错原因（<Est />按出现次数）：无</div>}
              <div className="ewb-ana-meta" style={{ margin: '12px 0 6px' }}>典型题（优先易错、难度高的）：</div>
              {r.typical.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}
            </div>)
        }}
        onRow={r => ({ 'data-testid': `hot-row-${r.code}`, 'data-priority': r.priority } as React.HTMLAttributes<HTMLElement>)}
        columns={[
          { title: '#', dataIndex: 'rank', width: 44 },
          { title: '知识点', render: (_, r) => <span title={r.path}><button type="button" className="ewb-ana-kpname ewb-ana-kplink" data-testid={`hot-open-${r.code}`} onClick={e => { e.stopPropagation(); setOpenCode(r.code) }}>{r.name}</button> <span className={`ewb-ana-pill ${LABEL_CLASS[labelOf(r)]}`} data-testid={`hot-label-${r.code}`} style={{ marginInlineStart: 4 }}>{labelOf(r)}</span></span> },
          { title: <Term term="考了几份卷子">考了几份卷子</Term>, render: (_, r) => <span title={`${r.papers}/${h.papers} 份 · ${pct(r.rate)}`}>{appearText(r.papers, h.papers)}</span> },
          { title: h.basis === 'score' ? <Term term="占总分多少">占总分多少</Term> : '占题数多少', render: (_, r) => pct(h.basis === 'score' ? r.scoreShare : r.share) },
          { title: <span><Term term="容易错">容易错</Term> <Est /></span>, render: (_, r) => <span title={`${r.errorCount}/${r.questions} · ${pct(r.errorRate)}`}>{r.questions} 道里估计 {r.errorCount} 道容易错</span> },
          { title: <span><Term term="难易程度">难易程度</Term> <Est /></span>, render: (_, r) => <span title={r.avgDifficulty === null ? '' : `平均 ${r.avgDifficulty}（1–5）`}>{difficultyText(r.avgDifficulty)}</span> }
        ]} />
      <KpDetailDrawer code={openCode} filter={filter} onClose={() => setOpenCode(null)} />
      <PageViewer target={view} onClose={() => setView(null)} />
    </div>
  )
}
