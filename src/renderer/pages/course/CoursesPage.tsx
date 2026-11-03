import React from 'react'
import { Page } from '../../design'
import CourseSettings from './CourseSettings'
import '../../design/page-report.css'

/** 侧栏「课程大纲」页：课程大纲和试卷一样是知识库内容。管理（上传向导、启用、替换、删除、匹配）都在这里；看板「课程对照」页签用它们来对照。 */
export default function CoursesPage() {
  return (
    <Page data-testid="courses-page">
      <h1 className="ewb-rep-h1">课程大纲</h1>
      <p className="ewb-set-lead">上传你自己的课程表（培训机构的课程大纲、学校的教学进度，或孩子在上的课），看板的“课程对照”页就能告诉你：容易出错的考点在哪一课讲，常考的考点哪些课没有覆盖。培训机构、学校、家长都能用。</p>
      <CourseSettings />
    </Page>
  )
}
