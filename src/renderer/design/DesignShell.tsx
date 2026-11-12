/**
 * 预览用外框（第二版）：浅灰应用底 + 窄图标侧栏 + 浮起的白色大画布。
 * 正式路由的外框还是旧的（AppLayout），用户确认审美后第二阶段再替换。
 */
import React, { useState } from 'react'
import { Sparkles, ChartColumn, Database, FileSearch, GraduationCap, Library, Settings } from 'lucide-react'
import Contents, { type ContentsItem } from './Contents'

/** 侧栏 6 项：助手、分析（总览 + 看板）、试卷（试卷库 + 处理中 + 待审核）、报告、课程（课程大纲 + 教研对照表）、数据；试卷角标 = 处理中 + 待审核 */
export const NAV_ITEMS = (queue: number, review: number, courseReview = 0): ContentsItem[] => [
  { key: '/assistant', label: '助手', tag: '助手', icon: Sparkles },
  { key: '/overview', label: '分析', tag: '分析', icon: ChartColumn },
  { key: '/', label: '试卷', tag: '试卷', icon: Library, count: queue + review, countTestId: 'badge-papers' },
  { key: '/report', label: 'AI 报告', tag: '报告', icon: FileSearch },
  { key: '/courses', label: '课程', tag: '课程', icon: GraduationCap, count: courseReview, countTestId: 'badge-course' },
  { key: '/datasets', label: '数据', tag: '数据', icon: Database }
]
export const NAV_FOOTER: ContentsItem[] = [{ key: '/settings', label: '设置', tag: '设置', icon: Settings }]

export default function DesignShell({ children, activeKey = '/overview', queue = 2, review = 3 }: { children: React.ReactNode; activeKey?: string; queue?: number; review?: number }) {
  const [active, setActive] = useState(activeKey)
  return (
    <div className="ewb-shell">
      <aside className="ewb-sider">
        <Contents items={NAV_ITEMS(queue, review)} footerItems={NAV_FOOTER} activeKey={active} onNavigate={setActive} />
      </aside>
      <main className="ewb-main" data-testid="design-main">{children}</main>
    </div>
  )
}
