import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Input } from 'antd'
import { Circle, CircleCheck, CircleDot, CornerDownRight, MessageSquare, Network, PanelLeftClose, PanelLeftOpen, Settings, Square, SquarePen, Trash2, Wrench, FileSpreadsheet, GitBranch, FileText, Image as ImageIcon } from 'lucide-react'
import { Btn, UsageNote } from '../design'
import './assistant-data'
import { getAssistantSlots } from './assistant-slots'
import { AssistantSettingsModal, RoleModal } from './assistant-dialogs'
import RoleWizard from './assistant-role-wizard'
import { popularTemplates } from '../../main/agent/role-templates'
import Composer, { chipsToHint } from './assistant-composer'
import type { Chip } from './assistant-composer'
import AiErrorExplain from '../components/AiErrorExplain'
import { ApprovalBox, BoardPane, QueryRecordModal } from './assistant-extras'
import type { ApprovalInfo } from './assistant-extras'
import { addDroppedFiles, addPickedDatasets, attachmentsLoading, clearAttachments, clearPickedDatasets, getAttachmentIds, getPickedDatasets, useAttachmentsBusy } from './assistant-data'
import AssistantCanvas from '../assistant/canvas/AssistantCanvas'
import AssistantSidePanel from '../assistant/side/AssistantSidePanel'
import type { SideMode } from '../assistant/side/AssistantSidePanel'
import { useAgentOutputs } from '../assistant/side/useAgentOutputs'
import { sessionToNodes } from '../assistant/toNodes'
import type { CanvasAction } from '../assistant/types'
import { TOOL_LABELS } from '../../main/agent/tools/bridge'
import { parseBlocks } from '../../shared/markdown'
import type { Inline } from '../../shared/markdown'
import { CITE_PATTERN } from '../../shared/agent-cite'
import '../design/page-report.css'
import '../design/page-library.css'
import '../design/page-assistant.css'

const TOOL_LABEL: Record<string, string> = {
  stats_overview: '看整体情况', kp_questions: '查考这个知识点的题', course_for_kp: '查对应的课', fact_check: '核对讲解', load_playbook: '读取分析步骤', ...TOOL_LABELS
}
/** 计划和提问有自己的显示方式，不重复列在工具步骤里 */
const HIDDEN_TOOLS = new Set(['update_plan', 'ask_user', 'session_state'])
const PLAN_APPROVE = '按这个做'

/** 从根到 seq 的路径（含自己） */
function pathTo(steps: AgentStepRow[], seq: number): AgentStepRow[] {
  const by = new Map(steps.map(s => [s.seq, s]))
  const out: AgentStepRow[] = []
  let cur = by.get(seq)
  for (let i = 0; cur && i < 10000; i++) { out.push(cur); cur = cur.parentId == null ? undefined : by.get(cur.parentId) }
  return out.reverse()
}
const STOP_NOTE: Record<string, string> = {
  stopped: '已停止。', rounds: '查询步骤太多，助手已自动停止。', tokens: '本次用量已到上限，助手已自动停止。', time: '用时太长，助手已自动停止。', stuck: '助手在重复同一个查询，已自动停止。', error: '调用模型时出错，已停止。'
}

/** 工具失败时界面上显示的白话短句（给模型看的文案不在这里改） */
export function friendlyFail(summary: string): string {
  const t = summary.trim()
  if (/没有同意|不同意/.test(t)) return '你没有同意，已取消'
  const keep = t.split(/(?<=[。！？!?])/).map(x => x.trim()).filter(x => x && !/请(换|重|改|再)|换一种|直接问|用户想/.test(x))
  const first = (keep[0] ?? '').replace(/[。！？!?]+$/, '')
  return first ? (first.length > 36 ? first.slice(0, 35) + '…' : first) : '没做成'
}

type Cites = Map<string, AgentCite>
const citeKey = (kind: string, id: string) => `${kind}:${id}`

// ───────── 回答的 Markdown：引用渲染成可点击的小标签 ─────────
function CiteChip({ kind, id, cites, onGo }: { kind: string; id: string; cites: Cites; onGo: (c: AgentCite) => void }) {
  const c = cites.get(citeKey(kind, id))
  if (!c || !c.ok) return null
  const prefix = kind === 'query' ? '查询 ' : kind === 'q' ? '题 · ' : kind === 'lesson' ? '课 · ' : '学员 · '
  return (
    <button type="button" className="ewb-as-chip" data-testid="assistant-cite" data-kind={kind} data-id={id} title="点一下查看" onClick={() => onGo(c)}>{prefix}{c.label}</button>
  )
}

function withChips(text: string, cites: Cites, onGo: (c: AgentCite) => void, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = new RegExp(CITE_PATTERN, 'g')
  let last = 0, n = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const chip = <CiteChip key={`${keyBase}-${n++}`} kind={m[1]} id={m[2]} cites={cites} onGo={onGo} />
    last = i + m[0].length
    // 标签后面紧跟的标点和标签粘在一起，不让句号单独掉到下一行
    const tail = /^[，。；：、！？．.,;:!?）)」』]+/.exec(text.slice(last))?.[0] ?? ''
    if (tail) { out.push(<span key={`${keyBase}-g${n}`} style={{ whiteSpace: 'nowrap' }}>{chip}{tail}</span>); last += tail.length } else out.push(chip)
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function AnswerMarkdown({ text, cites, onGo }: { text: string; cites: Cites; onGo: (c: AgentCite) => void }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const inl = (items: Inline[], k: string) => items.map((it, i) => {
    const key = `${k}-${i}`
    if (it.type === 'bold') return <b key={key}>{withChips(it.text, cites, onGo, key)}</b>
    return <React.Fragment key={key}>{withChips(it.type === 'text' ? it.text : it.token, cites, onGo, key)}</React.Fragment>
  })
  return (
    <div className="ewb-md" data-testid="assistant-md">
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.type) {
          case 'heading': return React.createElement(`h${Math.min(b.level + 2, 6)}`, { key: k, className: b.level <= 1 ? 'ewb-md__h1' : b.level === 2 ? 'ewb-md__h2' : 'ewb-md__h3' }, withChips(b.text, cites, onGo, k))
          case 'ul': return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inl(it, `${k}-${j}`)}</li>)}</ul>
          case 'ol': return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inl(it, `${k}-${j}`)}</li>)}</ol>
          case 'quote': return <blockquote key={k} className="ewb-md__quote">{b.lines.map((l, j) => <div key={j}>{inl(l, `${k}-${j}`)}</div>)}</blockquote>
          case 'hr': return <hr key={k} className="ewb-md__hr" />
          case 'code': return <pre key={k} className="ewb-md__code">{b.text}</pre>
          case 'table': return (
            <div key={k} className="ewb-md__tablewrap">
              <table className="ewb-md__table">
                <thead><tr>{b.header.map((c, j) => <th key={j} style={{ textAlign: b.align[j] ?? 'left' }}>{inl(c, `${k}h${j}`)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{b.header.map((_, c) => <td key={c} style={{ textAlign: b.align[c] ?? 'left' }}>{inl(r[c] ?? [], `${k}r${j}c${c}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>)
          case 'card': return <pre key={k} className="ewb-md__code">{b.raw.join('\n')}</pre>
          default: return <p key={k}>{inl(b.inline, k)}</p>
        }
      })}
    </div>
  )
}

// ───────── 对话流里的各种块 ─────────
function PlanBox({ items }: { items: AgentPlanItem[] }) {
  return (
    <div className="ewb-as-plan" data-testid="assistant-plan">
      <p className="ewb-as-plan__t">计划</p>
      <ul>
        {items.map((p, i) => (
          <li key={i} data-testid="assistant-plan-item" data-status={p.status}>
            <span className="ewb-as-plan__ic">{p.status === 'done' ? <CircleCheck size={16} /> : p.status === 'doing' ? <CircleDot size={16} /> : <Circle size={16} />}</span>
            <span>{p.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ToolItem({ call, result, prog }: { call: AgentStepRow; result?: AgentStepRow; prog?: { done: number; total: number } }) {
  const name = String(call.payload.name)
  const ok = result ? result.payload.ok !== false : true
  const sum = result ? String(result.payload.summary ?? '') : prog && prog.total > 0 ? `归类中 ${prog.done}/${prog.total}` : '查询中……'
  return (
    <details className="ewb-as-tool" data-testid="assistant-tool" data-name={name} data-ok={String(ok)} data-done={String(!!result)}>
      <summary>
        <Wrench size={14} />
        <span className="ewb-as-tool__name">{TOOL_LABEL[name] ?? name}</span>
        <span className="ewb-as-tool__sum" data-testid="assistant-tool-summary" data-progress={prog ? `${prog.done}/${prog.total}` : undefined}>{ok ? sum : friendlyFail(sum)}{result && result.ms ? `　${(result.ms / 1000).toFixed(1)} 秒` : ''}</span>
      </summary>
      <div className="ewb-as-tool__body">
        <div><span className="ewb-as-tool__k">查询条件</span><pre className="ewb-as-pre" data-testid="assistant-tool-args">{JSON.stringify(call.payload.args ?? {}, null, 2)}</pre></div>
        {result && <div><span className="ewb-as-tool__k">返回结果{result.payload.truncated ? '（太长，已截断）' : ''}</span><pre className="ewb-as-pre" data-testid="assistant-tool-result">{String(result.payload.text ?? '')}</pre></div>}
      </div>
    </details>
  )
}

function AskBox({ step, pending, onPick }: { step: AgentStepRow; pending: boolean; onPick: (id: string, a: string) => void }) {
  const p = step.payload
  const [other, setOther] = useState('')
  const answered = p.answer != null && p.answer !== ''
  if (p.planReview) {
    return (
      <div className="ewb-as-ask" data-testid="assistant-plan-review" data-answered={String(answered)}>
        <p className="ewb-as-ask__h">先看看这个计划</p>
        {answered
          ? <div className="ewb-as-ask__done" data-testid="assistant-plan-answer">{p.answer === PLAN_APPROVE ? '你确认了计划，开始执行。' : `你的修改意见：${p.answer}`}</div>
          : pending ? (
            <>
              <div className="ewb-as-ask__opts"><Btn tone="primary" data-testid="assistant-plan-go" onClick={() => onPick(p.id, PLAN_APPROVE)}>按这个做</Btn></div>
              <div className="ewb-as-ask__other">
                <Input size="small" placeholder="想改？写下修改意见，比如：只看四年级" value={other} data-testid="assistant-plan-feedback" onChange={e => setOther(e.target.value)} onPressEnter={() => other.trim() && onPick(p.id, other.trim())} />
                <Btn tone="secondary" size="small" disabled={!other.trim()} data-testid="assistant-plan-revise" onClick={() => onPick(p.id, other.trim())}>修改计划</Btn>
              </div>
            </>
          ) : <div className="ewb-as-ask__done">这个计划没有确认（对话已结束）。</div>}
      </div>
    )
  }
  return (
    <div className="ewb-as-ask" data-testid="assistant-ask" data-answered={String(answered)}>
      <p className="ewb-as-ask__h">需要你确认</p>
      <p className="ewb-as-ask__q">{p.question}</p>
      {answered
        ? <div className="ewb-as-ask__done" data-testid="assistant-ask-answer">你选了：{p.answer}</div>
        : pending ? (
          <>
            <div className="ewb-as-ask__opts">
              {(p.options as string[]).map((o, i) => <button key={i} type="button" className="ewb-as-opt" data-testid={`assistant-ask-opt-${i}`} onClick={() => onPick(p.id, o)}>{o}</button>)}
            </div>
            {p.allowOther && (
              <div className="ewb-as-ask__other">
                <Input size="small" placeholder="或者自己写……" value={other} data-testid="assistant-ask-other" onChange={e => setOther(e.target.value)} onPressEnter={() => other.trim() && onPick(p.id, other.trim())} />
                <Btn tone="quiet" size="small" disabled={!other.trim()} data-testid="assistant-ask-other-send" onClick={() => onPick(p.id, other.trim())}>确定</Btn>
              </div>
            )}
          </>
        ) : <div className="ewb-as-ask__done">这个问题没有回答（对话已结束）。</div>}
    </div>
  )
}

const refsOf = (text: string): Array<{ kind: string; id: string }> => {
  const seen = new Set<string>()
  const out: Array<{ kind: string; id: string }> = []
  for (const m of text.matchAll(new RegExp(CITE_PATTERN, 'g'))) { const k = citeKey(m[1], m[2]); if (!seen.has(k)) { seen.add(k); out.push({ kind: m[1], id: m[2] }) } }
  return out.slice(0, 60)
}

export default function Assistant() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { data: rolesData } = useQuery({ queryKey: ['agent', 'roles'], queryFn: () => window.api.agent.roles(), staleTime: 0 })
  const { data: status } = useQuery({ queryKey: ['agent', 'status'], queryFn: () => window.api.agent.status(), staleTime: 0, refetchOnMount: 'always' })
  const { data: sessions = [] } = useQuery({ queryKey: ['agent', 'sessions'], queryFn: () => window.api.agent.sessions(), staleTime: 0 })

  const [role, setRole] = useState('ops')
  const [active, setActive] = useState<string | null>(null)
  const [allSteps, setSteps] = useState<AgentStepRow[]>([])
  const [branchId, setBranchId] = useState('main')
  const [forkFrom, setForkFrom] = useState<number | null>(null)
  const [mode, setMode] = useState<AgentMode>('plan')
  const [model, setModel] = useState('')
  const [chips, setChips] = useState<Chip[]>([])
  const [approval2, setApproval2] = useState<AgentApproval>('ask-external')
  const [effort, setEffort] = useState<AgentEffort>('auto')
  const [roleModal, setRoleModal] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wizard, setWizard] = useState<{ open: boolean; tpl: string | null }>({ open: false, tpl: null })
  const [roleChosen, setRoleChosen] = useState(() => { try { return window.localStorage.getItem('ewb-as-role-chosen') === '1' } catch { return true } })
  const markChosen = () => { setRoleChosen(true); try { window.localStorage.setItem('ewb-as-role-chosen', '1') } catch { /* 忽略 */ } }
  const branchRef = useRef('main')
  branchRef.current = branchId
  const [stale, setStale] = useState(false)
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState('')
  const [statusText, setStatusText] = useState('')
  const [progress, setProgress] = useState<{ rounds: number; tokensIn: number; tokensOut: number; money: number | null; limitTokens: number } | null>(null)
  const [sessTok, setSessTok] = useState<number>(0)
  const [approval, setApproval] = useState<ApprovalInfo | null>(null)
  const [toolProg, setToolProg] = useState<Record<string, { done: number; total: number }>>({})
  const [view, setView] = useState<'chat' | 'canvas'>('chat')
  const [sideMode, setSideMode] = useState<SideMode>('outputs')
  const [selNode, setSelNode] = useState<string | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  const [queryN, setQueryN] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [checking, setChecking] = useState(false)
  const [histOpen, setHistOpen] = useState(() => { try { return window.localStorage.getItem('ewb-as-hist') !== '0' } catch { return true } })
  const toggleHist = () => setHistOpen(o => { try { window.localStorage.setItem('ewb-as-hist', o ? '0' : '1') } catch { /* 忽略 */ } return !o })
  const [dropping, setDropping] = useState(false)
  const activeRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  const flowEnd = useRef<HTMLDivElement>(null)
  activeRef.current = active

  const { data: models = [] } = useQuery({ queryKey: ['agent', 'models'], queryFn: () => window.api.agent.models(), staleTime: 0 })
  const roles = rolesData?.roles ?? []
  // 只显示当前分支（或正要追问的那一步）这条路径上的内容；兄弟分支不显示
  const steps = useMemo(() => {
    if (forkFrom !== null) return pathTo(allSteps, forkFrom)
    const mine = allSteps.filter(s => s.branchId === branchId)
    return mine.length ? pathTo(allSteps, mine[mine.length - 1].seq) : (branchId === 'main' ? allSteps.filter(s => s.branchId === 'main') : [])
  }, [allSteps, branchId, forkFrom])
  const curRole = roles.find(r => r.id === role) ?? roles[0]
  useEffect(() => { if (roles.length && !roles.some(r => r.id === role)) setRole(roles[0].id) }, [roles, role])
  // 记住上次的选择：运行模式全局，模型和思考强度按角色
  const prefsMode = rolesData?.prefs.mode
  useEffect(() => { if (prefsMode) setMode(prefsMode) }, [prefsMode])
  const prefsApproval = rolesData?.prefs.approval
  useEffect(() => { if (prefsApproval) setApproval2(prefsApproval) }, [prefsApproval])
  const { data: pbs } = useQuery({ queryKey: ['agent', 'playbooks'], queryFn: () => window.api.agent.playbooks(), staleTime: 0 })
  const roleModelPref = rolesData?.prefs.byRole[role]?.model ?? ''
  const roleEffortPref = rolesData?.prefs.byRole[role]?.effort ?? 'auto'
  useEffect(() => { setModel(roleModelPref); setEffort(roleEffortPref) }, [role, roleModelPref, roleEffortPref])
  const mainModel = status?.model ?? ''
  const curModel = model && model !== '__other__' ? model : mainModel
  const curInfo: AgentModelInfo | undefined = models.find(m => m.model === curModel)
  const effortChoices: AgentEffort[] = curInfo?.efforts ?? ['auto', 'off', 'low', 'medium', 'high']
  useEffect(() => { if (!effortChoices.includes(effort)) setEffort('auto') }, [effortChoices.join(','), effort])

  const loadSession = useCallback(async (id: string) => {
    const r = await window.api.agent.session(id)
    if (!r || activeRef.current !== id) return
    setSteps(r.steps); setStale(r.session.stale); setSessTok(r.session.tokensIn + r.session.tokensOut)
    setRunning(r.running)
  }, [])

  const openSession = useCallback(async (id: string) => {
    const r = await window.api.agent.session(id)
    if (!r) return
    qc.invalidateQueries({ queryKey: ['agent', 'sessions'] })
    activeRef.current = id
    clearPickedDatasets(); setSelNode(null); setSideMode('outputs'); setToolProg({}); setActive(id); setSteps(r.steps); setStale(r.session.stale); setRole(r.session.role); setLive(''); setProgress(null); setApproval(null); setStatusText(''); setBranchId('main'); setForkFrom(null)
    setSessTok(r.session.tokensIn + r.session.tokensOut); setRunning(r.running)
  }, [qc])

  const newChat = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['agent', 'sessions'] })
    activeRef.current = null
    clearPickedDatasets(); clearAttachments(); setSelNode(null); setSideMode('outputs'); setToolProg({}); setView('chat')
    setActive(null); setSteps([]); setBranchId('main'); setForkFrom(null); setStale(false); setLive(''); setProgress(null); setRunning(false); setApproval(null); setStatusText(''); setSessTok(0)
  }, [qc])

  // 主进程推来的过程事件
  useEffect(() => window.api.on('agent:event', (e: AgentEventMsg) => {
    const mine = e.sessionId === activeRef.current || (startingRef.current && activeRef.current === null)
    if (e.type === 'done') {
      qc.invalidateQueries({ queryKey: ['agent', 'sessions'] }); qc.invalidateQueries({ queryKey: ['agent', 'status'] }); qc.invalidateQueries({ queryKey: ['agent', 'models'] })
      if (!mine) return
      setRunning(false); setLive(''); setApproval(null); setStatusText('')
      activeRef.current = e.sessionId; setActive(e.sessionId)
      void loadSession(e.sessionId)
      return
    }
    if (!mine) return
    if (activeRef.current === null) { activeRef.current = e.sessionId; setActive(e.sessionId) }
    switch (e.type) {
      case 'step':
        setSteps(prev => (prev.some(s => s.seq === e.seq) ? prev : [...prev, { sessionId: e.sessionId, seq: e.seq, parentId: e.parentId, branchId: e.branchId, kind: e.kind, payload: e.payload, tokens: e.tokens, ms: e.ms, createdAt: '' }]))
        if (e.kind === 'user' && e.branchId !== branchRef.current) { setBranchId(e.branchId); setForkFrom(null) }
        if (e.kind !== 'user') setLive('')
        break
      case 'step-update': setSteps(prev => prev.map(s => (s.seq === e.seq ? { ...s, payload: { ...s.payload, ...e.payload } } : s))); break
      case 'delta': setLive(p => p + e.text); break
      case 'reset': setLive(''); break
      case 'status': setStatusText(e.text); break
      case 'progress': setProgress({ rounds: e.rounds, tokensIn: e.tokensIn, tokensOut: e.tokensOut, money: e.money, limitTokens: e.limitTokens }); break
      case 'approval': setApproval({ id: e.id, name: e.name, summary: e.summary, preview: e.preview }); break
      case 'tool-progress': setToolProg(p => ({ ...p, [e.id]: { done: e.done, total: e.total } })); break
    }
  }), [qc, loadSession])

  useEffect(() => { flowEnd.current?.scrollIntoView?.({ block: 'end' }) }, [steps.length, live])

  const send = async (q: string, fromSeq?: number) => {
    const t = q.trim()
    if (!t || running) return
    if (attachmentsLoading()) { message.info('附件还在读取，稍等一下再发'); return }
    const attachIds = getAttachmentIds()
    startingRef.current = true
    setRunning(true); setLive(''); setProgress(null); setApproval(null)
    try {
      const r = await window.api.agent.run({ sessionId: active ?? undefined, role: curRole?.id ?? role, text: t + chipsToHint(chips), ...(attachIds.length ? { attachments: attachIds } : {}), playbooks: chips.filter(c => c.kind === 'playbook').map(c => c.label), datasets: [...new Set([...getPickedDatasets().map(d => d.id), ...chips.filter(c => c.kind === 'dataset').map(c => c.key.slice('dataset:'.length))])], mode, approval: approval2, model: model && model !== '__other__' ? model : undefined, effort, ...(fromSeq !== undefined ? { branchFrom: fromSeq } : forkFrom !== null ? { branchFrom: forkFrom } : { branchId }) })
      activeRef.current = r.sessionId; setActive(r.sessionId); setBranchId(r.branchId); setForkFrom(null); setText(''); setChips([]); clearAttachments()
      const used = chips.filter(c => c.kind === 'dataset'); if (used.length) addPickedDatasets(used.map(c => ({ id: c.key.slice('dataset:'.length), name: c.label })))
    } catch (e) {
      setRunning(false)
      message.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally { startingRef.current = false }
  }

  const stop = () => { if (active) void window.api.agent.stop(active) }
  const pick = (askId: string, answer: string) => { if (active) void window.api.agent.answer(active, askId, answer) }
  const decide = (ok: boolean) => { if (active && approval) { void window.api.agent.approve(active, approval.id, ok); setApproval(null) } }
  const removeSession = async (id: string) => {
    await window.api.agent.deleteSession(id)
    if (active === id) newChat()
    qc.invalidateQueries({ queryKey: ['agent', 'sessions'] })
  }
  const recheck = async () => {
    setChecking(true)
    try { qc.setQueryData(['agent', 'status'], await window.api.agent.checkTools(curModel || undefined)); qc.invalidateQueries({ queryKey: ['agent', 'models'] }) } catch (e) { message.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } finally { setChecking(false) }
  }
  const setScene = async (s: 'org' | 'school') => { await window.api.agent.setScene(s); qc.invalidateQueries({ queryKey: ['agent', 'roles'] }) }

  // 回答里的引用：一次性解析
  const allAnswerText = allSteps.filter(s => s.kind === 'answer').map(s => String(s.payload.text ?? '')).join('\n')
  const refs = useMemo(() => refsOf(allAnswerText), [allAnswerText])
  const { data: citeList = [] } = useQuery({ queryKey: ['agent', 'cites', JSON.stringify(refs)], queryFn: () => window.api.agent.cites(refs), enabled: refs.length > 0, staleTime: Infinity })
  const cites: Cites = useMemo(() => new Map(citeList.map(c => [citeKey(c.kind, c.id), c])), [citeList])
  const goCite = (c: AgentCite) => {
    if (c.kind === 'query') setQueryN(Number(c.id))
    else if (c.kind === 'q' && c.paperId) nav(`/review/${c.paperId}?q=${encodeURIComponent(c.id)}`)
    else if (c.kind === 'lesson') nav('/courses')
  }

  // 每一轮只显示最后一份计划
  const keepPlan = useMemo(() => {
    const keep = new Set<number>()
    let lastPlan: number | null = null
    for (const s of steps) {
      if (s.kind === 'user') { if (lastPlan !== null) keep.add(lastPlan); lastPlan = null }
      else if (s.kind === 'plan') lastPlan = s.seq
    }
    if (lastPlan !== null) keep.add(lastPlan)
    return keep
  }, [steps])
  const results = useMemo(() => new Map(steps.filter(s => s.kind === 'tool_result').map(s => [String(s.payload.id), s])), [steps])
  const lastAsk = [...steps].reverse().find(s => s.kind === 'ask')

  const notReady = status && !status.configured
  const noTools = status?.toolSupport === 'no'
  const empty = steps.length === 0
  const tokens = progress ? progress.tokensIn + progress.tokensOut : sessTok

  const slots = getAssistantSlots()
  const attachBusy = useAttachmentsBusy()
  const importRole = async () => {
    try {
      const r = await window.api.agent.importRole()
      if (!r.picked) return
      if (!r.ok) { message.error(r.error); return }
      qc.invalidateQueries({ queryKey: ['agent', 'roles'] })
      message.success(`已导入角色「${r.role.name}」${r.droppedTools ? `（有 ${r.droppedTools} 项这里没有的查询已去掉）` : ''}`)
      newChat(); setRole(r.role.id)
    } catch (e) { message.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const outs = useAgentOutputs(active)
  const errMsg = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const openQuery = (id: string) => { if (/^\d+$/.test(id)) setQueryN(Number(id)) }
  // 画布：会话树 → 节点
  const { data: boardSpec } = useQuery({ queryKey: ['agent', 'board', active, outs.outputs.length, running], queryFn: () => (active ? window.api.agentOutputs.board(active) : null), enabled: !!active && outs.outputs.some(o => o.type === 'board') && view === 'canvas', staleTime: 0 })
  const converted = useMemo(() => sessionToNodes(allSteps, { outputs: outs.outputs, boardFindings: (boardSpec?.findings ?? []).map((f: any) => String(f.title ?? '')), running, toolLabel: n => TOOL_LABEL[n] ?? n }), [allSteps, outs.outputs, boardSpec, running])
  const canvasNodes = converted.nodes
  const onCanvasAction = (id: string, action: CanvasAction) => {
    const n = canvasNodes.find(x => x.id === id); if (!n) return
    const quote = `「${n.title}${n.body ? '：' + n.body.replace(/\s+/g, ' ').slice(0, 120) : ''}」`
    if (action === 'copy') { try { void navigator.clipboard.writeText(`${n.title}${n.body ? '\n' + n.body : ''}`); message.success('已复制') } catch { message.error('复制失败') } return }
    if (running) { message.info('助手正在回答，等它结束再继续'); return }
    const text = action === 'add-to-board' ? `把这条发现加到看板里：${quote}` : action === 'add-to-report' ? `把这条结论加到汇报里：${quote}` : `根据这条结论，生成需要跟进的名单：${quote}`
    void send(text, converted.seqOf[id])
  }
  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? id
  const meterTokens = tokens >= 10000 ? `${(tokens / 10000).toFixed(1)} 万` : tokens.toLocaleString()
  const limitMoney = progress && progress.money != null && tokens > 0 ? (progress.money / tokens) * progress.limitTokens : null
  const fmtMoney = (m: number) => `¥${m >= 1 ? m.toFixed(2) : m.toFixed(3)}`
  const sessionTitle = (active && sessions.find(x => x.id === active)?.title) || (empty ? '新对话' : '这次对话')
  const showStale = stale && !running && steps.some(s => s.kind === 'answer')

  return (
    <div className="ewb-as-shell" data-testid="assistant-page" data-dropping={dropping ? '1' : undefined}
      onDragOver={e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDropping(true) } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false) }}
      onDrop={e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); (e.nativeEvent as unknown as { __ewbHandled?: boolean }).__ewbHandled = true; setDropping(false); void addDroppedFiles(Array.from(e.dataTransfer.files)) } }}>
      <aside className={`ewb-as-side${histOpen ? '' : ' ewb-as-side--folded'}`} data-testid="assistant-history" data-folded={histOpen ? undefined : '1'}>
        {histOpen ? (
          <>
            <div className="ewb-as-side__top">
              <button type="button" className="ewb-as-newbtn" data-testid="assistant-new" onClick={newChat}><SquarePen size={14} strokeWidth={1.9} />新对话</button>
              <button type="button" className="ewb-as-iconbtn ewb-as-iconbtn--quiet" aria-label="收起历史" title="收起历史" data-testid="assistant-hist-fold" onClick={toggleHist}><PanelLeftClose size={16} strokeWidth={1.9} /></button>
            </div>
            <p className="ewb-as-side__title">最近</p>
            <div className="ewb-as-side__list">
              {sessions.length === 0 && <span className="ewb-lib-sub" data-testid="assistant-history-empty">还没有对话</span>}
              {sessions.map(s => (
                <div key={s.id} className="ewb-as-histrow">
                  <button type="button" className="ewb-as-hist" data-testid="assistant-history-item" aria-current={s.id === active} onClick={() => openSession(s.id)}>
                    <span className="ewb-as-hist__t">{s.title || '（没有标题）'}</span>
                    <span className="ewb-as-hist__m"><span>{roleName(s.role)}</span><span>{s.updatedAt.slice(5, 16)}</span>{s.stale && <span data-testid="assistant-history-stale">数据已更新</span>}</span>
                  </button>
                  <button type="button" className="ewb-as-hist ewb-as-hist__del" aria-label="删除这个对话" title="删除这个对话" data-testid="assistant-history-delete" onClick={() => removeSession(s.id)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <button type="button" className="ewb-as-setbtn" data-testid="assistant-settings-open" onClick={() => setSettingsOpen(true)}><Settings size={14} strokeWidth={1.9} />助手设置</button>
          </>
        ) : (
          <>
            <button type="button" className="ewb-as-iconbtn ewb-as-iconbtn--quiet" aria-label="展开历史" title="展开历史" data-testid="assistant-hist-unfold" onClick={toggleHist}><PanelLeftOpen size={16} strokeWidth={1.9} /></button>
            <button type="button" className="ewb-as-iconbtn ewb-as-iconbtn--quiet" aria-label="新对话" title="新对话" data-testid="assistant-new" onClick={newChat}><SquarePen size={16} strokeWidth={1.9} /></button>
            <span className="ewb-as-grow" />
            <button type="button" className="ewb-as-iconbtn ewb-as-iconbtn--quiet" aria-label="助手设置" title="助手设置" data-testid="assistant-settings-open" onClick={() => setSettingsOpen(true)}><Settings size={16} strokeWidth={1.9} /></button>
          </>
        )}
      </aside>

      <section className="ewb-as-conv">
        <div className="ewb-as-top">
          <h1 className="ewb-as-title" data-testid="assistant-title" title={sessionTitle}>{sessionTitle}</h1>
          <div className="ewb-as-seg ewb-as-seg--small" role="group" aria-label="显示方式">
            <button type="button" data-testid="assistant-view-chat" aria-pressed={view === 'chat'} onClick={() => setView('chat')}><MessageSquare size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /> 对话</button>
            <button type="button" data-testid="assistant-view-canvas" aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}><Network size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /> 画布</button>
          </div>
          <span className="ewb-as-grow" />
          <div className="ewb-as-meter" data-testid="assistant-meter">
            {progress && <span data-testid="assistant-rounds">第 {progress.rounds} 轮</span>}
            {(running || tokens > 0) && <span data-testid="assistant-tokens">{meterTokens} token{progress?.money != null ? ` · 约 ${fmtMoney(progress.money)}` : ''}{running && limitMoney != null ? ` / 上限约 ${fmtMoney(limitMoney)}` : ''}</span>}
            {running && <button type="button" className="ewb-as-stop" data-testid="assistant-stop" onClick={stop}><Square size={11} strokeWidth={2} />停止</button>}
          </div>
        </div>
        {branchId !== 'main' && (
          <div className="ewb-as-branchbar">
            <span className="ewb-as-branch" data-testid="assistant-branch"><GitBranch size={12} strokeWidth={1.9} />当前在分支：{allSteps.find(x => x.branchId === branchId && x.kind === 'user')?.payload.text?.slice(0, 16) ?? ''}
              <button type="button" className="ewb-as-chiplink" data-testid="assistant-branch-main" onClick={() => { setBranchId('main'); setForkFrom(null) }}>回到主线</button></span>
          </div>
        )}

        {view === 'canvas' && (
          <div className="ewb-as-canvaswrap" data-testid="assistant-canvas" style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
            {canvasNodes.length === 0
              ? <div className="ewb-as-empty" data-testid="assistant-canvas-empty"><p className="ewb-as-empty__p">还没有对话。先在「对话」里提个问题，这里会把思路画成一棵树。</p></div>
              : <AssistantCanvas nodes={canvasNodes} selectedId={selNode} focusSignal={focusSignal}
                  onSelect={id => { setSelNode(id); setSideMode(id ? 'card' : 'outputs') }}
                  onFollowUp={(id, t) => { if (running) { message.info('助手正在回答，等它结束再继续'); return } void send(t, converted.seqOf[id]) }}
                  onAction={onCanvasAction} showAskBar={!running} />}
          </div>
        )}
        <div className="ewb-as-scroll" data-testid="assistant-flow" style={view === 'canvas' ? { display: 'none' } : undefined}>
          {(notReady || noTools || showStale) && (
            <div className="ewb-as-notes">
              {notReady && (
                <UsageNote kind="caution" title="还没有设置 AI 服务" data-testid="assistant-noconfig" actions={<Btn tone="secondary" size="small" onClick={() => nav('/settings')}>去设置</Btn>}>
                  助手需要用你设置的 AI 服务来回答问题。请先在「设置 → AI 服务」填写服务地址、模型和密钥。
                </UsageNote>
              )}
              {!notReady && noTools && (
                <UsageNote kind="caution" title="当前模型不能用于助手" data-testid="assistant-notools" actions={<><Btn tone="secondary" size="small" onClick={() => nav('/settings')}>去换模型</Btn><Btn tone="quiet" size="small" loading={checking} data-testid="assistant-recheck" onClick={recheck}>换好了，重新检测</Btn></>}>
                  助手需要模型支持「工具调用」功能，当前的模型（{status?.model}）不支持。建议到「设置 → AI 服务」换一个支持的模型（一般新一些的对话模型都支持）。
                </UsageNote>
              )}
              {showStale && (
                <UsageNote kind="caution" title="数据已更新" data-testid="assistant-stale">这些回答是在试卷数据变化之前生成的，数字可能已经不是最新的。可以接着追问一次，让助手重新查。</UsageNote>
              )}
            </div>
          )}

          {empty && curRole && (
            <div className="ewb-as-empty" data-testid="assistant-empty">
              {!roleChosen && (
                <div className="ewb-rw-guide" data-testid="assistant-role-guide">
                  <h3 className="ewb-rw-guide__h">先选一个最像你的角色</h3>
                  <div className="ewb-rw-guide__row">
                    {popularTemplates(rolesData?.scene ?? 'org').map(t => <button key={t.id} type="button" className="ewb-rw-chip" data-testid={`assistant-guide-${t.id}`} onClick={() => setWizard({ open: true, tpl: t.id })}>{t.names[rolesData?.scene ?? 'org']}</button>)}
                    <button type="button" className="ewb-rw-chip ewb-rw-chip--more" data-testid="assistant-guide-more" onClick={() => setWizard({ open: true, tpl: null })}>更多…</button>
                  </div>
                </div>
              )}
              <h2 className="ewb-as-empty__h">今天要做什么？</h2>
              <p className="ewb-as-empty__p">数据只在这台电脑上，人名和手机号不会发给 AI。我只根据软件里的数据回答，查不到的会直接告诉你。</p>
              <div className="ewb-as-suggest" data-testid="assistant-suggest">
                {curRole.suggestions.slice(0, 4).map((q, i) => <button key={i} type="button" className="ewb-as-card" data-testid={`assistant-suggest-${i}`} disabled={running} onClick={() => (q.endsWith('：') ? setText(q) : send(q))}>{q}</button>)}
              </div>
              <div className="ewb-as-drop" data-testid="assistant-drophint"><FileSpreadsheet size={16} strokeWidth={1.9} />把表格、图片或文档拖到这里，截图可以直接粘贴到输入框</div>
            </div>
          )}

          {steps.map(s => {
            switch (s.kind) {
              case 'user': return <div key={s.seq} className="ewb-as-user" data-testid="assistant-user">{s.payload.text}{Array.isArray(s.payload.attachments) && s.payload.attachments.length > 0 && <span className="ewb-as-user__atts" data-testid="assistant-user-attachments">{s.payload.attachments.map((a: any, i: number) => <span key={i} className="ewb-as-user__att">{a.kind === 'image' ? <ImageIcon size={12} strokeWidth={1.9} /> : <FileText size={12} strokeWidth={1.9} />}{String(a.name)}</span>)}</span>}</div>
              case 'assistant': return s.payload.compacted ? <div key={s.seq} className="ewb-as-compacted" data-testid="assistant-compacted">{s.payload.text}</div> : <div key={s.seq} className="ewb-as-thought">{s.payload.text}</div>
              case 'plan': return keepPlan.has(s.seq) ? <PlanBox key={s.seq} items={s.payload.items} /> : null
              case 'tool_call': return HIDDEN_TOOLS.has(String(s.payload.name)) ? null : <ToolItem key={s.seq} call={s} result={results.get(String(s.payload.id))} prog={toolProg[String(s.payload.id)]} />
              case 'ask': return <AskBox key={s.seq} step={s} pending={running && lastAsk?.seq === s.seq} onPick={pick} />
              case 'answer': return (
                <div key={s.seq} className="ewb-as-answer" data-testid="assistant-answer" data-stop={s.payload.stop} data-seq={s.seq}>
                  {!running && <button type="button" className="ewb-as-fork" data-testid="assistant-fork" title="从这条回答往下追问，形成一个分支，不影响主线" onClick={() => { setForkFrom(s.seq); document.querySelector<HTMLTextAreaElement>('[data-testid=assistant-input]')?.focus() }}>{' '}<CornerDownRight size={12} strokeWidth={1.9} style={{ verticalAlign: '-1px' }} /> 从这里追问</button>}
                  {s.payload.stop && s.payload.stop !== 'answered' && <p className="ewb-lib-sub" data-testid="assistant-stop-note" style={{ marginTop: 0 }}>{STOP_NOTE[s.payload.stop] ?? ''}</p>}
                  <AnswerMarkdown text={String(s.payload.text ?? '')} cites={cites} onGo={goCite} />
                </div>)
              case 'error': {
                const c = String(s.payload.code)
                if (c === 'no_config') return <UsageNote key={s.seq} kind="caution" data-testid="assistant-error-noconfig" actions={<Btn tone="secondary" size="small" onClick={() => nav('/settings')}>去设置</Btn>}>{s.payload.message}</UsageNote>
                if (c === 'no_tools') return <UsageNote key={s.seq} kind="caution" data-testid="assistant-error-notools" actions={<><Btn tone="secondary" size="small" onClick={() => nav('/settings')}>去换模型</Btn><Btn tone="quiet" size="small" loading={checking} onClick={recheck}>换好了，重新检测</Btn></>}>{s.payload.message}</UsageNote>
                return <UsageNote key={s.seq} kind="mistake" title="助手没能完成" data-testid="assistant-error"><AiErrorExplain message={String(s.payload.message)} nonce={`${s.sessionId}-${s.seq}`} /></UsageNote>
              }
              default: return null
            }
          })}
          {running && live && <div className="ewb-as-answer"><div className="ewb-as-live" data-testid="assistant-live">{live}</div></div>}
          {running && !live && <div className="ewb-lib-sub" data-testid="assistant-working">{statusText || '助手正在查数据、想答案……'}</div>}
          {approval && <ApprovalBox approval={approval} onDecide={decide} />}
          <div ref={flowEnd} />
        </div>

        {view === 'chat' && forkFrom !== null && (
          <div className="ewb-as-forkbar" data-testid="assistant-forkbar">从第 {steps.filter(x => x.kind === 'answer').length} 条回答分出一个新分支追问（不影响主线）<button type="button" className="ewb-as-chiplink" data-testid="assistant-fork-cancel" onClick={() => setForkFrom(null)}>取消</button></div>
        )}
        {view === 'chat' && (
          <div className="ewb-as-rolebar" role="group" aria-label="我的身份">
            <span className="ewb-as-rolebar__k">我是</span>
            <div className="ewb-as-seg ewb-as-seg--small">
              {roles.map(r => <button key={r.id} type="button" data-testid={`assistant-role-${r.id}`} aria-pressed={r.id === curRole?.id} onClick={() => { markChosen(); if (r.id !== curRole?.id) { newChat(); setRole(r.id) } }}>{r.name}</button>)}
            </div>
          </div>
        )}
        {view === 'chat' && <Composer
          extra={slots.dataChips ? <div className="ewb-as-dataslot" data-testid="assistant-dataslot"><slots.dataChips sessionId={active} /></div> : undefined}
          value={text} onChange={setText} onSend={() => send(text)} disabled={!!notReady} busy={running} attachBusy={attachBusy}
          chips={chips} onChips={setChips} playbooks={(pbs?.items ?? []).map(x => x.name)}
          mode={mode} onMode={setMode} approval={approval2} onApproval={setApproval2}
          models={models} model={model && model !== '__other__' ? model : ''} mainModel={mainModel} onModel={m => setModel(m === mainModel ? '' : m)}
          effort={effort} onEffort={setEffort} effortChoices={effortChoices} curInfo={curInfo}
          onResetModel={() => { setModel(''); setEffort('auto') }}
        />}
      </section>

      <RoleWizard open={wizard.open} scene={rolesData?.scene ?? 'org'} startTemplate={wizard.tpl} onClose={() => setWizard({ open: false, tpl: null })} onSaved={id => { markChosen(); if (id) { newChat(); setRole(id) } }} />
      <RoleModal open={roleModal.open} roleId={roleModal.id} onClose={() => setRoleModal({ open: false, id: null })} onSaved={id => { if (id) { newChat(); setRole(id) } else { newChat(); setRole(roles[0]?.id ?? 'ops') } }} />
      <AssistantSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} extra={{
        scene: rolesData?.scene, onScene: setScene, curRoleName: curRole?.name, curRoleCustom: !!curRole?.custom,
        onNewRole: () => setWizard({ open: true, tpl: null }), onImportRole: importRole, onEditRole: () => curRole && setRoleModal({ open: true, id: curRole.id })
      }} />
      <AssistantSidePanel foldBelow={1280}
        mode={sideMode} onModeChange={setSideMode}
        outputs={outs.outputs} activeOutputId={outs.activeId} onActiveOutputChange={outs.setActiveId} content={outs.content}
        renderBoard={() => <BoardPane sessionId={active} onSource={openQuery} />}
        onExport={(id, f) => { void outs.exportOutput(id, f).then(r => { if (r.saved) message.success('已导出') }, e => message.error(errMsg(e))) }}
        onReveal={id => { void outs.reveal(id) }}
        onCopyImage={id => { if (active) void window.api.agentOutputs.copyImage(active, id).then(() => message.success('图片已复制，可以直接粘贴发送'), e => message.error(errMsg(e))) }}
        onSaveImage={id => { if (active) void window.api.agentOutputs.saveImage(active, id).then(r => { if (r.saved) message.success('图片已保存') }, e => message.error(errMsg(e))) }}
        onSendWecom={id => { const o = outs.outputs.find(x => x.id === id); if (o) void send(`请把产出「${o.name}」（编号 ${o.id}）这张图片发到企业微信群：先用 outputs_list 查它的文件路径，再用 wecom_send（kind=file）发送。`) }}
        onOpenRef={r => { if (r.type === 'query') openQuery(r.id); else goCite({ kind: r.type, id: r.id, ok: true, label: '', ...(cites.get(citeKey(r.type, r.id)) ?? {}) } as AgentCite) }}
        node={canvasNodes.find(n => n.id === selNode) ?? null} nodes={canvasNodes}
        onAskFrom={id => { setSelNode(id); setView('canvas'); setFocusSignal(n => n + 1) }}
        onAction={onCanvasAction} />
      <QueryRecordModal sessionId={active} n={queryN} onClose={() => setQueryN(null)} />
    </div>
  )
}
