import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page } from '../../design'
import { Btn } from '../../design'
import CourseSettings from './CourseSettings'
import ResearchTable from './ResearchTable'
import '../../design/page-report.css'

/**
 * 侧栏「课程」页：课程大纲和试卷一样是知识库内容。管理（上传向导、启用、替换、删除、匹配）都在这里；看板「课程对照」页签用它们来对照。
 * 教研对照表（ResearchTable）先放在这里的一个明显入口：?view=research 直接打开。合并侧栏改动后由顶部标签「教研对照」挂载。
 */
export default function CoursesPage() {
  const [params, setParams] = useSearchParams()
  const research = params.get('view') === 'research'
  const go = (on: boolean) => setParams(on ? { view: 'research' } : {}, { replace: true })
  return (
    <Page data-testid="courses-page">
      <h1 className="ewb-rep-h1">课程大纲</h1>
      <p className="ewb-set-lead">上传课程表，看板的“课程对照”页就能告诉你：容易出错的考点在哪一课讲，常考的考点哪些课没有覆盖。</p>
      <div className="ewb-rep-row" style={{ gap: 8, marginBottom: 16 }}>
        <Btn tone={research ? 'secondary' : 'primary'} data-testid="courses-open-research" onClick={() => go(!research)}>{research ? '收起教研对照表' : '教研对照表：大纲 × 教材 × 试卷 × 课件'}</Btn>
      </div>
      {research && <ResearchTable />}
      <CourseSettings />
    </Page>
  )
}
