import React, { useEffect, useMemo, useState } from 'react'
import { looksLikeCode, safeKpName, safeSuggestion, safeText } from '../../../shared/code-guard'
import { App, Collapse, Input, InputNumber, Modal, Rate, Select, Switch, Tooltip } from 'antd'
import { Check, Combine, Plus, Scissors, Trash2, X } from 'lucide-react'
import { Btn, UsageNote } from '../../design'
import '../../design/page-review.css'
import { Pill } from './parts'
import { KpMultiSelect, KpSelect } from '../../components/KpTreeSelect'
import { flagLabel, difficultyLabel } from '../../status'
import { Term } from '../../components/Plain'
import { useShowCodes } from '../../hooks/useUiPrefs'

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
  /** 同类题标注不一致的提示（有就标「需要核对」）；不计入「需关注」 */
  hint?: string
  /** 这道题还有没写库的本地修改：此时别用服务端数据覆盖表单里的知识点（重新拉取可能带回旧值） */
  localEdits?: boolean
  onRemove: () => void
  onApprove: (body: { parent_code: string | null; name: string }) => Promise<void>
  onReject: () => void
}

const kindLabel: Record<string, string> = { passage: '短文', dialogue: '对话', word_bank: '备选词句（A–E 这些选项）', listening_script: '听力原文', table: '表格', other: '材料' }

export default function QuestionForm(p: Props) {
  const { q } = p
  const { modal } = App.useApp()
  const [showCodes] = useShowCodes()
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
    for (const t of p.qtypes ?? []) (groups[t.group] ?? groups.written).options.push({ label: showCodes ? `${t.name}（${t.code}）` : t.name, value: t.code, search: `${t.name} ${t.code} ${t.note ?? ''}` } as any)
    return Object.values(groups).filter(g => g.options.length)
  }, [p.qtypes, showCodes])

  const kpName = (code: string | null) => (code ? safeKpName(p.kps?.find(k => k.code === code)?.name) : '')
  const attention = q.confidence < p.lowConfidence
  const suggestionPending = !!q.kp_suggestion && q.kp_suggestion_status === 'pending'

  const [approveOpen, setApproveOpen] = useState(false)
  const [approveParent, setApproveParent] = useState<string | null>(null)
  const [approveName, setApproveName] = useState('')
  const [approving, setApproving] = useState(false)
  const [approveErr, setApproveErr] = useState('')

  const openApprove = () => {
    const mainNode = p.kps?.find(k => k.code === q.kp_main)
    setApproveParent(mainNode ? (mainNode.level >= 3 ? mainNode.parent_code : mainNode.code) : null)
    const raw = q.kp_suggestion.trim()
    // 「待归类（AI 给的分类不在知识点树里，请手动选一个）」或带代码的建议：不预填，让老师自己起一个白话名字
    setApproveName(/^待归类/.test(raw) || looksLikeCode(raw) ? '' : safeText(raw).slice(0, 30))
    setApproveErr('')
    setApproveOpen(true)
  }

  return (
    <div data-testid="question-form" className="ewb-rev-form">
      <div className="ewb-rev-form__head">
        <h3 className="ewb-rev-form__title" data-testid="form-title">
          {q.section ? `${q.section}、` : ''}第 {q.no} 题
        </h3>
        <span className="ewb-rev-form__meta">{index(p)} · 第 {q.page_idx ?? '?'} 页</span>
        {attention && (
          <Tooltip title={<span><Term term="需要核对">AI 对这道题的位置或内容把握不大</Term>：请对着原卷看一眼；把握高的题不会出现这个提示。</span>}>
            <Pill kind="warn" tabIndex={0} style={{ marginLeft: 'auto' }} data-testid="confidence-tag">需要核对</Pill>
          </Tooltip>
        )}
      </div>
      {p.hint && <UsageNote kind="caution" label="需要核对" data-testid="consistency-hint">{p.hint}</UsageNote>}
      {(q.flags.length > 0) && (
        <div className="ewb-rev-form__flags" data-testid="flags">
          {q.flags.map(f => (
            <Tooltip key={f} title={flagLabel[f]?.hint ?? f}><Pill kind="warn" tabIndex={0}>{flagLabel[f]?.text ?? f}</Pill></Tooltip>
          ))}
        </div>
      )}

      <div className="ewb-rev-form__grid">
        <div className="ewb-rev-field"><Label>大题</Label><Input value={d.section} onChange={e => set({ section: e.target.value })} /></div>
        <div className="ewb-rev-field"><Label>题号</Label><Input data-testid="f-no" value={d.no} onChange={e => e.target.value.trim() && set({ no: e.target.value }, { no_label: e.target.value.trim() })} /></div>
        <div className="ewb-rev-field"><Label>分值</Label><InputNumber style={{ width: '100%' }} min={0} max={200} value={d.score} data-testid="f-score" onChange={v => set({ score: v as number | null })} /></div>
      </div>

      <div className="ewb-rev-field">
        <Label>题型</Label>
        <Select data-testid="f-qtype" style={{ width: '100%' }} showSearch filterOption={(input, opt) => String((opt as any)?.search ?? (opt as any)?.label ?? '').toLowerCase().includes(input.toLowerCase())} options={qtypeOptions} value={d.qtype} onChange={v => set({ qtype: v })} />
      </div>

      {p.material && (
        <Collapse size="small" items={[{
          key: 'm', label: `${kindLabel[p.material.kind] ?? '材料'}（本题引用）`,
          children: <div className="ewb-rev-material">{p.material.text}</div>
        }]} />
      )}

      <div className="ewb-rev-field">
        <Label>题干</Label>
        <Input.TextArea data-testid="f-stem" autoSize={{ minRows: 2, maxRows: 8 }} value={d.stem} onChange={e => set({ stem: e.target.value })} />
      </div>

      <div className="ewb-rev-field">
        <Label>选项</Label>
        <div>
          {d.options.map((o, i) => (
            <div key={i} className="ewb-rev-opt">
              <Input data-testid={`f-option-${i}`} value={o} onChange={e => { const opts = d.options.map((x, j) => (j === i ? e.target.value : x)); set({ options: opts }) }} />
              <Btn tone="quiet" size="small" icon={X} onClick={() => set({ options: d.options.filter((_, j) => j !== i) })}>去掉</Btn>
            </div>
          ))}
          <Btn tone="secondary" size="small" icon={Plus} onClick={() => set({ options: [...d.options, `${String.fromCharCode(65 + d.options.length)}. `] })}>添加选项</Btn>
        </div>
      </div>

      <div className="ewb-rev-field">
        <Label hint="只有卷面上印刷的参考答案才会填；AI 不会自己做题">参考答案（卷面上印的）</Label>
        <Input value={d.answer} onChange={e => set({ answer: e.target.value })} placeholder="（卷面没有就留空）" />
      </div>

      <div className="ewb-rev-field">
        <Label hint="一道题标一个“主要考的知识点”，得分按它算；再顺带标几个“还考到的”。"><Term term="这题主要考什么 / 还顺带考到什么">这题主要考什么</Term></Label>
        <KpSelect testId="f-kp-main" kps={p.kps} value={d.kp_main} placeholder="主要考的知识点（可以直接打字搜）" onChange={v => set({ kp_main: v }, { kp_main: v })} />
        <KpMultiSelect kps={p.kps} value={d.kp_secondary} max={3} onChange={v => set({ kp_secondary: v })} />
      </div>

      {q.kp_suggestion && (
        <UsageNote
          kind={suggestionPending ? 'caution' : 'tip'} label="AI 建议" data-testid="kp-suggestion"
          title={<span>AI 建议新增知识点：<b>{safeSuggestion(q.kp_suggestion)}</b>
            {q.kp_suggestion_status === 'approved' && <Pill kind="done" style={{ marginLeft: 8 }}>已采纳</Pill>}
            {q.kp_suggestion_status === 'rejected' && <Pill style={{ marginLeft: 8 }}>已忽略</Pill>}</span>}
          actions={suggestionPending ? (
            <>
              <Btn tone="secondary" size="small" data-testid="kp-approve" onClick={openApprove}>采纳…</Btn>
              <Btn tone="quiet" size="small" data-testid="kp-reject" onClick={p.onReject}>忽略</Btn>
            </>
          ) : undefined}
        >
          {suggestionPending && <>知识点树不会被自动修改；采纳后才会新建节点，并作为本题主知识点（原主知识点「{kpName(q.kp_main)}」降为次知识点）。</>}
        </UsageNote>
      )}

      <div className="ewb-rev-inline">
        <Label inline>难度</Label>
        <Rate data-testid="f-difficulty" value={d.difficulty} onChange={v => v > 0 && set({ difficulty: v })} />
        <Pill>{difficultyLabel[d.difficulty]}</Pill>
        <Tooltip title="难度由 AI 估计，不是学生得分统计"><Pill kind="info" tabIndex={0}>估计</Pill></Tooltip>
      </div>
      <div className="ewb-rev-field">
        <div className="ewb-rev-inline">
          <Label inline>易错</Label>
          <Switch data-testid="f-error-prone" checked={d.error_prone} onChange={v => set({ error_prone: v, ...(v ? {} : { error_reason: '' }) }, v ? { error_prone: true } : { error_prone: false, error_reason: '' })} />
          <Pill kind="info">估计</Pill>
        </div>
        {d.error_prone && <Input data-testid="f-error-reason" placeholder="易错在哪（一句话）" maxLength={60} value={d.error_reason} onChange={e => set({ error_reason: e.target.value })} />}
      </div>

      <div className="ewb-rev-actions">
        <Btn tone="primary" icon={Check} data-testid="confirm-q" onClick={p.onConfirm}>
          {q.reviewed ? '已确认' : '确认'}{p.hasNext ? ' · 下一题' : ''}（Enter）
        </Btn>
        <Tooltip title="这道题其实是两道题（AI 把它们并在一起了）时用：把内容分到两道题里"><Btn tone="secondary" icon={Scissors} data-testid="split-q" disabled={p.busy} onClick={p.onSplit}>拆成两题</Btn></Tooltip>
        <Tooltip title="本题和下一题其实是同一道题（AI 把它切开了）时用"><Btn tone="secondary" icon={Combine} data-testid="merge-q" disabled={!p.hasNext || p.busy} onClick={p.onMerge}>与下一题合并</Btn></Tooltip>
        <Btn tone="danger" icon={Trash2} disabled={p.busy} onClick={() => modal.confirm({ title: '删除这道题？', content: '删除后不可恢复。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: p.onRemove })}>删除</Btn>
      </div>

      <Modal
        title="采纳新增知识点" open={approveOpen} okText="新建并采纳" cancelText="取消" confirmLoading={approving}
        onCancel={() => setApproveOpen(false)}
        okButtonProps={{ 'data-testid': 'kp-approve-ok', disabled: !approveName.trim() } as any}
        onOk={async () => {
          setApproving(true); setApproveErr('')
          try { await p.onApprove({ parent_code: approveParent, name: approveName.trim() }); setApproveOpen(false) }
          catch (e) { setApproveErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }   // 后端拒绝（名字像代码、重名……）：把它的白话原因直接放在框里
          finally { setApproving(false) }
        }}
      >
        <div className="ewb-rev-field" style={{ marginBottom: 12 }}>
          <Label>挂在哪个节点之下（知识点树最多 3 层）</Label>
          <KpSelect kps={p.kps} value={approveParent} onChange={setApproveParent} placeholder="（不选 = 新的一级节点）" />
        </div>
        <div className="ewb-rev-field">
          <Label>新知识点名称</Label>
          <Input data-testid="kp-approve-name" value={approveName} maxLength={30} onChange={e => setApproveName(e.target.value)} />
        </div>
        {approveErr && <div style={{ marginTop: 12 }}><UsageNote kind="mistake" data-testid="kp-approve-error">{approveErr}</UsageNote></div>}
      </Modal>
    </div>
  )
}

function index(p: Props) { return `${p.index + 1}/${p.total}` }

function Label({ children, hint, inline }: { children: React.ReactNode; hint?: string; inline?: boolean }) {
  const el = <span className={`ewb-rev-label${hint ? ' ewb-rev-label--hint' : ''}`} style={inline ? undefined : { display: 'block' }}>{children}</span>
  return hint ? <Tooltip title={hint}>{el}</Tooltip> : el
}
