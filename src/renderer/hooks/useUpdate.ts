import { useEffect, useState } from 'react'

/** 应用内更新的状态（主进程是唯一来源：启动时取一次，之后跟着 update:state 事件走） */
export function useUpdateState(): UpdateStateView | null {
  const [st, setSt] = useState<UpdateStateView | null>(null)
  useEffect(() => {
    let alive = true
    window.api.update.state().then(s => { if (alive) setSt(s) }, () => undefined)
    const off = window.api.on?.('update:state', (s: UpdateStateView) => { if (alive) setSt(s) })
    return () => { alive = false; off?.() }
  }, [])
  return st
}
