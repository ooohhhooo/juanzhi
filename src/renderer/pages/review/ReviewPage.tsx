import SimilarNotice from '../../components/SimilarNotice'
import { safeText } from '../../../shared/code-guard'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Input, Modal, Segmented, Spin, Tooltip } from 'antd'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Pencil, TriangleAlert, ListChecks } from 'lucide-react'
import QuestionForm from './QuestionForm'
import { Pill } from './parts'
import { BoxEditor } from '../../components/BoxEditor'
import { statusMap } from '../../status'
import { Btn, EmptyState, Icon, StatusLabel, UsageNote } from '../../design'
import '../../design/page-review.css'

type Box = [number, number, number, number]
type Filter = 'all' | 'todo' | 'attention'

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
  // 改主知识点导致次知识点被去重删掉：页面上明确提示并给「撤销这一步」（12 秒后自动收起）
  const [dropped, setDropped] = useState<{ names: string; id: string; undo: QuestionPatch } | null>(null)
  useEffect(() => {
    if (!dropped) return
    const t = setTimeout(() => setDropped(null), 12_000)
    return () => clearTimeout(t)
  }, [dropped])
  // 编辑已完成的卷子会让它悄悄变回「待审核」、暂时不计入统计：变了就明确告诉老师，并写清怎么恢复
  const [reopenedNotice, setReopenedNotice] = useState(false)
  const lastStatus = useRef<string | null>(null)
  useEffect(() => {
    if (!paper) return
    if (lastStatus.current === 'done' && paper.status === 'reviewing') setReopenedNotice(true)
    if (paper.status === 'done') setReopenedNotice(false)
    lastStatus.current = paper.status
  }, [paper?.status])
  const lowConfidence = list?.lowConfidence ?? 0.7
  const questions = useMemo(() => (list?.questions ?? []).map(q => (overlay[q.id] ? applyPatch(q, overlay[q.id]) : q)), [list, overlay])
  const [filter, setFilter] = useState<Filter>('all')
  const [selId, setSelId] = useState<string | null>(null)
  const [pageIdx, setPageIdx] = useState(1)
  const [liveBox, setLiveBox] = useState<Box | null>(null)
  const [showOthers, setShowOthers] = useState(true)
  const [splitOpen, setSplitOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [listOpen, setListOpen] = useState(false)   // 窄窗口（≤ 1100px）时，题目列表收进左侧抽屉
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
    const before = queryClient.getQueryData<QuestionList>(['questions', paperId])?.questions.find(x => x.id === p.id)
    try {
      const view = await window.api.questions.update(p.id, p.patch)
      // 这次修改带来的、不能悄悄发生的变化：卷子变回待审核 / 次知识点因为和新主知识点重复被去掉
      if (view?.notices?.reopened) setReopenedNotice(true)
      if (view?.notices?.droppedSecondary?.length && before) {
        const names = view.notices.droppedSecondaryNames.join('、')
        const undo = { kp_main: before.kp_main, kp_secondary: before.kp_secondary }
        setDropped({ names, id: p.id, undo })
      }
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
    const suspect = paper?.similar_state === 'suspect'
    if (pendingN === 0 && !suspect) return doIt(false)
    const suspectLine = suspect ? '另外：这份卷子被标成「疑似重复」，确认完成后默认也不计入统计；如果它确实是新卷，请先到试卷库或处理队列点「确实是新卷，计入统计」。' : ''
    modal.confirm({
      title: pendingN > 0 ? `还有 ${pendingN} 道题没有逐题确认` : '确认整份试卷？',
      content: <div>{pendingN > 0 && <div>仍然完成的话，这些题会按当前内容一并标为已确认。</div>}{suspectLine && <div data-testid="finish-similar-note" style={{ marginTop: pendingN > 0 ? 8 : 0 }}>{suspectLine}</div>}</div>,
      okText: pendingN > 0 ? '全部标为已确认并完成' : '仍然确认完成', cancelText: pendingN > 0 ? '继续审核' : '再看看',
      okButtonProps: { 'data-testid': 'finish-ok' } as any, onOk: () => doIt(true)
    })
  }

  if (isLoading || !paper) return <div style={{ padding: 40, textAlign: 'center' }}><Spin size="large" /></div>
  if (!['reviewing', 'done'].includes(paper.status) && questions.length === 0) {
    return (
      <div style={{ padding: 'var(--ewb-sp-5)' }}>
        <Btn tone="secondary" icon={ArrowLeft} onClick={() => navigate('/review')}>返回</Btn>
        <EmptyState title="这份试卷还没有解析结果" description={`当前状态：${statusMap[paper.status]?.label ?? paper.status}。请先到「处理队列」运行 AI 解析。`} />
      </div>
    )
  }

  const done = paper.status === 'done'
  return (
    <div className="ewb-rev">
      <div className="ewb-rev__bar">
        <Btn tone="secondary" size="small" icon={ArrowLeft} onClick={() => navigate('/review')}>返回</Btn>
        <div className="ewb-rev__heading">
          <h2 className="ewb-rev__title" data-testid="review-title">{paper.title || paper.file_name}</h2>
          <div className="ewb-rev__sub">
            <StatusLabel kind={done ? 'done' : 'pending'}>{statusMap[paper.status]?.label}</StatusLabel>
            {list?.run && (
              <Tooltip title={`模型 ${list.run.model ?? '-'}${list.run.vision_model ? ` / 视觉 ${list.run.vision_model}` : ''}`}>
                <Pill tabIndex={0} data-testid="prompt-version">AI 整理版本 {list.run.prompt_version ?? '-'}</Pill>
              </Tooltip>
            )}
            <span data-testid="review-progress">已确认 {reviewedCount} / {questions.length}</span>
            <span className="ewb-rev__keys">按 J / K 切换题目 · 按 Enter 确认这道题</span>
          </div>
        </div>
        <div className="ewb-rev__actions">
          <Btn tone="secondary" icon={ListChecks} className="ewb-rev__listbtn" data-testid="open-question-list" onClick={() => setListOpen(!listOpen)}>题目列表（{questions.length} 题）</Btn>
          {done
            ? <Btn tone="secondary" icon={Pencil} onClick={async () => { await window.api.questions.reopen(paperId!); queryClient.invalidateQueries({ queryKey: ['papers'] }) }}>重新打开审核</Btn>
            : <Btn tone="secondary" icon={Check} data-testid="finish-paper" onClick={finish}>确认整份试卷</Btn>}
        </div>
      </div>
      {paper.similar_state === 'suspect' && <div className="ewb-rev__notes"><SimilarNotice paper={paper} /></div>}
      {((reopenedNotice && paper.status === 'reviewing') || dropped || (list?.notes?.length ?? 0) > 0) && (
        <div className="ewb-rev__notes">
          {reopenedNotice && paper.status === 'reviewing' && (
            <UsageNote kind="caution" data-testid="reopened-notice" title="这份卷子已经变回「待审核」，暂时不计入统计。">
              因为你改了已完成卷子里的内容。改完以后点右上角的「确认整份试卷」就恢复了；不点的话，看板和报告里会少这一份。
            </UsageNote>
          )}
          {dropped && (
            <UsageNote kind="caution" data-testid="dropped-secondary-notice"
              actions={<Btn tone="secondary" size="small" data-testid="undo-dropped-secondary" onClick={() => { const d = dropped; setDropped(null); patch(d.id, d.undo) }}>撤销这一步</Btn>}>
              改了主要考的知识点后，原来“还顺带考到”的「{dropped.names}」和新的重复，已经被去掉。
            </UsageNote>
          )}
          {(list?.notes?.length ?? 0) > 0 && (
            <UsageNote kind="caution" label="AI 备注" data-testid="ai-notes">{safeText(list!.notes.join('；'))}</UsageNote>
          )}
        </div>
      )}

      <div className="ewb-rev__cols">
        {listOpen && <div className="ewb-rev__backdrop" onClick={() => setListOpen(false)} />}
        {/* 左：题目列表（像词典的条目索引） */}
        <div className={`ewb-rev-left${listOpen ? ' is-open' : ''}`}>
          <div className="ewb-rev-left__top">
            <Segmented size="small" block value={filter} onChange={v => setFilter(v as Filter)} options={[
              { label: `全部 ${questions.length}`, value: 'all' },
              { label: `待确认 ${questions.length - reviewedCount}`, value: 'todo' },
              { label: `需关注 ${questions.filter(q => needsAttention(q, lowConfidence) && !q.reviewed).length}`, value: 'attention' }
            ]} />
          </div>
          <div className="ewb-rev-left__list" data-testid="question-list">
            {visible.length === 0 && <div className="ewb-rev-empty">没有符合条件的题目</div>}
            {visible.map((q, i) => {
              const warn = needsAttention(q, lowConfidence)
              const active = q.id === selId
              const prevSec = visible[i - 1]?.section
              const kp = q.kp_main ? tax?.kps.find(k => k.code === q.kp_main)?.name : undefined
              return (
                <React.Fragment key={q.id}>
                  {(i === 0 || prevSec !== q.section) && q.section_title && (
                    <div className="ewb-rev-sec">{q.section}、{q.section_title}</div>
                  )}
                  <div
                    data-qid={q.id} data-testid="q-item" data-warn={warn ? '1' : '0'} data-reviewed={q.reviewed ? '1' : '0'}
                    className={`ewb-rev-q${active ? ' ewb-rev-q--active' : ''}${warn && !q.reviewed ? ' ewb-rev-q--warn' : ''}`}
                    onClick={async () => { await flush(); setSelId(q.id); setListOpen(false) }}
                  >
                    <span className="ewb-rev-q__no">{q.no}</span>
                    <span className="ewb-rev-q__stem">{q.stem || q.options.join(' ') || '（无题干）'}</span>
                    <span className="ewb-rev-q__marks">
                      {list?.hints?.[q.id] && <Tooltip title={list.hints[q.id]}><Pill kind="warn" tabIndex={0} data-testid="hint-tag">核对</Pill></Tooltip>}
                      {q.reviewed
                        ? <span className="ewb-rev-q__state ewb-rev-q__state--done" role="img" aria-label="已确认"><Icon as={Check} size={16} /></span>
                        : warn
                          ? <span className="ewb-rev-q__state ewb-rev-q__state--warn" role="img" aria-label="需要关注"><Icon as={TriangleAlert} size={16} /></span>
                          : q.edited ? <span className="ewb-rev-q__state" role="img" aria-label="已编辑"><Icon as={Pencil} size={14} /></span> : null}
                    </span>
                    {kp && <span className="ewb-rev-q__kp">{kp}</span>}
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>

        {/* 中：原卷页面 + 题目框（白纸放在布面上） */}
        <div className="ewb-rev-mid">
          <div className="ewb-rev-mid__tools">
            <Btn tone="secondary" size="small" icon={ChevronLeft} disabled={pageIdx <= 1} onClick={() => setPageIdx(pageIdx - 1)}>上一页</Btn>
            <span data-testid="page-indicator" className="ewb-rev-mid__page">第 {pageIdx} / {pages.length} 页</span>
            <Btn tone="secondary" size="small" icon={ChevronRight} disabled={pageIdx >= pages.length} onClick={() => setPageIdx(pageIdx + 1)}>下一页</Btn>
            <div className="push">
              <Segmented size="small" value={zoom} onChange={v => setZoom(v as number)} options={[{ label: '适应宽度', value: 1 }, { label: '150%', value: 1.5 }, { label: '200%', value: 2 }]} />
              <label className="ewb-rev-check"><input type="checkbox" checked={showOthers} onChange={e => setShowOthers(e.target.checked)} />显示其他题的框</label>
              {cur && cur.page_idx !== pageIdx && <Btn tone="secondary" size="small" onClick={() => setPageIdx(cur.page_idx ?? 1)}>回到本题所在页</Btn>}
            </div>
          </div>
          <div className="ewb-rev-cloth" data-testid="page-scroll">
            {!page && <EmptyState inline title="没有页面数据" />}
            {page && hasImage && (
              <div data-box-canvas data-testid="page-canvas" className="ewb-rev-sheet" style={{ position: 'relative', lineHeight: 0, width: `${zoom * 100}%`, maxWidth: zoom === 1 ? 900 : undefined, margin: '0 auto' }}>
                <img data-testid="page-image" src={`ewb://page/${paperId}/${page.image_rel}`} alt={`第${page.idx}页`} draggable={false} style={{ width: '100%', display: 'block', userSelect: 'none' }} />
                {showOthers && questions.filter(x => x.id !== cur?.id && x.page_idx === pageIdx && x.bbox).map(x => (
                  <div key={x.id} className="ewb-rev-others" onClick={() => setSelId(x.id)} title={`第 ${x.no} 题`} style={{
                    left: `${x.bbox![0] * 100}%`, top: `${x.bbox![1] * 100}%`, width: `${x.bbox![2] * 100}%`, height: `${x.bbox![3] * 100}%`
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
              <div data-testid="docx-text" className="ewb-sheet ewb-rev-docx">{page.text}</div>
            )}
            {cur && hasImage && !box && cur.page_idx === pageIdx && (
              <div className="ewb-rev-cloth__act">
                <Pill kind="warn">这道题没有定位框</Pill>
                <Btn tone="secondary" size="small" data-testid="draw-box" onClick={() => patch(cur.id, { bbox: [0.1, 0.1, 0.8, 0.08], page_idx: pageIdx })}>在此页画一个框</Btn>
              </div>
            )}
            {cur && hasImage && cur.page_idx !== pageIdx && (
              <div className="ewb-rev-cloth__act">
                <Btn tone="secondary" size="small" onClick={() => patch(cur.id, { bbox: cur.bbox ?? [0.1, 0.1, 0.8, 0.08], page_idx: pageIdx })}>把本题的框移到当前页</Btn>
              </div>
            )}
          </div>
        </div>

        {/* 右：标注表单 */}
        <div className="ewb-rev-right">
          {cur ? (
            <QuestionForm
              key={`${cur.id}:${formVersion}`}
              lowConfidence={lowConfidence}
              busy={structBusy}
              localEdits={!!overlay[cur.id]}
              q={cur} index={curIndex < 0 ? questions.findIndex(q => q.id === cur.id) : curIndex} total={curIndex < 0 ? questions.length : visible.length}
              hint={list?.hints?.[cur.id]}
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
                } catch (e) { throw new Error(clean(e)) }   // 错误原因由采纳框自己显示（kp-approve-error）
              }}
              onReject={async () => { await window.api.taxonomy.rejectSuggestion(cur.id); queryClient.invalidateQueries({ queryKey: ['questions', paperId] }) }}
            />
          ) : <EmptyState inline title="请选择一道题" />}
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
      <div style={{ fontSize: 14, color: 'var(--ewb-ink-2)', marginBottom: 8 }}>把原题的内容分到两道题里：左边保留在本题，右边成为新题（紧跟在本题之后，知识点、题型沿用，需要时再改）。选项一行一个。</div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ height: 32, display: 'flex', alignItems: 'center' }}><b>本题（第 {q.no} 题）</b></div>
          <Input.TextArea data-testid="split-first-stem" rows={4} value={firstStem} onChange={e => setFirstStem(e.target.value)} placeholder="题干" style={{ margin: '6px 0' }} />
          <Input.TextArea rows={4} value={firstOpts} onChange={e => setFirstOpts(e.target.value)} placeholder="选项（一行一个）" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8 }}><b>新题 题号</b><Input data-testid="split-second-no" size="small" style={{ width: 80 }} value={secondNo} onChange={e => setSecondNo(e.target.value)} /></div>
          <Input.TextArea data-testid="split-second-stem" rows={4} value={secondStem} onChange={e => setSecondStem(e.target.value)} placeholder="题干" style={{ margin: '6px 0' }} />
          <Input.TextArea rows={4} value={secondOpts} onChange={e => setSecondOpts(e.target.value)} placeholder="选项（一行一个）" />
        </div>
      </div>
    </Modal>
  )
}
