import React, { useEffect, useState } from 'react'
import { App, Popconfirm } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, UsageNote } from '../design'
import '../design/page-course.css'
import { CostHint } from './AiCost'
import AiErrorExplain from './AiErrorExplain'

export const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const MATCH_LABEL: Record<string, string> = { none: '未匹配', partial: '部分已匹配', stale: '大纲已更新，需要重新匹配', done: '已匹配' }

const wan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : `${Math.max(1, Math.round(n / 100) * 100)}`)

/**
 * 知识点 → 课次 的 AI 匹配控件（设置的体系卡片和看板的“还没匹配”提示共用）：
 * 先显示规模和预计用量，用户点“开始匹配”才调用 AI；逐批显示进度，可取消，已完成的批次保留。
 */
export default function MatchBox({ card, onDone }: { card: Pick<CourseOutlineCard, 'id' | 'name' | 'match' | 'status'>; onDone?: () => void }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [prog, setProg] = useState<CourseMatchProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<string | null>(null)
  const [failed, setFailed] = useState(0)   // 每失败一次加 1：触发重新诊断
  const onlyNew = card.match.state === 'partial'
  const { data: est } = useQuery({ queryKey: ['course', 'estimate', card.id, onlyNew, card.match.state, card.match.total], queryFn: () => window.api.course.matchEstimate(card.id, onlyNew), staleTime: 5_000 })
  useEffect(() => {
    let alive = true
    window.api.course.matchProgress(card.id).then(p => { if (alive && p && p.phase === 'running') { setProg(p); setBusy(true) } }, () => undefined)
    const off = window.api.on('course:progress', (p: CourseMatchProgress) => { if (p.outlineId === card.id && alive) setProg(p) })
    return () => { alive = false; off?.() }
  }, [card.id])

  const run = async (again: boolean) => {
    setBusy(true); setLast(null)
    try {
      const r = await window.api.course.match(card.id, again ? false : onlyNew)
      setLast(r.ok ? `匹配完成：${r.matched} 个知识点找到了对应的课，${r.none} 个没有找到${r.dropped ? `（另有 ${r.dropped} 条 AI 回答对不上课程，已丢弃）` : ''}` : r.message ?? '匹配没有完成')
      if (r.ok) message.success('匹配完成'); else if (!r.cancelled) { message.error(r.message ?? '匹配失败'); setFailed(n => n + 1) }
      qc.invalidateQueries({ queryKey: ['course'] })
      onDone?.()
    } catch (e) { setLast(clean(e)); message.error(clean(e)); setFailed(n => n + 1) } finally { setBusy(false); setProg(null) }
  }
  if (card.status !== 'active') return null
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
  return (
    <div data-testid={`match-box-${card.id}`} data-state={card.match.state}>
      {busy ? (
        <div data-testid="match-progress">
          <span className="ewb-rep-note">正在匹配：第 {Math.min((prog?.done ?? 0) + 1, prog?.total ?? 1)} 批，共 {prog?.total ?? '…'} 批（每批约 30 个知识点；已完成的批次会保留）</span>
          <div className="ewb-crs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
          <Btn tone="secondary" size="small" data-testid="match-cancel" onClick={() => window.api.course.matchCancel(card.id)}>取消</Btn>
        </div>
      ) : (
        <div className="ewb-rep-row" style={{ gap: 8 }}>
          {card.match.state !== 'done' && (
            <Popconfirm disabled={!est?.needsConfirm} title={`这次匹配预计用量约 ${wan(est?.tokens ?? 0)} token，比较多（实际以服务商为准）。确定开始吗？`} okText="确定开始" cancelText="取消" onConfirm={() => run(false)}>
              <Btn tone="primary" size="small" data-testid="match-start" onClick={est?.needsConfirm ? undefined : () => run(false)}>{card.match.state === 'partial' ? `补匹配新知识点（${card.match.total - card.match.checked} 个）` : card.match.state === 'stale' ? '重新匹配' : '开始匹配'}</Btn>
            </Popconfirm>
          )}
          {card.match.state === 'partial' && <Popconfirm title="整体重新匹配会再调用多次模型（产生 token 费用），人工确认过的对应会保留。确定吗？" okText="重新匹配" cancelText="取消" onConfirm={() => run(true)}><Btn tone="secondary" size="small" data-testid="match-redo">整体重新匹配</Btn></Popconfirm>}
          {card.match.state === 'done' && <Popconfirm title="重新匹配会再调用多次模型（产生 token 费用）。人工确认 / 否决过的对应会保留。确定吗？" okText="重新匹配" cancelText="取消" onConfirm={() => run(true)}><Btn tone="quiet" size="small" data-testid="match-redo">重新匹配</Btn></Popconfirm>}
          {est && card.match.state !== 'done' && est.kps > 0 && (
            <span className="ewb-rep-note" data-testid="match-estimate">约 {est.kps} 个知识点 × {est.lessons} 课，{est.batches} 次请求，预计用量约 {wan(est.tokens)} token（实际以服务商为准）</span>
          )}
          {est && card.match.state !== 'done' && est.kps > 0 && <CostHint task="course-match" calls={est.batches} fallbackTokens={est.tokens} />}
        </div>
      )}
      {last && <p className="ewb-rep-note" data-testid="match-result" style={{ marginTop: 6 }}>{last}</p>}
      {last && failed > 0 && !/^匹配完成/.test(last) && <AiErrorExplain message={last} task="course-match" nonce={failed} />}
      {card.match.state === 'none' && est && est.kps === 0 && !busy && <UsageNote kind="tip">库里还没有标过知识点的题目（先导入并审核试卷），暂时没有可匹配的内容。</UsageNote>}
    </div>
  )
}
