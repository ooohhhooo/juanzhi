/**
 * 主题：跟随系统 + 手动（浅色 / 深色 / 跟随系统），偏好存 localStorage（读写都 try/catch）。
 *
 * - main.tsx 在渲染前调用 `installTheme()`：注入 CSS 变量 <style id="ewb-tokens">，并在 <html> 上写 data-theme，避免首帧闪白。
 * - `<ThemeProvider>` 提供 AntD ConfigProvider（algorithm + token）和 `useTheme()`。
 * - 深色模式下原卷 / 页面图片区域保持白纸：用 `<PaperSheet>`（或 .ewb-sheet 类）包住。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { antdTheme, cssVariablesText, echartsThemeName, type Mode } from './tokens'

export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'ewb-theme-pref'
const BIG_KEY = 'ewb-big-text'
const STYLE_ID = 'ewb-tokens'

function readPref(): ThemePref {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* 隐私模式 / 被禁用：用默认 */ }
  return 'system'
}
function writePref(p: ThemePref): void {
  try { window.localStorage.setItem(STORAGE_KEY, p) } catch { /* 存不上不影响本次使用 */ }
}
function readBig(): boolean {
  try { return window.localStorage.getItem(BIG_KEY) === '1' } catch { return false }
}
function writeBig(v: boolean): void {
  try { window.localStorage.setItem(BIG_KEY, v ? '1' : '0') } catch { /* 存不上不影响本次使用 */ }
}
function applyBig(v: boolean): void {
  if (v) document.documentElement.dataset.bigText = '1'
  else delete document.documentElement.dataset.bigText
}
function systemMode(): Mode {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } catch { return 'light' }
}
const resolve = (pref: ThemePref): Mode => (pref === 'system' ? systemMode() : pref)

function applyMode(mode: Mode): void {
  document.documentElement.dataset.theme = mode
}

/** 注入 CSS 变量并设置 data-theme。幂等，渲染前调用一次即可（ThemeProvider 也会兜底调用）。 */
export function installTheme(): Mode {
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = cssVariablesText()
    document.head.prepend(el)
  }
  // 设计系统全局样式挂在 html.ewb-design 下（第一阶段为了隔离预览页；正式启用后永久开启）
  document.documentElement.classList.add('ewb-design')
  const mode = resolve(readPref())
  applyMode(mode)
  applyBig(readBig())
  return mode
}

interface ThemeCtx {
  /** 用户选的：跟随系统 / 浅色 / 深色 */
  pref: ThemePref
  /** 实际生效的 */
  mode: Mode
  setPref: (p: ThemePref) => void
  /** 投屏大字：整个界面放大到 115%（只存在本机 localStorage，不进数据库设置） */
  bigText: boolean
  setBigText: (v: boolean) => void
  /** ECharts 主题名：ewb-light / ewb-dark */
  echartsTheme: 'ewb-light' | 'ewb-dark'
}

const Ctx = createContext<ThemeCtx | null>(null)

/** 在组件里读取 / 切换主题：`const { mode, pref, setPref } = useTheme()` */
export function useTheme(): ThemeCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme 必须在 ThemeProvider 里使用')
  return c
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [sys, setSys] = useState<Mode>(systemMode)
  const [bigText, setBigTextState] = useState<boolean>(readBig)

  useEffect(() => {
    installTheme()
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch { /* 无 matchMedia */ }
    if (!mq) return
    const on = () => setSys(mq!.matches ? 'dark' : 'light')
    mq.addEventListener('change', on)
    return () => mq!.removeEventListener('change', on)
  }, [])

  const mode: Mode = pref === 'system' ? sys : pref
  useEffect(() => { applyMode(mode) }, [mode])

  const setPref = useCallback((p: ThemePref) => { writePref(p); setPrefState(p) }, [])
  const setBigText = useCallback((v: boolean) => { writeBig(v); applyBig(v); setBigTextState(v) }, [])
  const value = useMemo<ThemeCtx>(() => ({ pref, mode, setPref, bigText, setBigText, echartsTheme: echartsThemeName(mode) }), [pref, mode, setPref, bigText, setBigText])
  const themeConfig = useMemo(() => antdTheme(mode), [mode])

  return (
    <Ctx.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={themeConfig}>{children}</ConfigProvider>
    </Ctx.Provider>
  )
}
