import React, { useState, useEffect, useMemo, useRef } from 'react'
import { inSubject } from '../subject/papers'
import { Modal, Form, Select, InputNumber, Input, App, Dropdown, Checkbox } from 'antd'
import { BarChart3, ClipboardCheck, Eye, FolderOpen, Inbox, MoreHorizontal, Pencil, Plus, RotateCw, Search, Trash2, X, Zap } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { paperKind, paperTag } from '../status'
import { Btn, EmptyState, Icon, IndexTable, Page, StatusLabel } from '../design'
import '../design/page-library.css'
import { useImportFlow } from '../hooks/useImportFlow'
import { useDiscardGuard } from '../hooks/useDiscardGuard'
import RetryActions from '../components/RetryActions'
import Onboarding from '../components/Onboarding'
import RoleGuide from '../components/RoleGuide'
import BetaWelcome from '../components/BetaWelcome'
import BatchEditModal from '../components/BatchEditModal'
import { useStatsFilter } from '../stats/StatsFilter'
import { MAX_SCOPE_PAPERS, chunk, filterPapers, isBusyStatus, plainError, scopeFromSelection, summarizeBatch, titleList } from '../../shared/library-select'
import type { BatchResult } from '../../shared/library-select'
import SimilarNotice from '../components/SimilarNotice'
import { ImportTarget, MathVisionHint } from '../components/ImportTarget'
import { useSubject } from '../subject/SubjectContext'

const gradeOptions = ['1', '2', '3', '4', '5', '6'].map(v => ({ label: `${v}年级`, value: v }))
const semesterOptions = [{ label: '上学期', value: '上' }, { label: '下学期', value: '下' }]
const examTypeOptions = ['单元测试', '期中', '期末', '月考', '其他'].map(v => ({ label: v, value: v }))

/** 哪些字段是 AI 预填的（用户改过就不再算） */
export function aiFieldsOf(p: Paper): string[] {
  try { return p.ai_meta_json ? JSON.parse(p.ai_meta_json) : [] } catch { return [] }
}
export const AiGuessTag = () => <span className="ewb-lib-guess" data-testid="ai-guess" title="这一项是 AI 从卷头读出来的，不一定对。你核对过、点「确认整份试卷」或改过它，这个提示就会消失">AI 猜的，请确认</span>

const FIELD_LABEL: Record<string, string> = { title: '标题', grade: '年级', semester: '学期', school_year_start: '学年', exam_type: '类型', textbook: '教材', total_score: '总分' }
/** 试卷库每行只标一次：这份卷子有 AI 从卷头读出来的信息，悬停看是哪几项 */
export const AiGuessRow = ({ fields }: { fields: string[] }) => (
  <span className="ewb-lib-guess ewb-lib-guess--row" data-testid="ai-guess" title={`AI 从卷头读出来的：${fields.map(f => FIELD_LABEL[f] ?? f).join('、')}，不一定对。你核对过、点「确认整份试卷」或改过它，这个提示就会消失`}>AI 猜的，请确认</span>
)

export default function PaperLibrary() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const { importPaths, pathsFromDrop } = useImportFlow()
  const discardGuard = useDiscardGuard()
  const [importing, setImporting] = useState(false)
  const [editPaper, setEditPaper] = useState<Paper | null>(null)
  const [editForm] = Form.useForm()
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})
  const [dragOver, setDragOver] = useState(false)
  const { selectPapers, filter: statsFilter } = useStatsFilter()
  const { subject, def } = useSubject()
  // 搜索：draft 是输入框里的字，query 是真正用来过滤的（输入法拼音还没确认时不过滤）
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const composing = useRef(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [batchEditOpen, setBatchEditOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  useEffect(() => {
    if (!window.api?.on) return
    return window.api.on('job:progress', (p: JobProgress) => {
      setProgress(prev => ({ ...prev, [p.paperId]: p }))
    })
  }, [])

  const { data: rawPapers = [], isLoading } = useQuery({
    queryKey: ['papers', 'list', subject],
    queryFn: () => window.api.papers.list({ subject })
  })
  const papers = useMemo(() => inSubject(rawPapers, subject), [rawPapers, subject])

  // 输入稍停一下再过滤；用输入法打字（拼音还没选字）时一律不过滤
  useEffect(() => {
    if (composing.current || draft === query) return
    const t = setTimeout(() => { if (!composing.current) setQuery(draft) }, 150)
    return () => clearTimeout(t)
  }, [draft, query])

  // 过滤在本地做：试卷列表本来就是整份取回来的（几百份也只是几百行），不必再走一趟主进程
  const visible = useMemo(() => filterPapers(papers, query), [papers, query])
  // 选中的只保留还看得到的：搜索词变了、或试卷被删了，看不见的就不再算选中，批量操作不会碰看不见的卷子
  useEffect(() => {
    const ok = new Set(visible.map(p => p.id))
    setSelectedIds(prev => (prev.every(id => ok.has(id)) ? prev : prev.filter(id => ok.has(id))))
  }, [visible])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selected = useMemo(() => visible.filter(p => selectedSet.has(p.id)), [visible, selectedSet])
  const allSelected = visible.length > 0 && selected.length === visible.length

  const doImport = async (paths: string[]) => {
    setImporting(true)
    try { await importPaths(paths) } finally { setImporting(false) }
  }

  const handleImportFiles = async () => {
    const paths = await window.api.dialog.openFiles()
    if (paths.length) await doImport(paths)
  }

  const handleImportFolder = async () => {
    const paths = await window.api.dialog.openFolder()
    if (paths.length) await doImport(paths)
  }

  const handleNativeDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.nativeEvent as any).__ewbHandled = true
    setDragOver(false)
    const paths = pathsFromDrop(e.dataTransfer)
    if (paths.length) await doImport(paths)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }

  const handleEdit = (paper: Paper) => {
    setEditPaper(paper)
    editForm.setFieldsValue({
      title: paper.title,
      grade: paper.grade,
      semester: paper.semester,
      school_year_start: paper.school_year_start,
      exam_type: paper.exam_type,
      textbook: paper.textbook,
      region: paper.region,
      school: paper.school,
      total_score: paper.total_score
    })
  }

  const handleEditSave = async () => {
    const values = await editForm.validateFields()
    if (!editPaper) return
    // 清空的字段是 undefined，经 IPC 序列化会丢失；显式转成 null 才能真正清除
    const meta: Record<string, unknown> = { ...values }
    for (const k of ['grade', 'semester', 'school_year_start', 'exam_type', 'textbook', 'region', 'school', 'total_score']) {
      if (meta[k] === undefined || meta[k] === '') meta[k] = null
    }
    try {
      await window.api.papers.update(editPaper.id, meta)
      message.success('已保存')
      setEditPaper(null)
      queryClient.invalidateQueries({ queryKey: ['papers'] })
    } catch (err) {
      message.error(`保存失败：${(err as Error).message.replace(/^Error invoking remote method '[^']+': /, '')}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.api.papers.remove(id)
      message.success('已删除')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
    queryClient.invalidateQueries({ queryKey: ['papers'] })
  }

  const handleParse = async (id: string) => {
    try {
      await window.api.parse.start(id)
      message.success('已加入 AI 解析队列')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  const confirmReprocess = async (p: Paper) => {
    if (await discardGuard(p, 'extract')) await handleReprocess(p.id)
  }

  const handleReprocess = async (id: string) => {
    try {
      await window.api.papers.reprocess(id)
      message.success('已重新加入处理队列')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  // 词条式行：一份卷子一行，标题加粗，下面一行年级 · 学期 · 学年 · 类型 · 页数；只有一个主操作胶囊，其余收进「更多」
  const confirmDelete = (p: Paper) => modal.confirm({
    title: '确定删除？', content: `「${p.title || p.file_name}」和它的页面图、题目都会删掉，不能恢复。`, okText: '删除', cancelText: '取消', okButtonProps: { danger: true, 'data-testid': 'delete-confirm' } as any,
    onOk: () => handleDelete(p.id)
  })
  const cleanErr = (err: unknown) => plainError(err)
  /** 大批量分段发给主进程（每段 500 份），结果合在一起；主进程单次的上限因此不会被用户碰到 */
  const callChunked = async (ids: string[], fn: (part: string[]) => Promise<BatchResult[]>): Promise<BatchResult[]> => {
    const out: BatchResult[] = []
    for (const part of chunk(ids, 500)) out.push(...await fn(part))
    return out
  }
  const reasonText = (r: ReturnType<typeof summarizeBatch>) => r.reasons.map(x => `${x.count} 份${x.reason}`).join('；')

  const batchDelete = () => {
    const busy = selected.filter(p => isBusyStatus(p.status))
    const rest = selected.filter(p => !isBusyStatus(p.status))
    if (rest.length === 0) {
      modal.info({ title: '现在不能删', content: <span data-testid="batch-delete-blocked">选中的 {busy.length} 份试卷都在提取或解析中，等它们处理完再删。</span>, okText: '知道了' })
      return
    }
    const { shown, more } = titleList(rest.map(p => p.title || p.file_name))
    modal.confirm({
      title: `确定删除这 ${rest.length} 份试卷？`,
      content: (
        <div data-testid="batch-delete-confirm">
          <ul className="ewb-lib-titlelist">{shown.map((t, i) => <li key={i}>{t}</li>)}{more > 0 && <li>……等共 {rest.length} 份</li>}</ul>
          <p>它们的页面图、题目都会删掉，不能恢复。已经生成的报告不会被删。</p>
          {busy.length > 0 && <p style={{ color: 'var(--ewb-red-ink)' }} data-testid="batch-delete-skip">另有 {busy.length} 份正在提取或解析，这次不会删。</p>}
        </div>
      ),
      okText: `删除 ${rest.length} 份`, cancelText: '取消', okButtonProps: { danger: true, 'data-testid': 'batch-delete-ok' } as any,
      onOk: async () => {
        let keep: string[] = busy.map(p => p.id)
        try {
          const results = await callChunked(rest.map(p => p.id), part => window.api.papers.batchRemove(part))
          const sum = summarizeBatch(results)
          keep = [...results.filter(r => !r.ok).map(r => r.id), ...busy.map(p => p.id)]
          const skipped = sum.skipped + busy.length
          if (sum.ok > 0) message.success(`已删除 ${sum.ok} 份${skipped ? `；${skipped} 份没删（${[busy.length ? `${busy.length} 份正在处理` : '', reasonText(sum)].filter(Boolean).join('；')}）` : ''}`)
          else message.warning(`没有删除任何试卷：${reasonText(sum) || '正在处理中'}`)
        } catch (err) { message.error(cleanErr(err)) }
        setSelectedIds(keep)   // 没删掉的（正在处理的、出错的）继续选着，方便看清是哪几份
        queryClient.invalidateQueries({ queryKey: ['papers'] })
      }
    })
  }

  const batchEdit = async (meta: Record<string, unknown>) => {
    setBatchBusy(true)
    try {
      const sum = summarizeBatch(await callChunked(selected.map(p => p.id), part => window.api.papers.batchUpdate(part, meta)))
      if (sum.skipped) message.warning(`已修改 ${sum.ok} 份；${reasonText(sum)}`); else message.success(`已修改 ${sum.ok} 份试卷的信息`)
      setBatchEditOpen(false)
    } catch (err) { message.error(`保存失败：${cleanErr(err)}`) } finally { setBatchBusy(false) }
    queryClient.invalidateQueries({ queryKey: ['papers'] })
  }

  const batchReparse = async () => {
    let qs: QueueState, sums: Awaited<ReturnType<typeof window.api.questions.summary>>
    try { qs = await window.api.queue.state(); sums = await window.api.questions.summary() } catch (err) { message.error(cleanErr(err)); return }
    if (!qs.aiReady) { message.error('尚未配置 AI 服务：请先到「设置 → AI 服务」填写 Base URL、模型和 API Key'); return }
    const busy = selected.filter(p => ['imported', 'extracting', 'parsing'].includes(p.status))
    const rest = selected.filter(p => !busy.includes(p))
    if (rest.length === 0) { message.warning('选中的试卷都在处理中，等处理完再重新解析'); return }
    // 和单份重新解析同一套提醒：已有题目的，说清楚审核的修改和确认会被新结果替换
    const byId = new Map(sums.map(x => [x.paper_id, x]))
    const withQs = rest.filter(p => (byId.get(p.id)?.total ?? 0) > 0)
    const reviewedQs = withQs.reduce((n, p) => n + (byId.get(p.id)?.reviewed ?? 0), 0)
    const confirmed = rest.filter(p => p.status === 'done').length
    modal.confirm({
      title: `让 AI 重新解析这 ${rest.length} 份试卷？`,
      content: (
        <div data-testid="batch-reparse-confirm">
          {withQs.length > 0 ? (
            <p>其中 <b>{withQs.length}</b> 份现在有题目（共 <b>{withQs.reduce((n, p) => n + (byId.get(p.id)?.total ?? 0), 0)}</b> 道，<b>{reviewedQs}</b> 道已审核确认{confirmed > 0 ? `；${confirmed} 份已整份确认` : ''}）。
              重新解析会用新结果替换它们：你在审核页做的修改（题干、知识点、框的位置、确认状态）都会作废，要重新审核。</p>
          ) : <p>这些试卷现在都还没有题目。</p>}
          <p>一次最多同时解析 {qs.concurrency} 份，其余排队；会用到 AI 额度。</p>
          {busy.length > 0 && <p style={{ color: 'var(--ewb-red-ink)' }}>另有 {busy.length} 份正在处理中，这次不会动。</p>}
        </div>
      ),
      okText: withQs.length > 0 ? '仍然重新解析' : '开始解析', cancelText: '取消', okButtonProps: { danger: withQs.length > 0, 'data-testid': 'batch-reparse-ok' } as any,
      onOk: async () => {
        try {
          const sum = summarizeBatch(await callChunked(rest.map(p => p.id), part => window.api.parse.batchStart(part)))
          message.success(`已把 ${sum.ok} 份加入 AI 解析队列${sum.skipped ? `；${sum.skipped} 份没加（${reasonText(sum)}）` : ''}`)
        } catch (err) { message.error(cleanErr(err)) }
        queryClient.invalidateQueries({ queryKey: ['queue'] })
        queryClient.invalidateQueries({ queryKey: ['papers'] })
      }
    })
  }

  const scopeToSelection = () => {
    const sc = scopeFromSelection(selected)
    if (sc.paperIds.length > MAX_SCOPE_PAPERS) { message.warning(`一次最多统计 ${MAX_SCOPE_PAPERS} 份，请先用搜索缩小范围`); return }
    // 会计入统计的：已确认的（打开「含待审核」时待审核的也算），疑似重复的不算
    const countable = (p: Paper) => (p.status === 'done' || (!!statsFilter.includeReviewing && p.status === 'reviewing')) && p.similar_state !== 'suspect'
    const counted = selected.filter(countable).length
    selectPapers(sc.paperIds, sc.sample)
    if (sc.dropped > 0) message.info(`选中的里有 ${sc.dropped} 份示例卷，示例数据不和真实数据一起统计，已经去掉。`)
    else if (counted === 0) message.warning('选中的试卷里还没有已确认的，统计会是空的；先去审核页确认，或在统计页打开「含待审核」')
    navigate('/overview')
  }

  const columns = [
    {
      title: '试卷',
      dataIndex: 'title',
      key: 'title',
      render: (text: string, record: Paper) => {
        const ai = aiFieldsOf(record)
        return (
          <div className="ewb-lib-papercell">
            <div className="ewb-lib-papertitle">
              <a onClick={() => navigate(`/paper/${record.id}`)}>{text || record.file_name}</a>
              <SimilarNotice paper={record} compact />
              {ai.length > 0 && <AiGuessRow fields={ai} />}
              {record.is_sample === 1 && <span className="ewb-lib-tag" style={{ marginInlineStart: 8 }} data-testid="sample-tag">示例</span>}
            </div>
            <div className="ewb-lib-meta">
              <span>{record.grade ? `${record.grade}年级` : '年级 -'}</span>
              <span>{record.semester ?? '学期 -'}</span>
              <span>{record.school_year_start ? `${record.school_year_start}-${record.school_year_start + 1}` : '学年 -'}</span>
              <span>{record.exam_type ?? '类型 -'}</span>
              <span>{record.page_count} 页</span>
            </div>
          </div>
        )
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 128,
      render: (_: string, record: Paper) => {
        const t = paperTag(record, progress[record.id])
        return (
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <StatusLabel kind={paperKind(record)} title={t.title}>{t.label}</StatusLabel>
            {(record.rec_low ?? 0) > 0 && (record.status === 'reviewing' || record.status === 'done' || record.status === 'extracted') && (
              <StatusLabel kind="pending" title="有几页本机识别效果不好，又没有交给 AI 读图。打开这份卷子可以看到每一页是怎么识别的">识别可能不完整</StatusLabel>
            )}
          </span>
        )
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_: unknown, record: Paper) => {
        const canRework = record.status === 'extracted' || record.status === 'done' || record.status === 'reviewing'
        const reviewable = record.status === 'reviewing' || record.status === 'done'
        const items = [
          { key: 'view', label: <span data-testid="view-paper">查看原卷</span> },
          { key: 'edit', label: <span data-testid="edit-paper" title="修改年级、学年、教材等信息">改信息</span> },
          ...(canRework ? [{ key: 'reprocess', label: <span data-testid="reprocess" title="重新读取文件（会清除已整理好的题目）">重新读取</span> }] : []),
          { key: 'delete', danger: true, label: <span data-testid="delete-paper">删除</span> }
        ]
        const onMenu = ({ key }: { key: string }) => {
          if (key === 'view') navigate(`/paper/${record.id}`)
          else if (key === 'edit') handleEdit(record)
          else if (key === 'reprocess') void confirmReprocess(record)
          else if (key === 'delete') confirmDelete(record)
        }
        return (
          <div className="ewb-lib-ops">
            {record.status === 'failed' && <RetryActions paper={record} menuLabel="其他方式" />}
            {record.status === 'extracted' && (
              <Btn tone="secondary" size="small" icon={Zap} title="让 AI 读出题目并标上知识点" data-testid="parse-paper" onClick={() => handleParse(record.id)}>AI 解析</Btn>
            )}
            {reviewable && (
              <Btn tone="secondary" size="small" icon={ClipboardCheck} title="核对 AI 标的题" data-testid="open-review" onClick={() => navigate(`/review/${record.id}`)}>去审核</Btn>
            )}
            {!reviewable && record.status !== 'extracted' && record.status !== 'failed' && (
              <Btn tone="secondary" size="small" icon={Eye} data-testid="open-paper" onClick={() => navigate(`/paper/${record.id}`)}>查看</Btn>
            )}
            <Dropdown trigger={['click']} menu={{ items, onClick: onMenu }}>
              <Btn tone="quiet" size="small" icon={MoreHorizontal} data-testid="more-menu" aria-label={`更多操作：${record.title || record.file_name}`}>更多</Btn>
            </Dropdown>
          </div>
        )
      }
    }
  ]

  return (
    <Page>
      <div className="ewb-lib-head">
        <h1 className="ewb-lib-title">试卷库</h1>
        <ImportTarget />
        <div className="ewb-lib-actions">
          <Btn tone="secondary" icon={FolderOpen} data-testid="import-folder" onClick={handleImportFolder} loading={importing}>导入文件夹</Btn>
          <Btn tone="primary" icon={Plus} onClick={handleImportFiles} loading={importing}>导入试卷</Btn>
        </div>
      </div>

      <MathVisionHint />
      <BetaWelcome />
      <RoleGuide />
      <Onboarding />

      <div
        data-testid="dropzone"
        data-over={dragOver ? 'true' : 'false'}
        className="ewb-lib-drop"
        role="button"
        tabIndex={0}
        onDrop={handleNativeDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleImportFiles}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleImportFiles() } }}
      >
        <div className="ewb-lib-drop__icon"><Icon as={Inbox} size={32} /></div>
        <p className="ewb-lib-drop__main">拖拽{def.name}试卷文件到此处，或点击选择</p>
        <p className="ewb-lib-drop__sub">支持 PDF、JPG/PNG/HEIC、DOCX（不支持 .doc，请先另存为 .docx）；也可以直接拖入整个文件夹</p>
      </div>

      {papers.length > 0 && (
        <div className="ewb-lib-tools">
          <Input
            className="ewb-lib-search"
            data-testid="lib-search"
            prefix={<Icon as={Search} size={16} />}
            allowClear={{ clearIcon: <span data-testid="lib-search-clear" aria-label="清除搜索"><Icon as={X} size={14} /></span> }}
            placeholder="搜索试卷标题或学校"
            aria-label="搜索试卷标题或学校"
            value={draft}
            onChange={e => { setDraft(e.target.value); if (!e.target.value) setQuery('') }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={e => { composing.current = false; setDraft(e.currentTarget.value); setQuery(e.currentTarget.value) }}
            onPressEnter={() => { if (!composing.current) setQuery(draft) }}
          />
          <span className="ewb-lib-count" data-testid="lib-count">{query.trim() ? `找到 ${visible.length} 份，共 ${papers.length} 份` : `共 ${papers.length} 份`}</span>
        </div>
      )}

      {selected.length > 0 && (
        <div className="ewb-lib-selbar" data-testid="select-bar" role="region" aria-label="批量操作">
          <span className="ewb-lib-selbar__count">已选 <b data-testid="select-count">{selected.length}</b> 份</span>
          {!allSelected && <Btn tone="quiet" size="small" data-testid="select-all-matching" onClick={() => setSelectedIds(visible.map(p => p.id))}>选中全部 {visible.length} 份</Btn>}
          <Btn tone="quiet" size="small" icon={X} data-testid="select-clear" onClick={() => setSelectedIds([])}>清除选择</Btn>
          <div className="ewb-lib-selbar__ops">
            <Btn tone="secondary" size="small" icon={Pencil} data-testid="batch-edit-open" onClick={() => setBatchEditOpen(true)}>批量改信息</Btn>
            <Btn tone="secondary" size="small" icon={RotateCw} data-testid="batch-reparse" title="让 AI 重新读这几份卷子" onClick={() => void batchReparse()}>重新解析</Btn>
            <Btn tone="secondary" size="small" icon={BarChart3} data-testid="scope-selected" title="统计、看板、报告只按选中的卷子算" onClick={scopeToSelection}>只看这几份的统计</Btn>
            <Btn tone="danger" size="small" icon={Trash2} data-testid="batch-delete" onClick={batchDelete}>删除</Btn>
          </div>
        </div>
      )}

      <IndexTable
        dataSource={visible}
        columns={columns}
        rowKey="id"
        loading={isLoading || importing}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: keys => setSelectedIds(keys as string[]),
          columnWidth: 44,
          preserveSelectedRowKeys: true,
          columnTitle: (
            <Checkbox data-testid="select-all" aria-label={`选中当前列表的全部 ${visible.length} 份`} disabled={visible.length === 0}
              checked={allSelected} indeterminate={selected.length > 0 && !allSelected}
              onChange={e => setSelectedIds(e.target.checked ? visible.map(p => p.id) : [])} />
          ),
          getCheckboxProps: (p: Paper) => ({ 'aria-label': `选中：${p.title || p.file_name}`, 'data-testid': `select-row-${p.id}` } as any)
        }}
        locale={query.trim() ? {
          emptyText: (
            <div data-testid="lib-search-empty">
              <EmptyState inline title="没有找到这样的试卷" description={`标题和学校里都没有「${query.trim()}」。换个词试试，或者清除搜索看全部试卷。`}
                action={<Btn tone="secondary" size="small" onClick={() => { setDraft(''); setQuery('') }}>清除搜索</Btn>} />
            </div>
          )
        } : undefined}
      />

      <BatchEditModal
        open={batchEditOpen}
        papers={selected.map(p => ({ id: p.id, ai: aiFieldsOf(p) }))}
        saving={batchBusy}
        onCancel={() => setBatchEditOpen(false)}
        onOk={meta => void batchEdit(meta)}
      />

      <Modal
        title="编辑试卷信息"
        open={!!editPaper}
        onOk={handleEditSave}
        onCancel={() => setEditPaper(null)}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" size="middle">
          <Form.Item name="title" label={<span>标题{editPaper && aiFieldsOf(editPaper).includes('title') && <AiGuessTag />}</span>}>
            <Input />
          </Form.Item>
          <div className="ewb-lib-formrow">
            <Form.Item name="grade" label={<span>年级{editPaper && aiFieldsOf(editPaper).includes('grade') && <AiGuessTag />}</span>}>
              <Select options={gradeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="semester" label={<span>学期{editPaper && aiFieldsOf(editPaper).includes('semester') && <AiGuessTag />}</span>}>
              <Select options={semesterOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="school_year_start" label={<span>学年起始{editPaper && aiFieldsOf(editPaper).includes('school_year_start') && <AiGuessTag />}</span>}>
              <InputNumber min={2000} max={2100} placeholder="如 2025" />
            </Form.Item>
            <Form.Item name="exam_type" label={<span>考试类型{editPaper && aiFieldsOf(editPaper).includes('exam_type') && <AiGuessTag />}</span>}>
              <Select options={examTypeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
          </div>
          <Form.Item name="textbook" label={<span>教材版本{editPaper && aiFieldsOf(editPaper).includes('textbook') && <AiGuessTag />}</span>}>
            <Input placeholder={subject === 'english' ? '如 PEP 三年级起点' : `如 ${def.textbooks[0]}`} />
          </Form.Item>
          <div className="ewb-lib-formrow">
            <Form.Item name="region" label="地区">
              <Input />
            </Form.Item>
            <Form.Item name="school" label="学校">
              <Input />
            </Form.Item>
            <Form.Item name="total_score" label={<span>总分{editPaper && aiFieldsOf(editPaper).includes('total_score') && <AiGuessTag />}</span>}>
              <InputNumber min={0} max={200} precision={0} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </Page>
  )
}
