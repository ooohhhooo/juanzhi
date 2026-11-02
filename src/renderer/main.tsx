import React from 'react'
import ReactDOM from 'react-dom/client'
import { installTheme, ThemeProvider } from './design'
import App from './App'

// 渲染前先注入 CSS 变量、设置 data-theme，首帧就是对的配色（浅色 / 深色 / 跟随系统）
installTheme()

// 页面里的未捕获错误上报到运行日志（主进程限速并脱敏）
// 错误文字可能带题目内容，所以只上报「错误类型名 + 文字的短指纹」，不带原文
const fingerprint = (t: string): string => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(16) }
window.addEventListener('error', e => { try { window.api?.logError?.(`window.onerror ${(e.error as Error)?.name ?? 'Error'} #${fingerprint(String(e.message))}`) } catch { /* 忽略 */ } })
window.addEventListener('unhandledrejection', e => { try { window.api?.logError?.(`unhandledrejection ${(e.reason as Error)?.name ?? typeof e.reason} #${fingerprint(String((e.reason as Error)?.message ?? e.reason))}`) } catch { /* 忽略 */ } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
