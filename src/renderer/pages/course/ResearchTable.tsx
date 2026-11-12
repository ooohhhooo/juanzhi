import React, { useEffect, useMemo, useState } from 'react'
import { App, Checkbox, Collapse, InputNumber, Modal, Select, Spin, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Download, Paperclip, Sparkles } from 'lucide-react'
import { useSubject } from '../../subject/SubjectContext'
import { useStatsFilter } from '../../stats/StatsFilter'
import FilterBar from '../../stats/StatsFilter'
import { clean } from '../../components/CourseMatch'
import { Btn, EmptyState, Panel, UsageNote } from '../../design'
import '../../design/page-report.css'
import '../../design/page-analysis.css'
import '../../design/page-course.css'

type RTable = Awaited<ReturnType<Window['api']['course']['researchTable']>>['table']
type RLesson = RTable['lessons'][number]
type RKp = RLesson['kps'][number]

const ADVICE_LABEL: Record<string, string> = { add: '要补', align: '要对齐', swap: '换例题', trim: '可减或超前' }
const ADVICE_COLOR: Record<string, string> = { add: 'red', align: 'orange', swap: 'blue', trim: 'default' }
const PREVIEW_STEP = 5

/** builtin_id 形如「math-renjiao:1上,1下」 */
const parseBuiltin = (s: string): { editionId: string; keys: string[] } | null => {
  const m = /^([a-z]+-[a-z]+):(.+)$/.exec(s ?? '')
  return m ? { editionId: m[1], keys: m[2].split(',').filter(Boolean) } : null
}

const locText = (l: RKp['locs'][number]): string => `${l.outlineName === l.levelName ? '' : `${l.outlineName}：`}${l.levelName} ${l.label}${l.pages ? `（${l.pages}）` : ''}${l.coarse ? ' · 较粗' : ''}`
const schoolText = (k: RKp): string => (k.papers === 0 ? '范围内没有考到' : `${k.questions} 题 · ${k.papers}/${k.paperTotal} 份卷子${k.frequent ? ' · 常考' : ''}${k.errorCount ? ` · 易错 ${k.errorCount} 题` : ''}`)

// ───────────────────────── 选教材：能搜索、按版本分组选册 ─────────────────────────

/**
 * 教材选择器：内置目录的版本很多（全国 40 多个），所以带搜索；每个版本折叠成一组，组里勾具体的册；
 * 勾了还没添加到“课程”里的册，点确定时会自动添加（内置目录，不需要 AI 匹配）。我上传的教材单独列在最前面。
 */
function TextbookPicker({ open, onClose, cards, initial, onDone }: { open: boolean; onClose: () => void; cards: CourseOutlineCard[]; initial: string[]; onDone: (ids: string[]) => void }) {
  const { message } = App.useApp()
  const { subject, def } = useSubject()
  const [q, setQ] = useState('')
  const [keys, setKeys] = useState<string[]>([])   // cat:<版本>:<册> 或 ol:<上传的教材 id>
  const [busy, setBusy] = useState(false)
  const { data: catalog } = useQuery({ queryKey: ['course', 'catalog', subject], queryFn: () => window.api.course.catalog(subject), enabled: open })
  const books = useMemo(() => cards.filter(c => c.kind === 'textbook' && c.status === 'active'), [cards])
  useEffect(() => {
    if (!open) return
    const k: string[] = []
    for (const id of initial) {
      const o = books.find(b => b.id === id)
      const p = o ? parseBuiltin(o.builtinId) : null
      if (o && p) p.keys.forEach(x => k.push(`cat:${p.editionId}:${x}`)); else if (o) k.push(`ol:${o.id}`)
    }
    setKeys(k); setQ('')
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  const uploaded = books.filter(b => !parseBuiltin(b.builtinId))
  const added = (editionId: string, key: string) => books.some(b => parseBuiltin(b.builtinId)?.editionId === editionId && parseBuiltin(b.builtinId)!.keys.includes(key))
  const t = q.trim().toLowerCase()
  const editions = (catalog ?? []).filter(e => !t || e.edition.toLowerCase().includes(t) || e.books.some(b => b.label.includes(t)))
  const upl = uploaded.filter(b => !t || b.name.toLowerCase().includes(t))
  const toggle = (k: string, on: boolean) => setKeys(cur => (on ? [...new Set([...cur, k])] : cur.filter(x => x !== k)))
  const selectedIn = (editionId: string) => keys.filter(k => k.startsWith(`cat:${editionId}:`)).length

  const submit = async () => {
    setBusy(true)
    try {
      const ids = new Set(keys.filter(k => k.startsWith('ol:')).map(k => k.slice(3)))
      const byEdition = new Map<string, Set<string>>()
      for (const k of keys.filter(x => x.startsWith('cat:'))) { const [, e, b] = k.split(':'); if (!byEdition.has(e)) byEdition.set(e, new Set()); byEdition.get(e)!.add(b) }
      for (const [editionId, sel] of byEdition) {
        const covered = new Set<string>()
        const mine = books.map(b => ({ b, p: parseBuiltin(b.builtinId) })).filter(x => x.p?.editionId === editionId).sort((a, z) => z.p!.keys.length - a.p!.keys.length)
        for (const { b, p } of mine) if (p!.keys.every(x => sel.has(x)) && p!.keys.some(x => !covered.has(x))) { ids.add(b.id); p!.keys.forEach(x => covered.add(x)) }
        const rest = [...sel].filter(x => !covered.has(x))
        if (rest.length) { const r = await window.api.course.addBuiltin({ editionId, books: rest }); ids.add(r.id) }
      }
      onDone([...ids])
      onClose()
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onCancel={onClose} title="选学校教材" okText={`确定（${keys.length} 册 / 份）`} cancelText="取消" width={680} destroyOnHidden data-testid="research-book-picker"
      okButtonProps={{ loading: busy, 'data-testid': 'research-book-ok' } as never} onOk={submit}>
      <p className="ewb-rep-note" style={{ marginBottom: 8 }}>当前学科：{def.name}。每个版本一组，勾要对照的册；没添加过的内置教材，确定后会自动添加到“课程”里。</p>
      <input className="ant-input" style={{ width: '100%', marginBottom: 12, padding: '6px 10px' }} placeholder="搜版本或册（如 人教、外研、三年级）" value={q} onChange={e => setQ(e.target.value)} data-testid="research-book-search" />
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        {upl.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="ewb-rep-note" style={{ marginBottom: 4 }}>我上传的教材</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {upl.map(b => <Checkbox key={b.id} checked={keys.includes(`ol:${b.id}`)} onChange={e => toggle(`ol:${b.id}`, e.target.checked)} data-testid={`research-book-ol-${b.id}`}>{b.name}</Checkbox>)}
            </div>
          </div>
        )}
        {editions.length === 0 && upl.length === 0 && <p className="ewb-rep-note" data-testid="research-book-none">{catalog && catalog.length === 0 ? '这个学科暂时没有内置的教材目录。' : '没有找到，换个词试试。'}</p>}
        <Collapse size="small" items={editions.map(e => ({
          key: e.id,
          label: <span data-testid={`research-edition-${e.id}`}>{e.edition}<span className="ewb-ana-meta" style={{ marginLeft: 8 }}>{selectedIn(e.id) ? `已选 ${selectedIn(e.id)} 册` : `${e.books.length} 册`}</span></span>,
          children: (
            <div style={{ display: 'grid', gap: 6 }}>
              {e.books.map(b => (
                <Checkbox key={b.key} checked={keys.includes(`cat:${e.id}:${b.key}`)} onChange={ev => toggle(`cat:${e.id}:${b.key}`, ev.target.checked)} data-testid={`research-book-${e.id}-${b.key}`}>
                  {b.label}（{b.units} 个单元）{b.editionYear ? <span className="ewb-ana-meta" style={{ marginLeft: 6 }}>{b.editionYear}</span> : null}{added(e.id, b.key) ? <span className="ewb-ana-meta" style={{ marginLeft: 6 }}>已添加</span> : null}
                </Checkbox>
              ))}
            </div>
          )
        }))} defaultActiveKey={t && editions.length <= 3 ? editions.map(e => e.id) : undefined} />
      </div>
    </Modal>
  )
}

// ───────────────────────── 教研对照表 ─────────────────────────

interface Row { key: string; lesson: RLesson; kp: RKp | null; first: boolean; span: number }

/**
 * 教研对照表：以机构大纲 A 的每一节课为一行——这节课对应的知识点（按大类分组）、教材里在哪一册哪个单元、校内试卷考过的原题、B 里对应的课，
 * 再加一列修订建议（要补 / 要对齐 / 换例题 / 可减或超前，依据由程序算；可选让 AI 写小结）。每一节可以挂机构课件（只在本机读文字）。导出 Excel。
 */
export default function ResearchTable() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { subject } = useSubject()
  const { filter } = useStatsFilter()
  const { data: cards } = useQuery({ queryKey: ['course', 'list', subject], queryFn: () => window.api.course.list(subject) })
  const courses = useMemo(() => (cards ?? []).filter(c => c.kind === 'course' && c.status === 'active'), [cards])
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [bookIds, setBookIds] = useState<string[]>([])
  const [perKp, setPerKp] = useState(3)
  const [picker, setPicker] = useState(false)
  const [shown, setShown] = useState(PREVIEW_STEP)
  // AI 小结：点按钮才调，结果存在这里（换范围就清空）；导出时带给主进程，不再调 AI
  const [ai, setAi] = useState<{ summaries: Record<string, string>; note: string; running: boolean; reqId: string }>({ summaries: {}, note: '', running: false, reqId: '' })
  const [busy, setBusy] = useState(false)
  const cid = courses.some(c => c.id === aId) ? aId : (courses[0]?.id ?? '')
  const bid = bId && bId !== cid && courses.some(c => c.id === bId) ? bId : ''
  const books = useMemo(() => bookIds.filter(id => (cards ?? []).some(c => c.id === id && c.kind === 'textbook')), [bookIds, cards])
  useEffect(() => { setAi(a => { if (a.running && a.reqId) void window.api.course.researchAdviceCancel(a.reqId); return { summaries: {}, note: '', running: false, reqId: '' } }); setShown(PREVIEW_STEP) }, [cid, bid, books.join(','), perKp, filter])
  const scope: ResearchScope = { filter: { ...filter, subject }, courseId: cid, courseBId: bid || undefined, textbookIds: books, perKp }
  const { data, isFetching, error } = useQuery({
    queryKey: ['course', 'research', scope], queryFn: () => window.api.course.researchTable(scope), enabled: !!cid,
    placeholderData: prev => prev, refetchOnWindowFocus: false
  })
  const t = data?.table

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const l of (t?.lessons ?? []).slice(0, shown)) {
      const n = Math.max(1, l.kps.length)
      if (!l.kps.length) out.push({ key: `${l.lessonId}-0`, lesson: l, kp: null, first: true, span: 1 })
      l.kps.forEach((k, i) => out.push({ key: `${l.lessonId}-${k.code}`, lesson: l, kp: k, first: i === 0, span: i === 0 ? n : 0 }))
    }
    return out
  }, [t, shown])

  const attach = async (l: RLesson) => {
    try {
      const r = await window.api.course.coursewareAdd({ outlineId: l.outlineId, levelName: l.levelName, seq: l.seq })
      if (!r) return
      if (r.added.length) message.success(`已挂上 ${r.added.length} 份课件（文字只在本机读取）`)
      if (r.errors.length) message.warning(r.errors.join('；'))
      qc.invalidateQueries({ queryKey: ['course', 'research'] })
    } catch (e) { message.error(clean(e)) }
  }
  const detach = async (l: RLesson, id: string) => {
    try { await window.api.course.coursewareRemove(l.outlineId, id); qc.invalidateQueries({ queryKey: ['course', 'research'] }) } catch (e) { message.error(clean(e)) }
  }
  const aiOf = (l: RLesson): string => l.aiAdvice || ai.summaries[`${l.levelName}|${l.seq}`] || ''
  const askAi = async () => {
    try {
      const c = await window.api.course.researchAdviceCount(scope)
      if (!c.ready) return
      if (!c.configured) { message.warning('还没有配置 AI 服务，请先到“设置 → AI 服务”里配置'); return }
      if (c.calls === 0) { message.info('这份对照表里没有需要写小结的课'); return }
      const ok = await new Promise<boolean>(res => Modal.confirm({
        title: '让 AI 写修订小结', okText: `开始（调用 ${c.calls} 次）`, cancelText: '先不了', onOk: () => res(true), onCancel: () => res(false), okButtonProps: { 'data-testid': 'research-ai-confirm' } as never,
        content: `有修订建议的课共 ${c.total} 节，每节调用一次你设置的 AI，这次会调用 ${c.calls} 次${c.total > c.calls ? `（一次最多写前 ${c.calls} 节）` : ''}。依据和课件摘录会发给它；可以随时取消。`
      }))
      if (!ok) return
      const reqId = crypto.randomUUID()
      setAi(a => ({ ...a, running: true, reqId, note: '' }))
      const r = await window.api.course.researchAdvice(scope, reqId)
      setAi(a => (a.reqId === reqId ? { summaries: { ...a.summaries, ...r.summaries }, note: r.note, running: false, reqId: '' } : a))
      qc.invalidateQueries({ queryKey: ['usage'] })
    } catch (e) { setAi(a => ({ ...a, running: false, reqId: '' })); message.error(clean(e)) }
  }
  const cancelAi = () => { if (ai.reqId) void window.api.course.researchAdviceCancel(ai.reqId) }
  const exportXlsx = async () => {
    setBusy(true)
    try {
      const x = await window.api.course.researchExport({ ...scope, aiAdvice: Object.keys(ai.summaries).length ? ai.summaries : undefined })
      if (x.saved) message.success(`已导出：${x.path}`)
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }

  const columns: ColumnsType<Row> = [
    {
      title: '课', dataIndex: 'lesson', width: 150, onCell: r => ({ rowSpan: r.span }),
      render: (_: unknown, r) => (
        <div data-testid={`research-lesson-${r.lesson.lessonId}`}>
          <b>{r.lesson.levelName} {r.lesson.label}</b>
          <div style={{ marginTop: 6 }}>
            {r.lesson.courseware.map(c => (
              <div key={c.id} className="ewb-ana-meta" data-testid="research-cw-file"><FileText size={12} /> {c.name} <a onClick={() => void detach(r.lesson, c.id)} data-testid="research-cw-remove">移除</a></div>
            ))}
            <Btn tone="quiet" size="small" icon={Paperclip} data-testid={`research-attach-${r.lesson.lessonId}`} onClick={() => void attach(r.lesson)}>挂课件</Btn>
          </div>
        </div>
      )
    },
    { title: '大类', width: 80, render: (_: unknown, r) => r.kp?.group ?? <span className="ewb-ana-meta">这节课没有对应的知识点</span> },
    { title: '知识点', width: 120, render: (_: unknown, r) => (r.kp ? <b>{r.kp.name}</b> : '') },
    ...(books.length ? [{ title: '教材位置', width: 200, render: (_: unknown, r: Row) => (r.kp ? (r.kp.locs.length ? r.kp.locs.map((l, i) => <div key={i} className="ewb-ana-meta" style={{ color: l.coarse ? undefined : 'inherit' }} data-testid="research-loc">{locText(l)}</div>) : <span className="ewb-ana-meta">教材里没有找到</span>) : '') }] : []),
    { title: '校内考察', width: 150, render: (_: unknown, r) => (r.kp ? <span data-testid="research-school">{schoolText(r.kp)}</span> : '') },
    {
      title: '校内例题', render: (_: unknown, r) => (r.kp ? (r.kp.examples.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {r.kp.examples.map(e => (
            <div key={e.id} data-testid="research-example">
              <div className="ewb-ana-meta">《{e.paperTitle}》第 {e.no} 题{e.errorProne ? <Tag color="red" style={{ marginLeft: 6 }}>易错</Tag> : null}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{e.stem.slice(0, 200)}</div>
              {e.options.length > 0 && <div className="ewb-ana-meta">{e.options.join('　')}</div>}
              {e.answer && <div className="ewb-ana-meta">答案：{e.answer}</div>}
            </div>
          ))}
        </div>
      ) : <span className="ewb-ana-meta">范围内没有这个知识点的题</span>) : '')
    },
    ...(t?.courseB ? [{ title: `「${t.courseB.name}」里的课`, width: 140, render: (_: unknown, r: Row) => (r.kp ? (r.kp.bLessons.length ? r.kp.bLessons.map((b, i) => <div key={i} className="ewb-ana-meta">{b.levelName} {b.label}{b.coarse ? ' · 较粗' : ''}</div>) : <span className="ewb-ana-meta">B 里没讲</span>) : '') }] : []),
    {
      title: '修订建议', width: 280, onCell: r => ({ rowSpan: r.span }),
      render: (_: unknown, r) => (
        <div data-testid={`research-advice-${r.lesson.lessonId}`}>
          {aiOf(r.lesson) && <div style={{ marginBottom: 6 }} data-testid="research-ai-advice"><Tag color="purple">AI 小结 · 供参考</Tag>{aiOf(r.lesson)}</div>}
          {r.lesson.advice.map((a, i) => <div key={i} style={{ marginBottom: 4 }} data-testid="research-advice-item" data-kind={a.kind}><Tag color={ADVICE_COLOR[a.kind]}>{ADVICE_LABEL[a.kind]}</Tag>{a.text}</div>)}
          {!r.lesson.advice.length && <span className="ewb-ana-meta">{r.lesson.courseware.length ? '没有发现需要改的地方。' : '暂无建议。挂上这一节的课件后，可以判断要补 / 可减的内容。'}</span>}
        </div>
      )
    }
  ]

  if (!cards) return <Spin style={{ margin: 40 }} />
  return (
    <div data-testid="research-table">
      <FilterBar />
      <Panel title="教研对照表" data-testid="research-panel"
        aside={<span className="ewb-rep-row" style={{ gap: 8 }}>
          {ai.running
            ? <Btn tone="secondary" size="small" data-testid="research-ai-cancel" onClick={cancelAi}>取消 AI 小结</Btn>
            : <Btn tone="secondary" size="small" icon={Sparkles} disabled={!t?.ready} data-testid="research-ai" onClick={() => void askAi()}>让 AI 写修订小结</Btn>}
          <Btn tone="primary" size="small" icon={Download} disabled={!t?.ready} loading={busy} data-testid="research-export" onClick={() => void exportXlsx()}>导出 Excel</Btn>
        </span>}>
        <p className="ewb-rep-note" style={{ marginBottom: 12 }}>以机构大纲的每一节课为一行：这节课对应的知识点、学校教材里在哪一册哪个单元、校内试卷考过的原题，再加修订建议。课件只在本机读取文字；点“让 AI 写修订小结”时，依据和课件摘录会发给你在“AI 服务”里设置的模型。</p>
        {courses.length === 0 ? (
          <EmptyState inline title="还没有机构大纲" description="先上传机构大纲，让 AI 把知识点对应到课，再回到这里。"
            steps={['在“课程大纲”里上传机构大纲', '让 AI 匹配知识点', '回到这里选大纲、教材和试卷范围']} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="ewb-rep-row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label>机构大纲 A　<Select style={{ minWidth: 200 }} value={cid} onChange={v => { setAId(v); if (v === bId) setBId('') }} data-testid="research-a" options={courses.map(c => ({ value: c.id, label: c.name }))} showSearch optionFilterProp="label" /></label>
              <label>机构大纲 B（可选）　<Select style={{ minWidth: 200 }} allowClear placeholder="不对比" value={bid || undefined} onChange={v => setBId(v ?? '')} data-testid="research-b" options={courses.filter(c => c.id !== cid).map(c => ({ value: c.id, label: c.name }))} showSearch optionFilterProp="label" /></label>
              <label>每个知识点例题数　<InputNumber min={1} max={10} value={perKp} onChange={v => setPerKp(Math.min(10, Math.max(1, Math.round(Number(v) || 3))))} data-testid="research-perkp" /></label>
            </div>
            <div className="ewb-rep-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>学校教材</span>
              <Btn tone="secondary" size="small" data-testid="research-pick-books" onClick={() => setPicker(true)}>选教材（已选 {books.length} 份）</Btn>
              {books.map(id => <Tag key={id} closable onClose={() => setBookIds(books.filter(x => x !== id))} data-testid="research-book-tag">{(cards ?? []).find(c => c.id === id)?.name}</Tag>)}
              {books.length === 0 && <span className="ewb-ana-meta">不选教材也可以，只是没有“教材位置”那一列</span>}
            </div>
          </div>
        )}
      </Panel>

      {error && <UsageNote kind="caution">{clean(error)}</UsageNote>}
      {isFetching && !t && <Spin style={{ margin: 24 }} />}
      {t && !t.ready && <UsageNote kind="caution" data-testid="research-reason">{t.reason}</UsageNote>}
      {t && t.ready && (
        <>
          <h3 className="ewb-crs-headline" data-testid="research-headline">
            《{t.course!.name}》共 <b>{t.summary.lessons}</b> 节课、<b>{t.summary.kps}</b> 个知识点，其中 <b data-testid="research-with-examples">{t.summary.kpsWithExamples}</b> 个有校内例题；修订建议 <b data-testid="research-advice-count">{t.summary.adviceItems}</b> 条
            {t.textbooks.length > 0 && <>；教材里有、A 没讲的 <b data-testid="research-tb-not-in-a">{t.summary.tbNotInA}</b> 个</>}
            {t.courseB && <>；只有 A 讲 <b>{t.summary.onlyA}</b> 个、只有 B 讲 <b>{t.summary.onlyB}</b> 个</>}。
          </h3>
          <p className="ewb-rep-note">试卷范围内共 {t.papers} 份{filter.includeReviewing ? '卷子（含待审核）' : '已审核的卷子'}{t.smallSample ? '（少于 3 份，不标“常考”）' : ''}。知识点对应是 AI 匹配的结果（内置教材来自目录），请教研核对；“较粗”表示只有更大的类别对得上。{ai.running ? ' AI 正在写修订小结……' : ''}{ai.note ? ` ${ai.note}` : ''}</p>
          <Table<Row> size="small" rowKey="key" columns={columns} dataSource={rows} pagination={false} bordered loading={isFetching} scroll={{ x: 'max-content' }} data-testid="research-grid" className="ewb-rt-grid" />
          {t.lessons.length > shown && (
            <div style={{ textAlign: 'center', margin: '12px 0' }}>
              <Btn tone="secondary" size="small" data-testid="research-more" onClick={() => setShown(n => n + PREVIEW_STEP)}>再看 {Math.min(PREVIEW_STEP, t.lessons.length - shown)} 节（已显示 {shown}/{t.lessons.length} 节，导出的 Excel 是全部）</Btn>
            </div>
          )}
          {t.textbooks.length > 0 && (
            <section className="ewb-crs-block" data-testid="research-tb-not-in-a-list">
              <h4 className="ewb-crs-block__title">教材有、机构大纲没讲的 <span className="ewb-ana-meta">学校常考的在前</span></h4>
              {t.tbNotInA.length === 0 ? <p className="ewb-rep-note">没有：所选教材里的知识点，机构大纲都讲到了。</p> : t.tbNotInA.slice(0, 20).map(r => (
                <div key={r.code} className="ewb-crs-row">
                  <div className="ewb-crs-row__kp"><span className="ewb-ana-kpname">{r.name}</span><span className="ewb-ana-meta">{r.group} · {r.papers ? `${r.papers}/${r.paperTotal} 份卷子考过${r.frequent ? ' · 常考' : ''}` : '范围内没有考到'}</span></div>
                  <span className="ewb-ana-meta">教材里：{r.units.slice(0, 3).join('、')}{r.units.length > 3 ? ` 等 ${r.units.length} 处` : ''}</span>
                </div>
              ))}
            </section>
          )}
          {t.courseB && (
            <section className="ewb-crs-block" data-testid="research-only-ab">
              <h4 className="ewb-crs-block__title">只有 A 讲 / 只有 B 讲</h4>
              <div className="ewb-crs-chips">
                {t.onlyA.slice(0, 40).map(r => <span key={`a-${r.code}`} className="ewb-ana-pill ewb-ana-pill--primary" title={r.lessons.join('；')}>只有 A：{r.name}</span>)}
                {t.onlyB.slice(0, 40).map(r => <span key={`b-${r.code}`} className="ewb-ana-pill ewb-ana-pill--quiet" title={r.lessons.join('；')}>只有 B：{r.name}</span>)}
                {t.onlyA.length + t.onlyB.length === 0 && <span className="ewb-rep-note">两份大纲讲的知识点一致。</span>}
              </div>
            </section>
          )}
        </>
      )}
      <TextbookPicker open={picker} onClose={() => setPicker(false)} cards={cards} initial={books} onDone={ids => { setBookIds(ids); qc.invalidateQueries({ queryKey: ['course'] }) }} />
    </div>
  )
}
