import React, { useMemo, useState } from 'react'
import { Alert, Button, Popconfirm, Space, Tag } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { sectionFor } from '../../shared/markdown'
import MarkdownView from './MarkdownView'
import type { ViewTarget } from './PageViewer'
import { cancelAnalysis, dismissAnalysis, startAnalysis, useAnalysisEntry } from './analysisStore'

/**
 * P2 年度变化分析。focusCode 有值时（在知识点抽屉里）只显示该知识点的小节，并可展开完整分析。
 * 数据或提示词变了只标「已过期，可重新生成」，绝不自动重新生成（要花钱）。
 */
export default function AnalysisPanel({ scope, focusCode, onView }: { scope: CompareScope; focusCode?: string; onView: (t: ViewTarget) => void }) {
  const nav = useNavigate()
  const { data: st } = useQuery({ queryKey: ['stats', 'analysis', scope], queryFn: () => window.api.ai.compareAnalysis(scope), staleTime: 5_000 })
  const entry = useAnalysisEntry(scope)
  const [full, setFull] = useState(false)
  const section = useMemo(() => (focusCode && st?.markdown ? sectionFor(st.markdown, focusCode) : null), [focusCode, st?.markdown])
  if (!st) return <div data-testid="ai-panel" style={{ color: '#999' }}>加载中…</div>

  const refs = entry?.refs?.length ? entry.refs : st.refs
  const gen = (label: string, danger = false) => st.blocked ? null : (
    <Popconfirm title="重新生成会再调用一次模型（产生 token 费用），确定吗？" okText="重新生成" cancelText="取消" disabled={!danger} onConfirm={() => startAnalysis(scope)}>
      <Button size="small" type={danger ? 'default' : 'primary'} data-testid="ai-run" onClick={danger ? undefined : () => startAnalysis(scope)}>{label}</Button>
    </Popconfirm>
  )

  return (
    <div data-testid="ai-panel" data-status={entry?.status ?? st.status} data-entry-len={entry ? entry.text.length : ''}>
      {entry?.status === 'running' ? (
        <>
          <Space style={{ marginBottom: 8 }}>
            <Tag color="processing" data-testid="ai-running">正在生成…</Tag>
            <Button size="small" danger data-testid="ai-cancel" onClick={() => cancelAnalysis(scope)}>取消生成</Button>
          </Space>
          <div data-testid="ai-text">{entry.text ? <MarkdownView markdown={entry.text} refs={refs} onView={onView} /> : <span style={{ color: '#999' }}>等待模型返回…</span>}</div>
        </>
      ) : entry?.status === 'error' ? (
        <>
          <Alert data-testid="ai-error" type="error" showIcon style={{ marginBottom: 8 }} message="生成失败" description={entry.message} />
          {entry.text && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#999' }}>以下是中断前收到的内容，没有保存：</div>
              <div data-testid="ai-partial" style={{ opacity: 0.7 }}><MarkdownView markdown={entry.text} refs={refs} onView={onView} /></div>
            </div>
          )}
          <Space>{gen('重试', st.status !== 'none')}<Button size="small" onClick={() => dismissAnalysis(scope)}>关闭提示</Button></Space>
        </>
      ) : entry?.status === 'cancelled' ? (
        <>
          <Alert data-testid="ai-cancelled" type="warning" showIcon style={{ marginBottom: 8 }} message="已取消生成，没有保存结果" />
          {entry.text && <div data-testid="ai-partial" style={{ opacity: 0.7, marginBottom: 8 }}><MarkdownView markdown={entry.text} refs={refs} onView={onView} /></div>}
          <Space>{gen('重新生成', st.status !== 'none')}<Button size="small" onClick={() => dismissAnalysis(scope)}>关闭提示</Button></Space>
        </>
      ) : st.status === 'none' ? (
        st.blocked
          ? (st.aiReady
            ? <Alert data-testid="ai-blocked" type="info" showIcon message={st.blocked} />
            : <Alert data-testid="ai-guide" type="info" showIcon message="还没有配置 AI 服务" description={<span>上面的统计数字不依赖 AI，照常可用。要生成「年度变化分析」，请先到 <a onClick={() => nav('/settings')} data-testid="ai-guide-link">设置 → AI 服务</a> 填写地址、模型和密钥。</span>} />)
          : <Space direction="vertical" size={4}><span style={{ color: '#666', fontSize: 13 }}>还没有生成过这个范围的 AI 分析。模型只解读程序算好的数字，不会自己计数。</span>{gen('生成 AI 分析')}</Space>
      ) : (
        <>
          <Space wrap style={{ marginBottom: 8 }}>
            {st.status === 'stale'
              ? <Alert data-testid="ai-stale" type="warning" showIcon style={{ padding: '2px 10px' }} message={<span><b>已过期，可重新生成</b>（{st.staleReasons.map(r => r === 'data' ? '统计数据或样本题有变化' : r === 'prompt' ? '提示词变了' : '换了模型').join('；')}）。下面是 {st.createdAt} 生成的旧结果。</span>} />
              : <Tag data-testid="ai-cached" color="green">已缓存 · {st.createdAt} · {st.model ?? ''}{st.staleReasons.includes('model') ? '（当前设置的模型已换，想用新模型请重新生成）' : ''}</Tag>}
            {st.blocked ? <span data-testid="ai-blocked" style={{ fontSize: 12, color: '#999' }}>{st.aiReady ? st.blocked : '未配置 AI，无法重新生成'}</span> : gen('重新生成', true)}
          </Space>
          {st.warnings.map((w, i) => <Alert key={i} type="warning" showIcon style={{ marginBottom: 6 }} message={w} data-testid="ai-warning" />)}
          <div data-testid="ai-text">
            {focusCode && !full ? (
              section
                ? <MarkdownView markdown={section} refs={refs} onView={onView} />
                : <div style={{ color: '#888', fontSize: 13 }}>完整分析里没有单独讨论这个知识点（新增超过 8 个时只展开前 8 个，其余只列名称；升降和消失的知识点在「三、消失与下降」里合并说明）。</div>
            ) : <MarkdownView markdown={st.markdown} refs={refs} onView={onView} />}
          </div>
          {focusCode && <Button size="small" type="link" data-testid="ai-toggle-full" onClick={() => setFull(!full)}>{full ? '只看这个知识点' : '查看完整分析'}</Button>}
        </>
      )}
    </div>
  )
}
