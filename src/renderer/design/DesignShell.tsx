/**
 * 预览用外框（第二版）：浅灰应用底 + 窄图标侧栏 + 浮起的白色大画布。
 * 正式路由的外框还是旧的（AppLayout），用户确认审美后第二阶段再替换。
 */
import React, { useState } from 'react'
import { BookOpenText, ChartColumn, ClipboardCheck, FileSearch, Library, ListOrdered, Settings } from 'lucide-react'
import Contents, { type ContentsItem } from './Contents'

export const NAV_ITEMS = (queue: number, review: number): ContentsItem[] => [
  { key: '/overview', label: '总览', tag: '总览', icon: BookOpenText },
  { key: '/', label: '试卷库', tag: '试卷', icon: Library },
  { key: '/queue', label: '处理队列', tag: '队列', icon: ListOrdered, count: queue, countTestId: 'badge-queue' },
  { key: '/review', label: '审核', tag: '审核', icon: ClipboardCheck, count: review, countTestId: 'badge-review' },
  { key: '/dashboard', label: '分析看板', tag: '看板', icon: ChartColumn },
  { key: '/report', label: 'AI 报告', tag: '报告', icon: FileSearch }
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
