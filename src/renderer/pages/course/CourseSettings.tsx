import React, { useState } from 'react'
import { useSubject } from '../../subject/SubjectContext'
import { App, Drawer, Input, Popconfirm, Table, Tabs } from 'antd'
import { Plus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, EmptyState, Panel, UsageNote } from '../../design'
import MatchBox, { MATCH_LABEL, clean } from '../../components/CourseMatch'
import CourseWizard from './CourseWizard'
import TextbookAdd from './TextbookAdd'
import LessonPicker from './LessonPicker'
import { groupByTerm, searchOutlines } from '../../../shared/report-course-pick'
import { CONF_LABEL, SCENE_LABEL, lessonText, wordsOf } from './format'
import '../../design/page-report.css'
import '../../design/page-course.css'

/** 设置 → 课程大纲：课程体系卡片（启用 / 查看 / 重新上传 / 删除 / 匹配）和上传向导。数据只存在这台电脑上。 */
/** 整理中的进度文字：读教材的页、文字识别（扫描版）、按单元挑知识点、按段、按表 */
function progressText(p: CourseJob['progress']): string {
  if (!p || p.total < 1) return 'AI 整理中'
  if (p.unit === '页') return `读取教材 · ${p.done}/${p.total} 页`
  if (p.unit === '页（文字识别）') return `文字识别 · ${p.done}/${p.total} 页（扫描版较慢）`
  if (p.unit === '个单元') return `AI 整理中 · 第 ${Math.min(p.done + 1, p.total)}/${p.total} 个单元`
  if (p.total < 2) return 'AI 整理中'
  return p.unit === '段' ? `AI 整理中 · 第 ${Math.min(p.done + 1, p.total)}/${p.total} 段` : `AI 整理中 · ${p.done}/${p.total} 张表`
}

export default function CourseSettings() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { subject } = useSubject()
  const [wizard, setWizard] = useState<{ open: boolean; replace?: CourseOutlineCard; job?: CourseJob }>({ open: false })
  const [detail, setDetail] = useState<string | null>(null)
  const [addBook, setAddBook] = useState(false)
  const [q, setQ] = useState('')
  const { data: cards } = useQuery({ queryKey: ['course', 'list', subject], queryFn: () => window.api.course.list(subject) })
  // 后台整理的任务（主进程内存里）：有排队 / 整理中的就隔几秒刷新一次
  const { data: jobs } = useQuery({
    queryKey: ['course', 'jobs'], queryFn: () => window.api.course.jobs(),
    refetchInterval: q => ((q.state.data ?? []).some(j => j.status === 'queued' || j.status === 'running') ? 1500 : false)
  })
  // 搜索（名字、学期）+ 机构课程按学期分组；教材排在后面
  const found = searchOutlines(cards ?? [], q)
  const ordered: Array<{ c: CourseOutlineCard; term: string }> = [
    ...groupByTerm(found.filter(c => c.kind === 'course')).flatMap(g => g.items.map(c => ({ c, term: g.term }))),
    ...found.filter(c => c.kind !== 'course').map(c => ({ c, term: '' }))
  ]
  const refresh = () => qc.invalidateQueries({ queryKey: ['course'] })
  const tpl = async (kind: 'blank' | 'sample') => { try { const r = await window.api.course.template(kind, subject); if (r.saved) message.success(`已保存：${r.path}`) } catch (e) { message.error(clean(e)) } }
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) message.success(ok); refresh() } catch (e) { message.error(clean(e)) } }

  return (
    <div className="ewb-set-panel">
      <Panel title="我的课程大纲" data-testid="course-settings"
        aside={<span className="ewb-rep-row" style={{ gap: 8 }}>
          <Btn tone="secondary" size="small" icon={Plus} data-testid="course-add-textbook" onClick={() => setAddBook(true)}>添加学校教材</Btn>
          <Btn tone="secondary" size="small" icon={Plus} data-testid="course-add" onClick={() => setWizard({ open: true })}>添加课程大纲</Btn>
        </span>}>
        <p className="ewb-rep-note" style={{ marginBottom: 12 }}>
          课程表只存在这台电脑上；整理和匹配时，内容会发给你在“AI 服务”里设置的模型，不会发给卷知开发者。
        </p>
        {cards && cards.length === 0 && !(jobs ?? []).length && (
          <EmptyState inline title="还没有上传课程大纲" description="上传以后，看板的“课程对照”页就能用了。"
            steps={['上传课程表（.xlsx 或 .csv，也可以先下载模板）', '核对 AI 整理的结果，保存', '让 AI 把知识点对应到课，再到看板里看']}
            action={<span className="ewb-rep-row" style={{ justifyContent: 'center' }}>
              <Btn tone="primary" data-testid="course-add-empty" onClick={() => setWizard({ open: true })}>添加课程大纲</Btn>
              <Btn tone="secondary" data-testid="course-empty-blank" onClick={() => void tpl('blank')}>下载空白模板</Btn>
              <Btn tone="secondary" data-testid="course-empty-sample" onClick={() => void tpl('sample')}>看示例</Btn>
            </span>} />
        )}
        {(cards ?? []).length > 0 && <Input.Search allowClear style={{ maxWidth: 360, marginBottom: 12 }} data-testid="course-search" placeholder="搜大纲名字或学期" value={q} onChange={e => setQ(e.target.value)} />}
        <div className="ewb-crs-cards" data-testid="course-cards">
          {(jobs ?? []).map(j => (
            <article key={j.id} className="ewb-crs-card" data-testid={`course-job-${j.id}`} data-status={j.status}>
              <div className="ewb-crs-card__head">
                <span className="ewb-crs-card__name" data-testid="course-job-name">{j.fileName}</span>
                {j.replaceId && <span className="ewb-ana-pill ewb-ana-pill--quiet">替换「{(cards ?? []).find(c => c.id === j.replaceId)?.name ?? j.name}」</span>}
                <span className={`ewb-ana-pill${j.status === 'failed' ? ' ewb-ana-pill--warn' : ''}`} data-testid="course-job-state">
                  {{ queued: '排队中', running: progressText(j.progress), ready: '待核对', failed: '整理失败' }[j.status]}
                </span>
              </div>
              {j.status === 'running' && j.progress?.note && <div className="ewb-crs-card__meta"><span data-testid="course-job-note">{j.progress.note}</span></div>}
              {j.status === 'failed' && <div className="ewb-crs-card__meta"><span data-testid="course-job-error">{j.error || '没有整理成功'}</span></div>}
              <div className="ewb-crs-card__actions">
                {j.status === 'ready' && <Btn tone="primary" size="small" data-testid="course-job-review"
                  onClick={() => setWizard({ open: true, job: j, replace: j.replaceId ? (cards ?? []).find(c => c.id === j.replaceId) : undefined })}>核对并保存</Btn>}
                {j.status === 'failed' && <Btn tone="secondary" size="small" data-testid="course-job-retry" onClick={() => run(() => window.api.course.jobRetry(j.id))}>重试</Btn>}
                {(j.status === 'queued' || j.status === 'running') && <Btn tone="secondary" size="small" data-testid="course-job-cancel" onClick={() => run(() => window.api.course.jobCancel(j.id))}>取消</Btn>}
                {(j.status === 'ready' || j.status === 'failed') && <Btn tone="quiet" size="small" data-testid="course-job-remove" onClick={() => run(() => window.api.course.jobRemove(j.id))}>移除</Btn>}
              </div>
            </article>
          ))}
          {q && ordered.length === 0 && (cards ?? []).length > 0 && <p className="ewb-rep-note" data-testid="course-search-none">没有找到名字或学期里带「{q}」的大纲。</p>}
          {ordered.map(({ c, term }, i, arr0) => {
            const arr = arr0.map(x => x.c)
            const termHead = c.kind === 'course' && (i === 0 || arr0[i - 1].term !== term) && new Set(arr0.filter(x => x.c.kind === 'course').map(x => x.term)).size > 1
            const w = wordsOf(c.scene)
            const both = arr.some(x => x.kind === 'course') && arr.some(x => x.kind === 'textbook')
            const head = both && (i === 0 || arr[i - 1].kind !== c.kind)
            return (
              <React.Fragment key={c.id}>
              {termHead && <h5 className="ewb-crs-group" data-testid="course-term-group" style={{ margin: '8px 0 4px', fontWeight: 500 }}>{term}</h5>}
              {head && <h4 className="ewb-crs-group" data-testid={`course-group-${c.kind}`}>{c.kind === 'course' ? '机构课程' : '学校教材'}（{arr.filter(x => x.kind === c.kind).length}）</h4>}
              <article className="ewb-crs-card" data-testid={`course-card-${c.id}`} data-draft={c.status === 'draft'} data-match={c.match.state}>
                <div className="ewb-crs-card__head">
                  <span className="ewb-crs-card__name" data-testid="course-card-name">{c.name}</span>
                  <span className="ewb-ana-pill ewb-ana-pill--quiet" data-testid="course-kind-tag" data-kind={c.kind}>{c.kind === 'textbook' ? (c.builtinId ? '学校教材 · 内置' : '学校教材') : (SCENE_LABEL[c.scene as keyof typeof SCENE_LABEL] ?? '机构课程')}</span>
                  {c.status === 'draft' && <span className="ewb-ana-pill ewb-ana-pill--warn" data-testid="course-draft-tag">草稿 · 还没确认，不参与对照</span>}
                </div>
                <div className="ewb-crs-card__meta">
                  <span>{c.levels} 个{w.level} · {c.lessons} 课</span>
                  {c.termNote && <span>{c.termNote}</span>}
                  <span>上传于 {c.createdAt}</span>
                  {c.status === 'active' && <span data-testid="course-match-state" className="ewb-ana-pill">{MATCH_LABEL[c.match.state]}</span>}
                </div>
                {c.status === 'draft' ? (
                  <UsageNote kind="caution">这是用命令行导入的草稿：AI 认列的结果还没有人核对过。请点“查看”核对课次，没问题就点“确认使用”。</UsageNote>
                ) : (
                  c.builtinId ? <p className="ewb-rep-note" style={{ margin: 0 }}>知识点对应来自内置目录，不需要 AI 匹配。</p> : <MatchBox card={c} />
                )}
                <div className="ewb-crs-card__actions">
                  {c.status === 'active' && (
                    <Btn tone="secondary" size="small" data-testid="course-active" data-active={c.active ? '1' : '0'} onClick={() => run(() => window.api.course.setActive(c.id, !c.active), c.active ? '已停用：不再出现在报告和对照里' : '已启用')}>{c.active ? '停用' : '启用'}</Btn>
                  )}
                  {c.status === 'draft' && <Btn tone="primary" size="small" data-testid="course-confirm-draft" onClick={() => run(() => window.api.course.confirmDraft(c.id), '已确认，现在可以参与对照了')}>确认使用</Btn>}
                  <Btn tone="secondary" size="small" data-testid="course-view" onClick={() => setDetail(c.id)}>查看</Btn>
                  {c.builtinId
                    ? <Popconfirm title="重新从内置目录更新？" description="单元和知识点对应会按当前内置目录重写；你手工改过的对应会被覆盖。" okText="更新" cancelText="取消" onConfirm={() => run(() => window.api.course.refreshBuiltin(c.id, true), '已重新从内置更新')}>
                      <Btn tone="secondary" size="small" data-testid="course-refresh-builtin">重新从内置更新</Btn>
                    </Popconfirm>
                    : <Btn tone="secondary" size="small" data-testid="course-reupload" onClick={() => setWizard({ open: true, replace: c })}>重新上传（替换）</Btn>}
                  <Popconfirm title={`删除「${c.name}」？`} description="课次和知识点对应会一起删除，不影响试卷；已经生成的报告里的课程文字是当时的快照。" okText="删除" okButtonProps={{ danger: true, 'data-testid': 'course-delete-ok' } as never} cancelText="取消"
                    onConfirm={() => run(() => window.api.course.remove(c.id), '已删除')}>
                    <Btn tone="danger" size="small" data-testid="course-delete">删除</Btn>
                  </Popconfirm>
                </div>
              </article>
              </React.Fragment>
            )
          })}
        </div>
      </Panel>
      <TextbookAdd open={addBook} onClose={() => setAddBook(false)} />
      <CourseWizard open={wizard.open} replace={wizard.replace} job={wizard.job} onClose={() => setWizard({ open: false })} />
      <CourseDetail id={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

/** 体系详情：课次一览 + 知识点对应（集中核对 / 修改） */
function CourseDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['course', 'get', id], queryFn: () => window.api.course.get(id!), enabled: !!id })
  const { data: maps } = useQuery({ queryKey: ['course', 'maps', id], queryFn: () => window.api.course.maps(id!), enabled: !!id })
  const [pick, setPick] = useState<{ code: string; name: string } | null>(null)
  // 整本教材的书库摘要（上传整本 PDF 时在后台建的；建库进度和失败原因也在这里看）
  const { data: bookRows } = useQuery({ queryKey: ['books', 'list'], queryFn: () => window.api.books.list(), enabled: !!id })
  const { data: buildRows } = useQuery({ queryKey: ['books', 'status'], queryFn: () => window.api.books.status(), enabled: !!id, refetchInterval: q => ((q.state.data ?? []).some(s => s.state === 'queued' || s.state === 'running') ? 1500 : false) })
  const book = (bookRows ?? []).find(b => b.outlineId === id) ?? null
  const building = (buildRows ?? []).find(s => s.outlineId === id && s.state !== 'done' && s.state !== 'skipped') ?? null
  const lessonBy = new Map((data?.levels ?? []).flatMap(l => l.lessons.map(x => [x.id, { ...x, levelName: l.name }] as const)))
  const edit = async (e: CourseMapEdit) => { try { await window.api.course.mapEdit(e); qc.invalidateQueries({ queryKey: ['course'] }) } catch (err) { message.error(clean(err)) } }
  const STATE: Record<string, string> = { suggested: 'AI 建议', confirmed: '已确认', rejected: '已否决' }
  const rows = (maps ?? []).map(m => ({ ...m, lesson: lessonBy.get(m.lessonId) }))
  return (
    <Drawer open={!!id} onClose={onClose} width="min(900px, 96vw)" destroyOnHidden title={data ? `${data.card.name} · ${data.card.levels} 个${wordsOf(data.card.scene).level}、${data.card.lessons} 课` : '课程体系'} data-testid="course-detail">
      {data && data.card.kind === 'textbook' && (book || building) && (
        <div className="ewb-rep-note" data-testid="book-summary" style={{ marginBottom: 12 }}>
          <b>课本原文库</b>：
          {building ? (
            building.state === 'error'
              ? <span data-testid="book-build-error">没有建成：{building.error || '原因不明'}（不影响这份教材的其他功能）</span>
              : <span data-testid="book-build-progress">{building.state === 'queued' ? '排队中' : `${building.what || '建库中'}${building.total ? ` · ${building.done}/${building.total}` : ''}`}</span>
          ) : <span data-testid="book-summary-line">{book!.summary?.line || `共 ${book!.totalPages} 页`}</span>}
        </div>
      )}
      {data && (
        <Tabs items={[
          {
            key: 'lessons', label: '课次',
            children: data.levels.map(l => (
              <section key={l.id} style={{ marginBottom: 16 }}>
                <h4 style={{ margin: '0 0 4px' }}>{l.name}（{l.lessons.length} 课）</h4>
                <Table size="small" pagination={false} rowKey="id" dataSource={l.lessons}
                  columns={[
                    { title: '课次', width: 90, render: (_, r) => lessonText({ seq: r.seq, noLabel: r.noLabel }) },
                    { title: '标题', dataIndex: 'title' },
                    { title: '主题', dataIndex: 'theme', width: 120 },
                    { title: '要点', render: (_, r) => r.points.map(p => `${p.label}：${p.text}`).join('；') },
                    { title: '教材对标', dataIndex: 'textbookRef', width: 160 }
                  ]} />
              </section>
            ))
          },
          {
            key: 'maps', label: `知识点对应（${rows.length}）`,
            children: rows.length === 0 ? <p className="ewb-rep-note">还没有匹配结果。回到设置页点“开始匹配”。</p> : (
              <Table size="small" pagination={{ pageSize: 15 }} rowKey={r => `${r.kp}-${r.lessonId}`} dataSource={rows} data-testid="course-maps"
                columns={[
                  { title: '知识点', dataIndex: 'kpName', width: 140 },
                  { title: '对应的课', render: (_, r) => r.lesson ? `${r.lesson.levelName} · ${lessonText(r.lesson)}` : '（课已删除）' },
                  { title: '匹配把握', width: 100, render: (_, r) => (r.state === 'rejected' ? '已否决' : r.role === 'main' ? (r.score >= 80 ? '很像' : '比较像') : r.role === 'side' ? '顺带' : '把握不高') },
                  { title: '依据', render: (_, r) => (r.evidence ? <span className="ewb-ana-meta">{r.evidence}</span> : <span className="ewb-ana-meta">{r.reason || '—'}</span>) },
                  { title: '状态', width: 90, render: (_, r) => STATE[r.state] ?? r.state },
                  {
                    title: '核对', width: 190, render: (_, r) => (
                      <span className="ewb-rep-row" style={{ gap: 4 }}>
                        <Btn tone="quiet" size="small" disabled={r.state === 'confirmed'} onClick={() => edit({ op: 'confirm', kp: r.kp, lessonId: r.lessonId })}>对</Btn>
                        <Btn tone="quiet" size="small" disabled={r.state === 'rejected'} onClick={() => edit({ op: 'reject', kp: r.kp, lessonId: r.lessonId })}>不对</Btn>
                        {(r.locked || r.state !== 'suggested') && <Btn tone="quiet" size="small" onClick={() => edit({ op: 'reset', kp: r.kp, lessonId: r.lessonId })}>撤销</Btn>}
                        <Btn tone="quiet" size="small" onClick={() => setPick({ code: r.kp, name: r.kpName })}>添加课次</Btn>
                      </span>
                    )
                  }
                ]} />
            )
          }
        ]} />
      )}
      <LessonPicker open={!!pick} kpCode={pick?.code ?? ''} kpName={pick?.name ?? ''} outlines={data ? [{ id: data.card.id, name: data.card.name }] : []} onClose={() => setPick(null)} />
    </Drawer>
  )
}

