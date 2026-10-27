import React, { useEffect, useMemo, useState } from 'react'
import { Segmented, Select, Spin, Switch } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import KpDrawer from './KpDrawer'
import AnalysisPanel from '../../stats/AnalysisPanel'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { LEVEL_LABEL, yearText } from '../../stats/format'
import { EmptyStats, NotCounted } from '../../stats/Parts'
import { NoticeStack } from '../../design'
import { emptyReason } from '../../../shared/emptyReason'
import { useStatsFilter } from '../../stats/StatsFilter'
import { compareText } from '../../../shared/plain-text'
import { Term } from '../../components/Plain'
import { Btn, Panel, UsageNote } from '../../design'
import '../../design/page-analysis.css'

// 四组词条：白话命名（今年新考 / 今年没考 / 考得更多 / 考得更少），颜色不再区分对错，只靠文字
const COLS = [
  { kind: 'added', title: '今年新考', hint: '去年及以前没考，今年考了' },
  { kind: 'removed', title: '今年没考', hint: '去年及以前考过，今年没考' },
  { kind: 'up', title: '考得更多', hint: '考了几份卷子的比例明显变高' },
  { kind: 'down', title: '考得更少', hint: '考了几份卷子的比例明显变低' }
] as const

function Semesters({ title, side, testid }: { title: string; side: Array<{ name: string; key: string; papers: number }>; testid: string }) {
  return (
    <div className="ewb-ana-side" data-testid={testid}>
      <h4 className="ewb-ana-side__title">{title}</h4>
      <div className="ewb-ana-pills" style={{ margin: 0 }}>
        {side.length === 0 ? <span className="ewb-ana-muted">没有试卷</span> : side.map(x => <span key={x.key} className="ewb-ana-pill" data-testid={`${testid}-${x.name}`} data-papers={x.papers}>{x.name}{x.name === '未填' ? '' : '学期'} {x.papers} 份</span>)}
      </div>
    </div>
  )
}

function Textbooks({ title, side, testid }: { title: string; side: CompareResult['target']; testid: string }) {
  const total = side.textbooks.reduce((s, t) => s + t.papers, 0) || 1
  return (
    <div className="ewb-ana-side" data-testid={testid}>
      <h4 className="ewb-ana-side__title">{title}</h4>
      <div className="ewb-ana-meta" style={{ marginBottom: 6 }}>{side.label} · {side.papers} 份</div>
      {side.textbooks.length === 0 ? <span className="ewb-ana-muted">没有试卷</span> : side.textbooks.map(t => (
        <div key={t.name} data-testid={`${testid}-${t.name}`} data-papers={t.papers} className="ewb-ana-tbrow ewb-ana-bar-primary">
          <span>{t.name}</span>
          <span className="ewb-bars__track" aria-hidden><span className="ewb-bars__fill" style={{ width: `${(t.papers / total) * 100}%` }} /></span>
          <span style={{ textAlign: 'right' }}>{t.papers} 份</span>
        </div>))}
    </div>
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
  // 样本不足（任一侧少于 3 份）时，「新考的 / 没再考的」默认折叠，点「仍要查看」才展开
  const [showFew, setShowFew] = useState(false)

  // 目标学年默认最新的学年；筛选变化后原来选的学年没有了就退回
  useEffect(() => { if (years.length && (target === null || !years.includes(target))) setTarget(years[years.length - 1]) }, [years, target])
  useEffect(() => { if (target !== null && base !== 'before' && base >= target) setBase('before') }, [target, base])

  const scope: CompareScope | null = target === null ? null : { filter, target, base, level, align }
  const { data: cmp, isLoading } = useQuery({ queryKey: ['stats', 'compare', scope], enabled: !!scope, queryFn: () => window.api.stats.compare(filter, target!, base, level, align), placeholderData: keepPreviousData })
  // 抽屉只记知识点代码，数字每次从最新的结果里取（抽屉开着时数据变了，上方的数字也跟着变）
  const open = useMemo(() => (cmp && openCode ? [...cmp.added, ...cmp.removed, ...cmp.up, ...cmp.down].find(i => i.code === openCode) ?? null : null), [cmp, openCode])
  const earlier = useMemo(() => years.filter(y => target !== null && y < target), [years, target])

  if (years.length < 2) {
    return <div><EmptyStats><div data-testid="compare-need-years" style={{ marginTop: 8 }} className="ewb-ana-meta">同比至少需要两个不同学年的已确认试卷（现在有 {years.length} 个学年：{years.map(yearText).join('、') || '无'}）。</div></EmptyStats></div>
  }
  const cmpNotes = cmp && !cmp.empty ? (
    <>
            {cmp.limited.length > 0 && (
              <UsageNote data-testid="sample-warning" kind="caution"><b>样本有限</b>：{cmp.limited.includes('target') && `今年只有 ${cmp.target.papers} 份卷子`}{cmp.limited.length === 2 && '，'}{cmp.limited.includes('base') && `去年及以前只有 ${cmp.base.papers} 份卷子`}（不足 5 份）。一两份卷子的差别就可能让“考了几份卷子”的比例变化 20 个百分点以上，结论仅供参考。</UsageNote>
            )}
            {cmp.insufficient.length > 0 && (
              <UsageNote data-testid="insufficient-warning" kind="caution"
                actions={!showFew ? <Btn tone="secondary" size="small" data-testid="show-few" onClick={() => setShowFew(true)}>仍要查看</Btn> : undefined}>
                <b>样本不足，暂不比较</b>：用来比的卷子少于 3 份（今年 {cmp.target.papers} 份，去年及以前 {cmp.base.papers} 份）。“新考的”“没再考的”很可能只是这几份卷子刚好考没考到，下面已默认折叠；多导入几份再看。
              </UsageNote>
            )}
            {cmp.mixed.length > 0 && <UsageNote data-testid="mixed-warning" kind="tip">{`两侧${cmp.mixed.join('；').replace(/目标学年/g, '今年').replace(/基线/g, '去年及以前')}。对比时请注意口径不一致（可在筛选栏限定年级或考试类型；学期见上面的「只比同一学期」）。`}</UsageNote>}
            {cmp.align.on && cmp.align.dropped > 0 && <UsageNote data-testid="align-note" kind="tip">{`已按“只比同一学期”：去年及以前只取今年出现过的学期（${cmp.align.targetSemesters.map(x => x.name).join('、')}），另有 ${cmp.align.dropped} 份其他学期的卷子没有参与比较。`}</UsageNote>}
            {!cmp.align.on && cmp.align.requested === false && <UsageNote data-testid="align-off" kind="caution">没有打开“只比同一学期”：去年及以前的上、下学期卷子都拿来比。今年还没考完的学期，对应的知识点会被显示成“没再考的”。</UsageNote>}
    </>
  ) : null
  return (
    <div>
      <div className="ewb-ana-toolbar">
        <span className="ewb-ana-toolbar__label">今年（看哪个学年）</span>
        <Select data-testid="compare-target" style={{ width: 150 }} value={target ?? undefined} onChange={setTarget} options={years.slice(1).map(y => ({ value: y, label: yearText(y) }))} />
        <span className="ewb-ana-toolbar__label">和谁比</span>
        <Select data-testid="compare-base" style={{ width: 220 }} value={base} onChange={setBase}
          options={[{ value: 'before', label: '去年及以前的全部学年（默认）' }, ...earlier.map(y => ({ value: y, label: `只和 ${yearText(y)} 比` }))]} />
        <span className="ewb-ana-toolbar__label">看哪一级的知识点</span>
        <Segmented data-testid="compare-level" value={level} onChange={v => setLevel(v as number)} options={[1, 2, 3].map(l => ({ label: LEVEL_LABEL[l], value: l }))} />
        <span title="一个学年有上、下两学期，今年往往只考完一半。默认只拿去年及以前“同一学期”的卷子来比（下学期对下学期）；关掉后会拿全部学期比，只在缺少的那个学期里考的知识点会被报成“新考的”或“没再考的”。" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Switch size="small" data-testid="compare-align" checked={align} onChange={setAlign} /><span><Term term="只比同一学期">只比同一学期</Term></span>
        </span>
      </div>
      <NoticeStack>
        {fullFilter.school_year_start && <UsageNote kind="tip" data-testid="compare-year-ignored">筛选栏里的「学年」在同比页签不生效——“今年”和“和谁比”由下面的选择决定，其它筛选条件照常生效。</UsageNote>}
        <NotCounted filter={filter} hint="以上是当前筛选条件下（不限学年）的统计；实际用来比的卷子还要按“今年 / 和谁比”和“只比同一学期”再挑，份数可能更少" />
        {cmpNotes}
      </NoticeStack>

      {isLoading || !cmp ? <Spin /> : cmp.empty ? (
        <UsageNote data-testid="compare-empty" kind="caution">{emptyReason({ targetLabel: cmp.target.label, baseLabel: cmp.base.label, targetPapers: cmp.target.papers, basePapers: cmp.base.papers, alignOn: cmp.align.on, dropped: cmp.align.dropped, targetSemesters: cmp.align.targetSemesters.map(x => x.name + (x.name === '未填' ? '' : '学期')).join('、'), where: 'compare' })}</UsageNote>
      ) : (
        <>
          <div className="ewb-ana-grid2 ewb-ana-panelgap">
            <Semesters title="今年的学期构成" side={cmp.align.targetSemesters} testid="semesters-target" />
            <Semesters title={`去年及以前的学期构成${cmp.align.on ? '（只比同一学期）' : ''}`} side={cmp.align.baseSemesters} testid="semesters-base" />
          </div>
          <div className="ewb-ana-grid2 ewb-ana-panelgap">
            <Textbooks title="今年的教材版本" side={cmp.target} testid="textbooks-target" />
            <Textbooks title="去年及以前的教材版本" side={cmp.base} testid="textbooks-base" />
          </div>
          <div className="ewb-ana-grid4 ewb-ana-panelgap">
            {COLS.map(c => {
              const items = cmp[c.kind] as CompareItem[]
              const folded = (c.kind === 'added' || c.kind === 'removed') && cmp.insufficient.length > 0 && !showFew && items.length > 0
              return (
                <section key={c.kind} className={`ewb-ana-col ewb-ana-col--${c.kind}`} data-testid={`col-${c.kind}`} data-count={items.length}>
                  <header className="ewb-ana-col__head">
                    <h3 className="ewb-ana-col__title">{c.title} <span className="ewb-ana-pill ewb-ana-pill--quiet">{items.length}</span></h3>
                    <span className="ewb-ana-col__hint">{c.hint}</span>
                  </header>
                  <div className="ewb-ana-col__body">
                    {folded && (
                      <div data-testid={`col-${c.kind}-folded`} className="ewb-ana-folded">样本不足，暂不比较<br /><a onClick={() => setShowFew(true)}>仍要查看（{items.length} 个）</a></div>
                    )}
                    <div className="ewb-ana-stack" style={{ display: folded ? 'none' : undefined }}>
                    {items.length === 0 ? <div className="ewb-ana-col__none">无</div> : items.map(i => (
                      <div key={i.code} data-testid={`item-${i.code}`} data-delta={i.deltaPP} role="button" tabIndex={0} className="ewb-ana-item" onClick={() => setOpenCode(i.code)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenCode(i.code) } }}>
                        <div className="ewb-ana-item__name">{i.name}</div>
                        <div className="ewb-ana-item__line" title={`去年及以前 ${i.aB}/${i.nB} 份 → 今年 ${i.aT}/${i.nT} 份；变化 ${i.deltaPP > 0 ? '+' : ''}${i.deltaPP.toFixed(1)} 个百分点；课标一般 ${i.intro_grade ?? '—'} 年级开始学`}>{compareText(i.aB, i.nB, i.aT, i.nT)}</div>
                      </div>))}
                    </div>
                  </div>
                </section>
              )
            })}
          </div>
          <Panel title="AI 年度变化分析（AI 草稿，请老师核对）" data-testid="analysis-card">
            <AnalysisPanel scope={scope!} onView={setView} />
          </Panel>
          <KpDrawer item={open} scope={scope!} cmp={cmp} onClose={() => setOpenCode(null)} />
          <PageViewer target={view} onClose={() => setView(null)} />
        </>
      )}
    </div>
  )
}
