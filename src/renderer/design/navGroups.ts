/** 侧栏大项与顶部标签的归属（纯函数，单测直接加载）。所有原有路由地址保留，侧栏只列大项，页内用标签切换。 */
export interface NavTab { key: string; label: string }
export interface NavGroup { key: string; tabs: NavTab[] }

export const NAV_GROUPS: NavGroup[] = [
  { key: '/', tabs: [{ key: '/', label: '全部试卷' }, { key: '/queue', label: '处理中' }, { key: '/review', label: '待审核' }] },
  { key: '/overview', tabs: [{ key: '/overview', label: '总览' }, { key: '/dashboard', label: '看板' }] },
  { key: '/courses', tabs: [{ key: '/courses', label: '课程大纲' }, { key: '/courses/research', label: '教研对照表' }] }
]

/** 当前地址对应侧栏的哪一项 */
export function navKeyForPath(pathname: string): string {
  if (pathname === '/' || pathname === '/queue' || pathname.startsWith('/paper/') || pathname === '/review' || pathname.startsWith('/review/')) return '/'
  if (pathname === '/overview' || pathname === '/dashboard') return '/overview'
  if (pathname === '/courses' || pathname.startsWith('/courses/')) return '/courses'
  return pathname
}

/** 页面顶部要不要显示标签条：只在各标签页本身显示（详情页、审核单页自己占满画布，不显示） */
export function tabGroupForPath(pathname: string): NavGroup | undefined {
  return NAV_GROUPS.find(g => g.tabs.some(t => t.key === pathname))
}
