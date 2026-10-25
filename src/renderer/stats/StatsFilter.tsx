import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Select, Space, Switch, Tooltip } from 'antd'
import { useQuery } from '@tanstack/react-query'

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
      const { includeReviewing: _a, includeDuplicates: _b, ...dims } = sanitizeFilter(v)
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
    const keep = sanitizeFilter({ includeReviewing: latest.current.includeReviewing, includeDuplicates: latest.current.includeDuplicates })
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

export default function FilterBar() {
  const { filter, set, reset } = useStatsFilter()
  const { data: opts } = useQuery({ queryKey: ['stats', 'filterOptions', !!filter.includeReviewing], queryFn: () => window.api.stats.filterOptions({ includeReviewing: filter.includeReviewing }), staleTime: 10_000 })
  const { data: notes } = useQuery({ queryKey: ['stats', 'notes', filter], queryFn: () => window.api.stats.notes(filter) })
  const w = 108
  const sel = (testid: string, placeholder: string, value: unknown, options: Array<{ value: any; label: string }>, key: keyof StatsFilter, width = w) => (
    <Select data-testid={testid} placeholder={placeholder} allowClear value={value as any} style={{ width }} options={options} onChange={v => set({ [key]: v })} popupMatchSelectWidth={false} />
  )
  const any = Object.keys(filter).some(k => k !== 'includeReviewing' && k !== 'includeDuplicates')
  const pending = notes?.reviewing ?? 0
  const counted = notes?.reviewingCounted ?? 0
  const superseded = notes?.reviewingSuperseded ?? 0
  return (
    <div data-testid="filter-bar" style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '10px 20px 8px' }}>
      <Space wrap size={[8, 8]} align="center">
        <span style={{ color: '#888', fontSize: 12 }}>筛选</span>
        {sel('filter-grade', '年级', filter.grade, GRADES.map(g => ({ value: g, label: GRADE_LABEL[Number(g)] })), 'grade', 96)}
        {sel('filter-semester', '学期', filter.semester, SEMESTERS.map(s => ({ value: s, label: `${s}学期` })), 'semester', 96)}
        {sel('filter-year', '学年', filter.school_year_start, (opts?.years ?? []).map(y => ({ value: y, label: `${y}-${y + 1}` })), 'school_year_start', 124)}
        {sel('filter-exam', '考试类型', filter.exam_type, EXAMS.map(e => ({ value: e, label: e })), 'exam_type', 116)}
        {sel('filter-textbook', '教材', filter.textbook, (opts?.textbooks ?? []).map(t => ({ value: t, label: t })), 'textbook', 130)}
        {sel('filter-region', '地区', filter.region, (opts?.regions ?? []).map(t => ({ value: t, label: t })), 'region', 110)}
        <Button size="small" data-testid="filter-reset" disabled={!any} onClick={reset}>清除筛选</Button>
        <span style={{ borderLeft: '1px solid #eee', height: 20 }} />
        <Tooltip title="默认只统计老师已确认（已完成）的试卷。打开后，AI 解析完但还没确认的试卷也会计入，数字可能随审核变化。">
          <span><Switch size="small" data-testid="filter-reviewing" checked={!!filter.includeReviewing} onChange={v => set({ includeReviewing: v })} /> <span style={{ fontSize: 12 }}>含待审核{pending > 0 ? `（${pending} 份）` : ''}</span></span>
        </Tooltip>
        <Tooltip title="同一个文件导入了多份（导入时选了「仍然导入」）时，默认只算一份：在当前状态与筛选下可见的几份里，先取已确认的，同状态再取最早导入的。打开后每一份都算，同一份卷子会被重复计数、抬高出现率。">
          <span><Switch size="small" data-testid="filter-dup" checked={!!filter.includeDuplicates} onChange={v => set({ includeDuplicates: v })} /> <span style={{ fontSize: 12 }}>包含重复导入（会重复计数）</span></span>
        </Tooltip>
      </Space>
      {filter.includeReviewing && (
        <Alert data-testid="reviewing-banner" type="warning" showIcon style={{ marginTop: 8, padding: '4px 12px' }}
          message={<span><b>当前统计包含尚未确认的 AI 结果</b>（{counted} 份待审核的试卷已计入{superseded > 0 ? `；另有 ${superseded} 份待审核的卷子因同一文件已有别的代表卷（比如已确认的副本）而没有重复计入` : ''}）。这些数字可能随审核修改而变化，定稿前请先把试卷审核确认。</span>} />
      )}
    </div>
  )
}
