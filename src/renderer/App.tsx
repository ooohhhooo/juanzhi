import React, { useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import AppLayout from './components/AppLayout'
import PaperLibrary from './pages/PaperLibrary'
import PaperDetail from './pages/PaperDetail'
import Settings from './pages/Settings'
import QueuePage from './pages/QueuePage'
import ReviewList from './pages/review/ReviewList'
import ReviewPage from './pages/review/ReviewPage'
import { useImportFlow } from './hooks/useImportFlow'
import Overview from './pages/Overview'
import Dashboard from './pages/dashboard/Dashboard'
import { StatsFilterProvider } from './stats/StatsFilter'
import { installChunkListener } from './stats/analysisStore'
import { installReportChunkListener } from './stats/reportStore'
import Report from './pages/Report'
import Guide from './pages/Guide'
import RestartGate from './components/RestartGate'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1
    }
  }
})

const STATS_SOURCES = new Set(['papers', 'questions', 'taxonomy', 'materials', 'pages', 'aiConfig', 'prompts'])
// 报告的「是否过期」随这些变化重新核对（报告列表和单份报告的查询键都以 'reports' 开头）
const REPORT_SOURCES = new Set([...STATS_SOURCES, 'reports'])

function DataChangeListener() {
  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('data:changed', (types: string[]) => {
      for (const t of types) {
        queryClient.invalidateQueries({ queryKey: [t] })
      }
      // 看板与总览的统计（含 AI 分析的缓存状态）：试卷状态、题目、知识点树任何一项变了都重新取数
      if (types.some(t => STATS_SOURCES.has(t))) queryClient.invalidateQueries({ queryKey: ['stats'] })
      if (types.some(t => REPORT_SOURCES.has(t))) queryClient.invalidateQueries({ queryKey: ['reports'] })
      // 示例数据加载 / 清除、数据包导入会改变"有没有示例数据"
      if (types.includes('papers')) queryClient.invalidateQueries({ queryKey: ['data'] })
      // 只有 AI 分析的缓存变了（比如生成中被刷新过的页面，等后台生成完）：只刷新 AI 区，不重跑统计
      else if (types.includes('analysis')) queryClient.invalidateQueries({ queryKey: ['stats', 'analysis'] })
    })
    const offChunk = installChunkListener(queryClient)
    const offReport = installReportChunkListener(queryClient)
    return () => { unsub(); offChunk(); offReport() }
  }, [])
  return null
}

/**
 * 窗口级拖放：任何页面把文件拖进窗口都不能让浏览器去「打开」它（会把整个应用导航成该文件），
 * 而是当作导入，并跳到试卷库看进度。试卷库自己的拖拽区会先处理并打上标记。
 */
function GlobalDrop() {
  const { importPaths, pathsFromDrop } = useImportFlow()
  const navigate = useNavigate()
  const ref = useRef({ importPaths, pathsFromDrop, navigate })
  ref.current = { importPaths, pathsFromDrop, navigate }

  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = async (e: DragEvent) => {
      e.preventDefault()
      if ((e as any).__ewbHandled || !e.dataTransfer || e.dataTransfer.files.length === 0) return
      const paths = ref.current.pathsFromDrop(e.dataTransfer)
      if (paths.length === 0) return
      ref.current.navigate('/')
      await ref.current.importPaths(paths)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
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
          <StatsFilterProvider>
          <HashRouter>
            <DataChangeListener />
            <GlobalDrop />
            <RestartGate />
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<PaperLibrary />} />
                <Route path="/paper/:id" element={<PaperDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/review" element={<ReviewList />} />
                <Route path="/review/:id" element={<ReviewPage />} />
                <Route path="/report" element={<Report />} />
                <Route path="/guide" element={<Guide />} />
              </Route>
            </Routes>
          </HashRouter>
          </StatsFilterProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}
