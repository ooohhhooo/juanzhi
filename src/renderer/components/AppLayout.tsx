import React, { useState } from 'react'
import { Layout, Menu } from 'antd'
import {
  FileTextOutlined,
  DashboardOutlined,
  UnorderedListOutlined,
  CheckSquareOutlined,
  FileSearchOutlined,
  SettingOutlined
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Badge } from 'antd'
import { useQuery } from '@tanstack/react-query'

const { Sider, Content } = Layout

const menuItems = (active: number, reviewing: number) => [
  { key: '/', icon: <FileTextOutlined />, label: '试卷库' },
  { key: '/queue', icon: <UnorderedListOutlined />, label: <span>处理队列 {active > 0 && <Badge count={active} size="small" color="#1677ff" data-testid="badge-queue" />}</span> },
  { key: '/review', icon: <CheckSquareOutlined />, label: <span>审核 {reviewing > 0 && <Badge count={reviewing} size="small" color="#faad14" data-testid="badge-review" />}</span> },
  { key: '/dashboard', icon: <DashboardOutlined />, label: '分析看板' },
  { key: '/report', icon: <FileSearchOutlined />, label: 'AI 报告' },
  { type: 'divider' as const },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' }
]

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const { data: papers = [] } = useQuery({ queryKey: ['papers'], queryFn: () => window.api.papers.list() })
  const active = papers.filter(p => ['imported', 'extracting', 'parsing'].includes(p.status)).length
  const reviewing = papers.filter(p => p.status === 'reviewing').length

  // 审核页要给原卷页面多留地方：自动收起侧栏（点折叠按钮仍可手动展开）
  const reviewMode = /^\/review\/.+/.test(location.pathname)

  const selectedKey = location.pathname.startsWith('/paper/')
    ? '/'
    : location.pathname.startsWith('/review')
      ? '/review'
      : location.pathname

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed || reviewMode}
        onCollapse={setCollapsed}
        theme="light"
        width={200}
        style={{
          borderRight: '1px solid #f0f0f0',
          background: '#fafafa'
        }}
      >
        <div style={{
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed || reviewMode ? 'center' : 'flex-start',
          padding: collapsed || reviewMode ? 0 : '0 16px',
          fontWeight: 700,
          fontSize: collapsed || reviewMode ? 16 : 14,
          color: '#1e2952',
          borderBottom: '1px solid #f0f0f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden'
        }}>
          {collapsed || reviewMode ? '英' : '英语校考分析'}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems(active, reviewing)}
          onClick={({ key }) => navigate(key)}
          style={{ border: 'none', background: 'transparent' }}
        />
      </Sider>
      <Content style={{ overflow: 'auto', background: '#fff', height: '100vh' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}
