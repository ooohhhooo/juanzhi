import React, { useMemo, useState } from 'react'
import { inSubject } from '../../subject/papers'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Progress, Segmented } from 'antd'
import { ArrowRight, Pencil, Upload } from 'lucide-react'
import { statusMap } from '../../status'
import SimilarNotice from '../../components/SimilarNotice'
import { Btn, EmptyState, IndexTable, Page, SectionTitle, StatusLabel } from '../../design'
import { Pill } from './parts'
import { useSubject } from '../../subject/SubjectContext'
import '../../design/page-review.css'

export default function ReviewList() {
  const navigate = useNavigate()
  const { subject } = useSubject()
  const [tab, setTab] = useState<'reviewing' | 'done'>('reviewing')
  const { data: rawPapers = [], isLoading } = useQuery({ queryKey: ['papers', 'list', subject], queryFn: () => window.api.papers.list({ subject }) })
  const papers = useMemo(() => inSubject(rawPapers, subject), [rawPapers, subject])
  const { data: summary = [] } = useQuery({ queryKey: ['questions', 'summary'], queryFn: () => window.api.questions.summary() })
  const bySummary = useMemo(() => new Map(summary.map(s => [s.paper_id, s])), [summary])

  const rows = papers.filter(p => p.status === tab)
  const nReviewing = papers.filter(p => p.status === 'reviewing').length
  const nDone = papers.filter(p => p.status === 'done').length
  // 待审核的卷子里：多少题已自动通过（AI 和规则一致），还剩多少题要老师看一眼
  const todo = useMemo(() => { let auto = 0, left = 0; for (const p of papers) if (p.status === 'reviewing') { const s = bySummary.get(p.id); if (s) { auto += s.auto ?? 0; left += s.total - (s.reviewed ?? 0) } } return { auto, left } }, [papers, bySummary])

  return (
    <Page>
      <SectionTitle aside={<Segmented value={tab} onChange={v => setTab(v as 'reviewing' | 'done')} options={[
        { label: `待审核 ${nReviewing}`, value: 'reviewing' }, { label: `已完成 ${nDone}`, value: 'done' }
      ]} />}>审核</SectionTitle>
      {tab === 'reviewing' && todo.auto > 0 && <p data-testid="review-auto-note" style={{ margin: '0 0 12px', color: 'var(--ewb-ink-2, #555)' }}>{todo.auto} 道已自动通过（AI 和规则一致），剩下 {todo.left} 道请看一眼。自动通过的题点进去仍然可以改。</p>}
      {rows.length === 0 && !isLoading ? (
        tab === 'reviewing' ? (
          <div data-testid="review-empty">
            <EmptyState title="没有待审核的试卷" description={<>审核是老师逐题核对 AI 标的题，核对完才计入统计。导入试卷并完成 AI 解析后会出现在这里。{nDone > 0 && <>已经审核完的 {nDone} 份在上面的「<a onClick={() => setTab('done')}>已完成</a>」里，想改点进去就行（改完要再确认一次整份）。</>}</>}
              action={<Btn tone="primary" icon={Upload} onClick={() => navigate('/')}>去导入试卷</Btn>} />
          </div>
        ) : <EmptyState title="还没有审核完成的试卷" description="在「待审核」里逐题确认、点「确认整份试卷」后，会出现在这里。" />
      ) : (
      <IndexTable<Paper>
        dataSource={rows} rowKey="id" loading={isLoading} scroll={{ x: 820 }} pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '试卷', dataIndex: 'title', ellipsis: true, render: (t: string, r: Paper) => <span><a className="ewb-rev-list-title" onClick={() => navigate(`/review/${r.id}`)}>{t || r.file_name}</a><SimilarNotice paper={r} compact /></span> },
          { title: '年级', dataIndex: 'grade', width: 80, render: (v: string | null) => (v ? `${v}年级` : '-') },
          { title: '学年', dataIndex: 'school_year_start', width: 110, render: (v: number | null) => (v ? <span className="ewb-rev-list-cell">{v}-{v + 1}</span> : '-') },
          {
            title: '审核进度', width: 190, render: (_: unknown, r: Paper) => {
              const s = bySummary.get(r.id)
              if (!s) return '-'
              return <Progress size="small" percent={Math.round(((s.reviewed ?? 0) / Math.max(1, s.total)) * 100)} format={() => `${s.reviewed ?? 0}/${s.total}`} />
            }
          },
          { title: '需关注', width: 90, render: (_: unknown, r: Paper) => { const a = bySummary.get(r.id)?.attention ?? 0; return a ? <Pill kind="warn">{a} 题</Pill> : '-' } },
          { title: 'AI 整理版本', dataIndex: 'prompt_version', width: 120, render: (v: string | null) => v ?? '-' },
          { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => <StatusLabel status={s}>{statusMap[s]?.label}</StatusLabel> },
          { title: '', width: 100, render: (_: unknown, r: Paper) => <Btn tone="secondary" size="small" icon={tab === 'done' ? ArrowRight : Pencil} onClick={() => navigate(`/review/${r.id}`)}>{tab === 'done' ? '查看' : '审核'}</Btn> }
        ]}
      />
      )}
    </Page>
  )
}
