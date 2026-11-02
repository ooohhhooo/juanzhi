import React from 'react'
import ReactDOM from 'react-dom/client'
import { installTheme, ThemeProvider } from './design'
import App from './App'

// 渲染前先注入 CSS 变量、设置 data-theme，首帧就是对的配色（浅色 / 深色 / 跟随系统）
installTheme()

// 页面里的未捕获错误上报到运行日志（只带错误信息，主进程限速并脱敏）
window.addEventListener('error', e => { try { window.api?.logError?.(`window.onerror: ${e.message}`) } catch { /* 忽略 */ } })
window.addEventListener('unhandledrejection', e => { try { window.api?.logError?.(`unhandledrejection: ${(e.reason as Error)?.message ?? e.reason}`) } catch { /* 忽略 */ } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
