import { useQuery, useQueryClient } from '@tanstack/react-query'

/** 界面偏好（存在 settings 表里，所有页面共用）：显示内部代码、管理员设置是否展开、角色引导是否收起、上次选的角色 */
function useBoolSetting(key: string, fallback = false): [boolean, (v: boolean) => Promise<void>, boolean] {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['settings', key], queryFn: () => window.api.settings.get(key), staleTime: 10_000 })
  const set = async (v: boolean) => {
    qc.setQueryData(['settings', key], v)
    try { await window.api.settings.set(key, v) } finally { qc.invalidateQueries({ queryKey: ['settings', key] }) }
  }
  return [typeof data === 'boolean' ? data : fallback, set, isLoading]
}

/** 「显示内部代码」：默认关。知识点 / 题型的英文代码（GR.PRON.POSS、PH_DIFF）只有管理员排查问题时有用 */
export const useShowCodes = () => useBoolSetting('show_internal_codes')
/** 设置页的「管理员设置」是否展开 */
export const useAdminOpen = () => useBoolSetting('admin_open')
/** 首页的角色引导是否已收起 */
export const useRoleGuideDismissed = () => useBoolSetting('role_guide_dismissed')

export function useRoleGuideRole(): ['ops' | 'tutor', (v: 'ops' | 'tutor') => Promise<void>] {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'role_guide_role'], queryFn: () => window.api.settings.get('role_guide_role'), staleTime: 10_000 })
  const set = async (v: 'ops' | 'tutor') => { qc.setQueryData(['settings', 'role_guide_role'], v); try { await window.api.settings.set('role_guide_role', v) } finally { qc.invalidateQueries({ queryKey: ['settings', 'role_guide_role'] }) } }
  return [data === 'tutor' ? 'tutor' : 'ops', set]
}
