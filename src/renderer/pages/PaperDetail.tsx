import React, { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Spin, Tag, Descriptions, Switch, Empty, Space } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'

export default function PaperDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [showOcr, setShowOcr] = useState(false)
  const [selectedPage, setSelectedPage] = useState(0)

  const { data: paper, isLoading: paperLoading } = useQuery({
    queryKey: ['papers', id],
    queryFn: () => window.api.papers.get(id!),
    enabled: !!id
  })

  const { data: pages = [], isLoading: pagesLoading } = useQuery({
    queryKey: ['pages', id],
    queryFn: () => window.api.papers.pages(id!),
    enabled: !!id
  })

  const currentPage = pages[selectedPage]
  const ocrLines: OcrLine[] = useMemo(() => {
    if (!currentPage) return []
    try { return JSON.parse(currentPage.lines_json) }
    catch { return [] }
  }, [currentPage])

  if (paperLoading || pagesLoading) {
    return <div style={{ padding: 40, textAlign: 'center' }}><Spin size="large" /></div>
  }

  if (!paper) {
    return <Empty description="试卷未找到" style={{ marginTop: 80 }} />
  }

  const statusMap: Record<string, { color: string; label: string }> = {
    imported: { color: 'default', label: '排队中' },
    extracting: { color: 'processing', label: '提取中' },
    parsing: { color: 'processing', label: '解析中' },
    reviewing: { color: 'warning', label: '待审核' },
    done: { color: 'success', label: '已提取' },
    failed: { color: 'error', label: '失败' }
  }
  const s = statusMap[paper.status] || { color: 'default', label: paper.status }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <h2 style={{ margin: 0, color: '#1e2952' }}>{paper.title || paper.file_name}</h2>
        <Tag color={s.color}>{s.label}</Tag>
      </div>

      <Descriptions size="small" column={4} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="年级">
          {paper.grade ? `${paper.grade}年级` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="学期">{paper.semester || '-'}</Descriptions.Item>
        <Descriptions.Item label="学年">
          {paper.school_year_start ? `${paper.school_year_start}-${paper.school_year_start + 1}` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="类型">{paper.exam_type || '-'}</Descriptions.Item>
        <Descriptions.Item label="页数">{paper.page_count}</Descriptions.Item>
        <Descriptions.Item label="文件">{paper.file_name}</Descriptions.Item>
        <Descriptions.Item label="导入时间">{paper.created_at}</Descriptions.Item>
      </Descriptions>

      {pages.length > 0 && (
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ width: 80, flexShrink: 0 }}>
            {pages.map((p, i) => (
              <div
                key={p.id}
                onClick={() => setSelectedPage(i)}
                style={{
                  cursor: 'pointer',
                  padding: 4,
                  marginBottom: 8,
                  border: i === selectedPage ? '2px solid #1e2952' : '1px solid #d9d9d9',
                  borderRadius: 4,
                  textAlign: 'center',
                  fontSize: 12,
                  color: '#666',
                  background: i === selectedPage ? '#f0f2ff' : '#fff'
                }}
              >
                <img
                  src={`ewb://page/${paper.id}/${p.image_rel}`}
                  alt={`第${p.idx}页`}
                  style={{ width: '100%', display: 'block' }}
                />
                <span>第{p.idx}页</span>
              </div>
            ))}
          </div>

          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{ marginBottom: 8 }}>
              <Space>
                <span style={{ fontSize: 13, color: '#666' }}>
                  文字来源: {currentPage?.text_source || '-'}
                </span>
                <Switch
                  checked={showOcr}
                  onChange={setShowOcr}
                  checkedChildren="OCR 叠加"
                  unCheckedChildren="OCR 叠加"
                  size="small"
                />
              </Space>
            </div>
            {currentPage && currentPage.image_rel && (
              <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
                <img
                  src={`ewb://page/${paper.id}/${currentPage.image_rel}`}
                  alt={`第${currentPage.idx}页`}
                  style={{ maxWidth: '100%', display: 'block', border: '1px solid #e8e8e8' }}
                />
                {showOcr && ocrLines.length > 0 && (
                  <svg
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'none'
                    }}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    {ocrLines.map((line, i) => (
                      <g key={i}>
                        <rect
                          x={line.x}
                          y={line.y}
                          width={line.w}
                          height={line.h}
                          fill="rgba(30, 41, 82, 0.08)"
                          stroke="rgba(30, 41, 82, 0.3)"
                          strokeWidth={0.001}
                        />
                      </g>
                    ))}
                  </svg>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {currentPage && !currentPage.image_rel && currentPage.text && (
        <div style={{
          flex: 1, padding: 16, border: '1px solid #e8e8e8', borderRadius: 4,
          background: '#fafafa', whiteSpace: 'pre-wrap', fontSize: 14,
          lineHeight: 1.8, maxHeight: 600, overflow: 'auto'
        }}>
          {currentPage.text}
        </div>
      )}

      {currentPage?.text_source === 'needs_ocr' && (
        <div style={{ padding: 16, background: '#fff7e6', border: '1px solid #ffe58f', borderRadius: 4, marginTop: 8 }}>
          此页面缺少 OCR 识别结果（当前平台不支持 OCR），文字内容可能不完整。
        </div>
      )}

      {pages.length === 0 && paper.status === 'done' && (
        <Empty description="暂无页面数据" />
      )}

      {paper.status === 'done' && paper.error && (
        <div style={{ padding: 16, background: '#fff7e6', border: '1px solid #ffe58f', borderRadius: 4, marginTop: 8 }}>
          提示：{paper.error}
        </div>
      )}

      {paper.status === 'failed' && paper.error && (
        <div style={{ padding: 16, background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 4, marginTop: 8 }}>
          提取失败：{paper.error}
        </div>
      )}
    </div>
  )
}
