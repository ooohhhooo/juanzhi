import React from 'react'
import { Button, Descriptions, message, Card, Tag } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'

export default function Settings() {
  const { data: dataDir = '' } = useQuery({
    queryKey: ['settings', 'dataDir'],
    queryFn: () => window.api.settings.getDataDir()
  })

  const { data: ocr, refetch: recheckOcr, isFetching: checkingOcr } = useQuery({
    queryKey: ['ocr', 'status'],
    queryFn: () => window.api.ocr.status(),
    staleTime: 0
  })

  const handleOpenDir = async () => {
    try {
      await window.api.settings.openDataDir()
    } catch {
      message.error('无法打开数据目录')
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <h2 style={{ margin: '0 0 24px', color: '#1e2952' }}>设置</h2>

      <Card title="数据存储" size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="数据目录">
            <code style={{ fontSize: 12 }}>{dataDir}</code>
            <Button
              type="link"
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={handleOpenDir}
              style={{ marginLeft: 8 }}
            >
              打开
            </Button>
          </Descriptions.Item>
        </Descriptions>
      </Card>

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

      <Card title="AI 服务" size="small" style={{ marginBottom: 16 }}>
        <p style={{ color: '#999' }}>AI 服务设置将在 M2 版本中实现</p>
      </Card>

      <Card title="关于" size="small">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="版本">0.1.0 (M1)</Descriptions.Item>
          <Descriptions.Item label="说明">
            小学英语校考知识点分析工作台 — 帮助教师分析试卷中的知识点分布和考频趋势
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  )
}
