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

const { Sider, Content } = Layout

const menuItems = [
  { key: '/', icon: <FileTextOutlined />, label: '试卷库' },
  { key: '/queue', icon: <UnorderedListOutlined />, label: '处理队列' },
  { key: '/review', icon: <CheckSquareOutlined />, label: '审核' },
  { key: '/dashboard', icon: <DashboardOutlined />, label: '分析看板' },
  { key: '/report', icon: <FileSearchOutlined />, label: 'AI 报告' },
  { type: 'divider' as const },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' }
]

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const selectedKey = location.pathname.startsWith('/paper/')
    ? '/'
    : location.pathname

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
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
          justifyContent: collapsed ? 'center' : 'flex-start',
          padding: collapsed ? 0 : '0 16px',
          fontWeight: 700,
          fontSize: collapsed ? 16 : 14,
          color: '#1e2952',
          borderBottom: '1px solid #f0f0f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden'
        }}>
          {collapsed ? '英' : '英语校考分析'}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ border: 'none', background: 'transparent' }}
        />
      </Sider>
      <Content style={{ overflow: 'auto', background: '#fff' }}>
        <Outlet />
      </Content>
    </Layout>
  )
}
