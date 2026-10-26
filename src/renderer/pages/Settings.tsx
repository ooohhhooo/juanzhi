import React from 'react'
import { Button, Descriptions, Card, Tag } from 'antd'
import { BookOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import AiSettings from './AiSettings'
import PromptSettings from './PromptSettings'
import DataSettings from './DataSettings'
import TaxonomySettings from './TaxonomySettings'

export default function Settings() {
  const nav = useNavigate()
  const { data: ocr, refetch: recheckOcr, isFetching: checkingOcr } = useQuery({
    queryKey: ['ocr', 'status'],
    queryFn: () => window.api.ocr.status(),
    staleTime: 0
  })
  const { data: about } = useQuery({ queryKey: ['app', 'info'], queryFn: () => window.api.app.info(), staleTime: Infinity })

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h2 style={{ margin: '0 0 24px', color: '#1e2952' }}>设置</h2>

      <DataSettings />

      <Card title="文字识别（OCR）" size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="状态">
            {ocr
              ? <Tag data-testid="ocr-status" color={ocr.available ? 'success' : 'error'}>{ocr.available ? '可用' : '不可用'}</Tag>
              : '检测中…'}
            {ocr && <span data-testid="ocr-detail">{ocr.detail}</span>}
            <Button type="link" size="small" loading={checkingOcr} onClick={() => recheckOcr()}>重新检测</Button>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <AiSettings />
      <PromptSettings />
      <TaxonomySettings />

      <Card title="关于" size="small" data-testid="about-card">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="软件">英语校考分析工作台 —— 帮助教师分析试卷中的知识点分布和考频趋势（离线桌面软件，数据只存在这台电脑上，没有服务器、不用登录）</Descriptions.Item>
          <Descriptions.Item label="版本"><span data-testid="about-version">{about?.version ?? '…'}</span>（数据库版本 v{about?.schema ?? '…'}）</Descriptions.Item>
          <Descriptions.Item label="运行环境"><span data-testid="about-env">{about ? `${about.platform} ${about.arch} · Electron ${about.electron} · Chromium ${about.chrome} · Node ${about.node}` : '…'}</span></Descriptions.Item>
          <Descriptions.Item label="数据目录"><code style={{ fontSize: 12 }}>{about?.dataDir}</code></Descriptions.Item>
          <Descriptions.Item label="安装指南">
            <Button type="link" size="small" icon={<BookOutlined />} data-testid="open-guide" style={{ padding: 0 }} onClick={() => nav('/guide')}>查看安装指南</Button>
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  )
}
