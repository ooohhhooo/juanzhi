import React from 'react'
import CropImage from './CropImage'
import { Est } from './Parts'
import { DIFF_LABEL, yearText } from './format'
import type { ViewTarget } from './PageViewer'
import '../design/page-analysis.css'

export default function QuestionCardView({ q, onView }: { q: QuestionCard; onView: (t: ViewTarget) => void }) {
  const open = q.pageRel ? () => onView({ paperId: q.paper_id, paperTitle: q.paperTitle, no: q.no, pageRel: q.pageRel!, page_idx: q.page_idx, bbox: q.bbox }) : undefined
  return (
    <div data-testid="question-card" data-qid={q.id} className="ewb-ana-qcard">
      <div className="ewb-ana-qcard__main">
        <div className="ewb-ana-qcard__head">
          <b>{q.paperTitle}</b> · 第 {q.no} 题 · {yearText(q.school_year_start)}{q.textbook ? ` · ${q.textbook}` : ''}
        </div>
        <div className="ewb-ana-qcard__tags">
          <span className="ewb-ana-pill">{q.qtypeName}</span>
          {q.score !== null ? <span className="ewb-ana-pill ewb-ana-pill--soft">{q.score} 分</span> : <span className="ewb-ana-pill">分值缺失</span>}
          {q.difficulty ? <span className="ewb-ana-meta"><Est />难易程度：{DIFF_LABEL[q.difficulty]}</span> : null}
          {q.error_prone && <span className="ewb-ana-pill ewb-ana-pill--red">容易错（估计）</span>}
          {!q.isPrimary && <span className="ewb-ana-pill">只是顺带考到</span>}
        </div>
        <div className="ewb-ana-qcard__stem">{q.stem || (q.options.length ? q.options.join('  ') : '（题干为空）')}</div>
        {q.stem && q.options.length > 0 && <div className="ewb-ana-qcard__opts">{q.options.join('  ')}</div>}
        {q.error_reason && <div className="ewb-ana-qcard__reason">为什么容易错（估计）：{q.error_reason}</div>}
      </div>
      <div className="ewb-ana-qcard__crop">
        <CropImage testid="crop" q={{ paperId: q.paper_id, pageRel: q.pageRel, pageW: q.pageW, pageH: q.pageH, bbox: q.bbox }} width={260} onOpen={open} />
      </div>
    </div>
  )
}
