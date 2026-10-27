import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Collapse, Dropdown, Segmented, Tooltip } from 'antd'
import { Ban, Check, ChevronDown, Pause, Play, Upload, X, Zap } from 'lucide-react'
import { PIPELINE_STEPS, pipelineStep, statusMap } from '../status'
import { Btn, EmptyState, Icon, IndexTable, Page, StatusLabel, UsageNote, type StatusKind } from '../design'
import '../design/page-library.css'
import { useDiscardGuard } from '../hooks/useDiscardGuard'
import RetryActions from '../components/RetryActions'
import SimilarNotice from '../components/SimilarNotice'
import { useAdminOpen } from '../hooks/useUiPrefs'

type View = 'active' | 'attention' | 'all'

/** 四阶段步骤条：已完成 ✓，当前阶段高亮（失败为玫红 ✕），后面的灰色；颜色之外一定有文字 */
function PipelineSteps({ index, state }: { index: number; state: 'wait' | 'process' | 'finish' | 'error' }) {
  return (
    <div className="ewb-lib-stepper" data-testid="pipeline-steps" data-step={index} data-state={state}>
      {PIPELINE_STEPS.map((label, i) => {
        const done = state === 'finish' || i < index
        const cur = !done && i === index
        const s = done ? 'done' : cur ? (state === 'error' ? 'err' : state === 'wait' ? 'wait' : 'cur') : 'todo'
        return (
          <React.Fragment key={label}>
            {i > 0 && <span className="ewb-lib-stepper__bar" aria-hidden />}
            <span className="ewb-lib-stepper__item" data-s={s}>
              <span className="ewb-lib-stepper__dot" aria-hidden>
                {done ? <Icon as={Check} size={11} /> : cur && state === 'error' ? <Icon as={X} size={11} /> : i + 1}
              </span>
              {label}
            </span>
          </React.Fragment>
        )
      })}
    </div>
  )
}

/** 运行中的进度：AI 思考时按「已用 / 通常上限」走细条（从不假装完成），其它阶段按百分比 */
function RunProgress({ message, percent }: { message: string; percent: number }) {
  const m = /已用 (\d+) 秒/.exec(message)
  const pct = m ? Math.min(95, (Number(m[1]) / 180) * 100) : Math.min(100, Math.max(0, percent))
  return (
    <div className="ewb-lib-progress">
      <div className="ewb-lib-progress__text">{message}</div>
      <div className="ewb-thinking__rail" aria-hidden><div className="ewb-thinking__fill" style={{ transform: `scaleX(${pct / 100})` }} /></div>
    </div>
  )
}

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function QueuePage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const discardGuard = useDiscardGuard()
  const queryClient = useQueryClient()
  const [adminOpen] = useAdminOpen()
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
      { key: 'ai', label: '重新让 AI 读一遍（沿用已读出的文字）' },
      { key: 'locate', label: '只重新找题目位置（不再调用 AI）' },
      { key: 'extract', label: '从头来（重新读取文件，再让 AI 整理）' }
    ],
    onClick: ({ key }: { key: string }) => restart(p, key as 'extract' | 'ai' | 'locate')
  })

  const columns = [
    {
      title: '试卷', dataIndex: 'title', width: 220,
      render: (t: string, p: Paper) => (
        <div className="ewb-lib-papercell">
          <div className="ewb-lib-papertitle"><a onClick={() => navigate(`/paper/${p.id}`)}>{t || p.file_name}</a><SimilarNotice paper={p} compact /></div>
          <div className="ewb-lib-file">{p.file_name}</div>
        </div>
      )
    },
    {
      title: '进度',
      render: (_: unknown, p: Paper) => {
        const s = pipelineStep(p, running.get(p.id)?.stage)
        const run = running.get(p.id)
        const ex = extractProg[p.id]
        const tag = statusMap[p.status] ?? { color: 'default', label: p.status }
        let label = tag.label
        if (p.status === 'imported') label = extractWaiting.has(p.id) ? '排队提取' : '排队中'
        if (p.status === 'extracted' && parseWaiting.has(p.id)) label = '排队解析'
        if (p.status === 'extracted' && !parseWaiting.has(p.id)) label = '待解析'
        const kind: StatusKind = parseWaiting.has(p.id) || p.status === 'imported' ? 'queued'
          : p.status === 'extracting' || p.status === 'parsing' ? 'working'
          : p.status === 'extracted' || p.status === 'reviewing' ? 'pending'
          : p.status === 'done' ? 'done' : p.status === 'failed' ? 'failed' : 'queued'
        return (
          <div>
            <PipelineSteps index={s.index} state={s.state} />
            <div className="ewb-lib-state" data-testid={`qstate-${p.file_name}`}>
              <StatusLabel kind={kind}>{label}</StatusLabel>
              {run && <RunProgress message={run.message} percent={run.progress} />}
              {!run && p.status === 'extracting' && ex && <RunProgress message={ex.message} percent={ex.progress} />}
              {p.status === 'failed' && p.error && (
                <div className="ewb-lib-error">
                  <UsageNote kind="mistake" title="这份卷子没有处理成功">
                    <div data-testid="paper-error" className="ewb-lib-error__what">
                      {p.error_stage === 'parse' ? '' : '读取文件失败：'}{p.error}
                    </div>
                    {p.error_stage !== 'parse' && !/重试/.test(p.error) && <p className="ewb-lib-error__next">可以点右边的「重试」重新读取；还不行就换一份更清楚的文件，或请管理员看看。</p>}
                    {p.error_detail && (
                      <Collapse ghost size="small" style={{ marginInlineStart: -12 }} items={[{ key: 'd', label: <span className="ewb-lib-sub">查看详情（给管理员看）</span>, children: <div data-testid="paper-error-detail" className="ewb-lib-detail">{p.error_detail}</div> }]} />
                    )}
                  </UsageNote>
                </div>
              )}
              {(p.status === 'reviewing' || p.status === 'done') && <SimilarNotice paper={p} />}
              {p.status === 'extracted' && p.warning && <Tooltip title={p.warning}><span className="ewb-lib-tag" tabIndex={0}>有提取提示</span></Tooltip>}
            </div>
          </div>
        )
      }
    },
    {
      title: '操作', width: 200,
      render: (_: unknown, p: Paper) => {
        const active = parseWaiting.has(p.id) || running.has(p.id)
        if (active) return <Btn tone="secondary" size="small" icon={Ban} data-testid="cancel-parse" onClick={() => act(() => window.api.parse.cancel(p.id), '已取消')}>取消</Btn>
        if (p.status === 'extracted') return <Btn tone="secondary" size="small" icon={Zap} data-testid="start-parse" onClick={() => start(p.id)}>开始 AI 解析</Btn>
        if (p.status === 'failed') return <RetryActions paper={p} />   // 与试卷库同一个组件
        if (p.status === 'reviewing' || p.status === 'done') {
          return (
            <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
              <Btn tone="secondary" size="small" onClick={() => navigate(`/review/${p.id}`)}>{p.status === 'done' ? '查看' : '去审核'}</Btn>
              <Dropdown menu={stageMenu(p)} trigger={['click']}><Btn tone="quiet" size="small" icon={ChevronDown} title="重新解析">重新解析</Btn></Dropdown>
            </span>
          )
        }
        return null
      }
    }
  ]

  const totalTokens = usage.reduce((s, u) => s + (u.prompt ?? 0) + (u.completion ?? 0), 0)

  return (
    <Page>
      <div className="ewb-lib-head">
        <h1 className="ewb-lib-title">处理队列</h1>
        <Segmented value={view} onChange={v => setView(v as View)} options={[
          { label: `进行中 ${nActive}`, value: 'active' }, { label: `需处理 ${nAttention}`, value: 'attention' }, { label: `全部 ${papers.length}`, value: 'all' }
        ]} />
        {adminOpen && <span className="ewb-lib-sub">同时解析 {q?.concurrency ?? 2} 份</span>}
        {adminOpen && usage.length > 0 && <Tooltip title={usage.map(u => `${u.model}：${u.calls} 次，输入 ${u.prompt}（缓存命中 ${u.cached}），输出 ${u.completion}`).join('\n')}><span className="ewb-lib-tag" tabIndex={0} data-testid="usage-total">累计 {totalTokens.toLocaleString()} tokens</span></Tooltip>}
        <div className="ewb-lib-actions">
          {q?.paused
            ? <Btn tone="primary" icon={Play} data-testid="resume-queue" onClick={() => act(() => window.api.queue.resume(), '已继续')}>继续处理</Btn>
            : <Btn tone="secondary" icon={Pause} data-testid="pause-queue" onClick={() => act(() => window.api.queue.pause(), '已暂停：正在处理的试卷会做完当前这一步，不再开始新的')}>暂停队列</Btn>}
        </div>
      </div>
      {q?.paused && <UsageNote kind="caution" title="队列已暂停" data-testid="paused-banner">不会开始新的提取和解析；已经在跑的试卷会继续做完。点右上角「继续处理」恢复。</UsageNote>}
      {q && !q.aiReady && <UsageNote kind="tip" title="还没有配置 AI 服务">提取完成的试卷会停在「待解析」。请管理员到 <a onClick={() => navigate('/settings?admin=1')}>设置 → 管理员设置 → AI 服务</a> 连接好 AI 后，就能开始解析了。</UsageNote>}
      {rows.length === 0 && !isLoading ? (
        <div data-testid="queue-empty">
          {view === 'active'
            ? <EmptyState title="现在没有在处理的试卷" description="导入的试卷会先读出文字，再让 AI 拆题、标上知识点，进度都显示在这一页，不用盯着。" action={<Btn tone="primary" icon={Upload} onClick={() => navigate('/')}>去导入试卷</Btn>} />
            : <EmptyState title="没有符合条件的试卷" description="换一个上面的分类看看。" />}
        </div>
      ) : (
      <IndexTable dataSource={rows} columns={columns} rowKey="id" loading={isLoading} pagination={{ pageSize: 20, showSizeChanger: false }}
        expandable={{
          showExpandColumn: false, expandRowByClick: true,
          rowExpandable: p => !!(p.prompt_version || p.ai_model || p.error),
          expandedRowRender: p => (
            <div className="ewb-lib-expand">
              {p.ai_model && <div>AI 模型：{p.ai_model}</div>}
              {p.prompt_version && <div>AI 整理版本：{p.prompt_version}</div>}
              {p.parsed_at && <div>解析完成：{p.parsed_at}</div>}
              {p.error && <div style={{ color: 'var(--ewb-red-ink)', whiteSpace: 'pre-wrap' }}>失败原因：{p.error}{p.error_detail ? `\n详情：${p.error_detail}` : ''}</div>}
            </div>
          )
        }}
        />
      )}
    </Page>
  )
}
