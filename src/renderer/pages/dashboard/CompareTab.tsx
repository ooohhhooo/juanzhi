import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Col, Row, Segmented, Select, Space, Spin, Switch, Tag } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import KpDrawer from './KpDrawer'
import AnalysisPanel from '../../stats/AnalysisPanel'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { LEVEL_LABEL, pct, yearText } from '../../stats/format'
import { EmptyStats, NotCounted } from '../../stats/Parts'
import { emptyReason } from '../../../shared/emptyReason'
import { useStatsFilter } from '../../stats/StatsFilter'

const COLS = [
  { kind: 'added', title: '新增', hint: '目标学年出现、基线从未出现', color: '#389e0d' },
  { kind: 'removed', title: '消失', hint: '基线出现、目标学年没有', color: '#8c8c8c' },
  { kind: 'up', title: '上升', hint: '出现率上升 ≥ 20 个百分点', color: '#d4380d' },
  { kind: 'down', title: '下降', hint: '出现率下降 ≥ 20 个百分点', color: '#096dd9' }
] as const

function Semesters({ title, side, testid }: { title: string; side: Array<{ name: string; key: string; papers: number }>; testid: string }) {
  return (
    <Card size="small" title={title} data-testid={testid} styles={{ body: { padding: '8px 12px' } }}>
      {side.length === 0 ? <span style={{ color: '#999' }}>没有试卷</span> : side.map(x => <Tag key={x.key} data-testid={`${testid}-${x.name}`} data-papers={x.papers}>{x.name}{x.name === '未填' ? '' : '学期'} {x.papers} 份</Tag>)}
    </Card>
  )
}

function Textbooks({ title, side, testid }: { title: string; side: CompareResult['target']; testid: string }) {
  const total = side.textbooks.reduce((s, t) => s + t.papers, 0) || 1
  return (
    <Card size="small" title={title} data-testid={testid} style={{ height: '100%' }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>{side.label} · {side.papers} 份</div>
      {side.textbooks.length === 0 ? <span style={{ color: '#999' }}>没有试卷</span> : side.textbooks.map(t => (
        <div key={t.name} data-testid={`${testid}-${t.name}`} data-papers={t.papers} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
          <span style={{ width: 90, flexShrink: 0 }}>{t.name}</span>
          <div style={{ flex: 1, background: '#f0f2f5', height: 12, borderRadius: 3 }}><div style={{ width: `${(t.papers / total) * 100}%`, height: '100%', background: '#9254de', borderRadius: 3 }} /></div>
          <span style={{ width: 50, textAlign: 'right' }}>{t.papers} 份</span>
        </div>))}
    </Card>
  )
}

export default function CompareTab() {
  const { filter: fullFilter } = useStatsFilter()
  // 同比自己决定学年：筛选栏里的学年在这里不生效，也不能混进请求与缓存键（否则换个学年筛选，AI 分析就会「消失」）
  const filter = useMemo(() => { const { school_year_start: _y, ...rest } = fullFilter; return rest as StatsFilter }, [fullFilter])
  const { data: years = [] } = useQuery({ queryKey: ['stats', 'years', filter], queryFn: async () => (await window.api.stats.filterOptions(filter)).years })
  const [target, setTarget] = useState<number | null>(null)
  const [base, setBase] = useState<'before' | number>('before')
  const [level, setLevel] = useState(2)
  const [align, setAlign] = useState(true)
  const [openCode, setOpenCode] = useState<string | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)

  // 目标学年默认最新的学年；筛选变化后原来选的学年没有了就退回
  useEffect(() => { if (years.length && (target === null || !years.includes(target))) setTarget(years[years.length - 1]) }, [years, target])
  useEffect(() => { if (target !== null && base !== 'before' && base >= target) setBase('before') }, [target, base])

  const scope: CompareScope | null = target === null ? null : { filter, target, base, level, align }
  const { data: cmp, isLoading } = useQuery({ queryKey: ['stats', 'compare', scope], enabled: !!scope, queryFn: () => window.api.stats.compare(filter, target!, base, level, align), placeholderData: keepPreviousData })
  // 抽屉只记知识点代码，数字每次从最新的结果里取（抽屉开着时数据变了，上方的数字也跟着变）
  const open = useMemo(() => (cmp && openCode ? [...cmp.added, ...cmp.removed, ...cmp.up, ...cmp.down].find(i => i.code === openCode) ?? null : null), [cmp, openCode])
  const earlier = useMemo(() => years.filter(y => target !== null && y < target), [years, target])

  if (years.length < 2) {
    return <div style={{ padding: 20 }}><EmptyStats><div data-testid="compare-need-years" style={{ marginTop: 8 }}>同比至少需要两个不同学年的已确认试卷（现在有 {years.length} 个学年：{years.map(yearText).join('、') || '无'}）。</div></EmptyStats></div>
  }
  return (
    <div style={{ padding: '12px 20px 40px' }}>
      {fullFilter.school_year_start && <Alert type="info" showIcon style={{ marginBottom: 10 }} data-testid="compare-year-ignored" message="筛选栏里的「学年」在同比页签不生效——目标学年和基线由下面的选择决定，其它筛选条件照常生效。" />}
      <Space wrap style={{ marginBottom: 12 }}>
        <span>目标学年</span>
        <Select data-testid="compare-target" style={{ width: 150 }} value={target ?? undefined} onChange={setTarget} options={years.slice(1).map(y => ({ value: y, label: yearText(y) }))} />
        <span>对比基线</span>
        <Select data-testid="compare-base" style={{ width: 200 }} value={base} onChange={setBase}
          options={[{ value: 'before', label: '之前的全部学年（默认）' }, ...earlier.map(y => ({ value: y, label: `只看 ${yearText(y)}` }))]} />
        <span>知识点层级</span>
        <Segmented data-testid="compare-level" value={level} onChange={v => setLevel(v as number)} options={[1, 2, 3].map(l => ({ label: LEVEL_LABEL[l], value: l }))} />
        <span title="一个学年有上、下两学期，当前学年往往只过了一半。默认只拿基线里与目标学年相同的学期来比；关掉后基线含全部学期，只在缺少的那个学期里考的知识点会被报成「新增」或「消失」。">
          <Switch size="small" data-testid="compare-align" checked={align} onChange={setAlign} /> <span style={{ fontSize: 12 }}>按学期对齐</span>
        </span>
      </Space>
      <NotCounted filter={filter} hint="以上是当前筛选条件下（不限学年）的统计；同比实际比较的卷子还要按目标 / 基线学年与「按学期对齐」再取，份数可能更少" />

      {isLoading || !cmp ? <Spin /> : cmp.empty ? (
        <Alert data-testid="compare-empty" type="warning" showIcon message={emptyReason({ targetLabel: cmp.target.label, baseLabel: cmp.base.label, targetPapers: cmp.target.papers, basePapers: cmp.base.papers, alignOn: cmp.align.on, dropped: cmp.align.dropped, targetSemesters: cmp.align.targetSemesters.map(x => x.name + (x.name === '未填' ? '' : '学期')).join('、'), where: 'compare' })} />
      ) : (
        <>
          {cmp.limited.length > 0 && (
            <Alert data-testid="sample-warning" type="warning" showIcon style={{ marginBottom: 10 }} message={<span><b>样本有限</b>：{cmp.limited.includes('target') && `目标学年只有 ${cmp.target.papers} 份卷子`}{cmp.limited.length === 2 && '，'}{cmp.limited.includes('base') && `基线只有 ${cmp.base.papers} 份卷子`}（不足 5 份）。一两份卷子的差别就可能造成 20 个百分点的变化，结论仅供参考。</span>} />
          )}
          {cmp.mixed.length > 0 && <Alert data-testid="mixed-warning" type="info" showIcon style={{ marginBottom: 10 }} message={`两侧${cmp.mixed.join('；')}。对比时请注意口径不一致（可在筛选栏限定年级或考试类型；学期见上面的「按学期对齐」）。`} />}
          {cmp.align.on && cmp.align.dropped > 0 && <Alert data-testid="align-note" type="info" showIcon style={{ marginBottom: 10 }} message={`已按学期对齐：基线只取目标学年出现过的学期（${cmp.align.targetSemesters.map(x => x.name).join('、')}），另有 ${cmp.align.dropped} 份其他学期的基线卷子没有参与比较。`} />}
          {!cmp.align.on && cmp.align.requested === false && <Alert data-testid="align-off" type="warning" showIcon style={{ marginBottom: 10 }} message="未按学期对齐：基线含全部学期。目标学年还没考完的学期，对应的知识点会被显示成「消失」。" />}
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col xs={24} md={12}><Semesters title="目标学年学期构成" side={cmp.align.targetSemesters} testid="semesters-target" /></Col>
            <Col xs={24} md={12}><Semesters title={`基线学期构成${cmp.align.on ? '（已对齐）' : ''}`} side={cmp.align.baseSemesters} testid="semesters-base" /></Col>
          </Row>
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col xs={24} md={12}><Textbooks title="目标学年教材版本" side={cmp.target} testid="textbooks-target" /></Col>
            <Col xs={24} md={12}><Textbooks title="基线教材版本" side={cmp.base} testid="textbooks-base" /></Col>
          </Row>
          <Row gutter={12}>
            {COLS.map(c => {
              const items = cmp[c.kind] as CompareItem[]
              return (
                <Col key={c.kind} xs={24} md={12} xl={6} style={{ marginBottom: 12 }}>
                  <Card size="small" data-testid={`col-${c.kind}`} data-count={items.length} title={<span>{c.title} <Tag>{items.length}</Tag></span>} extra={<span style={{ fontSize: 11, color: '#999' }}>{c.hint}</span>}
                    styles={{ header: { color: c.color }, body: { maxHeight: 420, overflow: 'auto', padding: 8 } }}>
                    {items.length === 0 ? <div style={{ color: '#bbb', fontSize: 12, textAlign: 'center', padding: 12 }}>无</div> : items.map(i => (
                      <div key={i.code} data-testid={`item-${i.code}`} data-delta={i.deltaPP} role="button" onClick={() => setOpenCode(i.code)}
                        style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '6px 8px', marginBottom: 6, cursor: 'pointer' }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{i.name}</div>
                        <div style={{ fontSize: 12, color: '#666' }}>基线 {i.aB}/{i.nB} → 目标 {i.aT}/{i.nT}{(c.kind === 'up' || c.kind === 'down') && <b style={{ color: c.color }}> {i.deltaPP > 0 ? '+' : ''}{i.deltaPP.toFixed(1)} 个百分点</b>}</div>
                        <div style={{ fontSize: 11, color: '#999' }}>出现率 {pct(i.rateB)} → {pct(i.rateT)} · 引入年级 {i.intro_grade ?? '-'}</div>
                      </div>))}
                  </Card>
                </Col>
              )
            })}
          </Row>
          <Card size="small" title="AI 年度变化分析" style={{ marginTop: 4 }} data-testid="analysis-card">
            <AnalysisPanel scope={scope!} onView={setView} />
          </Card>
          <KpDrawer item={open} scope={scope!} cmp={cmp} onClose={() => setOpenCode(null)} />
          <PageViewer target={view} onClose={() => setView(null)} />
        </>
      )}
    </div>
  )
}
