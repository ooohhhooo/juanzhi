import { useEffect, useState } from 'react'

/** 从 startedAt 到现在过了几秒（每秒刷新一次）；active=false 时不走表 */
export function useElapsedSeconds(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active, startedAt])
  return startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0
}
