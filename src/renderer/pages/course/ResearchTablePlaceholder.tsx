import React from 'react'
import { Page } from '../../design'
import '../../design/page-report.css'

/** 「教研对照表」占位页：合并时会换成 ResearchTable.tsx */
export default function ResearchTablePlaceholder() {
  return (
    <Page data-testid="research-table-page">
      <h1 className="ewb-rep-h1">教研对照表</h1>
      <p className="ewb-set-lead">教材、大纲和校内试卷考点的对照表，正在准备中。</p>
    </Page>
  )
}
