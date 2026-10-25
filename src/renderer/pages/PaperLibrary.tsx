import React, { useState, useCallback, useEffect } from 'react'
import {
  Button, Table, Tag, Space, Modal, Form, Select, InputNumber, Input,
  message, Popconfirm, Typography
} from 'antd'
import { PlusOutlined, InboxOutlined, EditOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

const gradeOptions = ['1', '2', '3', '4', '5', '6'].map(v => ({ label: `${v}年级`, value: v }))
const semesterOptions = [{ label: '上学期', value: '上' }, { label: '下学期', value: '下' }]
const examTypeOptions = ['单元测试', '期中', '期末', '月考', '其他'].map(v => ({ label: v, value: v }))

const statusMap: Record<string, { color: string; label: string }> = {
  imported: { color: 'default', label: '排队中' },
  extracting: { color: 'processing', label: '提取中' },
  parsing: { color: 'processing', label: '解析中' },
  reviewing: { color: 'warning', label: '待审核' },
  done: { color: 'success', label: '已提取' },
  failed: { color: 'error', label: '失败' }
}

export default function PaperLibrary() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [importing, setImporting] = useState(false)
  const [editPaper, setEditPaper] = useState<Paper | null>(null)
  const [editForm] = Form.useForm()
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})

  useEffect(() => {
    if (!window.api?.on) return
    return window.api.on('job:progress', (p: JobProgress) => {
      setProgress(prev => ({ ...prev, [p.paperId]: p }))
    })
  }, [])

  // 拖到拖拽区之外时不让浏览器把文件当页面打开
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  const { data: papers = [], isLoading } = useQuery({
    queryKey: ['papers'],
    queryFn: () => window.api.papers.list()
  })

  const handleImportFiles = useCallback(async () => {
    const paths = await window.api.dialog.openFiles()
    if (!paths.length) return
    await doImport(paths)
  }, [])

  const doImport = async (paths: string[]) => {
    setImporting(true)
    try {
      const results = await window.api.papers.import(paths)
      const ok = results.filter(r => r.paperId)
      if (ok.length) message.success(`已加入处理队列：${ok.length} 份`)
      for (const f of results.filter(r => r.error)) {
        message.warning(`${f.fileName}：${f.error}`)
      }
      queryClient.invalidateQueries({ queryKey: ['papers'] })
    } catch (err) {
      message.error(`导入失败: ${(err as Error).message}`)
    } finally {
      setImporting(false)
    }
  }

  const [dragOver, setDragOver] = useState(false)

  const handleNativeDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)

    if (!window.api?.getPathForFile) {
      message.error('拖拽导入不可用（请在 Electron 中运行）')
      return
    }

    const files: string[] = []
    const dt = e.dataTransfer
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i]
      try {
        const p = window.api.getPathForFile(f)
        if (p) files.push(p)
      } catch {
        // 无法获取路径
      }
    }
    if (files.length === 0) {
      message.warning('无法获取文件路径')
      return
    }
    await doImport(files)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

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
    await window.api.papers.update(editPaper.id, meta)
    message.success('已保存')
    setEditPaper(null)
    queryClient.invalidateQueries({ queryKey: ['papers'] })
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
        <a onClick={() => navigate(`/paper/${record.id}`)}>{text || record.file_name}</a>
      )
    },
    {
      title: '年级',
      dataIndex: 'grade',
      key: 'grade',
      width: 80,
      render: (v: string | null) => v ? `${v}年级` : '-'
    },
    {
      title: '学期',
      dataIndex: 'semester',
      key: 'semester',
      width: 80,
      render: (v: string | null) => v || '-'
    },
    {
      title: '学年',
      dataIndex: 'school_year_start',
      key: 'school_year_start',
      width: 100,
      render: (v: number | null) => v ? `${v}-${v + 1}` : '-'
    },
    {
      title: '类型',
      dataIndex: 'exam_type',
      key: 'exam_type',
      width: 100,
      render: (v: string | null) => v || '-'
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
      width: 90,
      render: (status: string, record: Paper) => {
        const s = statusMap[status] || { color: 'default', label: status }
        const p = progress[record.id]
        const running = status === 'extracting' && p
        const warn = status === 'done' && record.error
        return (
          <Tag color={warn ? 'warning' : s.color} title={record.error || undefined}>
            {running ? `${s.label} ${p.progress}%` : warn ? '已提取·缺文字' : s.label}
          </Tag>
        )
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: unknown, record: Paper) => (
        <Space size="small">
          <Button type="text" size="small" icon={<EyeOutlined />}
            onClick={() => navigate(`/paper/${record.id}`)} />
          <Button type="text" size="small" icon={<EditOutlined />}
            onClick={() => handleEdit(record)} />
          {(record.status === 'failed' || record.status === 'done') && (
            <Button type="text" size="small" icon={<ReloadOutlined />} title="重新提取"
              data-testid="reprocess" onClick={() => handleReprocess(record.id)} />
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
          <Form.Item name="title" label="标题">
            <Input />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="grade" label="年级">
              <Select options={gradeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="semester" label="学期">
              <Select options={semesterOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="school_year_start" label="学年起始">
              <InputNumber min={2000} max={2100} placeholder="如 2025" />
            </Form.Item>
            <Form.Item name="exam_type" label="考试类型">
              <Select options={examTypeOptions} allowClear style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="textbook" label="教材版本">
            <Input placeholder="如 PEP 三年级起点" />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="region" label="地区">
              <Input />
            </Form.Item>
            <Form.Item name="school" label="学校">
              <Input />
            </Form.Item>
            <Form.Item name="total_score" label="总分">
              <InputNumber min={0} max={200} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
