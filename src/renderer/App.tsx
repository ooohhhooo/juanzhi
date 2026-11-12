import React, { Suspense, lazy, useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import AppLayout from './components/AppLayout'
import PaperLibrary from './pages/PaperLibrary'
import PaperDetail from './pages/PaperDetail'
import CoursesPage from './pages/course/CoursesPage'
import ResearchTablePage from './pages/course/ResearchTablePage'
import Settings from './pages/Settings'
import DatasetsPage from './pages/datasets/DatasetsPage'
import QueuePage from './pages/QueuePage'
import ReviewList from './pages/review/ReviewList'
import ReviewPage from './pages/review/ReviewPage'
import { useImportFlow } from './hooks/useImportFlow'
import Overview from './pages/Overview'
import Dashboard from './pages/dashboard/Dashboard'
import { StatsFilterProvider } from './stats/StatsFilter'
import { SubjectProvider } from './subject/SubjectContext'
import { installChunkListener } from './stats/analysisStore'
import { installReportChunkListener } from './stats/reportStore'
import Report from './pages/Report'
import Assistant from './pages/Assistant'
import Guide from './pages/Guide'
import Help from './pages/Help'
import RestartGate from './components/RestartGate'
import UpdateNotice from './components/UpdateNotice'
import GlobalNotices from './components/GlobalNotices'

// 设计预览（隐藏路由 /design、/design/overview）：只在开发模式（或 VITE_EWB_DESIGN=1 的预览构建）里存在。
// 生产构建里这个条件是常量 false，路由、样板页和样张图片（design/assets/*.png）都不会进入 out/ 和安装包。
const SHOW_DESIGN = import.meta.env.DEV || import.meta.env.VITE_EWB_DESIGN === '1'
const AnalysisDemo = SHOW_DESIGN ? lazy(() => import('./analysis/AnalysisDemo')) : null   // 分析看板演示路由 /analysis-demo（仅开发与 e2e）
const DesignRoutes = SHOW_DESIGN ? lazy(() => import('./design/DesignRoutes')) : null

// 助手画布演示（隐藏路由 /assistant-canvas-demo，侧栏没有入口，只给开发与端到端测试用；懒加载，不访问就不加载）
const AssistantCanvasDemo = lazy(() => import('./assistant/demo/AssistantCanvasDemo'))

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

/** 打开卷知时先进入哪里：设置里选了「助手」才跳；没选过（默认）保持试卷库。只在刚打开、停在首页时跳一次 */
function StartPage() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!window.api?.settings) return
    if (location.hash && location.hash !== '#/' && location.hash !== '#') return
    void window.api.settings.get('start_page').then(v => { if (v === 'assistant' && (!location.hash || location.hash === '#/' || location.hash === '#')) navigate('/assistant', { replace: true }) }, () => undefined)
  }, [])
  return null
}

function DataChangeListener() {
  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('data:changed', (types: string[]) => {
      for (const t of types) {
        queryClient.invalidateQueries({ queryKey: [t] })
      }
      // 识别方式与「没找到位置的题」随试卷、页面、题目的变化重新取
      if (types.some(t => t === 'papers' || t === 'pages' || t === 'questions')) queryClient.invalidateQueries({ queryKey: ['diag'] })
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
 * 而是交给主进程自动分流（试卷进试卷库、表格和文档进数据），弹一条汇总提示，不跳页。
 * 试卷库、数据页、助手页自己的拖拽区会先处理并打上 __ewbHandled 标记，这里不再重复处理。
 */
function GlobalDrop() {
  const { importAuto, pathsFromDrop } = useImportFlow()
  const navigate = useNavigate()
  const ref = useRef({ importAuto, pathsFromDrop, navigate })
  ref.current = { importAuto, pathsFromDrop, navigate }

  // 应用菜单「检查更新…」：主进程让页面跳到设置里的对应位置（只接受站内路径）
  useEffect(() => window.api.on('menu:navigate', (to: unknown) => { if (typeof to === 'string' && to.startsWith('/')) ref.current.navigate(to) }), [])

  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = async (e: DragEvent) => {
      e.preventDefault()
      if ((e as any).__ewbHandled || !e.dataTransfer || e.dataTransfer.files.length === 0) return
      const paths = ref.current.pathsFromDrop(e.dataTransfer)
      if (paths.length === 0) return
      await ref.current.importAuto(paths)
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
      {/* 配色、字体、AntD token 由 main.tsx 里的 design/ThemeProvider 统一提供，这里只补语言包 */}
      <ConfigProvider locale={zhCN}>
        <AntApp>
          <SubjectProvider>
          <StatsFilterProvider>
          <HashRouter>
            <DataChangeListener />
            <GlobalDrop />
            <StartPage />
            <RestartGate />
            <UpdateNotice />
            <GlobalNotices />
            <Routes>
              {DesignRoutes && <Route path="/design/*" element={<Suspense fallback={null}><DesignRoutes /></Suspense>} />}
              {AnalysisDemo && <Route path="/analysis-demo" element={<Suspense fallback={null}><AnalysisDemo /></Suspense>} />}
              <Route element={<AppLayout />}>
                <Route path="/" element={<PaperLibrary />} />
                <Route path="/paper/:id" element={<PaperDetail />} />
                <Route path="/courses" element={<CoursesPage />} />
                <Route path="/courses/research" element={<ResearchTablePage />} />
                <Route path="/datasets" element={<DatasetsPage />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/review" element={<ReviewList />} />
                <Route path="/review/:id" element={<ReviewPage />} />
                <Route path="/report" element={<Report />} />
                <Route path="/assistant" element={<Assistant />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="/help" element={<Help />} />
                <Route path="/assistant-canvas-demo" element={<Suspense fallback={null}><AssistantCanvasDemo /></Suspense>} />
              </Route>
            </Routes>
          </HashRouter>
          </StatsFilterProvider>
          </SubjectProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}
