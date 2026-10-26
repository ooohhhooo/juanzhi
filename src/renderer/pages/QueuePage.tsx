import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Alert, Button, Dropdown, Progress, Segmented, Space, Table, Tag, Tooltip } from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, DownOutlined, StopOutlined, ThunderboltOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { PIPELINE_STEPS, pipelineStep, statusMap } from '../status'
import { useDiscardGuard } from '../hooks/useDiscardGuard'
import RetryActions from '../components/RetryActions'

type View = 'active' | 'attention' | 'all'

/** 四阶段步骤条：已完成 ✓，当前阶段高亮（失败为红 ✕），后面的灰色 */
function PipelineSteps({ index, state }: { index: number; state: 'wait' | 'process' | 'finish' | 'error' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} data-testid="pipeline-steps" data-step={index} data-state={state}>
      {PIPELINE_STEPS.map((label, i) => {
        const done = state === 'finish' || i < index
        const cur = !done && i === index
        const color = cur ? (state === 'error' ? '#cf1322' : state === 'wait' ? '#8c8c8c' : '#1677ff') : done ? '#52c41a' : '#bfbfbf'
        return (
          <React.Fragment key={label}>
            {i > 0 && <div style={{ width: 10, height: 1, background: done || cur ? color : '#e0e0e0' }} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, color, fontSize: 12, whiteSpace: 'nowrap', fontWeight: cur ? 600 : 400 }}>
              <span style={{ width: 16, height: 16, borderRadius: 8, border: `1px solid ${color}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, background: cur && state !== 'wait' ? color : '#fff', color: cur && state !== 'wait' ? '#fff' : color }}>
                {done ? <CheckOutlined /> : cur && state === 'error' ? <CloseOutlined /> : i + 1}
              </span>
              {label}
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function QueuePage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const discardGuard = useDiscardGuard()
  const queryClient = useQueryClient()
  const [view, setView] = useState<View>('active')
  const [extractProg, setExtractProg] = useState<Record<string, JobProgress>>({})

  useEffect(() => window.api.on('job:progress', (p: JobProgress) => setExtractProg(prev => ({ ...prev, [p.paperId]: p }))), [])

  const { data: papers = [], isLoading } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const { data: q } = useQuery({ queryKey: ['queue', 'state'], queryFn: () => window.api.queue.state(), refetchInterval: 1000 })
  const { data: usage = [] } = useQuery({ queryKey: ['usage'], queryFn: () => window.api.ai.usage() })

  const running = useMemo(() => new Map((q?.parse.running ?? []).map(r => [r.paperId, r])), [q])
  const parseWaiting = useMemo(() => new Set((q?.parse.waiting ?? []).map(w => w.paperId)), [q])
  const extractWaiting = useMemo(() => new Set(q?.extract.waiting ?? []), [q])

  const isActive = (p: Paper) => ['imported', 'extracting', 'parsing'].includes(p.status) || parseWaiting.has(p.id)
  const needsAttention = (p: Paper) => p.status === 'failed' || (p.status === 'extracted' && !parseWaiting.has(p.id))
  const rows = papers.filter(p => view === 'all' ? true : view === 'active' ? isActive(p) : needsAttention(p))
  const nActive = papers.filter(isActive).length
  const nAttention = papers.filter(needsAttention).length

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) message.success(ok) } catch (e) { message.error(clean(e)) }
    queryClient.invalidateQueries({ queryKey: ['queue'] })
    queryClient.invalidateQueries({ queryKey: ['papers'] })
  }
  const start = (id: string, stage?: 'extract' | 'ai' | 'locate', ok = '已加入解析队列') => act(() => window.api.parse.start(id, stage), ok)
  const restart = async (p: Paper, stage: 'extract' | 'ai' | 'locate') => {
    // 只要现在有题目（包括解析失败但保留着旧题的）就先确认
    if (await discardGuard(p, stage === 'extract' ? 'extract' : 'reparse')) await start(p.id, stage)
  }

  const stageMenu = (p: Paper) => ({
    items: [
      { key: 'ai', label: '重新 AI 解析（沿用已提取的文字）' },
      { key: 'locate', label: '仅重新定位（沿用上次 AI 结果，不再调用模型）' },
      { key: 'extract', label: '从头重试（重新提取文字再解析）' }
    ],
    onClick: ({ key }: { key: string }) => restart(p, key as 'extract' | 'ai' | 'locate')
  })

  const columns = [
    {
      title: '试卷', dataIndex: 'title', width: 190, ellipsis: true,
      render: (t: string, p: Paper) => (
        <div>
          <a onClick={() => navigate(`/paper/${p.id}`)}>{t || p.file_name}</a>
          <div style={{ fontSize: 12, color: '#999' }}>{p.file_name}</div>
        </div>
      )
    },
    {
      title: '阶段', width: 370,
      render: (_: unknown, p: Paper) => {
        const s = pipelineStep(p, running.get(p.id)?.stage)
        return <PipelineSteps index={s.index} state={s.state} />
      }
    },
    {
      title: '状态', width: 210,
      render: (_: unknown, p: Paper) => {
        const run = running.get(p.id)
        const ex = extractProg[p.id]
        const tag = statusMap[p.status] ?? { color: 'default', label: p.status }
        let label = tag.label
        if (p.status === 'imported') label = extractWaiting.has(p.id) ? '排队提取' : '排队中'
        if (p.status === 'extracted' && parseWaiting.has(p.id)) label = '排队解析'
        if (p.status === 'extracted' && !parseWaiting.has(p.id)) label = '待解析'
        return (
          <div data-testid={`qstate-${p.file_name}`}>
            <Tag color={parseWaiting.has(p.id) ? 'default' : tag.color}>{label}</Tag>
            {run && <div style={{ marginTop: 4 }}><Progress size="small" percent={run.progress} status="active" /><div style={{ fontSize: 12, color: '#666' }}>{run.message}</div></div>}
            {!run && p.status === 'extracting' && ex && <div style={{ marginTop: 4 }}><Progress size="small" percent={ex.progress} status="active" /><div style={{ fontSize: 12, color: '#666' }}>{ex.message}</div></div>}
            {p.status === 'failed' && p.error && (
              <Tooltip title={p.error}>
                <div data-testid="paper-error" style={{ color: '#cf1322', fontSize: 12, marginTop: 4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {p.error_stage === 'parse' ? 'AI 解析失败：' : '提取失败：'}{p.error}
                </div>
              </Tooltip>
            )}
            {p.status === 'extracted' && p.warning && <Tooltip title={p.warning}><Tag color="warning" style={{ marginTop: 4 }}>有提取提示</Tag></Tooltip>}
          </div>
        )
      }
    },
    {
      title: '操作', width: 190,
      render: (_: unknown, p: Paper) => {
        const active = parseWaiting.has(p.id) || running.has(p.id)
        if (active) return <Button size="small" icon={<StopOutlined />} data-testid="cancel-parse" onClick={() => act(() => window.api.parse.cancel(p.id), '已取消')}>取消</Button>
        if (p.status === 'extracted') return <Button size="small" type="primary" icon={<ThunderboltOutlined />} data-testid="start-parse" onClick={() => start(p.id)}>开始 AI 解析</Button>
        if (p.status === 'failed') return <RetryActions paper={p} />   // 与试卷库同一个组件
        if (p.status === 'reviewing' || p.status === 'done') {
          return (
            <Space.Compact size="small">
              <Button size="small" onClick={() => navigate(`/review/${p.id}`)}>{p.status === 'done' ? '查看' : '去审核'}</Button>
              <Dropdown menu={stageMenu(p)} trigger={['click']}><Button size="small" icon={<DownOutlined />} title="重新解析" /></Dropdown>
            </Space.Compact>
          )
        }
        return null
      }
    }
  ]

  const totalTokens = usage.reduce((s, u) => s + (u.prompt ?? 0) + (u.completion ?? 0), 0)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: '#1e2952' }}>处理队列</h2>
        <Segmented value={view} onChange={v => setView(v as View)} options={[
          { label: `进行中 ${nActive}`, value: 'active' }, { label: `需处理 ${nAttention}`, value: 'attention' }, { label: `全部 ${papers.length}`, value: 'all' }
        ]} />
        <span style={{ color: '#666', fontSize: 13 }}>同时解析 {q?.concurrency ?? 2} 份</span>
        {usage.length > 0 && <Tooltip title={usage.map(u => `${u.model}：${u.calls} 次，输入 ${u.prompt}（缓存命中 ${u.cached}），输出 ${u.completion}`).join('\n')}><Tag data-testid="usage-total">累计 {totalTokens.toLocaleString()} tokens</Tag></Tooltip>}
        <div style={{ marginLeft: 'auto' }}>
          {q?.paused
            ? <Button type="primary" icon={<PlayCircleOutlined />} data-testid="resume-queue" onClick={() => act(() => window.api.queue.resume(), '已继续')}>继续处理</Button>
            : <Button icon={<PauseCircleOutlined />} data-testid="pause-queue" onClick={() => act(() => window.api.queue.pause(), '已暂停：正在处理的试卷会做完当前这一步，不再开始新的')}>暂停队列</Button>}
        </div>
      </div>
      {q?.paused && <Alert data-testid="paused-banner" type="warning" showIcon style={{ marginBottom: 12 }} message="队列已暂停" description="不会开始新的提取和解析；已经在跑的试卷会继续做完。点右上角「继续处理」恢复。" />}
      {q && !q.aiReady && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="还没有配置 AI 服务" description={<span>提取完成的试卷会停在「待解析」。到 <a onClick={() => navigate('/settings')}>设置 → AI 服务</a> 填好 Base URL、模型和 API Key 后即可开始解析。</span>} />}
      <Table dataSource={rows} columns={columns} rowKey="id" loading={isLoading} size="middle" pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 'max-content' }}
        expandable={{
          showExpandColumn: false, expandRowByClick: true,
          rowExpandable: p => !!(p.prompt_version || p.ai_model || p.error),
          expandedRowRender: p => (
            <div style={{ fontSize: 12, color: '#666' }}>
              {p.ai_model && <div>模型：{p.ai_model}</div>}
              {p.prompt_version && <div>提示词版本：{p.prompt_version}</div>}
              {p.parsed_at && <div>解析完成：{p.parsed_at}</div>}
              {p.error && <div style={{ color: '#cf1322', whiteSpace: 'pre-wrap' }}>错误详情：{p.error}</div>}
            </div>
          )
        }}
        locale={{ emptyText: view === 'active' ? '队列是空的。在试卷库导入试卷后会自动出现在这里。' : '没有符合条件的试卷' }} />
    </div>
  )
}
