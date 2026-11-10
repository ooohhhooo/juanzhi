import React, { useEffect, useMemo, useState } from 'react'
import { App, Drawer, Spin } from 'antd'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Download } from 'lucide-react'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import CourseAdvice from '../../stats/CourseAdvice'
import { useStatsFilter } from '../../stats/StatsFilter'
import MatchBox, { clean } from '../../components/CourseMatch'
import LessonPicker from '../course/LessonPicker'
import { CONF_LABEL, lessonFull, lessonText, wordsOf } from '../course/format'
import { Btn, EmptyState, HeatCell, UsageNote } from '../../design'
import '../../design/page-analysis.css'
import '../../design/page-course.css'

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)

/**
 * 看板「课程对照」页签（M9 §1.7）：容易出错的考点 → 对应课程 / 体系 × 级别交叉 / 常考但课程没覆盖 / 家长沟通建议。
 * 数字全部由程序算；课程对应是 AI 匹配的建议（每条都有课程原文依据），老师随时可以改，改过的不会被重新匹配覆盖。
 * “易错”指的是卷子上常见的易错点：软件里没有学生成绩，所以界面里说“容易出错”，不说“丢分”。
 */
export default function CourseTab() {
  const { filter } = useStatsFilter()
  const { message, modal } = App.useApp()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: cards, isLoading } = useQuery({ queryKey: ['course', 'list', filter.subject ?? 'english'], queryFn: () => window.api.course.list(filter.subject) })
  const usable = useMemo(() => (cards ?? []).filter(c => c.status === 'active' && c.active), [cards])
  const [picked, setPicked] = useState<string[] | null>(null)   // null = 全部启用的
  const ids = useMemo(() => (picked ?? usable.map(c => c.id)).filter(id => usable.some(c => c.id === id)), [picked, usable])
  const { data: d } = useQuery({ queryKey: ['course', 'dashboard', filter, [...ids].sort()], queryFn: () => window.api.course.dashboard({ filter, outlineIds: ids }), enabled: ids.length > 0, placeholderData: keepPreviousData })
  const [open, setOpen] = useState<{ row: CourseRow; ref: CourseLessonRef } | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [pick, setPick] = useState<{ code: string; name: string } | null>(null)
  const [cell, setCell] = useState<{ outlineId: string; levelId: number } | null>(null)
  useEffect(() => { setCell(null) }, [filter, ids.join(',')])

  if (isLoading || !cards) return <Spin style={{ margin: 40 }} />

  // 没有任何可用的大纲：教学型空状态
  if (usable.length === 0) {
    const draftOnly = cards.some(c => c.status === 'draft')
    return (
      <div data-testid="course-empty">
        <EmptyState title="这里会告诉你：丢分的考点在哪一课讲"
          description={draftOnly ? '有课程表还是草稿（命令行导入的），请先到“设置 → 课程大纲”核对并确认使用。' : cards.length ? '课程大纲都已暂停“参与对照”，到设置里打开就能用。' : '上传你自己的课程表（课程大纲、教学进度，或孩子在上的课），卷知帮你对照。'}
          steps={['上传课程表（.xlsx 或 .csv，也可以先下载模板）', '核对 AI 整理的结果', '开始匹配：让 AI 把知识点对应到课']}
          action={<span className="ewb-rep-row" style={{ justifyContent: 'center' }}>
            <Btn tone="primary" data-testid="course-go-upload" onClick={() => nav('/courses')}>去上传课程大纲</Btn>
            <Btn tone="secondary" data-testid="course-go-template" onClick={async () => { try { const r = await window.api.course.template('blank', filter.subject); if (r.saved) message.success(`已保存：${r.path}`) } catch (e) { message.error(clean(e)) } }}>下载空白模板</Btn>
          </span>} />
        <p className="ewb-rep-note" style={{ textAlign: 'center' }}>课程表只存在这台电脑上；整理和匹配时，内容会发给你在“AI 服务”里设置的模型，不会发给卷知开发者。</p>
      </div>
    )
  }

  const unmatched = usable.filter(c => ids.includes(c.id) && c.match.state !== 'done')
  const rows = d?.rows ?? []
  const outlineName = (id: string) => usable.find(c => c.id === id)?.name ?? ''
  const w = wordsOf(usable[0].scene)
  const addableOutlines = usable.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, name: c.name }))
  const edit = async (e: CourseMapEdit) => { try { await window.api.course.mapEdit(e); qc.invalidateQueries({ queryKey: ['course'] }) } catch (err) { message.error(clean(err)) } }
  // “这个考点其实没有对应的课”：有老师确认过的对应时先问，不悄悄把它们翻成“不对”
  const markNone = async (outlineId: string, kp: string) => {
    try { await window.api.course.mapEdit({ op: 'none', outlineId, kp }); qc.invalidateQueries({ queryKey: ['course'] }) } catch (err) {
      const m = clean(err)
      if (!m.startsWith('需要确认')) { message.error(m); return }
      modal.confirm({ title: '这个考点有老师确认过的对应', content: m.replace(/^需要确认：/, ''), okText: '仍然标记', cancelText: '不改', onOk: async () => { try { await window.api.course.mapEdit({ op: 'none', outlineId, kp, force: true }); qc.invalidateQueries({ queryKey: ['course'] }) } catch (e2) { message.error(clean(e2)) } } })
    }
  }
  const sceneAll = d?.outlines.every(o => o.scene === 'school')
  const where = ids.length === 1 ? `「${outlineName(ids[0])}」` : '所选课程'
  const sm = d?.summary
  const headline = d && d.ready && sm
    ? (sm.lostPoints === 0
      ? '这批试卷里还没有 AI 估计容易出错的考点，可以先看下面“常考但课程没覆盖”的部分。'
      : sm.unchecked > 0
        // 部分知识点还没匹配：只对已匹配过的下结论，另说还有几个没匹配
        ? (sm.withCourse === 0 && sm.without === 0
          ? <>这批试卷里最容易出错的 <b>{sm.lostPoints}</b> 个考点，在{where}里都还没匹配过，先点上面的“开始匹配”。</>
          : <>这批试卷里最容易出错的 <b>{sm.lostPoints}</b> 个考点，<b>{sm.withCourse}</b> 个在{where}里能找到对应的课，<b>{sm.without}</b> 个还没有课讲到；另有 <b>{sm.unchecked}</b> 个还没匹配。</>)
        : sm.without === 0
          ? <>这批试卷里最容易出错的 <b>{sm.lostPoints}</b> 个考点，在{where}里都能找到对应的课。</>
          : sm.withCourse === 0
            ? <>这批试卷里最容易出错的 <b>{sm.lostPoints}</b> 个考点，在{where}里都还没有找到对应的课。</>
            : <>这批试卷里最容易出错的 <b>{sm.lostPoints}</b> 个考点，<b>{sm.withCourse}</b> 个在{where}里能找到对应的课，<b>{sm.without}</b> 个还没有课讲到。</>)
    : null

  return (
    <div data-testid="course-tab">
      <div className="ewb-ana-toolbar">
        <span className="ewb-ana-toolbar__label">对照哪几个课程</span>
        <div className="ewb-crs-pickers" style={{ margin: 0 }}>
          {usable.map(c => (
            <button key={c.id} type="button" className="ewb-crs-pick" aria-pressed={ids.includes(c.id)} data-testid={`course-pick-${c.id}`}
              onClick={() => setPicked(ids.includes(c.id) ? ids.filter(x => x !== c.id) : [...ids, c.id])}>{c.name}</button>
          ))}
        </div>
        <Btn tone="quiet" size="small" data-testid="course-manage" onClick={() => nav('/courses')}>管理课程大纲</Btn>
      </div>

      {ids.length === 0 && <UsageNote kind="tip">请在上面点选至少一个课程。</UsageNote>}

      {unmatched.length > 0 && (
        <UsageNote kind="caution" title="还没匹配完" data-testid="course-unmatched">
          {unmatched.map(c => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <b>{c.name}</b>：{c.match.state === 'stale' ? '课程内容更新过，需要重新匹配' : c.match.state === 'partial' ? `有 ${c.match.total - c.match.checked} 个新的知识点还没匹配` : '还没有把知识点对应到课'}。{c.match.state === 'partial' ? '没匹配的知识点不算“课程没覆盖”，下面的结果可能不全。' : '匹配前，下面的数字都先不显示。'}
              <MatchBox card={c} />
            </div>
          ))}
        </UsageNote>
      )}

      {d && d.papers === 0 && <UsageNote kind="caution">当前筛选范围里没有计入统计的试卷。</UsageNote>}
      {d && d.ready && d.papers > 0 && (
        <>
          <h3 className="ewb-crs-headline" data-testid="course-headline">{headline}</h3>
          <p className="ewb-rep-note">课程对应是 AI 匹配的结果（点课程可以看到课里的原文依据），请教研 / 老师核对；它说明“哪些课涉及这些考点”，不是“学完就能提分”。</p>

          {/* 块 1 */}
          <section className="ewb-crs-block" data-testid="course-block1">
            <h4 className="ewb-crs-block__title">容易出错的考点 → 对应课程 <span className="ewb-ana-meta">按 AI 估计的易错题数排序，再补上“重难点”里排在最前面的考点</span></h4>
            {rows.length === 0 && <p className="ewb-rep-note">没有 AI 估计容易出错的考点。</p>}
            {rows.map(r => (
              <div key={r.code} className="ewb-crs-row" data-testid={`course-row-${r.code}`} data-main={r.main.length}>
                <div className="ewb-crs-row__kp">
                  <span className="ewb-ana-kpname">{r.name}</span>
                  <span className="ewb-crs-row__tags">
                    {r.tags.map(t => <span key={t} className={`ewb-ana-pill ${t === '易错' ? 'ewb-ana-pill--red' : 'ewb-ana-pill--primary'}`}>{t}{t === '易错' ? `（估计 ${r.errorCount} 道）` : ''}</span>)}
                    <span className="ewb-ana-meta">{r.papers}/{r.paperTotal} 份卷子考了</span>
                  </span>
                  {r.plain && <span className="ewb-ana-meta">{r.plain}</span>}
                </div>
                <div>
                  {r.main.length > 0 ? (
                    <div className="ewb-crs-chips">
                      {r.main.slice(0, 3).map(m => (
                        <button key={m.lessonId} type="button" className="ewb-crs-chip" data-maybe={m.state !== 'confirmed' && m.confidence === 'medium'} data-testid="course-chip" onClick={() => setOpen({ row: r, ref: m })}>
                          {lessonFull(m)}{m.state === 'confirmed' ? ' · 已确认' : m.confidence === 'medium' ? ' · 可能' : ''}
                        </button>
                      ))}
                      {r.main.length > 3 && <span className="ewb-ana-meta">+{r.main.length - 3} 课：{r.main.slice(3).map(m => lessonText(m)).join('、')}</span>}
                    </div>
                  ) : (
                    <div className="ewb-rep-row" style={{ gap: 8 }}>
                      <span className="ewb-ana-meta" data-testid="course-none">没有找到对应的课</span>
                      <Btn tone="quiet" size="small" data-testid="course-know" onClick={() => setPick({ code: r.code, name: r.name })}>我知道是哪一课</Btn>
                    </div>
                  )}
                  {r.maybe.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="ewb-ana-meta" style={{ cursor: 'pointer' }}>可能相关（待确认）{r.maybe.length} 课</summary>
                      <div className="ewb-crs-chips" style={{ marginTop: 4 }}>
                        {r.maybe.map(m => <button key={m.lessonId} type="button" className="ewb-crs-chip" data-low="true" onClick={() => setOpen({ row: r, ref: m })}>{lessonFull(m)} · {CONF_LABEL[m.confidence]}</button>)}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </section>

          {/* 块 2 */}
          <section className="ewb-crs-block" data-testid="course-block2">
            <h4 className="ewb-crs-block__title">{w.outline} × {w.level} <span className="ewb-ana-meta">格子里是涉及的易错考点数，下面小字是这些考点约占本范围分值的多少</span></h4>
            {(() => {
              const levelNames = [...new Set(d.outlines.flatMap(o => o.levels.map(l => l.name)))]
              const max = Math.max(1, ...d.cross.map(c => c.kpCount))
              return (
                <div className="ewb-crs-heat">
                  <table data-testid="course-cross">
                    <thead><tr><th>{w.outline}</th>{levelNames.map(n => <th key={n}>{n}</th>)}</tr></thead>
                    <tbody>{d.outlines.map(o => (
                      <tr key={o.id}>
                        <td>{o.name}</td>
                        {levelNames.map(n => {
                          const lv = o.levels.find(l => l.name === n)
                          const c = lv && d.cross.find(x => x.outlineId === o.id && x.levelId === lv.id)
                          if (!c) return <td key={n}>—</td>
                          return (
                            <td key={n}>
                              <button type="button" data-testid={`course-cell-${o.id}-${lv!.id}`} aria-label={`${o.name} ${n}：涉及 ${c.kpCount} 个易错考点`} onClick={() => setCell({ outlineId: o.id, levelId: lv!.id })}>
                                <HeatCell rate={c.kpCount / max}>{c.kpCount} 个</HeatCell>
                                <small>{c.scoreShare === null ? '没有分值数据' : `约占分值 ${pct(c.scoreShare)}`}</small>
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )
            })()}
            {cell && (() => {
              const c = d.cross.find(x => x.outlineId === cell.outlineId && x.levelId === cell.levelId)
              const list = rows.filter(r => c?.codes.includes(r.code))
              return (
                <div style={{ marginTop: 8 }} data-testid="course-cell-detail">
                  <b>{outlineName(cell.outlineId)} · {c?.levelName}</b> 涉及这些易错考点：
                  <ul className="ewb-rep-list-ul">{list.map(r => <li key={r.code}>{r.name}：{r.main.filter(m => m.levelId === cell.levelId).map(m => lessonText(m)).join('、')}</li>)}</ul>
                </div>
              )
            })()}
            <p className="ewb-rep-note" style={{ marginTop: 6 }}>这是“哪些课涉及这些考点”，不是“学完就能提分”。</p>
          </section>

          {/* 块 3 */}
          <section className="ewb-crs-block" data-testid="course-block3">
            <h4 className="ewb-crs-block__title">{sceneAll ? '教学进度里没有安排的常考点' : '常考但课程没覆盖'}
              {d.gaps.computed && d.gaps.rows.length > 0 && <Btn tone="quiet" size="small" icon={Download} data-testid="course-export-gaps" onClick={async () => { try { const r = await window.api.course.exportGaps({ filter, outlineIds: ids }); if (r.saved) message.success(`已导出 ${r.rows} 个考点：${r.path}`) } catch (e) { message.error(clean(e)) } }}>导出 CSV</Btn>}
            </h4>
            {d.gaps.smallSample ? <UsageNote kind="caution" data-testid="course-gaps-small">卷子少于 3 份，样本太少，不下“课程没覆盖”的结论。</UsageNote>
              : d.gaps.rows.length === 0 ? <p className="ewb-rep-note" data-testid="course-gaps-none">在至少 {d.gaps.minPapers} 份卷子里出现的考点，所选课程里都能找到对应的课。</p>
                : (
                  <>
                    <p className="ewb-rep-note">下面是在至少 {d.gaps.minPapers} 份卷子里出现、却没有找到对应课的考点（AI 匹配的结果，请教研核对）。</p>
                    {d.gaps.rows.map(g => (
                      <div key={g.code} className="ewb-crs-row" data-testid={`course-gap-${g.code}`}>
                        <div className="ewb-crs-row__kp"><span className="ewb-ana-kpname">{g.name}</span><span className="ewb-ana-meta">{g.papers}/{g.paperTotal} 份卷子考了{g.errorCount > 0 ? ` · AI 估计 ${g.errorCount} 道容易出错` : ''}</span></div>
                        <div className="ewb-rep-row"><span className="ewb-ana-meta">没有找到对应的课</span><Btn tone="quiet" size="small" onClick={() => setPick({ code: g.code, name: g.name })}>其实有对应课</Btn></div>
                      </div>
                    ))}
                  </>
                )}
          </section>

          {/* 块 4 */}
          <section className="ewb-crs-block" data-testid="course-block4">
            <h4 className="ewb-crs-block__title">家长沟通建议 <span className="ewb-ana-meta">AI 草稿 · 请核对后再发给家长</span></h4>
            <CourseAdvice scope={{ kind: 'course_advice', filter, outlineIds: ids }} />
          </section>
        </>
      )}

      <Drawer open={!!open} onClose={() => setOpen(null)} width="min(640px, 94vw)" destroyOnHidden title="课程详情" data-testid="course-drawer">
        {open && <LessonDrawer row={open.row} lesson={open.ref} filter={filter} onView={setView} onEdit={async e => { await edit(e); setOpen(null) }} onNone={() => { void markNone(open.ref.outlineId, open.row.code); setOpen(null) }} />}
      </Drawer>
      <PageViewer target={view} onClose={() => setView(null)} />
      <LessonPicker open={!!pick} kpCode={pick?.code ?? ''} kpName={pick?.name ?? ''} outlines={addableOutlines} onClose={() => setPick(null)} />
    </div>
  )
}

function LessonDrawer({ row, lesson: m, filter, onView, onEdit, onNone }: { row: CourseRow; lesson: CourseLessonRef; filter: StatsFilter; onView: (t: ViewTarget) => void; onEdit: (e: CourseMapEdit) => Promise<void>; onNone: () => void }) {
  const { data: detail } = useQuery({ queryKey: ['course', 'get', m.outlineId], queryFn: () => window.api.course.get(m.outlineId) })
  const { data: qs } = useQuery({ queryKey: ['stats', 'kpQuestions', filter, { kind: 'filter' }, row.code, 3], queryFn: () => window.api.stats.questions(filter, { kind: 'filter' }, row.code, 3) })
  const full = detail?.levels.flatMap(l => l.lessons).find(l => l.id === m.lessonId)
  return (
    <div>
      <h4 style={{ margin: '0 0 4px' }}>{lessonFull(m)}</h4>
      <p className="ewb-rep-note">对应的考点：<b>{row.name}</b> · {CONF_LABEL[m.confidence]}{m.state === 'confirmed' ? ' · 老师已确认' : m.source === 'manual' ? ' · 老师手工指定' : ' · AI 建议'}</p>
      {full && (
        <dl className="ewb-ana-drawer-stats" data-testid="course-lesson-info">
          {full.theme && <div><dt>主题</dt> <dd>{full.theme}</dd></div>}
          {full.points.map((p, i) => <div key={i}><dt>{p.label}</dt> <dd>{p.text}</dd></div>)}
          {full.textbookRef && <div><dt>教材对标</dt> <dd>{full.textbookRef}</dd></div>}
        </dl>
      )}
      {m.reason && <p className="ewb-rep-note">AI 的理由：{m.reason}</p>}
      {m.quote && <blockquote className="ewb-crs-quote" data-testid="course-quote">课程里的原文依据：“{m.quote}”</blockquote>}
      {!m.quote && m.source === 'ai' && <UsageNote kind="caution">AI 没有给出课程里的原文依据，只是凭主题推测的，请老师核对。</UsageNote>}
      <div className="ewb-rep-row" style={{ margin: '12px 0' }}>
        <Btn tone="secondary" size="small" data-testid="course-confirm-map" disabled={m.state === 'confirmed'} onClick={() => onEdit({ op: 'confirm', kp: m.kp, lessonId: m.lessonId })}>对</Btn>
        <Btn tone="secondary" size="small" data-testid="course-reject-map" onClick={() => onEdit({ op: 'reject', kp: m.kp, lessonId: m.lessonId })}>不对</Btn>
        <Btn tone="quiet" size="small" data-testid="course-none-map" onClick={onNone}>这个考点其实没有对应的课</Btn>
      </div>
      <h4 style={{ margin: '16px 0 4px' }}>这个考点在原卷里（最多 3 题）</h4>
      {(qs ?? []).map(q => <QuestionCardView key={q.id} q={q} onView={onView} />)}
      {qs && qs.length === 0 && <p className="ewb-rep-note">当前范围里没有这个考点的题。</p>}
    </div>
  )
}
