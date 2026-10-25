import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Empty, Input, Modal, Segmented, Space, Spin, Tag, Tooltip } from 'antd'
import { ArrowLeftOutlined, CheckCircleFilled, CheckOutlined, LeftOutlined, RightOutlined, WarningFilled, EditOutlined } from '@ant-design/icons'
import QuestionForm from './QuestionForm'
import { BoxEditor } from '../../components/BoxEditor'
import { statusMap } from '../../status'

type Box = [number, number, number, number]
type Filter = 'all' | 'todo' | 'attention'

const colBorder = '1px solid #f0f0f0'
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 低置信度阈值由主进程给出（questions.list 返回 lowConfidence），界面不再自己写一份 */
function needsAttention(q: QuestionView, lowConfidence: number): boolean {
  return q.confidence < lowConfidence || (!!q.kp_suggestion && q.kp_suggestion_status === 'pending')
}

/** 把还没写库的修改叠到服务端数据上显示：界面立刻反映，而且重新拉取（data:changed）不会把它们冲回旧值 */
function applyPatch(q: QuestionView, p: QuestionPatch): QuestionView {
  const { no_label, bbox, ...rest } = p
  return {
    ...q, ...(rest as Partial<QuestionView>),
    ...(no_label !== undefined ? { no: no_label } : {}),
    ...(bbox !== undefined ? { bbox, bbox_source: bbox ? 'manual' : 'none' } : {})
  }
}

export default function ReviewPage() {
  const { id: paperId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const queryClient = useQueryClient()

  const { data: paper } = useQuery({ queryKey: ['papers', paperId], queryFn: () => window.api.papers.get(paperId!), enabled: !!paperId })
  const { data: pages = [] } = useQuery({ queryKey: ['pages', paperId], queryFn: () => window.api.papers.pages(paperId!), enabled: !!paperId })
  const { data: list, isLoading } = useQuery({ queryKey: ['questions', paperId], queryFn: () => window.api.questions.list(paperId!), enabled: !!paperId, staleTime: 5_000 })
  const { data: tax } = useQuery({ queryKey: ['taxonomy'], queryFn: () => window.api.taxonomy.tree(), staleTime: 60_000 })

  const [overlay, setOverlay] = useState<Record<string, QuestionPatch>>({})
  const lowConfidence = list?.lowConfidence ?? 0.7
  const questions = useMemo(() => (list?.questions ?? []).map(q => (overlay[q.id] ? applyPatch(q, overlay[q.id]) : q)), [list, overlay])
  const [filter, setFilter] = useState<Filter>('all')
  const [selId, setSelId] = useState<string | null>(null)
  const [pageIdx, setPageIdx] = useState(1)
  const [liveBox, setLiveBox] = useState<Box | null>(null)
  const [showOthers, setShowOthers] = useState(true)
  const [splitOpen, setSplitOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  // 合并等操作会让同一道题的内容在库里整体变化；表单按 id+版本号重新挂载，草稿才会跟着更新
  const [formVersion, setFormVersion] = useState(0)
  const [structBusy, setStructBusy] = useState(false)
  const structLock = useRef(false)   // 用 ref 加锁：两次点击可能发生在同一次渲染之内，state 还没来得及变

  const visible = useMemo(() => questions.filter(q =>
    filter === 'all' ? true : filter === 'todo' ? !q.reviewed : needsAttention(q, lowConfidence) && !q.reviewed), [questions, filter, lowConfidence])
  const cur = questions.find(q => q.id === selId) ?? null
  const curIndex = cur ? visible.findIndex(q => q.id === cur.id) : -1

  // 默认选第一道待确认的题
  useEffect(() => {
    if (!questions.length) return
    if (!selId || !questions.some(q => q.id === selId)) setSelId((questions.find(q => !q.reviewed) ?? questions[0]).id)
  }, [questions, selId])

  // 选中题目时翻到它所在的页
  useEffect(() => { if (cur?.page_idx) setPageIdx(cur.page_idx); setLiveBox(null) }, [cur?.id, cur?.page_idx])

  // ───── 保存：同一道题的连续修改合并成一次写库 ─────
  const pending = useRef<{ id: string; patch: QuestionPatch; timer: ReturnType<typeof setTimeout> | null } | null>(null)

  const writeCache = useCallback((view: QuestionView) => {
    queryClient.setQueryData<QuestionList>(['questions', paperId], old => old && { ...old, questions: old.questions.map(x => (x.id === view.id ? view : x)) })
  }, [queryClient, paperId])

  /** 把待保存的修改写库；成功返回 true。失败时提示并丢弃本地叠加，以库里的数据为准 */
  const flush = useCallback(async (): Promise<boolean> => {
    const p = pending.current
    if (!p) return true
    pending.current = null
    if (p.timer) clearTimeout(p.timer)
    try {
      const view = await window.api.questions.update(p.id, p.patch)
      // 写库期间若又来了同一题的新修改，不用旧结果覆盖界面（否则拖完框会闪回旧位置），等下一次写库再同步
      if ((pending.current as { id: string } | null)?.id !== p.id) {
        if (view) writeCache(view)
        setOverlay(o => { const { [p.id]: _drop, ...rest } = o; return rest })
      }
      return true
    } catch (e) {
      message.error(`保存失败：${clean(e)}`)
      // 只丢掉这次发出去、失败了的那一批；失败期间又排队的新修改（pending）保留，免得界面先回退又跳回来
      setOverlay(o => {
        const { [p.id]: _drop, ...rest } = o
        const queued = pending.current as { id: string; patch: QuestionPatch } | null
        return queued && queued.id === p.id ? { ...rest, [p.id]: queued.patch } : rest
      })
      queryClient.invalidateQueries({ queryKey: ['questions', paperId] })
      return false
    }
  }, [writeCache, message, queryClient, paperId])

  const patch = useCallback((id: string, p: QuestionPatch) => {
    if (pending.current && pending.current.id !== id) void flush()
    const cur = pending.current ?? { id, patch: {} as QuestionPatch, timer: null }
    if (cur.timer) clearTimeout(cur.timer)
    cur.patch = { ...cur.patch, ...p }
    cur.timer = setTimeout(() => { void flush() }, 300)
    pending.current = cur
    setOverlay(o => ({ ...o, [id]: { ...(o[id] ?? {}), ...p } }))
  }, [flush])

  // 离开页面/关窗口前把还没写的修改发出去（防抖窗口内退出的最后一次修改不丢）
  useEffect(() => {
    const onHide = () => { void flush() }
    window.addEventListener('beforeunload', onHide)
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('beforeunload', onHide); window.removeEventListener('pagehide', onHide); void flush() }
  }, [flush])

  const go = useCallback(async (delta: number) => {
    await flush()
    const i = visible.findIndex(q => q.id === selId)
    const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
    if (next) setSelId(next.id)
  }, [visible, selId, flush])

  const confirmCurrent = useCallback(async () => {
    if (!cur) return
    patch(cur.id, { reviewed: true })
    // 写库失败就不往下走：别在界面上显示「已确认」而库里没有
    if (!(await flush())) return
    const i = visible.findIndex(q => q.id === cur.id)
    const next = visible[i + 1] ?? (filter === 'all' ? undefined : visible[i - 1])
    if (next && next.id !== cur.id) setSelId(next.id)
    else if (i === visible.length - 1) message.success('已经是最后一题了')
  }, [cur, patch, flush, visible, filter, message])

  // 快捷键：J/K 切题，Enter 确认；在输入框里只认 Cmd/Ctrl+Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      const t = e.target as HTMLElement
      // 焦点在按钮上时 Enter 属于按钮自己（点击），不能再触发「确认当前题」
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.isContentEditable || !!t.closest('.ant-select'))
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void confirmCurrent(); return }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); void go(1) }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); void go(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); void confirmCurrent() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, confirmCurrent])

  // 左侧列表把选中项滚进视野
  useEffect(() => { document.querySelector(`[data-qid="${selId}"]`)?.scrollIntoView({ block: 'nearest' }) }, [selId])

  const page = pages.find(p => p.idx === pageIdx)
  const hasImage = !!page?.image_rel
  const box: Box | null = cur && cur.page_idx === pageIdx ? ((liveBox ?? (cur.bbox as Box | null)) ?? null) : null

  // 框画出来后滚进视野
  const boxKey = cur ? `${cur.id}:${cur.page_idx}:${cur.bbox?.join(',')}` : ''
  const boxSeen = useRef('')
  useEffect(() => {
    if (!cur || !hasImage || boxSeen.current === `${cur.id}:${cur.page_idx}`) return
    const t = setTimeout(() => {
      document.querySelector('[data-testid="bbox-current"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      boxSeen.current = `${cur.id}:${cur.page_idx}`
    }, 120)
    return () => clearTimeout(t)
  }, [boxKey, hasImage, cur])

  const reviewedCount = questions.filter(q => q.reviewed).length
  const material = cur?.material_id ? list?.materials.find(m => m.mid === cur.material_id) : undefined

  const finish = async () => {
    await flush()
    const pendingN = questions.length - reviewedCount
    const doIt = async (all: boolean) => {
      try {
        await window.api.questions.confirmPaper(paperId!, all)
        message.success('整份试卷已确认完成')
        queryClient.invalidateQueries({ queryKey: ['papers'] })
        queryClient.invalidateQueries({ queryKey: ['questions'] })
      } catch (e) { message.error(clean(e)) }
    }
    if (pendingN === 0) return doIt(false)
    modal.confirm({
      title: `还有 ${pendingN} 道题没有逐题确认`,
      content: '仍然完成的话，这些题会按当前内容一并标为已确认。', okText: '全部标为已确认并完成', cancelText: '继续审核',
      okButtonProps: { 'data-testid': 'finish-ok' } as any, onOk: () => doIt(true)
    })
  }

  if (isLoading || !paper) return <div style={{ padding: 40, textAlign: 'center' }}><Spin size="large" /></div>
  if (!['reviewing', 'done'].includes(paper.status) && questions.length === 0) {
    return (
      <div style={{ padding: 40 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/review')}>返回</Button>
        <Empty style={{ marginTop: 60 }} description={`这份试卷还没有解析结果（当前状态：${statusMap[paper.status]?.label ?? paper.status}）。请先到「处理队列」运行 AI 解析。`} />
      </div>
    )
  }

  const done = paper.status === 'done'
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: colBorder, background: '#fafafa' }}>
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate('/review')}>返回</Button>
        <b style={{ color: '#1e2952' }} data-testid="review-title">{paper.title || paper.file_name}</b>
        <Tag color={statusMap[paper.status]?.color}>{statusMap[paper.status]?.label}</Tag>
        {list?.run && (
          <Tooltip title={`模型 ${list.run.model ?? '-'}${list.run.vision_model ? ` / 视觉 ${list.run.vision_model}` : ''}`}>
            <Tag data-testid="prompt-version">提示词 {list.run.prompt_version ?? '-'}</Tag>
          </Tooltip>
        )}
        <span style={{ color: '#666', fontSize: 13 }} data-testid="review-progress">已确认 {reviewedCount} / {questions.length}</span>
        <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>J / K 切换题目 · Enter 确认</span>
        <div style={{ marginLeft: 'auto' }}>
          {done
            ? <Button size="small" icon={<EditOutlined />} onClick={async () => { await window.api.questions.reopen(paperId!); queryClient.invalidateQueries({ queryKey: ['papers'] }) }}>重新打开审核</Button>
            : <Button type="primary" size="small" icon={<CheckOutlined />} data-testid="finish-paper" onClick={finish}>确认整份试卷</Button>}
        </div>
      </div>
      {(list?.notes?.length ?? 0) > 0 && (
        <div style={{ padding: '4px 16px', background: '#fffbe6', borderBottom: '1px solid #ffe58f', fontSize: 12 }} data-testid="ai-notes">
          AI 备注：{list!.notes.join('；')}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 左：题目列表 */}
        <div style={{ width: 270, borderRight: colBorder, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: 8, borderBottom: colBorder }}>
            <Segmented size="small" block value={filter} onChange={v => setFilter(v as Filter)} options={[
              { label: `全部 ${questions.length}`, value: 'all' },
              { label: `待确认 ${questions.length - reviewedCount}`, value: 'todo' },
              { label: `需关注 ${questions.filter(q => needsAttention(q, lowConfidence) && !q.reviewed).length}`, value: 'attention' }
            ]} />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }} data-testid="question-list">
            {visible.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的题目" style={{ marginTop: 40 }} />}
            {visible.map((q, i) => {
              const warn = needsAttention(q, lowConfidence)
              const active = q.id === selId
              const prevSec = visible[i - 1]?.section
              return (
                <React.Fragment key={q.id}>
                  {(i === 0 || prevSec !== q.section) && q.section_title && (
                    <div style={{ padding: '4px 10px', fontSize: 12, color: '#666', background: '#f5f5f5', position: 'sticky', top: 0, zIndex: 1 }}>{q.section}、{q.section_title}</div>
                  )}
                  <div
                    data-qid={q.id} data-testid="q-item" data-warn={warn ? '1' : '0'} data-reviewed={q.reviewed ? '1' : '0'}
                    onClick={async () => { await flush(); setSelId(q.id) }}
                    style={{
                      padding: '6px 10px', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'flex-start',
                      borderLeft: `3px solid ${active ? '#1e2952' : 'transparent'}`,
                      background: warn && !q.reviewed ? (active ? '#fff1b8' : '#fffbe6') : active ? '#f0f2ff' : undefined,
                      borderBottom: '1px solid #f5f5f5'
                    }}
                  >
                    <span style={{ width: 34, fontWeight: 600, flexShrink: 0 }}>{q.no}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {q.stem || q.options.join(' ') || '（无题干）'}
                    </span>
                    {q.reviewed ? <CheckCircleFilled style={{ color: '#52c41a', marginTop: 3 }} /> : warn ? <WarningFilled style={{ color: '#faad14', marginTop: 3 }} /> : q.edited ? <EditOutlined style={{ color: '#999', marginTop: 3 }} /> : null}
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>

        {/* 中：原卷页面 + 题目框 */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: colBorder, background: '#f7f7f7' }}>
          <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8, background: '#fff', borderBottom: colBorder }}>
            <Button size="small" icon={<LeftOutlined />} disabled={pageIdx <= 1} onClick={() => setPageIdx(pageIdx - 1)} />
            <span data-testid="page-indicator" style={{ fontSize: 13 }}>第 {pageIdx} / {pages.length} 页</span>
            <Button size="small" icon={<RightOutlined />} disabled={pageIdx >= pages.length} onClick={() => setPageIdx(pageIdx + 1)} />
            <Space style={{ marginLeft: 'auto' }} size={8}>
              <Segmented size="small" value={zoom} onChange={v => setZoom(v as number)} options={[{ label: '适应宽度', value: 1 }, { label: '150%', value: 1.5 }, { label: '200%', value: 2 }]} />
              <span style={{ fontSize: 12, color: '#666' }}>显示其他题的框</span>
              <input type="checkbox" checked={showOthers} onChange={e => setShowOthers(e.target.checked)} />
              {cur && cur.page_idx !== pageIdx && <Button size="small" onClick={() => setPageIdx(cur.page_idx ?? 1)}>回到本题所在页</Button>}
            </Space>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }} data-testid="page-scroll">
            {!page && <Empty description="没有页面数据" />}
            {page && hasImage && (
              <div data-box-canvas data-testid="page-canvas" style={{ position: 'relative', lineHeight: 0, width: `${zoom * 100}%`, maxWidth: zoom === 1 ? 900 : undefined, margin: '0 auto', boxShadow: '0 1px 6px rgba(0,0,0,.15)' }}>
                <img data-testid="page-image" src={`ewb://page/${paperId}/${page.image_rel}`} alt={`第${page.idx}页`} draggable={false} style={{ width: '100%', display: 'block', userSelect: 'none' }} />
                {showOthers && questions.filter(x => x.id !== cur?.id && x.page_idx === pageIdx && x.bbox).map(x => (
                  <div key={x.id} onClick={() => setSelId(x.id)} title={`第 ${x.no} 题`} style={{
                    position: 'absolute', left: `${x.bbox![0] * 100}%`, top: `${x.bbox![1] * 100}%`, width: `${x.bbox![2] * 100}%`, height: `${x.bbox![3] * 100}%`,
                    border: '1px dashed rgba(30,41,82,.35)', cursor: 'pointer', boxSizing: 'border-box'
                  }} />
                ))}
                {cur && box && (
                  <BoxEditor
                    bbox={box}
                    onChange={setLiveBox}
                    onCommit={b => { setLiveBox(null); patch(cur.id, { bbox: b, page_idx: pageIdx }) }}
                  />
                )}
              </div>
            )}
            {page && !hasImage && (
              <div data-testid="docx-text" style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 16, fontSize: 14, lineHeight: 1.8, border: colBorder }}>{page.text}</div>
            )}
            {cur && hasImage && !box && cur.page_idx === pageIdx && (
              <div style={{ marginTop: 8, textAlign: 'center' }}>
                <Tag color="warning">这道题没有定位框</Tag>
                <Button size="small" data-testid="draw-box" onClick={() => patch(cur.id, { bbox: [0.1, 0.1, 0.8, 0.08], page_idx: pageIdx })}>在此页画一个框</Button>
              </div>
            )}
            {cur && hasImage && cur.page_idx !== pageIdx && (
              <div style={{ marginTop: 8, textAlign: 'center' }}>
                <Button size="small" onClick={() => patch(cur.id, { bbox: cur.bbox ?? [0.1, 0.1, 0.8, 0.08], page_idx: pageIdx })}>把本题的框移到当前页</Button>
              </div>
            )}
          </div>
        </div>

        {/* 右：标注表单 */}
        <div style={{ width: 380, flexShrink: 0, minHeight: 0 }}>
          {cur ? (
            <QuestionForm
              key={`${cur.id}:${formVersion}`}
              lowConfidence={lowConfidence}
              busy={structBusy}
              localEdits={!!overlay[cur.id]}
              q={cur} index={curIndex < 0 ? questions.findIndex(q => q.id === cur.id) : curIndex} total={curIndex < 0 ? questions.length : visible.length}
              kps={tax?.kps} qtypes={tax?.qtypes} material={material ? { mid: material.mid, kind: material.kind, text: material.text } : undefined}
              hasNext={questions.findIndex(q => q.id === cur.id) < questions.length - 1}
              onPatch={p => patch(cur.id, p)}
              onConfirm={confirmCurrent}
              onSplit={() => setSplitOpen(true)}
              onMerge={async () => {
                if (structLock.current) return
                structLock.current = true
                setStructBusy(true)
                try {
                  if (!(await flush())) return
                  await window.api.questions.merge(cur.id)
                  message.success('已与下一题合并')
                  await queryClient.invalidateQueries({ queryKey: ['questions', paperId] })
                  setFormVersion(v => v + 1)   // 合并后题干/选项/分值都变了，表单按新内容重新挂载
                } catch (e) { message.error(clean(e)) } finally { structLock.current = false; setStructBusy(false) }
              }}
              onRemove={async () => {
                if (!(await flush())) return
                const i = visible.findIndex(q => q.id === cur.id)
                try {
                  await window.api.questions.remove(cur.id)
                  setSelId((visible[i + 1] ?? visible[i - 1])?.id ?? null)
                  queryClient.invalidateQueries({ queryKey: ['questions', paperId] })
                } catch (e) { message.error(`删除失败：${clean(e)}`) }
              }}
              onApprove={async body => {
                await flush()
                try {
                  const code = await window.api.taxonomy.approveSuggestion(cur.id, body)
                  message.success(`已新建知识点 ${code}`)
                  queryClient.invalidateQueries({ queryKey: ['taxonomy'] })
                  queryClient.invalidateQueries({ queryKey: ['questions', paperId] })
                } catch (e) { message.error(clean(e)); throw e }
              }}
              onReject={async () => { await window.api.taxonomy.rejectSuggestion(cur.id); queryClient.invalidateQueries({ queryKey: ['questions', paperId] }) }}
            />
          ) : <Empty style={{ marginTop: 80 }} description="请选择一道题" />}
        </div>
      </div>

      {cur && <SplitModal key={cur.id + String(splitOpen)} open={splitOpen} q={cur} onClose={() => setSplitOpen(false)}
        onSubmit={async body => {
          await flush()
          try {
            const newId = await window.api.questions.split(cur.id, body)
            message.success('已拆分')
            setSplitOpen(false)
            await queryClient.invalidateQueries({ queryKey: ['questions', paperId] })
            setSelId(newId)
          } catch (e) { message.error(clean(e)) }
        }} />}
    </div>
  )
}

function SplitModal({ open, q, onClose, onSubmit }: {
  open: boolean; q: QuestionView; onClose: () => void
  onSubmit: (b: { first: { stem: string; options: string[] }; second: { no_label: string; stem: string; options: string[] } }) => Promise<void>
}) {
  const [firstStem, setFirstStem] = useState(q.stem)
  const [firstOpts, setFirstOpts] = useState(q.options.join('\n'))
  const [secondNo, setSecondNo] = useState(/^\d+$/.test(q.no) ? String(Number(q.no) + 1) : `${q.no}b`)
  const [secondStem, setSecondStem] = useState('')
  const [secondOpts, setSecondOpts] = useState('')
  const [busy, setBusy] = useState(false)
  const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean)
  return (
    <Modal open={open} title={`拆分第 ${q.no} 题`} width={720} onCancel={onClose} okText="拆分" cancelText="取消" confirmLoading={busy}
      okButtonProps={{ 'data-testid': 'split-ok', disabled: !secondNo.trim() } as any}
      onOk={async () => { setBusy(true); try { await onSubmit({ first: { stem: firstStem, options: lines(firstOpts) }, second: { no_label: secondNo.trim(), stem: secondStem, options: lines(secondOpts) } }) } finally { setBusy(false) } }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>把原题的内容分到两道题里：左边保留在本题，右边成为新题（紧跟在本题之后，知识点、题型沿用，需要时再改）。选项一行一个。</div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <b>本题（第 {q.no} 题）</b>
          <Input.TextArea data-testid="split-first-stem" rows={4} value={firstStem} onChange={e => setFirstStem(e.target.value)} placeholder="题干" style={{ margin: '6px 0' }} />
          <Input.TextArea rows={4} value={firstOpts} onChange={e => setFirstOpts(e.target.value)} placeholder="选项（一行一个）" />
        </div>
        <div style={{ flex: 1 }}>
          <Space><b>新题 题号</b><Input data-testid="split-second-no" size="small" style={{ width: 80 }} value={secondNo} onChange={e => setSecondNo(e.target.value)} /></Space>
          <Input.TextArea data-testid="split-second-stem" rows={4} value={secondStem} onChange={e => setSecondStem(e.target.value)} placeholder="题干" style={{ margin: '6px 0' }} />
          <Input.TextArea rows={4} value={secondOpts} onChange={e => setSecondOpts(e.target.value)} placeholder="选项（一行一个）" />
        </div>
      </div>
    </Modal>
  )
}
