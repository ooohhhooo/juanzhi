import React, { useState, useEffect } from 'react'
import { Modal, Form, Select, InputNumber, Input, App, Dropdown } from 'antd'
import { ClipboardCheck, Eye, Inbox, MoreHorizontal, Plus, Zap } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { paperKind, paperTag } from '../status'
import { Btn, Icon, IndexTable, Page, StatusLabel } from '../design'
import '../design/page-library.css'
import { useImportFlow } from '../hooks/useImportFlow'
import { useDiscardGuard } from '../hooks/useDiscardGuard'
import RetryActions from '../components/RetryActions'
import Onboarding from '../components/Onboarding'
import RoleGuide from '../components/RoleGuide'
import SimilarNotice from '../components/SimilarNotice'

const gradeOptions = ['1', '2', '3', '4', '5', '6'].map(v => ({ label: `${v}年级`, value: v }))
const semesterOptions = [{ label: '上学期', value: '上' }, { label: '下学期', value: '下' }]
const examTypeOptions = ['单元测试', '期中', '期末', '月考', '其他'].map(v => ({ label: v, value: v }))

/** 哪些字段是 AI 预填的（用户改过就不再算） */
export function aiFieldsOf(p: Paper): string[] {
  try { return p.ai_meta_json ? JSON.parse(p.ai_meta_json) : [] } catch { return [] }
}
export const AiGuessTag = () => <span className="ewb-lib-guess" data-testid="ai-guess" title="这一项是 AI 从卷头读出来的，不一定对。你核对过、点「确认整份试卷」或改过它，这个提示就会消失">AI 猜的，请确认</span>

const FIELD_LABEL: Record<string, string> = { title: '标题', grade: '年级', semester: '学期', school_year_start: '学年', exam_type: '类型', textbook: '教材', total_score: '总分' }
/** 试卷库每行只标一次：这份卷子有 AI 从卷头读出来的信息，悬停看是哪几项 */
export const AiGuessRow = ({ fields }: { fields: string[] }) => (
  <span className="ewb-lib-guess ewb-lib-guess--row" data-testid="ai-guess" title={`AI 从卷头读出来的：${fields.map(f => FIELD_LABEL[f] ?? f).join('、')}，不一定对。你核对过、点「确认整份试卷」或改过它，这个提示就会消失`}>AI 猜的，请确认</span>
)

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

  // 词条式行：一份卷子一行，标题加粗，下面一行年级 · 学期 · 学年 · 类型 · 页数；只有一个主操作胶囊，其余收进「更多」
  const confirmDelete = (p: Paper) => modal.confirm({
    title: '确定删除？', content: `「${p.title || p.file_name}」和它的页面图、题目都会删掉，不能恢复。`, okText: '删除', cancelText: '取消', okButtonProps: { danger: true, 'data-testid': 'delete-confirm' } as any,
    onOk: () => handleDelete(p.id)
  })
  const columns = [
    {
      title: '试卷',
      dataIndex: 'title',
      key: 'title',
      render: (text: string, record: Paper) => {
        const ai = aiFieldsOf(record)
        return (
          <div className="ewb-lib-papercell">
            <div className="ewb-lib-papertitle">
              <a onClick={() => navigate(`/paper/${record.id}`)}>{text || record.file_name}</a>
              <SimilarNotice paper={record} compact />
              {ai.length > 0 && <AiGuessRow fields={ai} />}
              {record.is_sample === 1 && <span className="ewb-lib-tag" style={{ marginInlineStart: 8 }} data-testid="sample-tag">示例</span>}
            </div>
            <div className="ewb-lib-meta">
              <span>{record.grade ? `${record.grade}年级` : '年级 -'}</span>
              <span>{record.semester ?? '学期 -'}</span>
              <span>{record.school_year_start ? `${record.school_year_start}-${record.school_year_start + 1}` : '学年 -'}</span>
              <span>{record.exam_type ?? '类型 -'}</span>
              <span>{record.page_count} 页</span>
            </div>
          </div>
        )
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 128,
      render: (_: string, record: Paper) => {
        const t = paperTag(record, progress[record.id])
        return <StatusLabel kind={paperKind(record)} title={t.title}>{t.label}</StatusLabel>
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_: unknown, record: Paper) => {
        const canRework = record.status === 'extracted' || record.status === 'done' || record.status === 'reviewing'
        const reviewable = record.status === 'reviewing' || record.status === 'done'
        const items = [
          { key: 'view', label: <span data-testid="view-paper">查看原卷</span> },
          { key: 'edit', label: <span data-testid="edit-paper" title="修改年级、学年、教材等信息">改信息</span> },
          ...(canRework ? [{ key: 'reprocess', label: <span data-testid="reprocess" title="重新读取文件（会清除已整理好的题目）">重新读取</span> }] : []),
          { key: 'delete', danger: true, label: <span data-testid="delete-paper">删除</span> }
        ]
        const onMenu = ({ key }: { key: string }) => {
          if (key === 'view') navigate(`/paper/${record.id}`)
          else if (key === 'edit') handleEdit(record)
          else if (key === 'reprocess') void confirmReprocess(record)
          else if (key === 'delete') confirmDelete(record)
        }
        return (
          <div className="ewb-lib-ops">
            {record.status === 'failed' && <RetryActions paper={record} />}
            {record.status === 'extracted' && (
              <Btn tone="secondary" size="small" icon={Zap} title="让 AI 读出题目并标上知识点" data-testid="parse-paper" onClick={() => handleParse(record.id)}>AI 解析</Btn>
            )}
            {reviewable && (
              <Btn tone="secondary" size="small" icon={ClipboardCheck} title="核对 AI 标的题" data-testid="open-review" onClick={() => navigate(`/review/${record.id}`)}>去审核</Btn>
            )}
            {!reviewable && record.status !== 'extracted' && record.status !== 'failed' && (
              <Btn tone="secondary" size="small" icon={Eye} data-testid="open-paper" onClick={() => navigate(`/paper/${record.id}`)}>查看</Btn>
            )}
            <Dropdown trigger={['click']} menu={{ items, onClick: onMenu }}>
              <Btn tone="quiet" size="small" icon={MoreHorizontal} data-testid="more-menu" aria-label={`更多操作：${record.title || record.file_name}`}>更多</Btn>
            </Dropdown>
          </div>
        )
      }
    }
  ]

  return (
    <Page>
      <div className="ewb-lib-head">
        <h1 className="ewb-lib-title">试卷库</h1>
        <div className="ewb-lib-actions">
          <Btn tone="primary" icon={Plus} onClick={handleImportFiles} loading={importing}>导入试卷</Btn>
        </div>
      </div>

      <RoleGuide />
      <Onboarding />

      <div
        data-testid="dropzone"
        data-over={dragOver ? 'true' : 'false'}
        className="ewb-lib-drop"
        role="button"
        tabIndex={0}
        onDrop={handleNativeDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleImportFiles}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleImportFiles() } }}
      >
        <div className="ewb-lib-drop__icon"><Icon as={Inbox} size={32} /></div>
        <p className="ewb-lib-drop__main">拖拽试卷文件到此处，或点击选择</p>
        <p className="ewb-lib-drop__sub">支持 PDF、JPG/PNG/HEIC、DOCX（不支持 .doc，请先另存为 .docx）</p>
      </div>

      <IndexTable
        dataSource={papers}
        columns={columns}
        rowKey="id"
        loading={isLoading || importing}
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
          <div className="ewb-lib-formrow">
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
          </div>
          <Form.Item name="textbook" label={<span>教材版本{editPaper && aiFieldsOf(editPaper).includes('textbook') && <AiGuessTag />}</span>}>
            <Input placeholder="如 PEP 三年级起点" />
          </Form.Item>
          <div className="ewb-lib-formrow">
            <Form.Item name="region" label="地区">
              <Input />
            </Form.Item>
            <Form.Item name="school" label="学校">
              <Input />
            </Form.Item>
            <Form.Item name="total_score" label={<span>总分{editPaper && aiFieldsOf(editPaper).includes('total_score') && <AiGuessTag />}</span>}>
              <InputNumber min={0} max={200} precision={0} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </Page>
  )
}
