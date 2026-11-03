import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, Input, Modal, Radio } from 'antd'
import { Download, FileSpreadsheet } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, UsageNote } from '../../design'
import { clean } from '../../components/CourseMatch'
import { SCENE_LABEL, wordsOf } from './format'
import type { Scene } from './format'
import '../../design/page-course.css'

const FIELDS: Array<[CourseSheetMapping['columns'][number]['field'], string]> = [
  ['seq', '课次'], ['level', '级别'], ['title', '课程标题'], ['theme', '主题'], ['textbook_ref', '教材对标'], ['phonics', '字母与语音'],
  ['word', '词汇'], ['pattern', '句型'], ['expression', '实用表达'], ['skill', '能力目标'], ['note', '备注'], ['ignore', '忽略']
]

type Mappings = Record<string, CourseSheetMapping | null>

/**
 * 上传向导（课程大纲页 → 添加 / 重新上传）：
 *  1. 选文件（可多选，或粘贴表格），填名称和场景；点“开始整理”后弹窗关闭，AI 在后台整理（课程大纲页的任务卡片），整理好再点“核对并保存”回到第 2 步；
 *  2. 预览并修改——AI 只认列，课程内容由程序从单元格原文复制；保存之前什么都不落库。
 * replace 有值 = 重新上传替换这个体系（按“级别 + 课次”比对，已确认的对应只要课还在就保留）。
 */
export default function CourseWizard({ open, onClose, replace, job }: { open: boolean; onClose: () => void; replace?: CourseOutlineCard; /** 后台已整理好的任务：直接进入第 2 步核对 */ job?: CourseJob }) {
  const { message, modal } = App.useApp()
  const qc = useQueryClient()
  const [step, setStep] = useState<1 | 2>(1)
  const [src, setSrc] = useState<CourseSource | null>(null)
  const [srcs, setSrcs] = useState<CourseSource[]>([])   // 第 1 步选的文件（可多个）
  const [reading, setReading] = useState(false)
  const [over, setOver] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [name, setName] = useState('')
  const [scene, setScene] = useState<Scene>('org')
  const [termNote, setTermNote] = useState('')
  const [mode, setMode] = useState<'ai' | 'manual'>('ai')
  const [busy, setBusy] = useState(false)
  const [mappings, setMappings] = useState<Mappings>({})
  const [sugg, setSugg] = useState<Record<string, CourseSuggestItem>>({})
  const [aiModel, setAiModel] = useState('')
  const [parsed, setParsed] = useState<CourseParsed | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [levelIdx, setLevelIdx] = useState(0)
  const [diff, setDiff] = useState<{ added: number; changed: number; removed: number; affectedMaps: number; lockedLost: number; lockedRecheck: number } | null>(null)
  const [edited, setEdited] = useState(false)   // 预览里手改过格子：保存时才把整理结果带回主进程；没改过就只带 sessionId + 列映射
  const [collide, setCollide] = useState<CourseOutlineCard | null>(null)
  const [saving, setSaving] = useState(false)
  const { data: cards } = useQuery({ queryKey: ['course', 'list'], queryFn: () => window.api.course.list(), enabled: open })
  const { data: ai } = useQuery({ queryKey: ['ai', 'config'], queryFn: () => window.api.ai.getConfig(), enabled: open })
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    setStep(1); setSrc(null); setSrcs([]); setPasteText(''); setName(replace?.name ?? ''); setScene((replace?.scene as Scene) ?? 'org'); setTermNote(replace?.termNote ?? ''); setMode('ai')
    setEdited(false); setMappings({}); setSugg({}); setParsed(null); setSheetName(''); setLevelIdx(0); setDiff(null); setCollide(null)
  }, [open, replace?.id, job?.id])

  // 打开的是后台整理好的任务：取出结果，直接到第 2 步
  useEffect(() => {
    if (!open || !job) return
    let dead = false
    setBusy(true)
    ;(async () => {
      try {
        const r = await window.api.course.jobTake(job.id)
        if (dead) return
        setSrc(r.source); setSheetName(r.source.sheets.find(x => !x.hidden)?.name ?? '')
        setName(job.name); setScene(job.scene as Scene); setTermNote(job.termNote)
        setSugg(r.items); setAiModel(job.mode === 'ai' || r.organised ? r.model : '')
        const m: Mappings = Object.fromEntries(Object.entries(r.items).map(([k, v]) => [k, v.mapping]))
        setMappings(m)
        await reparse(m, r.source.sessionId)
        if (!dead) setStep(2)
      } catch (e) { if (!dead) { message.error(clean(e)); onClose() } } finally { if (!dead) setBusy(false) }
    })()
    return () => { dead = true; setBusy(false) }   // 关闭 / 换任务时 finally 不会执行，这里无条件清掉转圈
  }, [open, job?.id])

  const takeSources = (list: CourseSource[]) => {
    if (!list.length) return
    setSrcs(list)
    setSrc(list.length === 1 ? list[0] : null)
    if (!replace) setName(list.length === 1 ? list[0].name.slice(0, 60) : '')
    setSheetName(list.length === 1 ? list[0].sheets.find(x => !x.hidden)?.name ?? '' : '')
  }
  const guard = async (fn: () => Promise<CourseSource[]>) => {
    setReading(true)
    try { takeSources(await fn()) } catch (e) { message.error(clean(e)) } finally { setReading(false) }
  }
  const pick = () => guard(async () => {
    const r = await window.api.course.pickFile()
    if (!r) return []
    for (const m of r.errors) message.error(m)
    return replace ? r.sources.slice(0, 1) : r.sources
  })
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    ;(e.nativeEvent as unknown as { __ewbHandled?: boolean }).__ewbHandled = true   // 窗口级拖放（App.tsx 的 GlobalDrop）看到这个标记就不会把课程表当试卷导入
    const files = Array.from(e.dataTransfer.files ?? []).slice(0, replace ? 1 : 20)
    if (!files.length) return
    void guard(async () => {
      const out: CourseSource[] = []
      for (const f of files) {
        const p = window.api.getPathForFile(f)
        if (!p) { message.error('没有取到文件路径，请用“选择文件”按钮'); continue }
        try { out.push(await window.api.course.readFile(p)) } catch (err) { message.error(clean(err)) }
      }
      return out
    })
  }
  const downloadTemplate = async (kind: 'blank' | 'sample') => {
    try { const r = await window.api.course.template(kind); if (r.saved) message.success(`已保存：${r.path}`) } catch (e) { message.error(clean(e)) }
  }

  const reparse = async (m: Mappings, sid = src?.sessionId) => {
    if (!sid) return
    const my = ++seq.current
    try {
      const p = await window.api.course.preview({ sessionId: sid, mappings: m })
      if (my !== seq.current) return
      setParsed(p); setEdited(false)
      setLevelIdx(i => Math.min(i, Math.max(0, p.levels.length - 1)))
    } catch (e) { message.error(clean(e)) }
  }
  const multi = srcs.length > 1
  /** 单文件 + 手动指定列：不用 AI，直接进第 2 步；其余都交给后台整理 */
  const direct = srcs.length === 1 && mode === 'manual' && !srcs[0].fromDoc?.aiOrganised
  const goStep2 = async () => {
    if (!srcs.length) return
    if (!multi && !name.trim()) { message.warning('请先给课程体系起个名字'); return }
    setBusy(true)
    try {
      if (direct) {
        const s0 = srcs[0]
        const r = await window.api.course.suggest({ sessionId: s0.sessionId, mode: 'manual' })
        setSrc(s0); setSheetName(s0.sheets.find(x => !x.hidden)?.name ?? '')
        setSugg(r.items); setAiModel('')
        const m: Mappings = Object.fromEntries(Object.entries(r.items).map(([k, v]) => [k, v.mapping]))
        setMappings(m)
        await reparse(m, s0.sessionId)
        setStep(2)
        return
      }
      const jobs = await window.api.course.jobStart(srcs.map(s0 => ({
        sessionId: s0.sessionId, name: multi ? s0.name.slice(0, 60) : (replace?.name ?? name.trim()), scene, termNote,
        mode: s0.fromDoc?.aiOrganised ? 'ai' as const : mode, ...(replace ? { replaceId: replace.id } : {})
      })))
      qc.invalidateQueries({ queryKey: ['course'] })
      message.success(jobs.length > 1 ? `${jobs.length} 个文件已开始整理，进度见课程大纲页` : '已开始整理，进度见课程大纲页')
      onClose()
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }

  const sheet = src?.sheets.find(s => s.name === sheetName)
  const curMap = mappings[sheetName] ?? null
  const setMap = (patch: (m: CourseSheetMapping) => CourseSheetMapping) => {
    const base: CourseSheetMapping = curMap ?? { headerRows: 1, levelName: '', columns: [], skipMarkers: [], uncertain: [] }
    const next = { ...mappings, [sheetName]: patch(base) }
    setMappings(next)
    void reparse(next)
  }
  const setColField = (col: number, field: string) => setMap(m => ({ ...m, columns: [...m.columns.filter(c => c.col !== col), ...(field ? [{ col, field: field as CourseSheetMapping['columns'][number]['field'] }] : [])].sort((a, b) => a.col - b.col) }))

  // 编辑预览（只改内存里的 parsed；列识别条一变会重新套用，之前手改的格子会被覆盖——所以先定列、再改格子）
  const levels = parsed?.levels ?? []
  const edit = (fn: (ls: CourseLevelDraft[]) => CourseLevelDraft[]) => { setEdited(true); setParsed(p => (p ? { ...p, levels: fn(p.levels.map(l => ({ ...l, lessons: l.lessons.map(x => ({ ...x })) }))) } : p)) }
  const setLesson = (i: number, patch: Partial<CourseLevelDraft['lessons'][number]>) => edit(ls => { Object.assign(ls[levelIdx].lessons[i], patch); return ls })
  const totalLessons = levels.reduce((n, l) => n + l.lessons.length, 0)
  const warnings = parsed?.warnings ?? []

  // 替换：算一遍涉及多少课、多少条对应
  useEffect(() => {
    if (!replace || step !== 2 || !parsed) { setDiff(null); return }
    const t = setTimeout(() => { window.api.course.diff({ id: replace.id, sessionId: src?.sessionId, mappings: payloadMappings(), ...(edited ? { levels: parsed.levels.filter(l => l.lessons.length) } : {}) }).then(setDiff, () => setDiff(null)) }, 200)
    return () => clearTimeout(t)
  }, [replace?.id, step, parsed, edited])

  const payloadMappings = () => Object.fromEntries(Object.entries(mappings).filter(([, v]) => v)) as Record<string, CourseSheetMapping>
  const doSave = async (replaceId?: string, asName?: string, confirmLockedLoss = false) => {
    if (!src || !parsed) return
    if (!replaceId && !(asName ?? name).trim()) { message.warning('请先给课程体系起个名字'); return }
    const ls = parsed.levels.filter(l => l.lessons.length)
    if (!ls.length) { message.error('没有可保存的课：请回到上面检查表头行数和列类型'); return }
    setSaving(true)
    try {
      const r = await window.api.course.save({
        sessionId: src.sessionId, name: asName ?? name.trim(), scene, termNote, replaceId, ...(edited ? { levels: ls } : {}), warnings: parsed.warnings.slice(0, 300), mappings: payloadMappings(), aiModel, confirmLockedLoss
      })
      if (job) void window.api.course.jobRemove(job.id).catch(() => undefined)
      message.success(replaceId ? `已替换：新增 ${r.added} 课、修改 ${r.changed} 课、删除 ${r.removed} 课` : '已保存课程体系')
      qc.invalidateQueries({ queryKey: ['course'] })
      setCollide(null)
      onClose()
    } catch (e) { message.error(clean(e)) } finally { setSaving(false) }
  }
  const save = () => {
    if (replace) {
      const d = diff
      modal.confirm({
        title: `替换「${replace.name}」`,
        content: d ? (
          <div>
            <p>新增 {d.added} 课、修改 {d.changed} 课、删除 {d.removed} 课。{d.affectedMaps ? `已有的知识点对应里，有 ${d.affectedMaps} 条涉及改动的课，需要重新匹配；` : ''}替换后需要整体重新匹配（暂不支持只重跑改动的课）。</p>
            {d.lockedRecheck > 0 && <p>有 {d.lockedRecheck} 条老师确认 / 手工指定的对应所在的课内容变了：原文依据找不到的会退回“待确认”，请重新核对。</p>}
            {d.lockedLost > 0 && <p style={{ color: 'var(--ewb-red-ink)' }} data-testid="course-locked-lost"><b>注意：有 {d.lockedLost} 条老师确认 / 手工指定的对应，因为它们所在的课（或整个级别）不在新表里，替换后会被删掉。</b></p>}
          </div>
        ) : '内容会按“级别 + 课次”比对后更新。',
        okText: d && d.lockedLost > 0 ? `我知道了，仍然替换（会删 ${d.lockedLost} 条确认）` : '替换', okButtonProps: { 'data-testid': 'course-replace-ok', danger: !!d && d.lockedLost > 0 } as never, cancelText: '再看看', onOk: () => doSave(replace.id, undefined, !!d && d.lockedLost > 0)
      })
      return
    }
    const same = (cards ?? []).find(c => c.name === name.trim())
    if (same) { setCollide(same); return }
    void doSave()
  }

  const close = () => {
    if (step === 2 && parsed && (edited || !job)) { modal.confirm({ title: job ? '关闭核对？' : '放弃这次整理？', content: job ? '预览里的修改不会保留；整理结果仍在课程大纲页，可以随时再点“核对并保存”。' : '预览里的修改还没有保存。', okText: job ? '关闭' : '放弃', cancelText: '继续核对', okButtonProps: { danger: true } as never, onOk: onClose }); return }
    onClose()
  }

  const w = wordsOf(scene)
  const level = levels[levelIdx]
  const headRows = sheet?.head ?? []
  const nCols = headRows.reduce((m, r) => Math.max(m, r.length), 0)
  const colField = (c: number) => curMap?.columns.find(x => x.col === c)?.field ?? ''
  const aiReady = !!(ai?.hasKey && ai.base_url)
  const summary = useMemo(() => {
    const nonEmpty = levels.filter(l => l.lessons.length).length
    return `识别到 ${nonEmpty} 个${w.level}、共 ${totalLessons} 课。${warnings.length ? `有 ${warnings.length} 处需要你看一眼。` : ''}`
  }, [levels, totalLessons, warnings, w.level])

  return (
    <Modal open={open} onCancel={close} footer={null} width="min(1120px, 96vw)" destroyOnHidden maskClosable={false} centered styles={{ body: { maxHeight: 'calc(100vh - 190px)', overflowY: 'auto', paddingInlineEnd: 6 } }}
      title={replace ? `重新上传：替换「${replace.name}」` : '添加课程大纲'}>
      <div data-testid="course-wizard">
      <ol className="ewb-crs-steps" aria-label="步骤">
        <li aria-current={step === 1 ? 'step' : undefined}><span className="ewb-crs-steps__n">1</span>选文件</li>
        <li aria-current={step === 2 ? 'step' : undefined}><span className="ewb-crs-steps__n">2</span>核对整理结果</li>
        <li><span className="ewb-crs-steps__n">3</span>保存</li>
      </ol>

      {step === 1 && (
        <div data-testid="course-step1">
          <div className="ewb-crs-drop" data-over={over} data-testid="course-drop"
            onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <FileSpreadsheet size={28} aria-hidden />
            {srcs.length === 1
              ? <><b data-testid="course-file-name">已读取：{srcs[0].name}</b>{srcs[0].fromDoc?.pending
                ? <span className="ewb-rep-note" data-testid="course-doc-note">{srcs[0].fromDoc.label}，{srcs[0].fromDoc.pages > 1 ? `${srcs[0].fromDoc.pages} 页，` : ''}约 {srcs[0].fromDoc.chars} 字。点“开始整理”后由 AI 整理成表格，需要你核对。</span>
                : <span className="ewb-rep-note">{srcs[0].sheets.filter(s => !s.hidden).length} 张{srcs[0].fromDoc ? '表格' : '工作表'}{srcs[0].sheets.some(s => s.hidden) ? `（另有 ${srcs[0].sheets.filter(s => s.hidden).length} 张隐藏的，已跳过）` : ''}，共 {srcs[0].sheets.reduce((n, s) => n + s.rows, 0)} 行</span>}</>
              : multi
                ? <><b data-testid="course-file-name">已读取 {srcs.length} 个文件</b>
                  <ul className="ewb-crs-warnings" data-testid="course-file-list" style={{ textAlign: 'left', margin: 0 }}>{srcs.map(s => <li key={s.sessionId} data-testid="course-file-item">{s.name}</li>)}</ul>
                  <span className="ewb-rep-note">每个文件在后台各整理成一个课程体系，名称取文件名。</span></>
                : <><b>上传课程表（Excel、CSV、Word、PDF 或图片）</b><span className="ewb-rep-note">{replace ? '拖到这里，或点“选择文件”。' : '可以一次选多个文件：拖到这里，或点“选择文件”。'}旧版 .xls / .doc 请先另存为 .xlsx / .docx。</span></>}
            <Btn tone={srcs.length ? 'secondary' : 'primary'} size="small" loading={reading} data-testid="course-pick" onClick={pick}>{srcs.length ? '换文件' : '选择文件'}</Btn>
          </div>
          {srcs.some(x => x.warnings.length) ? <UsageNote kind="caution">{srcs.flatMap(x => x.warnings.map(w => (multi ? `${x.name}：${w}` : w))).join('；')}</UsageNote> : null}

          {!srcs.length && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>不想找文件？直接粘贴表格</summary>
              <Input.TextArea data-testid="course-paste-text" rows={5} value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="在 Excel 里选中整张表，复制，粘贴到这里（第一行是表头）" style={{ marginTop: 8 }} />
              <Btn tone="secondary" size="small" style={{ marginTop: 6 }} disabled={!pasteText.trim()} data-testid="course-paste-go" onClick={() => guard(async () => [await window.api.course.readText(pasteText)])}>用粘贴的内容</Btn>
            </details>
          )}

          <div className="ewb-rep-row" style={{ marginTop: 12 }}>
            <Btn tone="quiet" size="small" icon={Download} data-testid="course-template-blank" onClick={() => downloadTemplate('blank')}>下载空白模板</Btn>
            <Btn tone="quiet" size="small" icon={Download} data-testid="course-template-sample" onClick={() => downloadTemplate('sample')}>下载示例（虚构数据）</Btn>
            <span className="ewb-rep-note">模板一张工作表放一个{w.level}，首行是列名：课次 / 级别 / 主题 / 课程标题 / 字母与语音 / 词汇 / 句型 / 实用表达 / 教材对标 / 能力目标 / 备注。</span>
          </div>

          <div className="ewb-crs-form">
            <div className="ewb-crs-field"><label htmlFor="course-name">名称</label><Input id="course-name" data-testid="course-name" value={multi ? '' : name} maxLength={60} disabled={!!replace || multi} onChange={e => setName(e.target.value)} placeholder={multi ? '多个文件：各取文件名' : '例如：示例体系 A'} style={{ maxWidth: 360 }} /></div>
            <div className="ewb-crs-field">
              <span className="ewb-crs-field__label">这是什么</span>
              <Radio.Group data-testid="course-scene" value={scene} disabled={!!replace} onChange={e => setScene(e.target.value)}>
                {(Object.keys(SCENE_LABEL) as Scene[]).map(s => <Radio key={s} value={s}>{SCENE_LABEL[s]}</Radio>)}
              </Radio.Group>
              <span className="ewb-rep-note">只改界面里的叫法，不影响功能。</span>
            </div>
            <div className="ewb-crs-field"><label htmlFor="course-term">学期或季度备注（可选）</label><Input id="course-term" data-testid="course-term" value={termNote} maxLength={100} onChange={e => setTermNote(e.target.value)} placeholder="例如：2026 秋季" style={{ maxWidth: 360 }} /></div>
            {!(srcs.length > 0 && srcs.every(x => x.fromDoc?.aiOrganised)) && <div className="ewb-crs-field">
              <span className="ewb-crs-field__label">怎么认出每一列是什么</span>
              <Radio.Group data-testid="course-mode" value={mode} onChange={e => setMode(e.target.value)}>
                <Radio value="ai" data-testid="course-mode-ai">让 AI 帮忙认列{aiReady ? '' : '（还没配置 AI 服务，会按表头文字猜）'}</Radio>
                <Radio value="manual" data-testid="course-mode-manual">手动指定每一列</Radio>
              </Radio.Group>
            </div>}
          </div>
          <UsageNote kind="caution" title="隐私">{srcs.some(x => x.fromDoc?.aiOrganised)
            ? '文件里的文字会发送给你在“AI 服务”里设置的模型来整理成表格；不会发给卷知开发者。AI 只能照抄原文，找不到原文的课会被去掉。'
            : '课程内容会发送给你在“AI 服务”里设置的模型来帮忙整理；不会发给卷知开发者。AI 只判断哪一列是什么，不会改写表格里的内容。不想发送：选“手动指定每一列”。'}</UsageNote>
          <div className="ewb-rep-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <Btn tone="primary" disabled={!srcs.length} loading={busy} data-testid="course-next" onClick={goStep2}>{direct ? '下一步：核对整理结果' : '开始整理'}</Btn>
          </div>
        </div>
      )}

      {step === 2 && src && (
        <div data-testid="course-step2">
          <p className="ewb-crs-headline" style={{ fontSize: 'var(--ewb-fs-lg)' }} data-testid="course-summary">{summary}</p>
          {!replace && <div className="ewb-crs-field"><label htmlFor="course-name-2">名称</label><Input id="course-name-2" data-testid="course-name-2" value={name} maxLength={60} onChange={e => setName(e.target.value)} style={{ maxWidth: 360 }} /></div>}
          {src.fromDoc && <UsageNote kind="caution" data-testid="course-doc-warning">{src.fromDoc.aiOrganised ? `这张表是 AI 从 ${src.fromDoc.label} 里整理出来的，可能漏课或认错，请对照原文件核对后再保存。` : `这张表直接取自 ${src.fromDoc.label} 里的表格，请核对后再保存。`}</UsageNote>}
          {replace && diff && <UsageNote kind="tip" data-testid="course-diff">相对现有的「{replace.name}」：新增 {diff.added} 课、修改 {diff.changed} 课、删除 {diff.removed} 课；已有的知识点对应里 {diff.affectedMaps} 条涉及改动的课，需要重新匹配。老师确认过的对应只要课还在就保留{diff.lockedLost > 0 ? `；但有 ${diff.lockedLost} 条确认过的对应会因为课被删而丢失` : ''}。替换后需要整体重新匹配。</UsageNote>}
          {Object.values(sugg).some(s => s.error) && <UsageNote kind="caution">{Object.values(sugg).filter(s => s.error).map(s => s.error).filter((x, i, a) => a.indexOf(x) === i).join('；')}</UsageNote>}
          {warnings.length > 0 && (
            <UsageNote kind="caution" title="需要你看一眼" data-testid="course-warnings">
              <ul className="ewb-crs-warnings">{warnings.slice(0, 8).map((x, i) => <li key={i}>{x.text}</li>)}{warnings.length > 8 && <li>还有 {warnings.length - 8} 条……</li>}</ul>
            </UsageNote>
          )}

          <h4 style={{ margin: '12px 0 4px' }}>每一列是什么</h4>
          <div className="ewb-rep-row" style={{ marginBottom: 6 }}>
            {src.sheets.filter(s => !s.hidden).length > 1 && (
              <select aria-label="工作表" className="ant-input" style={{ width: 'auto' }} data-testid="course-sheet" value={sheetName} onChange={e => setSheetName(e.target.value)}>
                {src.sheets.filter(s => !s.hidden).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            )}
            <label className="ewb-rep-note">表头占几行 <input type="number" min={0} max={10} aria-label="表头行数" data-testid="course-header-rows" value={curMap?.headerRows ?? 1} onChange={e => setMap(m => ({ ...m, headerRows: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))} className="ant-input" style={{ width: 64, display: 'inline-block' }} /></label>
            {curMap?.uncertain.length ? <span className="ewb-rep-note">AI 拿不准：{curMap.uncertain.join('；')}</span> : null}
          </div>
          <div className="ewb-crs-sheetbox" data-testid="course-strip">
            <table className="ewb-crs-sheet">
              <thead><tr>{Array.from({ length: nCols }, (_, c) => (
                <th key={c}>
                  <select aria-label={`第 ${c + 1} 列的类型`} data-testid={`course-col-${c}`} value={colField(c)} onChange={e => setColField(c, e.target.value)} className="ant-input" style={{ width: '100%', minWidth: 96 }}>
                    <option value="">未识别</option>
                    {FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </th>
              ))}</tr></thead>
              <tbody>{headRows.slice(0, 6).map((r, ri) => <tr key={ri}>{Array.from({ length: nCols }, (_, c) => <td key={c} data-header={ri < (curMap?.headerRows ?? 1)}>{r[c] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <p className="ewb-rep-note" style={{ marginTop: 4 }}>灰底的是表头行。改了列类型或表头行数，下面的预览会重新套用整张表（不会再问 AI）。价格、费用类的列会自动忽略，卷知不使用价格信息。</p>

          <h4 style={{ margin: '16px 0 4px' }}>整理出的课</h4>
          {levels.length === 0 ? <UsageNote kind="mistake">还没有识别出任何一课。可以调整上面的表头行数和列类型，或下载模板整理一份再上传。</UsageNote> : (
            <div className="ewb-crs-split">
              <div className="ewb-crs-levels" data-testid="course-levels">
                {levels.map((l, i) => (
                  <button key={i} type="button" className="ewb-crs-level" aria-current={i === levelIdx} data-testid={`course-level-${i}`} onClick={() => setLevelIdx(i)}>
                    <span>{l.name}</span><span>{l.lessons.length} 课</span>
                  </button>
                ))}
              </div>
              <div>
                {level && (
                  <>
                    <div className="ewb-rep-row" style={{ marginBottom: 6 }}>
                      <Input size="small" aria-label={`${w.level}名称`} data-testid="course-level-name" value={level.name} maxLength={60} style={{ width: 200 }}
                        onChange={e => edit(ls => { ls[levelIdx].name = e.target.value; return ls })} />
                      <Btn tone="quiet" size="small" disabled={levelIdx === 0} onClick={() => { edit(ls => { const [x] = ls.splice(levelIdx, 1); ls.splice(levelIdx - 1, 0, x); return ls }); setLevelIdx(levelIdx - 1) }}>上移</Btn>
                      <Btn tone="quiet" size="small" disabled={levelIdx >= levels.length - 1} onClick={() => { edit(ls => { const [x] = ls.splice(levelIdx, 1); ls.splice(levelIdx + 1, 0, x); return ls }); setLevelIdx(levelIdx + 1) }}>下移</Btn>
                      <Btn tone="quiet" size="small" disabled={levelIdx === 0} data-testid="course-level-merge" onClick={() => { edit(ls => { const [x] = ls.splice(levelIdx, 1); ls[levelIdx - 1].lessons.push(...x.lessons); return ls }); setLevelIdx(levelIdx - 1) }}>并入上一个{w.level}</Btn>
                      <Btn tone="danger" size="small" data-testid="course-level-delete" onClick={() => { edit(ls => { ls.splice(levelIdx, 1); return ls }); setLevelIdx(0) }}>删除这个{w.level}</Btn>
                    </div>
                    <div className="ewb-crs-sheetbox" data-testid="course-lessons">
                      <table className="ewb-crs-sheet">
                        <thead><tr><th>课次</th><th>标题</th><th>主题</th><th>教材对标</th><th>要点</th><th /></tr></thead>
                        <tbody>{level.lessons.map((l, i) => (
                          <tr key={i} data-testid={`course-lesson-${i}`}>
                            <td><input aria-label="课次" value={l.noLabel} onChange={e => setLesson(i, { noLabel: e.target.value, seq: Number((/\d+/.exec(e.target.value) ?? [l.seq])[0]) })} /></td>
                            <td><input aria-label="标题" data-testid={`course-lesson-title-${i}`} value={l.title} onChange={e => setLesson(i, { title: e.target.value })} /></td>
                            <td><input aria-label="主题" value={l.theme} onChange={e => setLesson(i, { theme: e.target.value })} /></td>
                            <td><input aria-label="教材对标" value={l.textbookRef} onChange={e => setLesson(i, { textbookRef: e.target.value })} /></td>
                            <td>{l.points.map(p => `${p.label}：${p.text}`).join('；')}</td>
                            <td><Btn tone="quiet" size="small" onClick={() => edit(ls => { ls[levelIdx].lessons.splice(i, 1); return ls })}>删除</Btn></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <Btn tone="quiet" size="small" style={{ marginTop: 4 }} onClick={() => edit(ls => { const last = ls[levelIdx].lessons; last.push({ seq: (last[last.length - 1]?.seq ?? 0) + 1, noLabel: String((last[last.length - 1]?.seq ?? 0) + 1), title: '', theme: '', textbookRef: '', points: [], raw: {} }); return ls })}>加一课</Btn>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="ewb-rep-row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            {job ? <span /> : <Btn tone="secondary" onClick={() => setStep(1)}>上一步</Btn>}
            <Btn tone="primary" loading={saving} disabled={totalLessons === 0} data-testid="course-save" onClick={save}>{replace ? '替换并保存' : '保存课程体系'}</Btn>
          </div>
        </div>
      )}

      </div>
      <Modal open={!!collide} onCancel={() => setCollide(null)} title={`已经有一个叫「${collide?.name ?? ''}」的${w.outline}`} footer={null} destroyOnHidden>
        <div data-testid="course-collide">
        <p>要替换它，还是另存为一个新的？替换时会按“级别 + 课次”比对，已确认的知识点对应只要课还在就保留。</p>
        <div className="ewb-rep-row" style={{ justifyContent: 'flex-end' }}>
          <Btn tone="secondary" onClick={() => setCollide(null)}>取消</Btn>
          <Btn tone="secondary" data-testid="course-collide-new" onClick={() => void doSave(undefined, `${name.trim()}（新）`.slice(0, 60))}>另存为新体系</Btn>
          <Btn tone="primary" data-testid="course-collide-replace" onClick={() => { const c = collide!; setCollide(null); void doSave(c.id) }}>替换「{collide?.name}」</Btn>
        </div>
        </div>
      </Modal>
    </Modal>
  )
}
