/**
 * 设计预览路由（隐藏，不在导航里）：
 *   #/design?admin=1           组件样板（Gallery）
 *   #/design/overview?admin=1  总览高保真样张（含新外框）
 * 不带 admin=1 会回到首页。
 * 主题 Provider 在 main.tsx 里统一挂载（第二阶段起设计系统对整个应用生效）。
 */
import React from 'react'
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import './styles'
import Gallery from './Gallery'
import DesignOverview from './DesignOverview'

export default function DesignRoutes() {
  // 预览页只在带 ?admin=1 时开放（正式版里普通用户打不开：#/design?admin=1）
  const [params] = useSearchParams()
  if (params.get('admin') !== '1') return <Navigate to="/" replace />
  return (
    <div className="ewb-root">
      <Routes>
        <Route path="overview" element={<DesignOverview />} />
        <Route index element={<Gallery />} />
      </Routes>
    </div>
  )
}
