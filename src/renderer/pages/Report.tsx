import React, { useEffect, useState } from 'react'
import { App, Checkbox, Collapse, Modal, Popconfirm, Tooltip } from 'antd'
import { ClipboardList, Copy, FileText, FileType2, Sparkles, ShieldCheck, Trash2, X } from 'lucide-react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import MarkdownView from '../stats/MarkdownView'
import PageViewer from '../stats/PageViewer'
import type { ViewTarget } from '../stats/PageViewer'
import { filterLabel, useScopeGuide, useStatsFilter } from '../stats/StatsFilter'
import { NotCounted } from '../stats/Parts'
import { cancelReport, dismissReportEntry, startReport, useLastDone, useReportEntry } from '../stats/reportStore'
import { READERS, READER_HINT, READER_LABEL } from '../../shared/report-post'
import { AiDraftBadge, waitingText } from '../components/Plain'
import { useElapsedSeconds } from '../hooks/useElapsed'
import { useRoleGuideRole } from '../hooks/useUiPrefs'
import { Btn, EmptyState, NoticeStack, Page, Panel, SkeletonBar, StatusLabel, UsageNote } from '../design'
import '../design/page-report.css'

/** 写进剪贴板：优先用标准接口，不行再退回隐藏文本框 + execCommand（窗口没焦点、非安全上下文时标准接口会失败） */
async function writeClipboard(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return } catch { /* 退回旧办法 */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  try { if (!document.execCommand('copy')) throw new Error('复制失败') } finally { ta.remove() }
}

/** 给老师的核对清单（纯文本，可以直接发微信 / 邮件）：这份报告要看哪些地方 + 系统没能对上题目解释的句子 */
function checklistText(d: ReportDetail): string {
  const lines = [
    `【请老师核对】${d.title}`,
    '这份报告是 AI 写的草稿，需要懂英语的老师看一遍再用。请重点看：',
    '1. 讲英语规则的句子对不对（比如 time for / time to 怎么用、名词复数怎么变）；',
    '2. 每个例句有没有错，例句和讲的那条是不是对得上；'
  ]
  if (d.unverified.length > 0) {
    lines.push(`3. 下面 ${d.unverified.length} 句，系统没能对上老师审核过的题目解释，请逐句确认无误，或者从报告里删掉：`)
    d.unverified.forEach((u, i) => lines.push(`   ${i + 1}) ${u.sentence}（${u.kind === 'conflict' ? '和题目解释矛盾，必须删掉或改' : '没找到依据'}）`))
  } else {
    lines.push('3. 系统没有标出需要特别确认的句子，但上面两点还是请看一遍。')
  }
  lines.push('核对完：在软件里打开「AI 报告」，选这份报告，点「我已核对」。')
  return lines.join('\n')
}

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const REASON: Record<string, string> = { data: '统计数据（试卷、题目、知识点）有变化', prompt: 'AI 的写作要求有更新', model: '换了 AI 模型' }
type ExportInfo = { fmt: 'md' | 'pdf' | 'docx'; path: string; dir?: string | null; images?: number; missingImages?: number; bytes?: number }
const FMT_NAME = { md: 'Markdown', pdf: 'PDF', docx: 'Word' } as const
/** 每种读者一种拇指索引色（颜色旁边永远有字）：老板 = 写作陶土、家长 = 词汇绿、老师 = 交际青、完整数据 = 语法蓝 */
const READER_CAT: Record<ReportReader, string> = { boss: 'writing', parent: 'vocab', teacher: 'communication', full: 'grammar' }
const ReaderChip = ({ reader, label, testid }: { reader: ReportReader; label: string; testid?: string }) => <span className={`ewb-rep-reader ewb-cat-${READER_CAT[reader]}`} data-testid={testid}><i aria-hidden />{label}</span>

/** 等待 AI：状态条（结构同 design/ThinkingBar，文案按「思考 / 写 / 自动重试」三种情况由 waitingText 给出） */
function Waiting({ text, seconds, onCancel }: { text: string; seconds: number; onCancel: () => void }) {
  const pct = Math.min(95, (seconds / 180) * 100)
  return (
    <div className="ewb-thinking" role="status" aria-live="off">
      <div className="ewb-thinking__row">
        <StatusLabel kind="working">处理中</StatusLabel>
        <span className="ewb-thinking__text" data-testid="report-running">{text}</span>
        <span className="ewb-thinking__actions"><Btn tone="danger" size="small" icon={X} data-testid="report-cancel" onClick={onCancel}>取消生成</Btn></span>
      </div>
      <div className="ewb-thinking__rail" aria-hidden><div className="ewb-thinking__fill" style={{ transform: `scaleX(${pct / 100})` }} /></div>
    </div>
  )
}

/**
 * AI 报告（P3）：先选读者（老板版 / 家长版 / 老师版 / 完整数据版）再生成；历史列表 + 流式输出 + 导出 Word / PDF / Markdown。
 * 家长版必须老师点「我已核对」后才能导出或「复制到微信」。数据或提示词变了只标「已过期」，绝不自动重新生成（要花钱）。
 * AI 生成的内容统一带「AI 草稿 · 请老师核对」（老师核对后换成「已由老师核对」）。
 */
export default function Report() {
  const { message, modal } = App.useApp()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { filter, ready } = useStatsFilter()
  const entry = useReportEntry()
  const [role] = useRoleGuideRole()
  const lastDone = useLastDone()
  const [reader, setReader] = useState<ReportReader>('full')
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [exporting, setExporting] = useState<'md' | 'pdf' | 'docx' | 'wechat' | null>(null)
  const [exported, setExported] = useState<ExportInfo | null>(null)
  const elapsed = useElapsedSeconds(entry?.startedAt, entry?.status === 'running')

  const { data: list = [], isLoading } = useQuery({ queryKey: ['reports', 'list'], queryFn: () => window.api.report.list(), placeholderData: keepPreviousData })
  const { data: preview } = useQuery({ queryKey: ['reports', 'preview', filter, reader], queryFn: () => window.api.report.preview(filter, reader), enabled: ready, placeholderData: keepPreviousData })
  const current = selected && list.some(r => r.id === selected) ? selected : (list[0]?.id ?? null)
  const { data: detail } = useQuery({ queryKey: ['reports', 'detail', current], queryFn: () => window.api.report.get(current!), enabled: !!current })
  // 书眉：当前这份报告的第一个和最后一个小节
  const heads = detail?.markdown ? Array.from(detail.markdown.matchAll(/^##\s+(.+)$/gm)).map(m => m[1].trim()) : []
  useScopeGuide(heads[0], heads.length > 1 ? heads[heads.length - 1] : undefined)

  // 新报告生成完成：自动选中它
  useEffect(() => { if (lastDone) setSelected(lastDone.id) }, [lastDone?.id, lastDone?.at])
  useEffect(() => { setExported(null) }, [current])

  const running = entry?.status === 'running'
  const blockedExport = !!detail?.needsConfirm || !!detail?.blockReason
  const blockTip = detail?.blockReason ?? '家长版要先由老师点「我已核对」，才能导出'
  const doExport = async (fmt: 'md' | 'pdf' | 'docx') => {
    if (!detail) return
    setExporting(fmt)
    try {
      const r = await window.api.report.export(detail.id, fmt)
      if (r.saved && r.path) {
        setExported({ fmt, path: r.path, dir: r.dir, images: r.images, missingImages: r.missingImages, bytes: r.bytes })
        message.success(`已导出 ${FMT_NAME[fmt]}`)
      }
    } catch (e) { message.error(clean(e)) }
    finally { setExporting(null) }
  }
  const copyWechat = async () => {
    if (!detail) return
    setExporting('wechat')
    try {
      const r = await window.api.report.copyWechat(detail.id)
      message.success(`已复制 ${r.chars} 字，可以直接粘贴到微信`)
    } catch (e) { message.error(clean(e)) }
    finally { setExporting(null) }
  }
  // 核对确认框：列出每一句「未核实 / 矛盾」的话，每句可以勾「已确认无误」或从报告里删掉；有矛盾句必须先删掉才能确认
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [okSentences, setOkSentences] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<string | null>(null)
  useEffect(() => { setOkSentences(new Set()); setConfirmOpen(false) }, [current])
  const confirm = () => { if (detail) setConfirmOpen(true) }
  const conflictCount = detail?.unverified.filter(u => u.kind === 'conflict').length ?? 0
  // 家长版：每一句「未核实」的话，要么勾上「已确认无误」，要么从报告里删掉，之后才能点「我已核对」（老师版、老板版维持原规则：只有矛盾句必须先删）
  const pendingCount = detail?.reader === 'parent' ? detail.unverified.filter(u => u.kind === 'unverified' && !okSentences.has(u.sentence)).length : 0
  const removeSentence = async (sentence: string) => {
    if (!detail) return
    setRemoving(sentence)
    try {
      const updated = await window.api.report.removeSentence(detail.id, sentence)
      qc.setQueryData(['reports', 'detail', detail.id], updated)
      qc.invalidateQueries({ queryKey: ['reports', 'list'] })
      message.success('已从报告里删掉这一句')
    } catch (e) { message.error(clean(e)) }
    finally { setRemoving(null) }
  }
  const handOver = async () => {
    if (!detail) return
    try { await writeClipboard(checklistText(detail)); message.success('已复制核对清单，发给懂英语的老师就行') } catch (e) { message.error(clean(e)) }
  }
  const doConfirm = async () => {
    if (!detail) return
    try {
      // 家长版：把勾了「已确认无误」的句子原文一起交给后端留痕（只带仍在报告里的句子）；其他版本不需要
      const acknowledged = detail.reader === 'parent' ? detail.unverified.filter(u => u.kind === 'unverified' && okSentences.has(u.sentence)).map(u => u.sentence) : undefined
      await window.api.report.confirm(detail.id, acknowledged)
      message.success('已标记为老师核对过')
      setConfirmOpen(false)
      qc.invalidateQueries({ queryKey: ['reports'] })
    } catch (e) { message.error(clean(e)) }
  }
  const remove = async (id: string) => {
    try { await window.api.report.delete(id); if (selected === id) setSelected(null); qc.invalidateQueries({ queryKey: ['reports'] }) } catch (e) { message.error(clean(e)) }
  }

  const refs = (entry?.refs?.length ? entry.refs : detail?.refs) ?? []
  const retryActions = (e: NonNullable<typeof entry>) => (
    <>
      {preview && !preview.blocked && <Btn tone="secondary" size="small" data-testid="report-retry" onClick={() => startReport(filter, preview.filterDesc, e.reader)}>{e.status === 'error' ? '重试' : '重新生成'}</Btn>}
      <Btn tone="quiet" size="small" data-testid="report-dismiss" onClick={dismissReportEntry}>关闭提示</Btn>
    </>
  )
  return (
    <Page data-testid="report-page">
      <h1 className="ewb-rep-h1">AI 报告</h1>
      <section className="ewb-rep-new" data-testid="report-new">
        <h2 className="ewb-rep-h2">生成一份新报告</h2>
        <p className="ewb-rep-ask" id="rep-readers-label">这份报告给谁看？</p>
        <div className="ewb-rep-readers" role="radiogroup" aria-labelledby="rep-readers-label" data-testid="report-reader">
          {READERS.map(r => (
            <label key={r} className={`ewb-rep-readeropt ewb-cat-${READER_CAT[r]}`} data-active={reader === r} data-disabled={running}>
              <input type="radio" name="report-reader" value={r} checked={reader === r} disabled={running} onChange={() => setReader(r)} data-testid={`reader-${r}`} />
              <span className="ewb-rep-readeropt__name"><i aria-hidden />{READER_LABEL[r]}</span>
              <span className="ewb-rep-readeropt__hint" data-testid={reader === r ? 'reader-hint' : undefined}>{READER_HINT[r]}</span>
            </label>
          ))}
        </div>
        <div className="ewb-rep-genrow">
          <span>按当前筛选生成：<b data-testid="report-scope">{filterLabel(filter)}{filter.sample ? ' · 示例数据' : ''}</b>
            {preview && <span className="ewb-rep-counts" data-testid="report-counts">共 {preview.papers} 份卷子、{preview.questions} 道题</span>}</span>
          {!running && !preview?.blocked && <Btn tone="primary" icon={Sparkles} data-testid="report-generate" disabled={!preview || !ready} onClick={() => startReport(filter, preview!.filterDesc, reader)}>生成{READER_LABEL[reader]}</Btn>}
        </div>
        <Collapse ghost size="small" className="ewb-rep-how" data-testid="report-how" items={[{ key: 'how', forceRender: true, label: <span className="ewb-rep-collapse-label">怎么算的？要花钱吗？（点开看）</span>, children: <div className="ewb-rep-stack"><NotCounted /><p className="ewb-rep-note">所有数字、知识点、例题都由程序先算好再交给 AI，AI 只负责把它写成人话，不自己数数；难易程度和“容易错”是 AI 估计，不是学生成绩。每生成一次会调用一次 AI（要花一点钱），生成的报告都会留在下面的历史里。</p></div> }]} />
        {running ? (
              <Waiting text={waitingText({ seconds: elapsed, hasText: (entry?.text.length ?? 0) > 0, thinking: !!entry?.thinking, retried: !!entry?.retried })} seconds={elapsed} onCancel={cancelReport} />
            ) : preview?.blocked ? (
              preview.aiReady
                ? <UsageNote kind="tip" data-testid="report-blocked">{preview.blocked}</UsageNote>
                : <UsageNote kind="caution" data-testid="report-guide" title="还没有配置 AI 服务">
                  统计和看板不依赖 AI，照常可用。要生成报告，请管理员先到 <a className="ewb-rep-link" role="button" tabIndex={0} data-testid="report-guide-link" onClick={() => nav('/settings?admin=1')} onKeyDown={e => { if (e.key === 'Enter') nav('/settings?admin=1') }}>设置 → 管理员设置 → AI 服务</a> 连接好 AI。
                </UsageNote>
            ) : null}
      </section>

      {entry && entry.status !== 'running' && (
        <div style={{ marginBottom: 'var(--ewb-sp-4)' }}>
          {entry.status === 'error'
            ? <UsageNote kind="mistake" label="失败" data-testid="report-error" title={entry.message} actions={retryActions(entry)}>
              {entry.detail
                ? <Collapse ghost size="small" style={{ marginInlineStart: -12 }} items={[{ key: 'd', label: <span className="ewb-rep-collapse-label">查看详情（给管理员看）</span>, children: <div data-testid="report-error-detail" className="ewb-rep-detail-text">{entry.detail}</div> }]} />
                : <span className="ewb-rep-muted">没有保存任何结果，可以直接重试。</span>}
            </UsageNote>
            : <UsageNote kind="caution" data-testid="report-cancelled" actions={retryActions(entry)}>已取消生成，没有保存结果</UsageNote>}
          {entry.text && (
            <div className="ewb-rep-partial-box ewb-rep-partial">
              <Panel title="AI 写到一半的内容（未完成草稿，只能看，不算有效结果）"><div data-testid="report-partial"><MarkdownView markdown={entry.text} refs={refs} onView={setView} /></div></Panel>
            </div>
          )}
        </div>
      )}

      {!entry && preview?.draft && (
        <Collapse ghost size="small" style={{ marginBottom: 'var(--ewb-sp-3)' }} data-testid="report-draft-box" items={[{
          key: 'draft',
          label: <span className="ewb-rep-collapse-label">上次生成{READER_LABEL[reader]}时 AI 没写完，留下了一份未完成草稿（{preview.draft.createdAt}）：点开查看。它不算有效结果，也不能导出。</span>,
          children: <div>
            <div className="ewb-rep-err-ink" style={{ fontSize: 'var(--ewb-fs-sm)', marginBottom: 4 }} data-testid="report-draft-message">{preview.draft.message}</div>
            <div data-testid="report-draft-text" className="ewb-rep-partial"><MarkdownView markdown={preview.draft.markdown} refs={preview.draft.refs} onView={setView} /></div>
          </div>
        }]} />
      )}

      {running && entry && (
        <div style={{ marginBottom: 'var(--ewb-sp-4)' }}>
          <Panel title={`正在生成：${READER_LABEL[entry.reader]}`} data-testid="report-live">
            <div data-testid="report-text" data-len={entry.text.length} className="ewb-rep-body">{entry.text ? <MarkdownView markdown={entry.text} refs={refs} onView={setView} /> : <span className="ewb-rep-live-hint">AI 在认真写，请稍等，不需要操作。写好以后会自动显示在这里。</span>}</div>
          </Panel>
        </div>
      )}

      {!isLoading && list.length === 0 ? (
        <p className="ewb-rep-empty" data-testid="report-list-empty">还没有生成过报告。选好读者、点上面的生成按钮，写好的报告会留在这里，随时可以回来看、导出。</p>
      ) : (
      <div className="ewb-rep-cols">
        <div className="ewb-rep-panel-flush" data-testid="report-list">
          <Panel title={`历史报告（${list.length}）`}>
            {isLoading ? <div className="ewb-rep-spinwrap"><SkeletonBar height={16} /><SkeletonBar width="70%" height={16} /></div> : list.length === 0 ? <div style={{ padding: 'var(--ewb-sp-4)' }}><EmptyState inline title="还没有生成过报告" description="选好读者，点上面的生成按钮，写好的报告会留在这里。" /></div> : (
              <ul className="ewb-rep-list">
                {list.map(r => (
                  <li key={r.id} className="ewb-rep-item" data-testid={`report-item-${r.id}`} data-status={r.status} data-reader={r.reader} data-current={r.id === current}
                    role="button" tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={e => { if (e.key === 'Enter') setSelected(r.id) }}>
                    <div className="ewb-rep-item__title">{r.title}</div>
                    <div className="ewb-rep-item__daterow">
                      <span className="ewb-rep-item__date">{r.createdAt}</span>
                      <Popconfirm title="删除这份报告？" okText="删除" cancelText="取消" onConfirm={() => remove(r.id)}>
                        <Btn tone="quiet" size="small" icon={Trash2} data-testid={`report-delete-${r.id}`} onClick={e => e.stopPropagation()}>删除</Btn>
                      </Popconfirm>
                    </div>
                    <div className="ewb-rep-item__tags">
                      <ReaderChip reader={r.reader as ReportReader} label={r.readerLabel} testid="reader-tag" />
                      {r.status === 'stale' ? <StatusLabel kind="queued">已过期</StatusLabel> : <StatusLabel kind="done">最新</StatusLabel>}
                      {r.needsConfirm && <StatusLabel kind="pending">待老师核对</StatusLabel>}
                      {r.filter.sample && <StatusLabel kind="done">示例数据</StatusLabel>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div data-testid="report-detail" style={{ minWidth: 0 }}>
          {!current ? <EmptyState inline title="选择左边的报告，或生成一份新的" /> : !detail ? <div className="ewb-rep-spinwrap"><SkeletonBar height={20} /><SkeletonBar width="80%" height={16} /><SkeletonBar width="60%" height={16} /></div> : (
            <Panel title={<span data-testid="report-title">{detail.readerLabel} · {detail.createdAt}</span>}>
              <div className="ewb-rep-actions">
                {!detail.confirmedAt && role === 'ops' && <Btn tone="secondary" icon={ClipboardList} data-testid="report-hand-over" onClick={handOver}>交给老师核对</Btn>}
                {!detail.confirmedAt && <Btn tone="secondary" icon={ShieldCheck} data-testid="report-confirm" disabled={!!detail.blockReason && conflictCount === 0} onClick={confirm}>我已核对</Btn>}
                <Tooltip title={blockedExport ? (detail?.blockReason ?? '家长版要先由老师点「我已核对」，才能复制') : '复制成纯文本（带换行和序号），可以直接粘贴到微信'}>
                  <Btn tone="secondary" icon={Copy} data-testid="report-copy-wechat" disabled={blockedExport} loading={exporting === 'wechat'} onClick={copyWechat}>复制到微信</Btn>
                </Tooltip>
                <Tooltip title={blockedExport ? blockTip : ''}>
                  <Btn tone="secondary" icon={FileType2} data-testid="report-export-docx" disabled={blockedExport} loading={exporting === 'docx'} onClick={() => doExport('docx')}>导出 Word</Btn>
                </Tooltip>
                <Tooltip title={blockedExport ? blockTip : ''}>
                  <Btn tone="secondary" icon={FileText} data-testid="report-export-pdf" disabled={blockedExport} loading={exporting === 'pdf'} onClick={() => doExport('pdf')}>导出 PDF</Btn>
                </Tooltip>
                <Tooltip title={blockedExport ? blockTip : ''}>
                  <Btn tone="secondary" icon={FileText} data-testid="report-export-md" disabled={blockedExport} loading={exporting === 'md'} onClick={() => doExport('md')}>导出 Markdown</Btn>
                </Tooltip>
              </div>
              {exported && (
                <UsageNote kind="tip" label="已导出" data-testid="report-export-result"
                  title={`已导出 ${FMT_NAME[exported.fmt]}${exported.images ? `（含 ${exported.images} 张题目截图${exported.fmt === 'md' ? '，在同名文件夹里' : ''}）` : ''}`}
                  actions={<>
                    <Btn tone="secondary" size="small" data-testid="report-reveal" onClick={() => window.api.report.reveal(exported.path).catch(() => undefined)}>在文件夹里显示</Btn>
                    <Btn tone="quiet" size="small" onClick={() => setExported(null)}>关闭</Btn>
                  </>}>
                  <code className="ewb-rep-code" data-testid="report-export-path">{exported.path}</code>
                </UsageNote>
              )}
              <div className="ewb-rep-meta">
                <AiDraftBadge confirmedAt={detail.confirmedAt} />
                <ReaderChip reader={detail.reader as ReportReader} label={detail.readerLabel} testid="detail-reader-tag" />
                {detail.reader === 'parent' && (
                  <span data-testid="report-chars" data-chars={detail.chars} title="按「复制到微信」的口径数（含换行和序号），微信里一屏读完最合适">
                    <StatusLabel kind={detail.chars > 300 ? 'pending' : 'done'}>复制到微信 {detail.chars} 字{detail.chars > 300 ? '（超过 300，建议删减）' : '（建议不超过 300）'}</StatusLabel>
                  </span>
                )}
                {detail.status !== 'stale' && <span data-testid="report-fresh"><StatusLabel kind="done">最新 · {detail.createdAt} · {detail.model ?? ''}{detail.staleReasons.includes('model') ? '（当前设置的模型已换）' : ''}</StatusLabel></span>}
              </div>
              <NoticeStack data-testid="report-notices">
              {detail.status === 'stale' && (
                <UsageNote kind="caution" data-testid="report-stale"><b>已过期</b>（{detail.staleReasons.map(r => REASON[r]).join('；')}）。下面是 {detail.createdAt} 生成的旧结果，想要新数据请回到上面重新生成一份——不会自动重新生成。</UsageNote>
              )}
              {detail.blockReason && <UsageNote kind="mistake" label="不能导出" data-testid="report-block-reason">{detail.blockReason}。{conflictCount > 0 ? '点上面的「我已核对」，在核对框里把矛盾的句子删掉后才能确认；' : ''}现在不能「我已核对」、复制到微信和导出。</UsageNote>}
              {detail.needsConfirm && <UsageNote kind="caution" data-testid="report-needs-confirm">家长版要先由老师核对：读一遍、改掉不对的地方，然后点上面的「我已核对」，才能导出或复制到微信。</UsageNote>}
              {detail.sampleWarning && <UsageNote kind="caution" data-testid="report-sample-warning"><b>样本提示（程序判定）：</b>{detail.sampleWarning}结论仅供参考。</UsageNote>}
              {detail.unverified.length > 0 && (
                <UsageNote kind="caution" data-testid="report-unverified" title={`有 ${detail.unverified.length} 句讲英语规则的话没能对上老师审核过的题目解释（正文里已标“未核实”或“与题目解释矛盾”）`}>
                  <Collapse ghost size="small" style={{ marginInlineStart: -12 }} items={[{ key: 'u', label: <span className="ewb-rep-collapse-label">看是哪几句</span>, children: <ul className="ewb-rep-list-ul">{detail.unverified.map((u, i) => <li key={i}>{u.sentence}<span className="ewb-rep-muted">：{u.reason}{u.acknowledged ? '（老师已确认无误）' : ''}</span></li>)}</ul> }]} />
                </UsageNote>
              )}
              {detail.warnings.map((w, i) => <UsageNote key={i} kind="caution" data-testid="report-warning">{w}</UsageNote>)}
              </NoticeStack>
              <div data-testid="report-body" className="ewb-rep-body"><MarkdownView markdown={detail.markdown} refs={detail.refs} onView={setView} /></div>
            </Panel>
          )}
        </div>
      </div>
      )}
      <Modal open={confirmOpen} title="确认你已经核对过这份报告？" okText="我已核对" cancelText="再看看" onCancel={() => setConfirmOpen(false)} onOk={doConfirm}
        okButtonProps={{ 'data-testid': 'confirm-ok', disabled: conflictCount > 0 || pendingCount > 0 || !!removing } as any} width={640}>
        {detail && (
          <div data-testid="confirm-dialog">
            <div>核对后，标识会从“AI 草稿”变成“已由老师核对”{detail.reader === 'parent' ? '，才能导出或复制到微信' : ''}。请至少看一遍：讲英语规则的句子对不对、例句有没有错。</div>
            <div className="ewb-rep-verify__who" data-testid="confirm-who">这一步要由<b>懂英语的老师</b>来做：核对的是英语规则和例句对不对，运营不确定的话，请不要自己点「我已核对」。</div>
            {role === 'ops' && <div style={{ marginTop: 8 }}><Btn tone="secondary" size="small" icon={ClipboardList} data-testid="confirm-hand-over" onClick={handOver}>改为「交给老师核对」：复制核对清单</Btn></div>}
            {detail.unverified.length > 0 && (
              <div className="ewb-rep-verify" data-testid="confirm-unverified">
                <p className="ewb-rep-verify__head">有 {detail.unverified.length} 句话没能对上老师审核过的题目解释，请逐句看一下：</p>
                <ul className="ewb-rep-verify__list">
                  {detail.unverified.map(u => (
                    <li key={u.sentence} data-kind={u.kind} data-testid="verify-item">
                      <span className="ewb-rep-verify__sentence">{u.sentence}</span>
                      <span className="ewb-rep-verify__reason"><StatusLabel kind={u.kind === 'conflict' ? 'failed' : 'pending'}>{u.kind === 'conflict' ? '与题目解释矛盾' : '未核实'}</StatusLabel> {u.reason}</span>
                      <span className="ewb-rep-verify__acts">
                        {u.kind === 'unverified' && <Checkbox data-testid="verify-ok" checked={okSentences.has(u.sentence)} onChange={e => setOkSentences(prev => { const n = new Set(prev); if (e.target.checked) n.add(u.sentence); else n.delete(u.sentence); return n })}>已确认无误</Checkbox>}
                        <Btn tone="danger" size="small" icon={Trash2} data-testid="verify-remove" loading={removing === u.sentence} onClick={() => removeSentence(u.sentence)}>从报告里删掉这一句</Btn>
                      </span>
                    </li>
                  ))}
                </ul>
                {detail.reader === 'parent' && conflictCount === 0 && pendingCount > 0 && <UsageNote kind="caution" data-testid="confirm-pending-note">家长版每一句“未核实”的话，都要勾上「已确认无误」或者从报告里删掉，才能点「我已核对」（还差 {pendingCount} 句）。</UsageNote>}
                {conflictCount > 0 && <UsageNote kind="mistake" data-testid="confirm-conflict-note">还有 {conflictCount} 句和题目解释矛盾：要先把它们从报告里删掉，才能点「我已核对」。</UsageNote>}
              </div>
            )}
          </div>
        )}
      </Modal>
      <PageViewer target={view} onClose={() => setView(null)} />
    </Page>
  )
}
