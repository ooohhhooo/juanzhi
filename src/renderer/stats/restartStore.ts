/** 更改数据目录后需要重启才生效：重启之前界面被一个不能关闭的提示盖住，免得老师继续在旧目录里改东西（重启后就看不到了） */
import { useSyncExternalStore } from 'react'

let state: { required: boolean; target: string; oldDir: string } = { required: false, target: '', oldDir: '' }
const listeners = new Set<() => void>()
export function requireRestart(target: string, oldDir: string): void {
  state = { required: true, target, oldDir }
  for (const l of listeners) l()
}
export const useRestartState = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
