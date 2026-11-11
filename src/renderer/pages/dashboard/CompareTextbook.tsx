import React, { useEffect, useMemo, useState } from 'react'
import { App, Spin } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Copy, Download } from 'lucide-react'
import { useStatsFilter } from '../../stats/StatsFilter'
import { clean } from '../../components/CourseMatch'
import { Btn, EmptyState, UsageNote } from '../../design'
import '../../design/page-analysis.css'
import '../../design/page-course.css'

/**
 * 看板「机构课程 vs 学校教材」：选一份机构课程 + 一册或几册学校教材。
 * 教材每个单元考到的知识点，机构课程哪几课讲到了、哪些没讲到；机构课讲了而教材里没有的；再叠加试卷里出现的份数，把“学校常考、机构课没覆盖”的排在最前。
 * 数字全部由程序算；机构课程的知识点对应是 AI 匹配的结果，请教研核对。
 */
export default function CompareTextbook() {
  const { filter } = useStatsFilter()
  const { message } = App.useApp()
  const nav = useNavigate()
  const { data: cards, isLoading } = useQuery({ queryKey: ['course', 'list', filter.subject ?? 'english'], queryFn: () => window.api.course.list(filter.subject) })
  const courses = useMemo(() => (cards ?? []).filter(c => c.kind === 'course' && c.status === 'active'), [cards])
  const books = useMemo(() => (cards ?? []).filter(c => c.kind === 'textbook' && c.status === 'active'), [cards])
  const [courseId, setCourseId] = useState<string>('')
  const [bookIds, setBookIds] = useState<string[] | null>(null)   // null = 全部教材
  const cid = courses.some(c => c.id === courseId) ? courseId : (courses[0]?.id ?? '')
  const bids = useMemo(() => (bookIds ?? books.map(b => b.id)).filter(id => books.some(b => b.id === id)), [bookIds, books])
  useEffect(() => { if (courseId && !courses.some(c => c.id === courseId)) setCourseId('') }, [courses, courseId])
  const scope = { filter, courseId: cid, textbookIds: bids }
  const { data: r, isFetching } = useQuery({ queryKey: ['course', 'compare', filter, cid, [...bids].sort()], queryFn: () => window.api.course.compare(scope), enabled: !!cid && bids.length > 0 })

  if (isLoading || !cards) return <Spin style={{ margin: 40 }} />
  if (courses.length === 0 || books.length === 0) {
    return (
      <div data-testid="compare-empty">
        <EmptyState title="对比机构课程和学校教材"
          description={courses.length === 0 ? '先上传一份机构课程大纲，再添加学校教材，就能看到课程和学校进度哪里对得上、哪里对不上。' : '还没有添加学校教材。内置了常见版本的目录，选版本和年级就能添加。'}
          steps={['上传机构课程大纲，并让 AI 把知识点对应到课', '添加学校教材（内置目录，选版本、年级和上下册）', '回到这里选一份课程和几册教材，查看覆盖情况']}
          action={<Btn tone="primary" data-testid="compare-go-courses" onClick={() => nav('/courses')}>去课程大纲</Btn>} />
      </div>
    )
  }
  const toggle = (id: string) => setBookIds(bids.includes(id) ? bids.filter(x => x !== id) : [...bids, id])
  const s = r?.summary
  const exportCsv = async () => { try { const x = await window.api.course.compareExport(scope); if (x.saved) message.success(`已导出：${x.path}`) } catch (e) { message.error(clean(e)) } }
  const copy = async () => { try { const x = await window.api.course.compareCopy(scope); message.success(`已复制（${x.chars} 字）`) } catch (e) { message.error(clean(e)) } }

  return (
    <div data-testid="compare-textbook">
      <div className="ewb-ana-toolbar">
        <span className="ewb-ana-toolbar__label">机构课程</span>
        <div className="ewb-crs-pickers" style={{ margin: 0 }}>
          {courses.map(c => <button key={c.id} type="button" className="ewb-crs-pick" aria-pressed={c.id === cid} data-testid={`compare-course-${c.id}`} onClick={() => setCourseId(c.id)}>{c.name}</button>)}
        </div>
      </div>
      <div className="ewb-ana-toolbar">
        <span className="ewb-ana-toolbar__label">学校教材</span>
        <div className="ewb-crs-pickers" style={{ margin: 0 }}>
          {books.map(b => <button key={b.id} type="button" className="ewb-crs-pick" aria-pressed={bids.includes(b.id)} data-testid={`compare-book-${b.id}`} onClick={() => toggle(b.id)}>{b.name}</button>)}
        </div>
        <Btn tone="quiet" size="small" onClick={() => nav('/courses')}>管理课程大纲</Btn>
      </div>
      {bids.length === 0 && <UsageNote kind="tip">请至少点选一份学校教材。</UsageNote>}
      {isFetching && !r && <Spin style={{ margin: 24 }} />}
      {r && !r.ready && r.reason && <UsageNote kind="caution" data-testid="compare-reason">{r.reason}</UsageNote>}
      {r && r.ready && s && (
        <>
          <h3 className="ewb-crs-headline" data-testid="compare-headline">
            所选教材共考到 <b>{s.textbookKps}</b> 个知识点：机构课程讲到了 <b data-testid="compare-covered">{s.covered}</b> 个，<b data-testid="compare-uncovered">{s.uncovered}</b> 个没有讲到
            {!r.smallSample && s.priority > 0 && <>，其中 <b data-testid="compare-priority-count">{s.priority}</b> 个是学校常考的</>}。
          </h3>
          <p className="ewb-rep-note">“讲到”看的是机构课程里 AI 匹配的结果（高 / 中把握或老师确认过的），请教研核对；“学校常考”指在当前筛选范围的不少于 {r.minPapers} 份卷子里出现。
            <span className="ewb-rep-row" style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
              <Btn tone="quiet" size="small" icon={Download} data-testid="compare-export" onClick={exportCsv}>导出 CSV</Btn>
              <Btn tone="quiet" size="small" icon={Copy} data-testid="compare-copy" onClick={copy}>复制成文字</Btn>
            </span>
          </p>
          {r.smallSample && <UsageNote kind="caution">卷子少于 3 份，样本太少，不标“学校常考”。</UsageNote>}

          <section className="ewb-crs-block" data-testid="compare-priority">
            <h4 className="ewb-crs-block__title">学校常考、机构课没讲到的 <span className="ewb-ana-meta">优先补</span></h4>
            {r.priority.length === 0 ? <p className="ewb-rep-note" data-testid="compare-priority-none">{r.smallSample ? '试卷太少，暂不判断。' : '没有：学校常考的知识点，机构课程都讲到了。'}</p>
              : r.priority.map(p => (
                <div key={p.code} className="ewb-crs-row" data-testid={`compare-priority-${p.code}`}>
                  <div className="ewb-crs-row__kp"><span className="ewb-ana-kpname">{p.name}</span><span className="ewb-ana-meta">{p.papers}/{p.paperTotal} 份卷子考了{p.errorCount > 0 ? ` · AI 估计 ${p.errorCount} 道容易出错` : ''}</span></div>
                  <span className="ewb-ana-meta">教材里：{p.units.slice(0, 3).join('、')}{p.units.length > 3 ? ` 等 ${p.units.length} 处` : ''}</span>
                </div>
              ))}
          </section>

          <section className="ewb-crs-block" data-testid="compare-units">
            <h4 className="ewb-crs-block__title">教材每个单元的覆盖情况 <span className="ewb-ana-meta">绿色 = 机构课程讲到了，红色 = 没讲到</span></h4>
            {r.units.map(u => (
              <div key={u.lessonId} className="ewb-crs-row" data-testid={`compare-unit-${u.lessonId}`} data-covered={u.covered} data-total={u.total}>
                <div className="ewb-crs-row__kp">
                  <span className="ewb-ana-kpname">{u.levelName} · {u.label}</span>
                  <span className="ewb-ana-meta">{u.total === 0 ? '这个单元没有对应的知识点' : `${u.covered}/${u.total} 个知识点有课讲到`}</span>
                </div>
                <div className="ewb-crs-chips">
                  {u.kps.map(k => (
                    <span key={k.code} className={`ewb-ana-pill ${k.lessons.length ? 'ewb-ana-pill--primary' : 'ewb-ana-pill--red'}`} data-testid={k.lessons.length ? 'compare-kp-covered' : 'compare-kp-uncovered'} title={k.lessons.length ? k.lessons.map(l => `${l.levelName} ${l.label}`).join('；') : '机构课程里没有讲到'}>
                      {k.name}{k.lessons.length ? `：${k.lessons.slice(0, 2).map(l => `${l.levelName} ${l.label}`).join('、')}${k.lessons.length > 2 ? ` 等 ${k.lessons.length} 课` : ''}` : ' · 没讲到'}{k.frequent ? ' · 常考' : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="ewb-crs-block" data-testid="compare-extra">
            <h4 className="ewb-crs-block__title">机构课程讲了、所选教材里没有的 <span className="ewb-ana-meta">超前 / 拓展</span></h4>
            {r.extra.length === 0 ? <p className="ewb-rep-note" data-testid="compare-extra-none">没有：机构课程讲到的知识点，所选教材里都有。</p>
              : r.extra.map(e => (
                <div key={e.lessonId} className="ewb-crs-row" data-testid={`compare-extra-${e.lessonId}`}>
                  <div className="ewb-crs-row__kp"><span className="ewb-ana-kpname">{e.levelName} · {e.label}</span><span className="ewb-ana-meta">{e.kps.length === e.totalKps ? '整节课的知识点教材里都没有' : `${e.kps.length}/${e.totalKps} 个知识点教材里没有`}</span></div>
                  <div className="ewb-crs-chips">{e.kps.map(k => <span key={k.code} className="ewb-ana-pill ewb-ana-pill--quiet">{k.name}</span>)}</div>
                </div>
              ))}
          </section>
        </>
      )}
    </div>
  )
}
