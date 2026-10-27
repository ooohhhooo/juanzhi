import React from 'react'
import ReactDOM from 'react-dom/client'
import { installTheme, ThemeProvider } from './design'
import App from './App'

// 渲染前先注入 CSS 变量、设置 data-theme，首帧就是对的配色（浅色 / 深色 / 跟随系统）
installTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
