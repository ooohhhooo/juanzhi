import React, { useMemo, useState } from 'react'
import { App, Drawer, Segmented, Spin } from 'antd'
import { Download } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { NotCounted } from '../../stats/Parts'
import { useStatsFilter } from '../../stats/StatsFilter'
import { KpModeSwitch, KpPickMulti } from '../../components/KpPaperFilter'
import type { KpMode } from '../../components/KpPaperFilter'
import { compareToTable, OVERLAP_LABEL, overlapKind } from '../../../shared/kp-compare-table'
import { Btn, EmptyState, UsageNote } from '../../design'
import '../../design/page-analysis.css'

type Kind = 'all' | 'one' | 'some' | 'none'
const KIND_FILTERS: Array<{ label: string; value: 'any' | Kind }> = [{ label: '全部', value: 'any' }, { label: '都考了', value: 'all' }, { label: '只有一份考', value: 'one' }, { label: '部分考', value: 'some' }]

/**
 * 知识点 ↔ 试卷 并排对比。横排是卷子，竖排是知识点，格子里是题数 / 分值 / 易错。
 * 两个方向都能进：在筛选栏（或试卷库）选几份卷子，看它们考了哪些知识点；或者在这里选知识点，找出考了它们的卷子。
 * 点格子看原题（和看板里的题目卡片同一套）。
 */
export default function KpCompareTab() {
  const { filter } = useStatsFilter()
  const { message } = App.useApp()
  const loc = useLocation()
  const [codes, setCodes] = useState<string[]>(() => ((loc.state as { codes?: string[] } | null)?.codes ?? []))
  const [mode, setMode] = useState<KpMode>('any')
  const [level, setLevel] = useState(2)
  const [kindFilter, setKindFilter] = useState<'any' | Kind>('any')
  const [open, setOpen] = useState<{ paper: string; kp: string } | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [exporting, setExporting] = useState(false)
  const picked = !!filter.paperIds?.length
  const { data: r, isLoading } = useQuery({
    queryKey: ['stats', 'kpCompare', filter, codes, mode, level],
    queryFn: () => window.api.stats.kpCompare(filter, codes, mode, level),
    enabled: picked || codes.length > 0
  })
  const n = r?.papers.length ?? 0
  const cellOf = useMemo(() => new Map((r?.cells ?? []).map(c => [`${c.paper}|${c.kp}`, c])), [r])
  const shownKps = useMemo(() => (r?.kps ?? []).filter(k => kindFilter === 'any' || overlapKind(k.papers, n) === kindFilter), [r, kindFilter, n])
  const stat = useMemo(() => {
    const all = r?.kps ?? []
    return { all: all.filter(k => overlapKind(k.papers, n) === 'all').length, one: all.filter(k => overlapKind(k.papers, n) === 'one').length, none: all.filter(k => k.papers === 0).length }
  }, [r, n])

  const exportXlsx = async () => {
    if (!r) return
    setExporting(true)
    try {
      const t = compareToTable({ ...r, kps: shownKps })
      const res = await window.api.analysisReport.exportTable(t.columns, t.rows, '知识点对比')
      if (res.saved) message.success('已导出 Excel')
    } catch (e) { message.error(`导出失败：${(e as Error).message.replace(/^Error invoking remote method '[^']+': /, '')}`) } finally { setExporting(false) }
  }

  const openPaper = open ? r?.papers.find(p => p.id === open.paper) : undefined
  const openKp = open ? r?.kps.find(k => k.code === open.kp) : undefined
  const { data: qs, isLoading: qLoading } = useQuery({
    queryKey: ['stats', 'kpCompareQuestions', filter, open?.paper, open?.kp],
    queryFn: () => window.api.stats.questions({ ...filter, paperIds: [open!.paper] }, { kind: 'filter' }, open!.kp, 50),
    enabled: !!open
  })

  // 分组：一级大类
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; kps: typeof shownKps }>()
    for (const k of shownKps) { const g = m.get(k.groupCode) ?? { name: k.group, kps: [] }; g.kps.push(k); m.set(k.groupCode, g) }
    return [...m.values()]
  }, [shownKps])

  return (
    <div data-testid="kpcompare">
      <div className="ewb-ana-toolbar">
        <span className="ewb-ana-toolbar__label">知识点</span>
        <KpPickMulti testId="kpc-kps" value={codes} onChange={setCodes} placeholder="不选 = 看这些卷子考过的全部知识点；选几个 = 只看这几个" />
        {!picked && codes.length > 1 && <KpModeSwitch testId="kpc-mode" value={mode} onChange={setMode} />}
        {codes.length === 0 && <Segmented data-testid="kpc-level" size="small" value={level} onChange={v => setLevel(v as number)} options={[{ label: '二级知识点', value: 2 }, { label: '三级知识点', value: 3 }]} />}
      </div>
      <NotCounted />
      {!picked && codes.length === 0 && (
        <div data-testid="kpc-empty"><EmptyState inline title="选几份卷子，或选几个知识点"
          description="从卷子出发：到上面的筛选栏里选几份试卷（或在试卷库里勾选后点「知识点对比」），就能看到它们考了哪些知识点。从知识点出发：在上面选一个或几个知识点，会找出考了它们的卷子并排放在一起。" /></div>
      )}
      {(picked || codes.length > 0) && isLoading && <Spin style={{ margin: 40 }} />}
      {r && n === 0 && (picked || codes.length > 0) && <div data-testid="kpc-none"><EmptyState inline title="没有可以对比的卷子" description="只统计已确认的卷子（待审核的可以打开上方「含待审核」）。换几个知识点，或改成「考了其中任一个」试试。" /></div>}
      {r && n > 0 && (
        <>
          <div className="ewb-ana-toolbar" style={{ marginBottom: 'var(--ewb-sp-2)' }}>
            <span className="ewb-ana-meta" data-testid="kpc-summary">
              {picked ? `你选中的 ${n} 份卷子` : `考了这些知识点的 ${n + r.truncated} 份卷子`} × {r.kps.length} 个知识点
              {r.kps.length > 0 && n > 1 && <>：<b>{stat.all}</b> 个每份都考了，<b>{stat.one}</b> 个只有一份考{stat.none > 0 ? <>，<b>{stat.none}</b> 个都没考</> : null}</>}
            </span>
            <Segmented data-testid="kpc-kind" size="small" value={kindFilter} onChange={v => setKindFilter(v as 'any' | Kind)} options={KIND_FILTERS} />
            <Btn tone="secondary" size="small" icon={Download} data-testid="kpc-export" loading={exporting} disabled={shownKps.length === 0} onClick={() => void exportXlsx()}>导出 Excel</Btn>
          </div>
          {r.truncated > 0 && <UsageNote kind="caution" data-testid="kpc-truncated">符合的卷子有 {n + r.truncated} 份，一次最多并排 {n} 份，其余 {r.truncated} 份没有列出。可以多选几个知识点或在筛选栏里缩小范围。</UsageNote>}
          {n === 1 && <UsageNote kind="tip">只有 1 份卷子，没法比较「哪些知识点几份卷子都考」；多选几份就能看出来。</UsageNote>}
          {shownKps.length === 0
            ? <div data-testid="kpc-nokp"><EmptyState inline title="没有符合的知识点" description={kindFilter === 'any' ? '这几份卷子里没有标过知识点的题。' : '换一个「都考了 / 只有一份考」的筛选看看。'} /></div>
            : (
              <div className="ewb-kpc-wrap">
                <table className="ewb-kpc" data-testid="kpc-table">
                  <thead>
                    <tr>
                      <th className="ewb-kpc__kp">知识点</th>
                      <th className="ewb-kpc__hit">几份考了</th>
                      {r.papers.map(p => (
                        <th key={p.id} className="ewb-kpc__paper" data-testid={`kpc-head-${p.id}`} title={p.title}>
                          <span className="ewb-ana-ellipsis">{p.title}</span>
                          <span className="ewb-ana-meta">{[p.school_year_start ? `${p.school_year_start}学年` : '', p.grade ? `${p.grade}年级` : '', p.semester ?? '', p.exam_type ?? ''].filter(Boolean).join(' ')}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(g => (
                      <React.Fragment key={g.name}>
                        <tr className="ewb-kpc__group"><td colSpan={2 + r.papers.length}>{g.name}</td></tr>
                        {g.kps.map(k => {
                          const kind = overlapKind(k.papers, n)
                          return (
                            <tr key={k.code} data-testid={`kpc-row-${k.code}`} data-kind={kind}>
                              <th className="ewb-kpc__kp" scope="row">{k.name}</th>
                              <td className="ewb-kpc__hit">
                                <span data-testid={`kpc-hit-${k.code}`}>{k.papers}/{n}</span>
                                {n > 1 && kind !== 'some' && kind !== 'none' && <span className={`ewb-ana-pill ${kind === 'all' ? 'ewb-ana-pill--primary' : 'ewb-ana-pill--quiet'}`} style={{ marginInlineStart: 6 }}>{OVERLAP_LABEL[kind]}</span>}
                              </td>
                              {r.papers.map(p => {
                                const c = cellOf.get(`${p.id}|${k.code}`)
                                return (
                                  <td key={p.id} className="ewb-kpc__cell">
                                    {c
                                      ? <button type="button" className="ewb-kpc__btn" data-testid={`kpc-cell-${p.id}-${k.code}`} data-q={c.questions} onClick={() => setOpen({ paper: p.id, kp: k.code })} title="点开看原题">
                                        <b>{c.questions}</b> 题{c.scored > 0 ? ` · ${c.score} 分` : ''}{c.errors > 0 && <span className="ewb-ana-pill ewb-ana-pill--red" style={{ marginInlineStart: 4 }}>易错</span>}
                                      </button>
                                      : <span className="ewb-ana-muted">—</span>}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          <div className="ewb-ana-meta" style={{ marginTop: 8 }}>题数：命中这个知识点（含它下面的子知识点）的题，一道题只算一次。分值只按主要考的知识点计；「易错」是 AI 估计、老师审核过的，不是学生成绩。</div>
        </>
      )}
      <Drawer open={!!open} onClose={() => setOpen(null)} width="min(760px, 94vw)" destroyOnHidden data-testid="kpc-drawer" title={openPaper && openKp ? `${openPaper.title} · ${openKp.name}` : '原题'}>
        {qLoading && <Spin />}
        {qs && qs.length === 0 && <div className="ewb-ana-meta">这份卷子里没有查到相关题目。</div>}
        {qs?.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}
      </Drawer>
      <PageViewer target={view} onClose={() => setView(null)} />
    </div>
  )
}
