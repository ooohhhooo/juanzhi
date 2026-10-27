/** 外观切换：浅色 / 深色 / 跟随系统（图标在上、文字在下）。偏好存 localStorage（见 theme.tsx）。 */
import React from 'react'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { Icon } from './icons'
import { useTheme, type ThemePref } from './theme'

const OPTS: Array<{ value: ThemePref; label: string; icon: LucideIcon }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor }
]

const NEXT: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' }
const SHORT: Record<ThemePref, string> = { light: '浅色', dark: '深色', system: '自动' }
const FULL: Record<ThemePref, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
const ICON: Record<ThemePref, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

/** 侧栏用的外观切换：图标加两字标签，点一下按 浅色 → 深色 → 跟随系统 循环 */
export function ThemeCycle() {
  const { pref, setPref } = useTheme()
  return (
    <button type="button" className="ewb-contents__link" onClick={() => setPref(NEXT[pref])} data-testid="theme-cycle" data-pref={pref}
      aria-label={`外观：${FULL[pref]}，点击切换到${FULL[NEXT[pref]]}`} title={`外观：${FULL[pref]}（点击切换）`}>
      <span className="ewb-contents__icon"><Icon as={ICON[pref]} size={22} /></span>
      <span className="ewb-contents__tag">{SHORT[pref]}</span>
    </button>
  )
}

export default function ThemeSwitch() {
  const { pref, setPref } = useTheme()
  return (
    <div className="ewb-themeswitch" role="group" aria-label="外观">
      <span className="ewb-themeswitch__label">外观</span>
      <div className="ewb-themeswitch__opts">
        {OPTS.map(o => (
          <button key={o.value} type="button" className="ewb-themeswitch__opt" aria-pressed={pref === o.value} onClick={() => setPref(o.value)} data-testid={`theme-${o.value}`}>
            <Icon as={o.icon} size={16} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
