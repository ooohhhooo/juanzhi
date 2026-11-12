import React from 'react'
import { Download, RotateCw, Upload } from 'lucide-react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import FilterBar from '../stats/StatsFilter'
import { useImportFlow } from '../hooks/useImportFlow'
import { Btn, Contents, NAV_FOOTER, NAV_ITEMS } from '../design'
import { Tooltip, Segmented } from 'antd'
import { navKeyForPath, tabGroupForPath } from '../design/navGroups'
import { updateNavView } from '../design/updateNav'
import { useUpdateState } from '../hooks/useUpdate'
import { asSubject } from '../../shared/subject'
import { useSubject } from '../subject/SubjectContext'
import SubjectSwitch from './SubjectSwitch'

/**
 * 应用外框（设计系统第二版）：浅灰底 + 窄图标侧栏（84px，图标 + 两字标签）+ 浮起的白色大画布。
 * 侧栏 6 项 + 设置；试卷 / 分析 / 课程三项里的各页用顶部标签切换（路由地址不变）。
 * 测试钩子：.ewb-sider；标签上的数字 data-testid=badge-queue / badge-review（只含数字）；侧栏试卷角标 badge-papers。
 * 侧栏恒为窄栏，不需要像旧版那样在审核页自动收起：原卷页面直接占满画布宽度。
 */
export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { importPaths } = useImportFlow()
  const { subject } = useSubject()

  // 处理队列显示全部学科的卷子（每份标着学科）；审核的角标只数当前学科
  const { data: papers = [] } = useQuery({ queryKey: ['papers', 'list', 'all'], queryFn: () => window.api.papers.list({ allSubjects: true }) })
  const active = papers.filter(p => ['imported', 'extracting', 'parsing'].includes(p.status)).length
  const reviewing = papers.filter(p => p.status === 'reviewing' && asSubject(p.subject) === subject).length

  const { data: courseJobs = [] } = useQuery({
    queryKey: ['course', 'jobs'], queryFn: () => window.api.course.jobs(),
    refetchInterval: q => ((q.state.data ?? []).some(j => j.status === 'queued' || j.status === 'running') ? 1500 : false)
  })
  // 课程对照的待确认：只数当前学科的（任务带学科时按它分；没带的按不分学科全数）
  const courseReview = courseJobs.filter(j => j.status === 'ready' && (!(j as { subject?: string }).subject || (j as { subject?: string }).subject === subject)).length

  const upd = updateNavView(useUpdateState())
  const goUpdate = () => {
    if (upd?.download) void window.api.update.download()
    navigate('/settings?tab=about')
  }
  const updateEntry = upd && (
    <li key="sider-update">
      <Tooltip title={upd.label} placement="right" mouseEnterDelay={0.4}>
        <button type="button" className="ewb-contents__link" data-testid="sider-update" data-phase={upd.phase} aria-label={upd.label} onClick={goUpdate}>
          <span className="ewb-contents__icon">
            {upd.phase === 'downloading'
              ? <span className="ewb-contents__ring" style={{ ['--p' as string]: upd.percent }} data-testid="sider-update-percent"><span>{upd.percent}</span></span>
              : upd.phase === 'ready' ? <RotateCw size={22} strokeWidth={1.75} /> : <Download size={22} strokeWidth={1.75} />}
            {upd.phase === 'available' && <span className="ewb-contents__dot" data-testid="sider-update-dot" />}
          </span>
          <span className="ewb-contents__tag">{upd.tag}</span>
        </button>
      </Tooltip>
    </li>
  )

  const selectedKey = navKeyForPath(location.pathname)
  const tabGroup = tabGroupForPath(location.pathname)
  // 标签上的数字（只含数字）：处理中、待审核；0 不显示
  const tabLabel = (key: string, label: string) => {
    const n = key === '/queue' ? active : key === '/review' ? reviewing : 0
    const id = key === '/queue' ? 'badge-queue' : 'badge-review'
    return n > 0 ? <span>{label} <span className="ewb-tabcount" data-testid={id}>{n}</span></span> : label
  }

  const importFromOverview = async () => {
    const paths = await window.api.dialog.openFiles()
    if (paths.length) { navigate('/'); await importPaths(paths) }
  }
  const showFilter = location.pathname === '/overview' || location.pathname === '/dashboard' || location.pathname === '/report'

  return (
    <div className="ewb-shell" data-testid="app-shell">
      <aside className="ewb-sider">
        <Contents showThemeSwitch={false} items={NAV_ITEMS(active, reviewing, courseReview)} footerItems={NAV_FOOTER} footerExtra={updateEntry} brandExtra={<SubjectSwitch />} activeKey={selectedKey} onNavigate={navigate} />
      </aside>
      <main className="ewb-main" data-testid="app-main">
        {tabGroup && (
          <div className="ewb-page ewb-page--filter ewb-page--tabs" data-testid="nav-tabs">
            <Segmented value={location.pathname} onChange={v => navigate(String(v))}
              options={tabGroup.tabs.map(t => ({ value: t.key, label: tabLabel(t.key, t.label) }))} />
          </div>
        )}
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
