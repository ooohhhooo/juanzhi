import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Empty, Progress, Segmented, Table, Tag } from 'antd'
import { statusMap } from '../../status'

export default function ReviewList() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'reviewing' | 'done'>('reviewing')
  const { data: papers = [], isLoading } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const { data: summary = [] } = useQuery({ queryKey: ['questions', 'summary'], queryFn: () => window.api.questions.summary() })
  const bySummary = useMemo(() => new Map(summary.map(s => [s.paper_id, s])), [summary])

  const rows = papers.filter(p => p.status === tab)
  const nReviewing = papers.filter(p => p.status === 'reviewing').length
  const nDone = papers.filter(p => p.status === 'done').length

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 16 }}>
        <h2 style={{ margin: 0, color: '#1e2952' }}>审核</h2>
        <Segmented value={tab} onChange={v => setTab(v as 'reviewing' | 'done')} options={[
          { label: `待审核 ${nReviewing}`, value: 'reviewing' }, { label: `已完成 ${nDone}`, value: 'done' }
        ]} />
      </div>
      <Table
        dataSource={rows} rowKey="id" loading={isLoading} size="middle" pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={tab === 'reviewing' ? '没有待审核的试卷。导入试卷并完成 AI 解析后会出现在这里。' : '还没有审核完成的试卷'} /> }}
        columns={[
          { title: '试卷', dataIndex: 'title', ellipsis: true, render: (t: string, r: Paper) => <a onClick={() => navigate(`/review/${r.id}`)}>{t || r.file_name}</a> },
          { title: '年级', dataIndex: 'grade', width: 80, render: (v: string | null) => (v ? `${v}年级` : '-') },
          { title: '学年', dataIndex: 'school_year_start', width: 100, render: (v: number | null) => (v ? `${v}-${v + 1}` : '-') },
          {
            title: '审核进度', width: 200, render: (_: unknown, r: Paper) => {
              const s = bySummary.get(r.id)
              if (!s) return '-'
              return <Progress size="small" percent={Math.round(((s.reviewed ?? 0) / Math.max(1, s.total)) * 100)} format={() => `${s.reviewed ?? 0}/${s.total}`} />
            }
          },
          { title: '需关注', width: 90, render: (_: unknown, r: Paper) => { const a = bySummary.get(r.id)?.attention ?? 0; return a ? <Tag color="gold">{a} 题</Tag> : '-' } },
          { title: '提示词', dataIndex: 'prompt_version', width: 130, render: (v: string | null) => v ?? '-' },
          { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label}</Tag> },
          { title: '', width: 90, render: (_: unknown, r: Paper) => <Button size="small" type="primary" ghost onClick={() => navigate(`/review/${r.id}`)}>{tab === 'done' ? '查看' : '审核'}</Button> }
        ]}
      />
    </div>
  )
}
