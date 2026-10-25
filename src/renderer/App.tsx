import React, { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { HashRouter, Routes, Route } from 'react-router-dom'
import AppLayout from './components/AppLayout'
import PaperLibrary from './pages/PaperLibrary'
import PaperDetail from './pages/PaperDetail'
import Settings from './pages/Settings'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1
    }
  }
})

function DataChangeListener() {
  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('data:changed', (types: string[]) => {
      for (const t of types) {
        queryClient.invalidateQueries({ queryKey: [t] })
      }
    })
    return unsub
  }, [])
  return null
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: '#1e2952',
            borderRadius: 6,
            colorBgContainer: '#ffffff',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
          }
        }}
      >
        <AntApp>
          <HashRouter>
            <DataChangeListener />
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<PaperLibrary />} />
                <Route path="/paper/:id" element={<PaperDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/dashboard" element={<Placeholder title="分析看板" />} />
                <Route path="/queue" element={<Placeholder title="处理队列" />} />
                <Route path="/review" element={<Placeholder title="审核" />} />
                <Route path="/report" element={<Placeholder title="AI 报告" />} />
              </Route>
            </Routes>
          </HashRouter>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}

function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
      <h2>{title}</h2>
      <p style={{ marginTop: 12 }}>此功能将在后续版本中实现</p>
    </div>
  )
}
