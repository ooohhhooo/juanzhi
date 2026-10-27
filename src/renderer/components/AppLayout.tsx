import React from 'react'
import { Upload } from 'lucide-react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import FilterBar from '../stats/StatsFilter'
import { useImportFlow } from '../hooks/useImportFlow'
import { Btn, Contents, NAV_FOOTER, NAV_ITEMS } from '../design'

/**
 * 应用外框（设计系统第二版）：浅灰底 + 窄图标侧栏（84px，图标 + 两字标签）+ 浮起的白色大画布。
 * 保留的测试钩子：.ewb-sider（审核页断言侧栏仍是窄栏）、data-testid=badge-queue / badge-review（只含数字）。
 * 侧栏恒为窄栏，不需要像旧版那样在审核页自动收起：原卷页面直接占满画布宽度。
 */
export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { importPaths } = useImportFlow()

  const { data: papers = [] } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const active = papers.filter(p => ['imported', 'extracting', 'parsing'].includes(p.status)).length
  const reviewing = papers.filter(p => p.status === 'reviewing').length

  const selectedKey = location.pathname.startsWith('/paper/')
    ? '/'
    : location.pathname.startsWith('/review')
      ? '/review'
      : location.pathname

  const importFromOverview = async () => {
    const paths = await window.api.dialog.openFiles()
    if (paths.length) { navigate('/'); await importPaths(paths) }
  }
  const showFilter = location.pathname === '/overview' || location.pathname === '/dashboard' || location.pathname === '/report'

  return (
    <div className="ewb-shell" data-testid="app-shell">
      <aside className="ewb-sider">
        <Contents items={NAV_ITEMS(active, reviewing)} footerItems={NAV_FOOTER} activeKey={selectedKey} onNavigate={navigate} />
      </aside>
      <main className="ewb-main" data-testid="app-main">
        {showFilter && (
          <div className="ewb-page ewb-page--filter">
            <FilterBar actions={location.pathname === '/overview' ? <Btn tone="primary" icon={Upload} data-testid="overview-import" onClick={importFromOverview}>导入试卷</Btn> : undefined} />
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
