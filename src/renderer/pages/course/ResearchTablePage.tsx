import React from 'react'
import { Page } from '../../design'
import ResearchTable from './ResearchTable'
import '../../design/page-report.css'

/** 「课程」页第二个标签「教研对照表」（路由 /courses/research）。试卷范围筛选条在 ResearchTable 里自带，顶栏不用再放。 */
export default function ResearchTablePage() {
  return (
    <Page data-testid="research-table-page">
      <h1 className="ewb-rep-h1">教研对照表</h1>
      <ResearchTable />
    </Page>
  )
}
