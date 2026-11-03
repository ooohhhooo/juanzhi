/** 侧栏底部「更新」入口的显示逻辑（纯函数，单测直接加载）：只有 available / downloading / ready 才显示 */
export interface UpdateNavView { phase: 'available' | 'downloading' | 'ready'; tag: string; label: string; percent?: number; /** 点击时是否先开始下载 */ download: boolean }
export function updateNavView(st: { phase: string; progress?: { percent: number }; blocker?: unknown; latestVersion?: string } | null | undefined): UpdateNavView | null {
  if (!st) return null
  const v = st.latestVersion ? ` ${st.latestVersion}` : ''
  if (st.phase === 'available') return { phase: 'available', tag: '更新', label: `有新版本${v}`, download: !st.blocker }
  if (st.phase === 'downloading') return { phase: 'downloading', tag: '下载中', label: `正在下载新版本${v}`, percent: Math.max(0, Math.min(100, Math.round(st.progress?.percent ?? 0))), download: false }
  if (st.phase === 'ready') return { phase: 'ready', tag: '重启', label: `新版本${v}已下载，去设置里重启更新`, download: false }
  return null
}
