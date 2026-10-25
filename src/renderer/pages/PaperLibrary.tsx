import React, { useState, useEffect } from 'react'
import {
  Button, Table, Tag, Space, Modal, Form, Select, InputNumber, Input,
  App, Popconfirm
} from 'antd'
import { PlusOutlined, InboxOutlined, EditOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined, ThunderboltOutlined, CheckSquareOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { paperTag } from '../status'
import { useImportFlow } from '../hooks/useImportFlow'
import { useDiscardGuard } from '../hooks/useDiscardGuard'

const gradeOptions = ['1', '2', '3', '4', '5', '6'].map(v => ({ label: `${v}年级`, value: v }))
const semesterOptions = [{ label: '上学期', value: '上' }, { label: '下学期', value: '下' }]
const examTypeOptions = ['单元测试', '期中', '期末', '月考', '其他'].map(v => ({ label: v, value: v }))

/** 哪些字段是 AI 预填的（用户改过就不再算） */
export function aiFieldsOf(p: Paper): string[] {
  try { return p.ai_meta_json ? JSON.parse(p.ai_meta_json) : [] } catch { return [] }
}
export const AiGuessTag = () => <Tag color="purple" style={{ marginInlineStart: 4, fontSize: 11, lineHeight: '16px' }} data-testid="ai-guess">AI 猜测</Tag>

export default function PaperLibrary() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message, modal } = App.useApp()
  const { importPaths, pathsFromDrop } = useImportFlow()
  const discardGuard = useDiscardGuard()
  const [importing, setImporting] = useState(false)
  const [editPaper, setEditPaper] = useState<Paper | null>(null)
  const [editForm] = Form.useForm()
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (!window.api?.on) return
    return window.api.on('job:progress', (p: JobProgress) => {
      setProgress(prev => ({ ...prev, [p.paperId]: p }))
    })
  }, [])

  const { data: papers = [], isLoading } = useQuery({
    queryKey: ['papers'],
    queryFn: () => window.api.papers.list()
  })

  const doImport = async (paths: string[]) => {
    setImporting(true)
    try { await importPaths(paths) } finally { setImporting(false) }
  }

  const handleImportFiles = async () => {
    const paths = await window.api.dialog.openFiles()
    if (paths.length) await doImport(paths)
  }

  const handleNativeDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.nativeEvent as any).__ewbHandled = true
    setDragOver(false)
    const paths = pathsFromDrop(e.dataTransfer)
    if (paths.length) await doImport(paths)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }

  const handleEdit = (paper: Paper) => {
    setEditPaper(paper)
    editForm.setFieldsValue({
      title: paper.title,
      grade: paper.grade,
      semester: paper.semester,
      school_year_start: paper.school_year_start,
      exam_type: paper.exam_type,
      textbook: paper.textbook,
      region: paper.region,
      school: paper.school,
      total_score: paper.total_score
    })
  }

  const handleEditSave = async () => {
    const values = await editForm.validateFields()
    if (!editPaper) return
    // 清空的字段是 undefined，经 IPC 序列化会丢失；显式转成 null 才能真正清除
    const meta: Record<string, unknown> = { ...values }
    for (const k of ['grade', 'semester', 'school_year_start', 'exam_type', 'textbook', 'region', 'school', 'total_score']) {
      if (meta[k] === undefined || meta[k] === '') meta[k] = null
    }
    try {
      await window.api.papers.update(editPaper.id, meta)
      message.success('已保存')
      setEditPaper(null)
      queryClient.invalidateQueries({ queryKey: ['papers'] })
    } catch (err) {
      message.error(`保存失败：${(err as Error).message.replace(/^Error invoking remote method '[^']+': /, '')}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.api.papers.remove(id)
      message.success('已删除')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
    queryClient.invalidateQueries({ queryKey: ['papers'] })
  }

  const handleParse = async (id: string) => {
    try {
      await window.api.parse.start(id)
      message.success('已加入 AI 解析队列')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  const confirmReprocess = async (p: Paper) => {
    if (await discardGuard(p, 'extract')) await handleReprocess(p.id)
  }

  const handleReprocess = async (id: string) => {
    try {
      await window.api.papers.reprocess(id)
      message.success('已重新加入处理队列')
    } catch (err) {
      message.error((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }
  }

  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: Paper) => (
        <span>
          <a onClick={() => navigate(`/paper/${record.id}`)}>{text || record.file_name}</a>
          {aiFieldsOf(record).includes('title') && <AiGuessTag />}
        </span>
      )
    },
    {
      title: '年级',
      dataIndex: 'grade',
      key: 'grade',
      width: 80,
      render: (v: string | null, r: Paper) => v ? <span>{v}年级{aiFieldsOf(r).includes('grade') && <AiGuessTag />}</span> : '-'
    },
    {
      title: '学期',
      dataIndex: 'semester',
      key: 'semester',
      width: 110,
      render: (v: string | null, r: Paper) => v ? <span>{v}{aiFieldsOf(r).includes('semester') && <AiGuessTag />}</span> : '-'
    },
    {
      title: '学年',
      dataIndex: 'school_year_start',
      key: 'school_year_start',
      width: 150,
      render: (v: number | null, r: Paper) => v ? <span>{v}-{v + 1}{aiFieldsOf(r).includes('school_year_start') && <AiGuessTag />}</span> : '-'
    },
    {
      title: '类型',
      dataIndex: 'exam_type',
      key: 'exam_type',
      width: 130,
      render: (v: string | null, r: Paper) => v ? <span>{v}{aiFieldsOf(r).includes('exam_type') && <AiGuessTag />}</span> : '-'
    },
    {
      title: '页数',
      dataIndex: 'page_count',
      key: 'page_count',
      width: 60
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (_: string, record: Paper) => {
        const t = paperTag(record, progress[record.id])
        return <Tag color={t.color} title={t.title}>{t.label}</Tag>
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_: unknown, record: Paper) => (
        <Space size="small">
          <Button type="text" size="small" icon={<EyeOutlined />}
            onClick={() => navigate(`/paper/${record.id}`)} />
          <Button type="text" size="small" icon={<EditOutlined />}
            onClick={() => handleEdit(record)} />
          {record.status === 'extracted' && (
            <Button type="text" size="small" icon={<ThunderboltOutlined />} title="AI 解析"
              data-testid="parse-paper" onClick={() => handleParse(record.id)} />
          )}
          {(record.status === 'reviewing' || record.status === 'done') && (
            <Button type="text" size="small" icon={<CheckSquareOutlined />} title="审核"
              data-testid="open-review" onClick={() => navigate(`/review/${record.id}`)} />
          )}
          {(record.status === 'failed' || record.status === 'extracted' || record.status === 'done' || record.status === 'reviewing') && (
            <Button type="text" size="small" icon={<ReloadOutlined />} title="重新提取（会清除已解析的题目）"
              data-testid="reprocess" onClick={() => confirmReprocess(record)} />
          )}
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: '#1e2952' }}>试卷库</h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleImportFiles}
          loading={importing}
        >
          导入试卷
        </Button>
      </div>

      <div
        data-testid="dropzone"
        onDrop={handleNativeDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleImportFiles}
        style={{
          marginBottom: 16, padding: '20px 0', textAlign: 'center',
          border: `1px dashed ${dragOver ? '#1e2952' : '#d9d9d9'}`,
          borderRadius: 8, cursor: 'pointer', transition: 'border-color 0.2s',
          background: dragOver ? '#f0f2ff' : '#fafafa'
        }}
      >
        <p style={{ fontSize: 36, color: '#999', margin: '0 0 8px' }}><InboxOutlined /></p>
        <p style={{ fontSize: 14, color: 'rgba(0,0,0,0.85)' }}>拖拽试卷文件到此处，或点击选择</p>
        <p style={{ fontSize: 12, color: '#999' }}>支持 PDF、JPG/PNG/HEIC、DOCX（不支持 .doc，请先另存为 .docx）</p>
      </div>

      <Table
        dataSource={papers}
        columns={columns}
        rowKey="id"
        loading={isLoading || importing}
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: false }}
      />

      <Modal
        title="编辑试卷信息"
        open={!!editPaper}
        onOk={handleEditSave}
        onCancel={() => setEditPaper(null)}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" size="middle">
          <Form.Item name="title" label={<span>标题{editPaper && aiFieldsOf(editPaper).includes('title') && <AiGuessTag />}</span>}>
            <Input />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="grade" label={<span>年级{editPaper && aiFieldsOf(editPaper).includes('grade') && <AiGuessTag />}</span>}>
              <Select options={gradeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="semester" label={<span>学期{editPaper && aiFieldsOf(editPaper).includes('semester') && <AiGuessTag />}</span>}>
              <Select options={semesterOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="school_year_start" label={<span>学年起始{editPaper && aiFieldsOf(editPaper).includes('school_year_start') && <AiGuessTag />}</span>}>
              <InputNumber min={2000} max={2100} placeholder="如 2025" />
            </Form.Item>
            <Form.Item name="exam_type" label={<span>考试类型{editPaper && aiFieldsOf(editPaper).includes('exam_type') && <AiGuessTag />}</span>}>
              <Select options={examTypeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="textbook" label={<span>教材版本{editPaper && aiFieldsOf(editPaper).includes('textbook') && <AiGuessTag />}</span>}>
            <Input placeholder="如 PEP 三年级起点" />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="region" label="地区">
              <Input />
            </Form.Item>
            <Form.Item name="school" label="学校">
              <Input />
            </Form.Item>
            <Form.Item name="total_score" label={<span>总分{editPaper && aiFieldsOf(editPaper).includes('total_score') && <AiGuessTag />}</span>}>
              <InputNumber min={0} max={200} precision={0} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
