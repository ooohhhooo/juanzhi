import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Collapse, Input, InputNumber, Modal, Rate, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { CheckOutlined, DeleteOutlined, MergeCellsOutlined, PlusOutlined, SplitCellsOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { KpMultiSelect, KpSelect } from '../../components/KpTreeSelect'
import { flagLabel, difficultyLabel } from '../../status'

interface Props {
  q: QuestionView
  index: number
  total: number
  /** 低置信度阈值（由主进程给出） */
  lowConfidence: number
  kps: KpNode[] | undefined
  qtypes: QtypeRow[] | undefined
  material?: { mid: string; kind: string; text: string }
  hasNext: boolean
  /** 保存字段修改（父组件负责防抖合并与写库） */
  onPatch: (patch: QuestionPatch) => void
  onConfirm: () => void
  onSplit: () => void
  onMerge: () => void
  /** 拆分/合并/删除进行中：禁用这些按钮，避免连点把后面的题也并进来（合并不可撤销） */
  busy?: boolean
  /** 这道题还有没写库的本地修改：此时别用服务端数据覆盖表单里的知识点（重新拉取可能带回旧值） */
  localEdits?: boolean
  onRemove: () => void
  onApprove: (body: { parent_code: string | null; name: string }) => Promise<void>
  onReject: () => void
}

const kindLabel: Record<string, string> = { passage: '短文', dialogue: '对话', word_bank: '词库', listening_script: '听力原文', table: '表格', other: '材料' }

export default function QuestionForm(p: Props) {
  const { q } = p
  // 本地草稿：输入时立刻反映，同时把修改交给父组件防抖保存。换题时重置
  // 父组件按题目 id 设了 key：换题时整个表单重新挂载，草稿与题目同一帧切换，不会出现「标题已是新题、输入框还是旧题内容」的空档
  const [d, setD] = useState(q)
  // 同一道题被外部更新（采纳建议、重新定位）时，只同步由主进程决定的字段
  // 依赖里用 join 后的字符串而不是数组本身：每次重新拉取都会得到新数组，直接依赖数组会在用户刚改完次知识点时把它盖回旧值
  const secondaryKey = q.kp_secondary.join(',')
  useEffect(() => {
    if (p.localEdits) return
    setD(prev => prev.id === q.id ? { ...prev, kp_main: q.kp_main, kp_secondary: secondaryKey ? secondaryKey.split(',') : [], kp_suggestion_status: q.kp_suggestion_status, reviewed: q.reviewed } : prev)
  }, [q.kp_main, secondaryKey, q.kp_suggestion_status, q.reviewed, q.id, p.localEdits])

  const set = (patch: Partial<QuestionView>, send: QuestionPatch = patch as QuestionPatch) => {
    setD(prev => ({ ...prev, ...patch }))
    p.onPatch(send)
  }

  const qtypeOptions = useMemo(() => {
    const groups: Record<string, { label: string; options: Array<{ label: string; value: string }> }> = {
      listening: { label: '听力题型', options: [] }, written: { label: '笔试题型', options: [] }
    }
    for (const t of p.qtypes ?? []) (groups[t.group] ?? groups.written).options.push({ label: `${t.name}（${t.code}）`, value: t.code })
    return Object.values(groups).filter(g => g.options.length)
  }, [p.qtypes])

  const kpName = (code: string | null) => (code ? p.kps?.find(k => k.code === code)?.name ?? code : '')
  const attention = q.confidence < p.lowConfidence
  const suggestionPending = !!q.kp_suggestion && q.kp_suggestion_status === 'pending'

  const [approveOpen, setApproveOpen] = useState(false)
  const [approveParent, setApproveParent] = useState<string | null>(null)
  const [approveName, setApproveName] = useState('')
  const [approving, setApproving] = useState(false)

  const openApprove = () => {
    const mainNode = p.kps?.find(k => k.code === q.kp_main)
    setApproveParent(mainNode ? (mainNode.level >= 3 ? mainNode.parent_code : mainNode.code) : null)
    setApproveName(q.kp_suggestion.replace(/^待归类：/, '').slice(0, 30))
    setApproveOpen(true)
  }

  return (
    <div data-testid="question-form" style={{ padding: '12px 16px', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={5} style={{ margin: 0 }} data-testid="form-title">
          {q.section ? `${q.section}、` : ''}第 {q.no} 题
        </Typography.Title>
        <span style={{ color: '#999', fontSize: 12 }}>{index(p)} · 第 {q.page_idx ?? '?'} 页</span>
        <Tooltip title="置信度由程序按标记与定位结果折算，低于 70% 会在左侧标黄">
          <Tag color={attention ? 'gold' : 'green'} style={{ marginLeft: 'auto' }}>置信度 {Math.round(q.confidence * 100)}%</Tag>
        </Tooltip>
      </div>
      {(q.flags.length > 0) && (
        <div style={{ marginBottom: 8 }} data-testid="flags">
          {q.flags.map(f => (
            <Tooltip key={f} title={flagLabel[f]?.hint ?? f}><Tag color="warning">{flagLabel[f]?.text ?? f}</Tag></Tooltip>
          ))}
        </div>
      )}

      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input addonBefore="大题" style={{ width: '38%' }} value={d.section} onChange={e => set({ section: e.target.value })} />
        <Input addonBefore="题号" style={{ width: '32%' }} data-testid="f-no" value={d.no} onChange={e => e.target.value.trim() && set({ no: e.target.value }, { no_label: e.target.value.trim() })} />
        <InputNumber addonBefore="分值" style={{ width: '30%' }} min={0} max={200} value={d.score} data-testid="f-score" onChange={v => set({ score: v as number | null })} />
      </Space.Compact>

      <Label>题型</Label>
      <Select data-testid="f-qtype" style={{ width: '100%', marginBottom: 8 }} showSearch optionFilterProp="label" options={qtypeOptions} value={d.qtype} onChange={v => set({ qtype: v })} />

      {p.material && (
        <Collapse size="small" style={{ marginBottom: 8 }} items={[{
          key: 'm', label: `${kindLabel[p.material.kind] ?? '材料'}（本题引用）`,
          children: <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, maxHeight: 160, overflow: 'auto' }}>{p.material.text}</div>
        }]} />
      )}

      <Label>题干</Label>
      <Input.TextArea data-testid="f-stem" autoSize={{ minRows: 2, maxRows: 8 }} value={d.stem} onChange={e => set({ stem: e.target.value })} style={{ marginBottom: 8 }} />

      <Label>选项</Label>
      <div style={{ marginBottom: 8 }}>
        {d.options.map((o, i) => (
          <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <Input data-testid={`f-option-${i}`} value={o} onChange={e => { const opts = d.options.map((x, j) => (j === i ? e.target.value : x)); set({ options: opts }) }} />
            <Button type="text" icon={<MinusCircleOutlined />} onClick={() => set({ options: d.options.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => set({ options: [...d.options, `${String.fromCharCode(65 + d.options.length)}. `] })}>添加选项</Button>
      </div>

      <Label hint="只有卷面上印刷的参考答案才会填；AI 不会自己做题">参考答案</Label>
      <Input value={d.answer} onChange={e => set({ answer: e.target.value })} style={{ marginBottom: 8 }} placeholder="（卷面没有就留空）" />

      <Label>知识点</Label>
      <div style={{ marginBottom: 4 }}>
        <KpSelect testId="f-kp-main" kps={p.kps} value={d.kp_main} placeholder="主知识点" onChange={v => set({ kp_main: v }, { kp_main: v })} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <KpMultiSelect kps={p.kps} value={d.kp_secondary} max={3} onChange={v => set({ kp_secondary: v })} />
      </div>

      {q.kp_suggestion && (
        <Alert
          data-testid="kp-suggestion" style={{ marginBottom: 8 }} type={suggestionPending ? 'warning' : 'info'} showIcon
          message={<span>AI 建议新增知识点：<b>{q.kp_suggestion}</b>
            {q.kp_suggestion_status === 'approved' && <Tag color="green" style={{ marginLeft: 8 }}>已采纳</Tag>}
            {q.kp_suggestion_status === 'rejected' && <Tag style={{ marginLeft: 8 }}>已忽略</Tag>}</span>}
          description={suggestionPending ? (
            <div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>知识点树不会被自动修改；采纳后才会新建节点，并作为本题主知识点（原主知识点「{kpName(q.kp_main)}」降为次知识点）。</div>
              <Space>
                <Button size="small" type="primary" data-testid="kp-approve" onClick={openApprove}>采纳…</Button>
                <Button size="small" data-testid="kp-reject" onClick={p.onReject}>忽略</Button>
              </Space>
            </div>
          ) : undefined}
        />
      )}

      <Space align="center" style={{ marginBottom: 8 }} wrap>
        <Label inline>难度</Label>
        <Rate data-testid="f-difficulty" value={d.difficulty} onChange={v => v > 0 && set({ difficulty: v })} />
        <Tag>{difficultyLabel[d.difficulty]}</Tag>
        <Tooltip title="难度由 AI 估计，不是学生得分统计"><Tag color="blue">估计</Tag></Tooltip>
      </Space>
      <div style={{ marginBottom: 8 }}>
        <Space align="center">
          <Label inline>易错</Label>
          <Switch data-testid="f-error-prone" checked={d.error_prone} onChange={v => set({ error_prone: v, ...(v ? {} : { error_reason: '' }) }, v ? { error_prone: true } : { error_prone: false, error_reason: '' })} />
          <Tag color="blue">估计</Tag>
        </Space>
        {d.error_prone && <Input data-testid="f-error-reason" style={{ marginTop: 4 }} placeholder="易错在哪（一句话）" maxLength={60} value={d.error_reason} onChange={e => set({ error_reason: e.target.value })} />}
      </div>

      <Space wrap style={{ marginTop: 12, paddingBottom: 16 }}>
        <Button type="primary" icon={<CheckOutlined />} data-testid="confirm-q" onClick={p.onConfirm}>
          {q.reviewed ? '已确认' : '确认'}{p.hasNext ? ' · 下一题' : ''}（Enter）
        </Button>
        <Button icon={<SplitCellsOutlined />} data-testid="split-q" disabled={p.busy} onClick={p.onSplit}>拆分</Button>
        <Button icon={<MergeCellsOutlined />} data-testid="merge-q" disabled={!p.hasNext || p.busy} onClick={p.onMerge}>与下一题合并</Button>
        <Button danger icon={<DeleteOutlined />} disabled={p.busy} onClick={() => Modal.confirm({ title: '删除这道题？', content: '删除后不可恢复。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: p.onRemove })}>删除</Button>
      </Space>

      <Modal
        title="采纳新增知识点" open={approveOpen} okText="新建并采纳" cancelText="取消" confirmLoading={approving}
        onCancel={() => setApproveOpen(false)}
        okButtonProps={{ 'data-testid': 'kp-approve-ok', disabled: !approveName.trim() } as any}
        onOk={async () => { setApproving(true); try { await p.onApprove({ parent_code: approveParent, name: approveName.trim() }); setApproveOpen(false) } finally { setApproving(false) } }}
      >
        <Label>挂在哪个节点之下（知识点树最多 3 层）</Label>
        <KpSelect kps={p.kps} value={approveParent} onChange={setApproveParent} placeholder="（不选 = 新的一级节点）" />
        <Label>新知识点名称</Label>
        <Input data-testid="kp-approve-name" value={approveName} maxLength={30} onChange={e => setApproveName(e.target.value)} />
      </Modal>
    </div>
  )
}

function index(p: Props) { return `${p.index + 1}/${p.total}` }

function Label({ children, hint, inline }: { children: React.ReactNode; hint?: string; inline?: boolean }) {
  const el = <span style={{ fontSize: 12, color: '#666', display: inline ? 'inline' : 'block', marginBottom: inline ? 0 : 2 }}>{children}</span>
  return hint ? <Tooltip title={hint}>{el}</Tooltip> : el
}
