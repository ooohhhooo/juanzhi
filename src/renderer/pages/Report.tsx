import React, { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Empty, List, Popconfirm, Space, Spin, Tag, Tooltip } from 'antd'
import { DeleteOutlined, FileMarkdownOutlined, FilePdfOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import MarkdownView from '../stats/MarkdownView'
import PageViewer from '../stats/PageViewer'
import type { ViewTarget } from '../stats/PageViewer'
import { filterLabel, useStatsFilter } from '../stats/StatsFilter'
import { NotCounted } from '../stats/Parts'
import { cancelReport, dismissReportEntry, startReport, useLastDone, useReportEntry } from '../stats/reportStore'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const REASON: Record<string, string> = { data: '统计数据（试卷、题目、知识点树）有变化', prompt: '提示词变了', model: '换了模型' }

/** AI 报告（P3）：历史列表 + 按当前全局筛选生成 + 流式输出 + 导出 Markdown / PDF。数据或提示词变了只标「已过期」，绝不自动重新生成（要花钱）。 */
export default function Report() {
  const { message } = App.useApp()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { filter, ready } = useStatsFilter()
  const entry = useReportEntry()
  const lastDone = useLastDone()
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [exporting, setExporting] = useState<'md' | 'pdf' | null>(null)

  const { data: list = [], isLoading } = useQuery({ queryKey: ['reports', 'list'], queryFn: () => window.api.report.list(), placeholderData: keepPreviousData })
  const { data: preview } = useQuery({ queryKey: ['reports', 'preview', filter], queryFn: () => window.api.report.preview(filter), enabled: ready, placeholderData: keepPreviousData })
  const current = selected && list.some(r => r.id === selected) ? selected : (list[0]?.id ?? null)
  const { data: detail } = useQuery({ queryKey: ['reports', 'detail', current], queryFn: () => window.api.report.get(current!), enabled: !!current })

  // 新报告生成完成：自动选中它
  useEffect(() => { if (lastDone) setSelected(lastDone.id) }, [lastDone?.id, lastDone?.at])

  const running = entry?.status === 'running'
  const doExport = async (fmt: 'md' | 'pdf') => {
    if (!detail) return
    setExporting(fmt)
    try {
      const r = await window.api.report.export(detail.id, fmt)
      if (r.saved) message.success(fmt === 'md' ? `已导出 Markdown：${r.path}${r.images ? `（含 ${r.images} 张题目截图，在同名文件夹里）` : ''}` : `已导出 PDF：${r.path}`)
    } catch (e) { message.error(clean(e)) }
    finally { setExporting(null) }
  }
  const remove = async (id: string) => {
    try { await window.api.report.delete(id); if (selected === id) setSelected(null); qc.invalidateQueries({ queryKey: ['reports'] }) } catch (e) { message.error(clean(e)) }
  }

  const refs = (entry?.refs?.length ? entry.refs : detail?.refs) ?? []
  return (
    <div data-testid="report-page" style={{ padding: '12px 20px 40px' }}>
      <h2 style={{ margin: '4px 0 12px', color: '#1e2952' }}>AI 报告</h2>
      <Card size="small" style={{ marginBottom: 12 }} data-testid="report-new">
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          <div style={{ fontSize: 13 }}>
            按当前筛选生成「考情分析报告」：<b data-testid="report-scope">{filterLabel(filter)}{filter.sample ? ' · 示例数据' : ''}</b>
            {preview && <span style={{ color: '#666', marginLeft: 8 }} data-testid="report-counts">共 {preview.papers} 份卷子、{preview.questions} 道题</span>}
          </div>
          <NotCounted />
          <div style={{ fontSize: 12, color: '#888' }}>所有数字、知识点、样本题都由程序先算好再交给 AI，AI 只负责解读，不自己计数；难度和易错点是 AI 估计，不是学生成绩。每生成一次会调用一次 AI（产生 token 费用），生成的报告都会留在下面的历史里。</div>
          {running ? (
            <Space>
              <Tag color="processing" data-testid="report-running">正在生成…</Tag>
              <Button danger data-testid="report-cancel" onClick={cancelReport}>取消生成</Button>
            </Space>
          ) : preview?.blocked ? (
            preview.aiReady
              ? <Alert data-testid="report-blocked" type="info" showIcon message={preview.blocked} />
              : <Alert data-testid="report-guide" type="info" showIcon message="还没有配置 AI 服务" description={<span>统计和看板不依赖 AI，照常可用。要生成报告，请先到 <a data-testid="report-guide-link" onClick={() => nav('/settings')}>设置 → AI 服务</a> 填写地址、模型和密钥。</span>} />
          ) : (
            <Button type="primary" icon={<ThunderboltOutlined />} data-testid="report-generate" disabled={!preview || !ready} onClick={() => startReport(filter, preview!.filterDesc)}>生成报告</Button>
          )}
        </Space>
      </Card>

      {entry && entry.status !== 'running' && (
        <div style={{ marginBottom: 12 }}>
          {entry.status === 'error'
            ? <Alert data-testid="report-error" type="error" showIcon message="生成失败" description={entry.message} style={{ marginBottom: 8 }} />
            : <Alert data-testid="report-cancelled" type="warning" showIcon message="已取消生成，没有保存结果" style={{ marginBottom: 8 }} />}
          {entry.text && <Card size="small" title="中断前收到的内容（没有保存）" style={{ opacity: 0.75 }}><div data-testid="report-partial"><MarkdownView markdown={entry.text} refs={refs} onView={setView} /></div></Card>}
          <Space style={{ marginTop: 8 }}>
            {preview && !preview.blocked && <Button size="small" type="primary" data-testid="report-retry" onClick={() => startReport(filter, preview.filterDesc)}>{entry.status === 'error' ? '重试' : '重新生成'}</Button>}
            <Button size="small" data-testid="report-dismiss" onClick={dismissReportEntry}>关闭提示</Button>
          </Space>
        </div>
      )}

      {running && entry && (
        <Card size="small" title={`正在生成：${entry.filterDesc}`} style={{ marginBottom: 12 }} data-testid="report-live">
          <div data-testid="report-text" data-len={entry.text.length}>{entry.text ? <MarkdownView markdown={entry.text} refs={refs} onView={setView} /> : <span style={{ color: '#999' }}>等待模型返回…</span>}</div>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Card size="small" title={`历史报告（${list.length}）`} style={{ width: 300, flexShrink: 0 }} styles={{ body: { padding: 0 } }} data-testid="report-list">
          {isLoading ? <Spin style={{ margin: 16 }} /> : list.length === 0 ? <Empty style={{ margin: 16 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成过报告" /> : (
            <List size="small" dataSource={list} renderItem={r => (
              <List.Item data-testid={`report-item-${r.id}`} data-status={r.status} onClick={() => setSelected(r.id)}
                style={{ cursor: 'pointer', background: r.id === current ? '#f0f5ff' : undefined, padding: '8px 12px', alignItems: 'flex-start' }}
                actions={[<Popconfirm key="d" title="删除这份报告？" okText="删除" cancelText="取消" onConfirm={() => remove(r.id)}><Button type="text" size="small" danger data-testid={`report-delete-${r.id}`} icon={<DeleteOutlined />} onClick={e => e.stopPropagation()} /></Popconfirm>]}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.4, wordBreak: 'break-all' }}>{r.filterDesc}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>{r.createdAt}</div>
                  <Space size={4} style={{ marginTop: 2 }}>
                    {r.status === 'stale' ? <Tag color="orange" style={{ margin: 0 }}>已过期</Tag> : <Tag color="green" style={{ margin: 0 }}>最新</Tag>}
                    {r.filter.sample && <Tag style={{ margin: 0 }}>示例数据</Tag>}
                  </Space>
                </div>
              </List.Item>)} />
          )}
        </Card>

        <div style={{ flex: 1, minWidth: 0 }} data-testid="report-detail">
          {!current ? <Empty description="选择左边的报告，或生成一份新的" /> : !detail ? <Spin style={{ margin: 24 }} /> : (
            <Card size="small" title={<span>{detail.title}</span>} extra={
              <Space>
                <Button icon={<FileMarkdownOutlined />} size="small" data-testid="report-export-md" loading={exporting === 'md'} onClick={() => doExport('md')}>导出 Markdown</Button>
                <Button icon={<FilePdfOutlined />} size="small" data-testid="report-export-pdf" loading={exporting === 'pdf'} onClick={() => doExport('pdf')}>导出 PDF</Button>
              </Space>}>
              <Space wrap style={{ marginBottom: 8 }}>
                {detail.status === 'stale'
                  ? <Alert data-testid="report-stale" type="warning" showIcon style={{ padding: '2px 10px' }} message={<span><b>已过期</b>（{detail.staleReasons.map(r => REASON[r]).join('；')}）。下面是 {detail.createdAt} 生成的旧结果，想要新数据请回到上面重新生成一份——不会自动重新生成。</span>} />
                  : <Tag color="green" data-testid="report-fresh">最新 · {detail.createdAt} · {detail.model ?? ''}{detail.staleReasons.includes('model') ? '（当前设置的模型已换）' : ''}</Tag>}
                {detail.promptVersion && <Tooltip title="生成时用的提示词版本"><Tag>{detail.promptVersion}</Tag></Tooltip>}
              </Space>
              {detail.sampleWarning && <Alert data-testid="report-sample-warning" type="warning" showIcon style={{ marginBottom: 8 }} message={<span><b>样本提示（程序判定）：</b>{detail.sampleWarning}结论仅供参考。</span>} />}
              {detail.warnings.map((w, i) => <Alert key={i} data-testid="report-warning" type="warning" showIcon style={{ marginBottom: 6 }} message={w} />)}
              <div data-testid="report-body"><MarkdownView markdown={detail.markdown} refs={detail.refs} onView={setView} /></div>
            </Card>
          )}
        </div>
      </div>
      <PageViewer target={view} onClose={() => setView(null)} />
    </div>
  )
}
