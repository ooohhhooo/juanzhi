import React, { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Spin, Tag, Descriptions, Switch, Empty, Space } from 'antd'
import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons'
import { paperTag, textSourceLabel } from '../status'

const noticeStyle = (kind: 'warn' | 'error'): React.CSSProperties => ({
  padding: 12, borderRadius: 4, marginTop: 8, fontSize: 13,
  background: kind === 'warn' ? '#fff7e6' : '#fff1f0',
  border: `1px solid ${kind === 'warn' ? '#ffe58f' : '#ffa39e'}`
})

/** docx 页：按 [图n] 占位把提取出来的图片内联到文本里 */
function DocxView({ paperId, text, assets }: { paperId: string; text: string; assets: PaperAsset[] }) {
  const parts = text.split(/(\[图\d+\])/g)
  return (
    <div data-testid="docx-view" style={{
      padding: 16, border: '1px solid #e8e8e8', borderRadius: 4, background: '#fafafa',
      whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8, maxHeight: 640, overflow: 'auto'
    }}>
      {parts.map((part, i) => {
        const m = /^\[图(\d+)\]$/.exec(part)
        if (!m) return <React.Fragment key={i}>{part}</React.Fragment>
        const asset = assets.find(a => a.seq === Number(m[1]))
        if (!asset) return <React.Fragment key={i}>{part}</React.Fragment>
        const file = asset.rel_path.split('/').pop()
        return (
          <img key={i} data-testid="docx-image" alt={part}
            src={`ewb://media/${paperId}/${file}`}
            style={{ display: 'block', maxWidth: '100%', margin: '8px 0', border: '1px solid #e8e8e8', background: '#fff' }} />
        )
      })}
    </div>
  )
}

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

  const { data: assets = [] } = useQuery({
    queryKey: ['assets', id],
    queryFn: () => window.api.papers.assets(id!),
    enabled: !!id
  })

  const currentPage = pages[selectedPage]
  const hasImage = !!currentPage?.image_rel
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

  const tag = paperTag(paper)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <h2 style={{ margin: 0, color: '#1e2952' }}>{paper.title || paper.file_name}</h2>
        <Tag color={tag.color}>{tag.label}</Tag>
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

      {paper.warning && (
        <div data-testid="paper-warning" style={noticeStyle('warn')}>提示：{paper.warning}</div>
      )}
      {paper.status === 'failed' && paper.error && (
        <div style={noticeStyle('error')}>提取失败：{paper.error}</div>
      )}

      {pages.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
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
                {p.image_rel ? (
                  <img
                    src={`ewb://page/${paper.id}/${p.image_rel}`}
                    alt={`第${p.idx}页`}
                    style={{ width: '100%', display: 'block' }}
                  />
                ) : (
                  <div style={{ padding: '12px 0', fontSize: 22, color: '#8c8c8c' }}><FileTextOutlined /></div>
                )}
                <span>第{p.idx}页</span>
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ marginBottom: 8 }}>
              <Space>
                <span style={{ fontSize: 13, color: '#666' }}>
                  文字来源: {textSourceLabel[currentPage?.text_source] ?? currentPage?.text_source ?? '-'}
                </span>
                {hasImage && (
                  <Switch
                    checked={showOcr}
                    onChange={setShowOcr}
                    checkedChildren="文字框叠加"
                    unCheckedChildren="文字框叠加"
                    size="small"
                  />
                )}
              </Space>
            </div>

            {currentPage?.text_source === 'ocr_failed' && (
              <div data-testid="ocr-failed" style={{ ...noticeStyle('error'), marginTop: 0, marginBottom: 8 }}>
                这一页的 OCR 没有成功：{currentPage.ocr_error || '原因未知'}
              </div>
            )}
            {currentPage?.text_source === 'needs_ocr' && (
              <div style={{ ...noticeStyle('warn'), marginTop: 0, marginBottom: 8 }}>
                当前平台暂不支持 OCR，这一页没有文字，只保存了页面图片。
              </div>
            )}
            {currentPage?.text_source === 'none' && (
              <div style={{ ...noticeStyle('warn'), marginTop: 0, marginBottom: 8 }}>
                OCR 已正常运行，但这一页没有识别出文字（可能是空白页或纯图片）。
              </div>
            )}

            {hasImage ? (
              <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
                <img
                  src={`ewb://page/${paper.id}/${currentPage.image_rel}`}
                  alt={`第${currentPage.idx}页`}
                  style={{ maxWidth: '100%', display: 'block', border: '1px solid #e8e8e8' }}
                />
                {showOcr && ocrLines.length > 0 && (
                  <svg
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    {ocrLines.map((line, i) => (
                      <rect
                        key={i}
                        x={line.x}
                        y={line.y}
                        width={line.w}
                        height={line.h}
                        fill="rgba(30, 41, 82, 0.08)"
                        stroke="rgba(30, 41, 82, 0.3)"
                        strokeWidth={0.001}
                      />
                    ))}
                  </svg>
                )}
              </div>
            ) : currentPage?.text ? (
              <DocxView paperId={paper.id} text={currentPage.text} assets={assets.filter(a => a.page_idx === currentPage.idx)} />
            ) : (
              <Empty description="这一页没有可显示的内容" />
            )}
          </div>
        </div>
      )}

      {pages.length === 0 && paper.status !== 'failed' && (
        <Empty description="暂无页面数据" style={{ marginTop: 24 }} />
      )}
    </div>
  )
}
