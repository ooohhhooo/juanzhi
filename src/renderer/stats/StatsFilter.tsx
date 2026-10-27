import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Popconfirm, Segmented, Select, Switch, Tooltip } from 'antd'
import { Btn, ScopeBar, ScopeField, UsageNote } from '../design'
import { useQuery, useQueryClient } from '@tanstack/react-query'

/** 全局筛选条件（总览与分析看板共用）。存在设置里（ui_stats_filter），重启后记住。 */
const SETTING_KEY = 'ui_stats_filter'
const GRADES = ['1', '2', '3', '4', '5', '6'] as const
const SEMESTERS = ['上', '下'] as const
const EXAMS = ['单元测试', '期中', '期末', '月考', '其他'] as const
const GRADE_LABEL = ['', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级']

/** 读回来的值不可信（可能是旧版本留下的或被改过）：只保留合法字段 */
export function sanitizeFilter(raw: unknown): StatsFilter {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const f: StatsFilter = {}
  if (GRADES.includes(r.grade as any)) f.grade = r.grade as StatsFilter['grade']
  if (SEMESTERS.includes(r.semester as any)) f.semester = r.semester as StatsFilter['semester']
  if (Number.isInteger(r.school_year_start) && (r.school_year_start as number) >= 2000 && (r.school_year_start as number) <= 2100) f.school_year_start = r.school_year_start as number
  if (EXAMS.includes(r.exam_type as any)) f.exam_type = r.exam_type as StatsFilter['exam_type']
  if (typeof r.textbook === 'string' && r.textbook && r.textbook.length <= 100) f.textbook = r.textbook
  if (typeof r.region === 'string' && r.region && r.region.length <= 100) f.region = r.region
  if (r.includeReviewing === true) f.includeReviewing = true
  if (r.includeDuplicates === true) f.includeDuplicates = true
  if (r.sample === true) f.sample = true   // 只看示例数据（M4）
  return f
}

interface Ctx {
  filter: StatsFilter
  ready: boolean
  set: (patch: Partial<Record<keyof StatsFilter, unknown>>) => void
  reset: () => void
}
const FilterCtx = createContext<Ctx | null>(null)

export function StatsFilterProvider({ children }: { children: React.ReactNode }) {
  const [filter, setFilter] = useState<StatsFilter>({})
  const [ready, setReady] = useState(false)
  const latest = useRef(filter)
  latest.current = filter

  useEffect(() => {
    let alive = true
    // 两个「计入范围」开关（含待审核、包含重复导入）每次启动都回到默认（关）：安全的默认是只统计已确认、重复只算一份，
    // 免得重启后忘了自己上次打开过它们、看着不对的数字。维度筛选（年级等）照常记住。
    window.api.settings.get(SETTING_KEY).then(v => {
      if (!alive) return
      const { includeReviewing: _a, includeDuplicates: _b, ...dims } = sanitizeFilter(v)   // sample 随维度一起记住：重启后仍停在示例数据（它不会改变任何真实数据的统计）
      setFilter(dims); latest.current = dims; setReady(true)
    }, () => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [])

  const persist = useCallback((f: StatsFilter) => { window.api.settings.set(SETTING_KEY, f).catch(() => { /* 存不上不影响本次使用 */ }) }, [])
  const set = useCallback((patch: Partial<Record<keyof StatsFilter, unknown>>) => {
    const next = { ...latest.current } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null || v === '' || v === false) delete next[k]; else next[k] = v }
    const f = sanitizeFilter(next)
    latest.current = f
    setFilter(f)
    persist(f)
  }, [persist])
  const reset = useCallback(() => {
    // 清除维度筛选，但保留两个「计入范围」开关——它们不是筛选条件，不该被「清除筛选」悄悄关掉
    // 「示例数据 / 真实数据」也是范围开关，不是筛选条件，同样不该被「清除筛选」悄悄切换
    const keep = sanitizeFilter({ includeReviewing: latest.current.includeReviewing, includeDuplicates: latest.current.includeDuplicates, sample: latest.current.sample })
    latest.current = keep; setFilter(keep); persist(keep)
  }, [persist])

  const value = useMemo(() => ({ filter, ready, set, reset }), [filter, ready, set, reset])
  return <FilterCtx.Provider value={value}>{children}</FilterCtx.Provider>
}

export function useStatsFilter(): Ctx {
  const c = useContext(FilterCtx)
  if (!c) throw new Error('useStatsFilter 必须在 StatsFilterProvider 里使用')
  return c
}

export const filterLabel = (f: StatsFilter): string => {
  const parts: string[] = []
  if (f.grade) parts.push(GRADE_LABEL[Number(f.grade)])
  if (f.semester) parts.push(`${f.semester}学期`)
  if (f.school_year_start) parts.push(`${f.school_year_start}-${f.school_year_start + 1}学年`)
  if (f.exam_type) parts.push(f.exam_type)
  if (f.textbook) parts.push(f.textbook)
  if (f.region) parts.push(f.region)
  return parts.length ? parts.join(' · ') : '全部试卷'
}

/** 范围条是否展开：切页后记住（模块级变量）。默认收起，顶栏只剩一行范围句，和设计样张一致 */
let scopeOpenMemo = false

// ── 书眉的首尾词条：各页面用 useScopeGuide(first, last) 告诉范围条「本页第一个 / 最后一个词条是谁」 ──
let guide: { first?: string; last?: string } = {}
const guideSubs = new Set<() => void>()
const setGuide = (g: { first?: string; last?: string }) => { guide = g; guideSubs.forEach(f => f()) }
const useGuide = () => useSyncExternalStore(cb => { guideSubs.add(cb); return () => { guideSubs.delete(cb) } }, () => guide)
/** 页面调用：把本页首尾词条名交给顶栏书眉（「名词复数 — 连词成句」）。离开页面时自动清掉 */
export function useScopeGuide(first?: string, last?: string): void {
  useEffect(() => { setGuide({ first, last }); return () => setGuide({}) }, [first, last])
}

/** 范围句：没选筛选时也写成完整的一句（「看的是全部 2 份四年级试卷」），选了就写成「看的是 四年级 · 期末（3 份）」 */
export function scopeSentence(f: StatsFilter, count: number | null, grades: string[]): string {
  const n = count == null ? '' : `${count} 份`
  const dimsOn = Object.keys(f).some(k => k !== 'includeReviewing' && k !== 'includeDuplicates' && k !== 'sample')
  const src = f.sample ? '示例数据里的' : ''
  if (dimsOn) return `看的是${src} ${filterLabel(f)}${n ? `（${n}）` : ''}`
  if (count === 0) return f.sample ? '示例数据里还没有可统计的试卷' : '还没有可统计的试卷'
  const g = grades.length === 1 ? GRADE_LABEL[Number(grades[0])] : ''
  return `看的是${src}全部${n ? ' ' + n : ''}${g}试卷${grades.length > 1 ? `（${grades.map(x => GRADE_LABEL[Number(x)]).join('、')}）` : ''}`
}

/**
 * 筛选栏（设计系统第二版）：书眉式范围句 +「修改范围」展开的筛选面板（默认收起）。
 * 逻辑、数据和所有 data-testid 与旧版相同；只换外观。右上角的操作区由页面传入（总览放「导入试卷」）。
 */
export default function FilterBar({ actions }: { actions?: React.ReactNode }) {
  const { filter, set, reset, ready } = useStatsFilter()
  const g = useGuide()
  const qc = useQueryClient()
  const [open, setOpen] = useState(scopeOpenMemo)
  const { data: sampleSt, isFetching: sampleFetching } = useQuery({ queryKey: ['data', 'sample'], queryFn: () => window.api.data.sampleStatus(), staleTime: 5_000 })
  // 示例数据被清除了，筛选里却还停在"示例数据"：自动切回真实数据，免得看到一个空看板还不知道为什么
  // （正在重新取数时不判断：刚加载完示例数据、缓存里还是旧的"没有示例数据"，不能据此把筛选切回去）
  useEffect(() => { if (sampleSt && !sampleFetching && !sampleSt.loaded && filter.sample) set({ sample: false }) }, [sampleSt?.loaded, sampleFetching, filter.sample])
  const { data: opts } = useQuery({ queryKey: ['stats', 'filterOptions', !!filter.includeReviewing, !!filter.sample], queryFn: () => window.api.stats.filterOptions({ includeReviewing: filter.includeReviewing, sample: filter.sample }), staleTime: 10_000 })
  const { data: notes } = useQuery({ queryKey: ['stats', 'notes', filter], queryFn: () => window.api.stats.notes(filter) })
  const { data: ov } = useQuery({ queryKey: ['stats', 'overview', filter], queryFn: () => window.api.stats.overview(filter), enabled: ready, staleTime: 10_000 })
  const { data: allPapers = [] } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const grades = Array.from(new Set(allPapers.filter(p => p.status === 'done' && !!p.is_sample === !!filter.sample && p.grade).map(p => p.grade as string))).sort()
  const sel = (label: string, testid: string, placeholder: string, value: unknown, options: Array<{ value: any; label: string }>, key: keyof StatsFilter, width = 120) => (
    <ScopeField label={label}>
      <Select data-testid={testid} placeholder={placeholder} allowClear value={value as any} style={{ width }} options={options} onChange={v => set({ [key]: v })} popupMatchSelectWidth={false} />
    </ScopeField>
  )
  const any = Object.keys(filter).some(k => k !== 'includeReviewing' && k !== 'includeDuplicates' && k !== 'sample')
  const pending = notes?.reviewing ?? 0
  const counted = notes?.reviewingCounted ?? 0
  const superseded = notes?.reviewingSuperseded ?? 0
  return (
    <div data-testid="filter-bar">
      <ScopeBar scope={scopeSentence(filter, ov ? ov.cards.papers : null, grades)} first={g.first} last={g.last} actions={actions} open={open} onOpenChange={v => { scopeOpenMemo = v; setOpen(v) }}>
        {sel('年级', 'filter-grade', '全部', filter.grade, GRADES.map(g => ({ value: g, label: GRADE_LABEL[Number(g)] })), 'grade', 112)}
        {sel('学期', 'filter-semester', '全部', filter.semester, SEMESTERS.map(s => ({ value: s, label: `${s}学期` })), 'semester', 112)}
        {sel('学年', 'filter-year', '全部', filter.school_year_start, (opts?.years ?? []).map(y => ({ value: y, label: `${y}-${y + 1}` })), 'school_year_start', 136)}
        {sel('考试类型', 'filter-exam', '全部', filter.exam_type, EXAMS.map(e => ({ value: e, label: e })), 'exam_type', 128)}
        {sel('教材', 'filter-textbook', '全部', filter.textbook, (opts?.textbooks ?? []).map(t => ({ value: t, label: t })), 'textbook', 140)}
        {sel('地区', 'filter-region', '全部', filter.region, (opts?.regions ?? []).map(t => ({ value: t, label: t })), 'region', 120)}
        <Btn tone="secondary" size="small" data-testid="filter-reset" disabled={!any} onClick={reset}>清除筛选</Btn>
        {sampleSt?.loaded && (
          <Tooltip title="示例数据是内置的合成演示卷，和你的真实数据分开统计、互不混淆。">
            <Segmented data-testid="filter-dataset" value={filter.sample ? 'sample' : 'real'} onChange={v => set({ sample: v === 'sample' })}
              options={[{ label: '真实数据', value: 'real' }, { label: '示例数据', value: 'sample' }]} />
          </Tooltip>
        )}
        <div className="ewb-scope__switches">
          <Tooltip title="默认只统计老师已确认（已完成）的试卷。打开后，AI 解析完但还没确认的试卷也会计入，数字可能随审核变化。">
            <label><Switch size="small" data-testid="filter-reviewing" checked={!!filter.includeReviewing} onChange={v => set({ includeReviewing: v })} /><span>含待审核{pending > 0 ? `（${pending} 份）` : ''}</span></label>
          </Tooltip>
          <Tooltip title="同一个文件导入了多份（导入时选了「仍然导入」）时，默认只算一份；被标成“疑似重复”的卷子默认也不计入。打开后每一份都算，同一份卷子会被重复计数、抬高“考了几份卷子”的比例。">
            <label><Switch size="small" data-testid="filter-dup" checked={!!filter.includeDuplicates} onChange={v => set({ includeDuplicates: v })} /><span>包含重复导入（会重复计数）</span></label>
          </Tooltip>
        </div>
      </ScopeBar>
      {filter.sample && (
        <UsageNote kind="caution" data-testid="sample-banner"
          actions={<>
            <Btn tone="quiet" size="small" data-testid="sample-back" onClick={() => set({ sample: false })}>切回真实数据</Btn>
            <Popconfirm title="清除全部示例数据？" description="示例卷、它们的页面图，以及基于示例数据生成的报告都会删除；你的真实数据不受影响。" okText="清除" cancelText="取消"
              onConfirm={async () => { await window.api.data.clearSample(); qc.setQueryData(['data', 'sample'], { loaded: false, papers: 0, questions: 0 }); set({ sample: false }); qc.invalidateQueries({ queryKey: ['data'] }) }}>
              <Btn tone="danger" size="small" data-testid="sample-clear">清除示例数据</Btn>
            </Popconfirm>
          </>}>
          <b>当前看的是示例数据</b>（内置的合成演示卷，不是任何真实考情）。它不会混进你的真实数据的统计。
        </UsageNote>
      )}
      {filter.includeReviewing && (
        <UsageNote kind="caution" data-testid="reviewing-banner">
          <span><b>当前统计包含尚未确认的 AI 结果</b>（{counted} 份待审核的试卷已计入{superseded > 0 ? `；另有 ${superseded} 份待审核的卷子因同一文件已有别的代表卷（比如已确认的副本）而没有重复计入` : ''}）。这些数字可能随审核修改而变化，定稿前请先把试卷审核确认。</span>
        </UsageNote>
      )}
    </div>
  )
}
