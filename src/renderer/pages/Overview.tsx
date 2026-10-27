import React, { useMemo, useState } from 'react'
import { Collapse, Tooltip } from 'antd'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CoverageNote, EmptyStats, NotCounted } from '../stats/Parts'
import { pct, yearText } from '../stats/format'
import { filterLabel, useScopeGuide, useStatsFilter } from '../stats/StatsFilter'
import MethodologyButton from '../stats/Methodology'
import CropImage from '../stats/CropImage'
import PageViewer from '../stats/PageViewer'
import KpDetailDrawer from '../stats/KpDetailDrawer'
import type { ViewTarget } from '../stats/PageViewer'
import { appearText } from '../../shared/plain-text'
import {
  CATEGORIES, CATEGORY_BY_KEY, categoryOfCode, Entry, EmptyState, EntryColumns, EntrySkeleton, Glossary, Headline, IndexTable, Page, PageTurn,
  Panel, SectionTitle, StatusLabel, ThumbIndex, UsageNote
} from '../design'
import type { CategoryKey, EntryProps } from '../design'
import '../design/page-analysis.css'

type Top = OverviewResult['top'][number]

/** 词条里的「出自原卷」：这个知识点在当前范围里的一道题，用原卷截图（点击看整页） */
function OriginExample({ code, filter, onView }: { code: string; filter: StatsFilter; onView: (t: ViewTarget) => void }) {
  const { data } = useQuery({ queryKey: ['stats', 'kpQuestions', filter, { kind: 'filter' }, code, 3], queryFn: () => window.api.stats.questions(filter, { kind: 'filter' }, code, 3), staleTime: 30_000 })
  const q = data?.find(x => x.pageRel && x.bbox) ?? data?.find(x => x.pageRel)
  if (!q) return null
  const open = () => onView({ paperId: q.paper_id, paperTitle: q.paperTitle, no: q.no, pageRel: q.pageRel!, page_idx: q.page_idx, bbox: q.bbox })
  return (
    <section className="ewb-entry__src ewb-ana-origin" aria-label="出自原卷">
      <h4 className="ewb-entry__src-title">出自原卷</h4>
      <CropImage testid="ov-crop" q={{ paperId: q.paper_id, pageRel: q.pageRel, pageW: q.pageW, pageH: q.pageH, bbox: q.bbox }} width={440} onOpen={open} />
      <span className="ewb-thumb-src__cap">{q.paperTitle} · 第 {q.no} 题</span>
    </section>
  )
}

export default function Overview() {
  const { filter, ready } = useStatsFilter()
  const nav = useNavigate()
  const [cat, setCat] = useState<CategoryKey | null>(null)
  const [order, setOrder] = useState(0)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [openCode, setOpenCode] = useState<string | null>(null)
  const { data: o, isLoading } = useQuery({ queryKey: ['stats', 'overview', filter], queryFn: () => window.api.stats.overview(filter), enabled: ready, placeholderData: keepPreviousData })
  // 知识点的白话释义、例句、例词（和审核页、看板抽屉同一份）；易错信息取自「重难点」的二级排名（同一个缓存键）
  const { data: tax } = useQuery({ queryKey: ['taxonomy'], queryFn: () => window.api.taxonomy.tree(), staleTime: 60_000 })
  const hasPapers = (o?.cards.papers ?? 0) > 0
  const { data: hot } = useQuery({ queryKey: ['stats', 'hot', filter, 2], queryFn: () => window.api.stats.hot(filter, 2), enabled: ready && hasPapers, placeholderData: keepPreviousData })
  const nodes = useMemo(() => new Map((tax?.kps ?? []).map(k => [k.code, k])), [tax])
  const hotBy = useMemo(() => new Map((hot?.rows ?? []).map(r => [r.code, r])), [hot])

  // 书眉：本页第一个和最后一个词条（随大类筛选变化）
  const guideList = (o ? (o.topGroups ? [...o.topGroups.everyPaper, ...o.topGroups.somePapers] : o.top) : []).filter(t => cat === null || categoryOfCode(t.code) === cat)
  useScopeGuide(guideList[0]?.name, guideList.length > 1 ? guideList[guideList.length - 1].name : undefined)

  if (!ready || isLoading || !o) return <Page><EntrySkeleton count={3} /></Page>
  const total = o.cards.papers

  const entryOf = (t: Top): EntryProps => {
    const n = nodes.get(t.code)
    const h = hotBy.get(t.code)
    const words = (n?.hint_words ?? '').split('/').map(x => x.trim()).filter(Boolean).slice(0, 3)
    return {
      term: t.name,
      examples: words.length ? words : undefined,
      category: categoryOfCode(t.code) ?? undefined,
      tags: [
        { label: appearText(t.papers, total), hint: `${t.papers}/${total} 份卷子里出现过，占 ${pct(t.rate)}` },
        { label: `${t.questions} 道题`, hint: '这些卷子里一共有几道题考到它（主要考的和顺带考到的都算）' },
        ...(h && h.errorCount > 0 ? [{ label: '易错', kind: 'mistake' as const, hint: `AI 估计其中 ${h.errorCount} 道题学生容易做错（估计，不是学生成绩）` }] : [])
      ],
      plain: n?.plain || t.path,
      examplesSentences: n?.example_en ? [{ en: n.example_en, zh: n.example_zh ?? undefined }] : undefined
    }
  }
  const inCat = (t: Top) => cat === null || categoryOfCode(t.code) === cat
  const rank = new Map(o.top.map((t, i) => [t.code, i + 1]))
  const entries = (list: Top[]) => (
    <EntryColumns always>
      {list.filter(inCat).map(t => (
        <div key={t.code} className="ewb-ana-entry-wrap" data-testid={`top-${t.code}`} data-rank={rank.get(t.code)} data-papers={t.papers}>
          <Entry {...entryOf(t)} size="standard" onOpen={() => setOpenCode(t.code)} footer={<OriginExample code={t.code} filter={filter} onView={setView} />} />
        </div>
      ))}
    </EntryColumns>
  )
  const shown: Top[] = o.topGroups ? [...o.topGroups.everyPaper, ...o.topGroups.somePapers] : o.top
  const counts: Partial<Record<CategoryKey, number>> = {}
  for (const t of shown) { const k = categoryOfCode(t.code); if (k) counts[k] = (counts[k] ?? 0) + 1 }
  const pick = (k: CategoryKey) => { if (k === cat) { setCat(null); return } setCat(k); setOrder(CATEGORIES.findIndex(c => c.key === k)) }

  // 大字结论：卷子 ≥ 3 份才敢说「最该补的」（取重难点排名前两名）；更少时只说考得最多的
  const headTerms = total >= 3 && hot && hot.rows.length ? hot.rows.slice(0, 2).map(r => r.name) : o.top.slice(0, 2).map(t => t.name)
  const worst = hot?.rows.filter(r => r.errorCount > 0).sort((a, b) => b.errorCount - a.errorCount || a.rank - b.rank)[0]

  const head = total === 0 ? <Headline>当前范围里还没有已确认的试卷</Headline> : (
    <Headline>
      <span>这 {total} 份卷子共 </span><Headline.Num>{o.cards.questions}</Headline.Num><span> 道题，{total >= 3 ? '最该补的是 ' : '考得最多的是 '}</span>
      {headTerms.map((n, i) => <React.Fragment key={n}>{i > 0 && <span> 和 </span>}<Headline.Term>{n}</Headline.Term></React.Fragment>)}
    </Headline>
  )

  return (
    <Page data-testid="overview">
      <div className={`ewb-ana-ov-head${worst ? '' : ' ewb-ana-ov-head--solo'}`}>
        <div>
          {head}
          <p className="ewb-ana-facts">
            <span data-testid="overview-filter-label">范围：{filterLabel(filter)}</span>
            <span className="ewb-ana-facts__sep" aria-hidden>·</span>
            <span>试卷 <b data-testid="card-papers">{o.cards.papers}</b> 份</span>
            <span>题目 <b data-testid="card-questions">{o.cards.questions}</b> 道</span>
            <span>涉及<Glossary term="考点">知识点</Glossary> <b data-testid="card-kps">{o.cards.kps}</b> 个</span>
            <button type="button" className="ewb-ana-link" onClick={() => nav('/review')}>待审核 <b data-testid="card-pending">{o.cards.pending}</b> 份</button>
            <CoverageNote c={o.coverage} />
            <MethodologyButton />
          </p>
          {total > 0 && total < 5 && <p className="ewb-ana-meta">只有 {total} 份卷子，属于<Glossary term="样本不足，暂不比较">样本不足</Glossary>，规律先当参考，不要当趋势。</p>}
          <NotCounted />
        </div>
        {worst && (
          <UsageNote kind="mistake" title={`最容易丢分：${worst.name}`}>
            AI 估计这个考点有 {worst.errorCount} 道题学生容易做错{worst.reasons[0] ? `，常见原因：${worst.reasons[0].reason}` : ''}。（是 AI 估计，不是学生成绩。）
          </UsageNote>
        )}
      </div>

      {total === 0 ? <EmptyStats pending={o.cards.pending} /> : (
        <div className="ewb-ana-ov-body">
          <div>
            <SectionTitle level={3} compact aside={cat ? <>{CATEGORY_BY_KEY[cat].label}类 · 再点一次索引回到全部</> : '点右边的索引按知识大类看'}>
              <span>最常考的知识点（前 10 个，看<Glossary term="考了几份卷子">考了几份卷子</Glossary>）</span>
            </SectionTitle>
            <div data-testid="top10">
              <PageTurn pageKey={cat ?? 'all'} order={order}>
                {o.topGroups ? (
                  // 只有 1–2 份卷子时，「Top 10」全是 100%，没有区分度：改成两组
                  <div data-testid="top10-groups">
                    <p className="ewb-ana-meta ewb-ana-tipline" data-testid="top10-tip">卷子只有 1–2 份，排名没有意义，所以分成“每份都考”和“只考了一份”两组。多导入几份再看排名。</p>
                    <h4 className="ewb-ana-groupname">{total === 1 ? '这份卷子里考了' : `每份都考（${total} 份都有）`}</h4>
                    <div data-testid="top10-every">{entries(o.topGroups.everyPaper)}{o.topGroups.everyPaper.filter(inCat).length === 0 && <span className="ewb-ana-muted">没有</span>}</div>
                    {total > 1 && <>
                      <h4 className="ewb-ana-groupname">只考了一份</h4>
                      <div data-testid="top10-some">{entries(o.topGroups.somePapers)}{o.topGroups.somePapers.filter(inCat).length === 0 && <span className="ewb-ana-muted">没有</span>}</div>
                    </>}
                  </div>
                ) : entries(o.top)}
              </PageTurn>
              {o.top.length === 0 && <p className="ewb-ana-emptycat">没有已标注的知识点</p>}
              {o.top.length > 0 && !o.topGroups && o.top.filter(inCat).length === 0 && <p className="ewb-ana-emptycat">最常考的前 10 个里没有这一类</p>}
            </div>
          </div>
          <ThumbIndex responsive counts={counts} value={cat} onChange={pick} aria-label="按知识大类看词条" />
        </div>
      )}

      <div className="ewb-ana-section" />
      <Panel title={`今年新出现的知识点${o.newThisYear.year ? `（${yearText(o.newThisYear.year)}）` : ''}`} data-testid="new-this-year">
        {!o.newThisYear.reason && o.newThisYear.limited.length > 0 && (
          <UsageNote data-testid="new-limited" kind="caution">{`样本有限：${o.newThisYear.limited.includes('target') ? `本学年只有 ${o.newThisYear.targetPapers} 份卷子` : ''}${o.newThisYear.limited.length === 2 ? '，' : ''}${o.newThisYear.limited.includes('base') ? `之前学年只有 ${o.newThisYear.basePapers} 份` : ''}（不足 5 份），「新增」可能只是还没考到`}</UsageNote>
        )}
        {!o.newThisYear.reason && o.newThisYear.mixed.length > 0 && <UsageNote data-testid="new-mixed" kind="tip">{`两侧${o.newThisYear.mixed.join('，')}`}</UsageNote>}
        {!o.newThisYear.reason && o.newThisYear.insufficient.length > 0 && <UsageNote data-testid="new-insufficient" kind="caution">样本不足，暂不比较：用来比的卷子少于 3 份，“新出现”很可能只是这几份卷子刚好考没考到，下面默认折叠。</UsageNote>}
        <div style={{ marginTop: 12 }}>
          {o.newThisYear.reason ? <span data-testid="new-reason" className="ewb-ana-muted">{o.newThisYear.reason}</span>
            : o.newThisYear.items.length === 0 ? <span className="ewb-ana-muted">相比之前的 {o.newThisYear.basePapers} 份卷子，没有新出现的知识点</span>
              : (() => {
                const chips = <div className="ewb-ana-chips">{o.newThisYear.items.map(i => <Tooltip key={i.code} title={`今年 ${i.aT}/${i.nT} 份卷子有，去年及以前没考过`}><span className="ewb-ana-pill ewb-ana-pill--primary" tabIndex={0} data-testid={`new-${i.code}`}>{i.name}</span></Tooltip>)}</div>
                return o.newThisYear.insufficient.length > 0
                  ? <Collapse size="small" ghost data-testid="new-collapse" items={[{ key: 'x', forceRender: true, label: `样本不足，暂不比较（${o.newThisYear.items.length} 个，点开仍要查看）`, children: chips }]} />
                  : chips
              })()}
        </div>
      </Panel>

      <div className="ewb-ana-section" />
      <Panel title="最近导入" data-testid="recent">
        {o.recent.length === 0 ? <span className="ewb-ana-muted">还没有导入过试卷</span> : (
          <div className="ewb-ana-recent">
            <IndexTable<OverviewResult['recent'][number]> rowKey="id" dataSource={o.recent} showHeader={false}
              onRow={r => ({ 'data-testid': `recent-${r.id}` } as React.HTMLAttributes<HTMLElement>)}
              columns={[
                { key: 'title', render: (_, r) => <a className="ewb-ana-ellipsis" onClick={() => nav(r.status === 'reviewing' || r.status === 'done' ? `/review/${r.id}` : `/paper/${r.id}`)}>{r.title}</a> },
                { key: 'meta', width: 190, render: (_, r) => <span className="ewb-ana-meta">{r.grade ? `${r.grade}年级` : ''} {r.school_year_start ? yearText(r.school_year_start) : ''}</span> },
                { key: 'q', width: 70, align: 'right', render: (_, r) => <span className="ewb-ana-meta">{r.questions} 题</span> },
                { key: 'st', width: 170, render: (_, r) => r.similar_state === 'suspect' && r.status === 'done' ? <StatusLabel kind="queued" title="像是已有卷子的一部分，默认不计入统计">疑似重复 · 没计入统计</StatusLabel> : <StatusLabel status={r.status} /> },
                { key: 'at', width: 170, align: 'right', render: (_, r) => <span className="ewb-ana-meta">{r.created_at}</span> }
              ]} />
          </div>
        )}
      </Panel>
      <KpDetailDrawer code={openCode} filter={filter} onClose={() => setOpenCode(null)} />
      <PageViewer target={view} onClose={() => setView(null)} />
    </Page>
  )
}
