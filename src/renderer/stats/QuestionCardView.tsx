import React from 'react'
import { Tag } from 'antd'
import CropImage from './CropImage'
import { Est } from './Parts'
import { DIFF_LABEL, yearText } from './format'
import type { ViewTarget } from './PageViewer'

export default function QuestionCardView({ q, onView }: { q: QuestionCard; onView: (t: ViewTarget) => void }) {
  const open = q.pageRel ? () => onView({ paperId: q.paper_id, paperTitle: q.paperTitle, no: q.no, pageRel: q.pageRel!, page_idx: q.page_idx, bbox: q.bbox }) : undefined
  return (
    <div data-testid="question-card" data-qid={q.id} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 10, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          <b>{q.paperTitle}</b> · 第 {q.no} 题 · {yearText(q.school_year_start)}{q.textbook ? ` · ${q.textbook}` : ''}
        </div>
        <div style={{ marginBottom: 4 }}>
          <Tag>{q.qtypeName}</Tag>
          {q.score !== null ? <Tag color="blue">{q.score} 分</Tag> : <Tag>分值缺失</Tag>}
          {q.difficulty ? <span style={{ fontSize: 12 }}><Est />难度 {q.difficulty}（{DIFF_LABEL[q.difficulty]}）</span> : null}
          {q.error_prone && <Tag color="red" style={{ marginInlineStart: 6 }}>易错（估计）</Tag>}
          {!q.isPrimary && <Tag style={{ marginInlineStart: 6 }}>次知识点</Tag>}
        </div>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{q.stem || (q.options.length ? q.options.join('  ') : '（题干为空）')}</div>
        {q.stem && q.options.length > 0 && <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{q.options.join('  ')}</div>}
        {q.error_reason && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>易错原因（估计）：{q.error_reason}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>
        <CropImage testid="crop" q={{ paperId: q.paper_id, pageRel: q.pageRel, pageW: q.pageW, pageH: q.pageH, bbox: q.bbox }} width={220} onOpen={open} />
      </div>
    </div>
  )
}
