import React from 'react'
import { Alert, Card, Col, Row, Space, Spin, Statistic, Tag } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CoverageNote, EmptyStats, NotCounted } from '../stats/Parts'
import { pct, yearText } from '../stats/format'
import { filterLabel, useStatsFilter } from '../stats/StatsFilter'
import MethodologyButton from '../stats/Methodology'
import { statusMap } from '../status'

export default function Overview() {
  const { filter, ready } = useStatsFilter()
  const nav = useNavigate()
  const { data: o, isLoading } = useQuery({ queryKey: ['stats', 'overview', filter], queryFn: () => window.api.stats.overview(filter), enabled: ready, placeholderData: keepPreviousData })
  if (!ready || isLoading || !o) return <Spin style={{ margin: 40 }} />
  const max = Math.max(0.0001, ...o.top.map(t => t.rate))
  return (
    <div data-testid="overview" style={{ padding: '12px 20px 40px' }}>
      <Space style={{ marginBottom: 10, width: '100%', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: '#888' }} data-testid="overview-filter-label">当前范围：{filterLabel(filter)}</span>
        <MethodologyButton />
      </Space>
      <NotCounted />
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic data-testid="card-papers" title="试卷" value={o.cards.papers} suffix="份" /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic data-testid="card-questions" title="题目" value={o.cards.questions} suffix="道" /><div style={{ marginTop: 4 }}><CoverageNote c={o.coverage} /></div></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic data-testid="card-kps" title="涉及知识点" value={o.cards.kps} suffix="个" /></Card></Col>
        <Col xs={12} md={6}><Card size="small" hoverable onClick={() => nav('/review')}><Statistic data-testid="card-pending" title="待审核" value={o.cards.pending} suffix="份" valueStyle={o.cards.pending ? { color: '#d48806' } : undefined} /></Card></Col>
      </Row>
      {o.cards.papers === 0 ? <EmptyStats pending={o.cards.pending} /> : (
        <Row gutter={12}>
          <Col xs={24} lg={14}>
            <Card size="small" title="常考知识点 Top 10（二级，按出现率）" style={{ marginBottom: 12 }} data-testid="top10">
              {o.top.map((t, i) => (
                <div key={t.code} data-testid={`top-${t.code}`} data-rank={i + 1} data-papers={t.papers} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <span style={{ width: 20, color: '#999' }}>{i + 1}</span>
                  <span style={{ width: 150, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.path}>{t.name}</span>
                  <div style={{ flex: 1, background: '#f0f2f5', height: 14, borderRadius: 3 }}><div style={{ width: `${(t.rate / max) * 100}%`, height: '100%', background: '#4c6ef5', borderRadius: 3 }} /></div>
                  <span style={{ width: 110, textAlign: 'right', flexShrink: 0 }}>{t.papers}/{o.cards.papers} 份 · {pct(t.rate)}</span>
                </div>))}
              {o.top.length === 0 && <span style={{ color: '#999' }}>没有已标注的知识点</span>}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card size="small" title={`本学年新增知识点${o.newThisYear.year ? `（${yearText(o.newThisYear.year)}，二级）` : ''}`} style={{ marginBottom: 12 }} data-testid="new-this-year">
              {!o.newThisYear.reason && o.newThisYear.limited.length > 0 && (
                <Alert data-testid="new-limited" type="warning" showIcon style={{ marginBottom: 8, padding: '2px 10px' }} message={`样本有限：${o.newThisYear.limited.includes('target') ? `本学年只有 ${o.newThisYear.targetPapers} 份卷子` : ''}${o.newThisYear.limited.length === 2 ? '，' : ''}${o.newThisYear.limited.includes('base') ? `之前学年只有 ${o.newThisYear.basePapers} 份` : ''}（不足 5 份），「新增」可能只是还没考到`} />
              )}
              {!o.newThisYear.reason && o.newThisYear.mixed.length > 0 && <Alert data-testid="new-mixed" type="info" showIcon style={{ marginBottom: 8, padding: '2px 10px' }} message={`两侧${o.newThisYear.mixed.join('，')}`} />}
              {o.newThisYear.reason ? <span data-testid="new-reason" style={{ color: '#999' }}>{o.newThisYear.reason}</span>
                : o.newThisYear.items.length === 0 ? <span style={{ color: '#999' }}>相比之前的 {o.newThisYear.basePapers} 份卷子，没有新出现的知识点</span>
                  : o.newThisYear.items.map(i => <Tag key={i.code} color="green" data-testid={`new-${i.code}`} style={{ marginBottom: 4 }}>{i.name} {i.aT}/{i.nT}</Tag>)}
            </Card>
          </Col>
        </Row>
      )}
      <Card size="small" title="最近导入" data-testid="recent">
        {o.recent.length === 0 ? <span style={{ color: '#999' }}>还没有导入过试卷</span> : o.recent.map(r => {
          const st = statusMap[r.status] ?? { color: 'default', label: r.status }
          return (
            <div key={r.id} data-testid={`recent-${r.id}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #fafafa', fontSize: 13 }}>
              <a style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => nav(r.status === 'reviewing' || r.status === 'done' ? `/review/${r.id}` : `/paper/${r.id}`)}>{r.title}</a>
              <span style={{ color: '#999', fontSize: 12 }}>{r.grade ? `${r.grade}年级` : ''} {r.school_year_start ? yearText(r.school_year_start) : ''}</span>
              <span style={{ color: '#999', fontSize: 12 }}>{r.questions} 题</span>
              <Tag color={st.color} style={{ marginInlineEnd: 0 }}>{st.label}</Tag>
              <span style={{ color: '#bbb', fontSize: 12, width: 130, textAlign: 'right' }}>{r.created_at}</span>
            </div>)
        })}
      </Card>
    </div>
  )
}
