import React, { useMemo, useState } from 'react'
import { Collapse, Popconfirm } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { sectionFor } from '../../shared/markdown'
import MarkdownView from './MarkdownView'
import type { ViewTarget } from './PageViewer'
import { cancelAnalysis, dismissAnalysis, startAnalysis, useAnalysisEntry } from './analysisStore'
import type { AiScope } from './analysisStore'
import { AiDraftBadge } from '../components/Plain'
import { useElapsedSeconds } from '../hooks/useElapsed'
import { Btn, ThinkingBar, UsageNote } from '../design'
import '../design/page-analysis.css'

/** 等待 AI 时状态条上的前缀：推理模型先「思考」再「写」；写不完时会自动加长篇幅重试一次 */
function waitingLabel(o: { hasText: boolean; thinking: boolean; retried: boolean }): string {
  if (o.retried && !o.hasText) return '输出内容较长，AI 正在自动加长篇幅重试一次，不需要操作'
  if (o.hasText) return 'AI 正在写'
  return o.thinking ? 'AI 正在思考' : 'AI 正在准备'
}

/**
 * P2 年度变化分析。focusCode 有值时（在知识点抽屉里）只显示该知识点的小节，并可展开完整分析。
 * 数据或提示词变了只标「已过期，可重新生成」，绝不自动重新生成（要花钱）。
 */
export default function AnalysisPanel({ scope, focusCode, onView }: { scope: AiScope; focusCode?: string; onView: (t: ViewTarget) => void }) {
  const nav = useNavigate()
  const kp = 'code' in scope   // 单个考点模式（词条详情抽屉）：只讲这一个考点，不需要「只看这个知识点 / 完整分析」切换
  const { data: st } = useQuery({ queryKey: ['stats', 'analysis', scope], queryFn: () => (kp ? window.api.ai.kpAnalysis(scope) : window.api.ai.compareAnalysis(scope)) as Promise<AnalysisState>, staleTime: 5_000 })
  const entry = useAnalysisEntry(scope)
  const [full, setFull] = useState(false)
  const elapsed = useElapsedSeconds(entry?.startedAt, entry?.status === 'running')
  const section = useMemo(() => (focusCode && st?.markdown ? sectionFor(st.markdown, focusCode) : null), [focusCode, st?.markdown])
  if (!st) return <div data-testid="ai-panel" className="ewb-ana-muted">加载中…</div>

  const refs = entry?.refs?.length ? entry.refs : st.refs
  const gen = (label: string, danger = false) => st.blocked ? null : (
    <Popconfirm title="重新生成会再调用一次模型（产生 token 费用），确定吗？" okText="重新生成" cancelText="取消" disabled={!danger} onConfirm={() => startAnalysis(scope)}>
      <Btn size="small" tone={danger ? 'secondary' : 'primary'} data-testid="ai-run" onClick={danger ? undefined : () => startAnalysis(scope)}>{label}</Btn>
    </Popconfirm>
  )

  return (
    <div className="ewb-ana-ai" data-testid="ai-panel" data-status={entry?.status ?? st.status} data-entry-len={entry ? entry.text.length : ''}>
      {entry?.status === 'running' ? (
        <>
          <div className="ewb-ana-ai__actions">
            <span data-testid="ai-running" style={{ flex: 1, minWidth: 260 }}>
              <ThinkingBar elapsedSeconds={elapsed} label={waitingLabel({ hasText: entry.text.length > 0, thinking: !!entry.thinking, retried: !!entry.retried })} />
            </span>
            <Btn size="small" tone="secondary" data-testid="ai-cancel" onClick={() => cancelAnalysis(scope)}>取消生成</Btn>
          </div>
          <div data-testid="ai-text">{entry.text ? <MarkdownView markdown={entry.text} refs={refs} onView={onView} /> : <span className="ewb-ana-ai__hint">AI 在认真写，请稍等，不需要操作。写好以后会自动显示在这里。</span>}</div>
        </>
      ) : entry?.status === 'error' ? (
        <>
          <UsageNote data-testid="ai-error" kind="mistake" title={entry.message}>
            {entry.detail && <Collapse ghost size="small" style={{ marginInlineStart: -12 }} items={[{ key: 'd', label: <span className="ewb-ana-meta">查看详情（给管理员看）</span>, children: <div data-testid="ai-error-detail" className="ewb-ana-meta" style={{ wordBreak: 'break-all' }}>{entry.detail}</div> }]} />}
          </UsageNote>
          {entry.text && (
            <div>
              <div className="ewb-ana-ai__hint">以下是 AI 写到一半的内容（未完成草稿，只能看，不算有效结果）：</div>
              <div data-testid="ai-partial" className="ewb-ana-ai__partial"><MarkdownView markdown={entry.text} refs={refs} onView={onView} /></div>
            </div>
          )}
          <div className="ewb-ana-ai__actions">{gen('重试', st.status !== 'none')}<Btn size="small" tone="secondary" onClick={() => dismissAnalysis(scope)}>关闭提示</Btn></div>
        </>
      ) : entry?.status === 'cancelled' ? (
        <>
          <UsageNote data-testid="ai-cancelled" kind="caution">已取消生成，没有保存结果</UsageNote>
          {entry.text && <div data-testid="ai-partial" className="ewb-ana-ai__partial"><MarkdownView markdown={entry.text} refs={refs} onView={onView} /></div>}
          <div className="ewb-ana-ai__actions">{gen('重新生成', st.status !== 'none')}<Btn size="small" tone="secondary" onClick={() => dismissAnalysis(scope)}>关闭提示</Btn></div>
        </>
      ) : st.status === 'none' ? (
        st.blocked
          ? (st.aiReady
            ? <UsageNote data-testid="ai-blocked" kind="tip">{st.blocked}</UsageNote>
            : <UsageNote data-testid="ai-guide" kind="tip" title="还没有配置 AI 服务">上面的统计数字不依赖 AI，照常可用。要生成「{kp ? '这个考点的' : '年度变化'}分析」，请先到 <a onClick={() => nav('/settings?admin=1')} data-testid="ai-guide-link">设置 → 管理员设置 → AI 服务</a>（请管理员）连接好 AI。</UsageNote>)
          : <div className="ewb-ana-stack"><span className="ewb-ana-ai__hint">{kp ? '还没有生成过这个考点的 AI 分析（只讲这一个考点，写得比整篇分析短）。模型只解读程序算好的数字，不会自己计数。' : '还没有生成过这个范围的 AI 分析。模型只解读程序算好的数字，不会自己计数。'}</span><div>{gen('生成 AI 分析')}</div></div>
      ) : (
        <>
          <div className="ewb-ana-ai__actions">
            <AiDraftBadge />
            {st.status !== 'stale' && <span data-testid="ai-cached" className="ewb-ana-pill ewb-ana-pill--quiet">已缓存 · {st.createdAt} · {st.model ?? ''}{st.staleReasons.includes('model') ? '（当前设置的模型已换，想用新模型请重新生成）' : ''}</span>}
            {st.blocked ? <span data-testid="ai-blocked" className="ewb-ana-ai__hint">{st.aiReady ? st.blocked : '未配置 AI，无法重新生成'}</span> : gen('重新生成', true)}
          </div>
          {st.status === 'stale' && <UsageNote data-testid="ai-stale" kind="caution"><b>已过期，可重新生成</b>（{st.staleReasons.map(r => r === 'data' ? '统计数据或样本题有变化' : r === 'prompt' ? 'AI 的写作要求有更新' : '换了 AI 模型').join('；')}）。下面是 {st.createdAt} 生成的旧结果。</UsageNote>}
          {st.warnings.map((w, i) => <UsageNote key={i} kind="caution" data-testid="ai-warning">{w}</UsageNote>)}
          {st.unverified.length > 0 && <UsageNote data-testid="ai-unverified" kind="caution">{`有 ${st.unverified.length} 句讲英语规则的话没能对上老师审核过的题目解释（正文里已标“未核实”）：请老师核对后再用`}</UsageNote>}
          <div data-testid="ai-text">
            {focusCode && !full ? (
              section
                ? <MarkdownView markdown={section} refs={refs} onView={onView} />
                : <div className="ewb-ana-ai__hint">完整分析里没有单独讨论这个知识点（新增超过 8 个时只展开前 8 个，其余只列名称；升降和消失的知识点在「三、消失与下降」里合并说明）。</div>
            ) : <MarkdownView markdown={st.markdown} refs={refs} onView={onView} />}
          </div>
          {focusCode && <Btn size="small" tone="quiet" data-testid="ai-toggle-full" onClick={() => setFull(!full)}>{full ? '只看这个知识点' : '查看完整分析'}</Btn>}
        </>
      )}
      {!entry && st.draft && (
        <Collapse ghost size="small" style={{ marginTop: 8 }} data-testid="ai-draft-box" items={[{
          key: 'draft',
          label: <span className="ewb-ana-meta">上次 AI 没写完，留下了一份未完成草稿（{st.draft.createdAt}）：点开查看。它不算有效结果。</span>,
          children: <div>
            <div className="ewb-ana-draftmsg" data-testid="ai-draft-message">{st.draft.message}</div>
            <div data-testid="ai-draft-text" className="ewb-ana-ai__partial"><MarkdownView markdown={st.draft.markdown} refs={st.draft.refs} onView={onView} /></div>
          </div>
        }]} />
      )}
    </div>
  )
}
