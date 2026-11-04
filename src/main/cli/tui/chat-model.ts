/**
 * 交互界面的对话状态：把助手服务发出的事件（和窗口收到的 agent:event 同一份）折叠成
 *   · items：已经定下来的内容（问题、回答、工具行、计划……），界面一行行往上滚；
 *   · live：正在发生的（流式文字、进行中的工具、当前计划、等你回答的提问 / 审批）。
 * 纯逻辑，不依赖 Ink / electron，单测直接加载。
 */

export type Tone = 'info' | 'ok' | 'warn' | 'error'
export interface PlanRow { content: string; status: 'todo' | 'doing' | 'done' }

export type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'text'; md: string }
  | { id: number; kind: 'tool'; label: string; hint: string; ok: boolean; ms: number; summary: string }
  | { id: number; kind: 'plan'; items: PlanRow[] }
  | { id: number; kind: 'notice'; text: string; tone: Tone }
  | { id: number; kind: 'lines'; title?: string; lines: string[]; mono?: boolean }
  | { id: number; kind: 'md'; md: string }
  | { id: number; kind: 'banner'; banner: Banner }

/** 还没有编号的内容 */
export type NewItem = Item extends infer I ? (I extends { id: number } ? Omit<I, 'id'> : never) : never

export interface Banner {
  version: string; dataDir: string; model: string | null
  papers: number; parsed: number; datasets: number; role: string
}

export interface PendingAsk { type: 'ask'; id: string; question: string; options: string[]; allowOther: boolean; planReview: boolean }
export interface PendingApproval { type: 'approval'; id: string; name: string; summary: string; target?: string; content?: string; privacyWarning?: string }
export type Pending = PendingAsk | PendingApproval

export interface RunningTool { id: string; name: string; label: string; hint: string; t0: number; done?: number; total?: number }

export interface Usage { tokensIn: number; tokensOut: number; money: number | null }

export interface Live {
  running: boolean
  stream: string
  tools: RunningTool[]
  plan: PlanRow[]
  pending: Pending | null
  status: string
  runStartedAt: number
}

export interface ModelOpts {
  /** 工具的中文名（没有就用工具名） */
  toolLabel?: (name: string) => string
  now?: () => number
}

const STOP_TEXT: Record<string, string> = {
  stopped: '已中断',
  rounds: '步骤太多，已停止。可以把问题拆小一点再问',
  tokens: '用量到了上限，已停止。可以把问题拆小一点再问',
  time: '用时太长，已停止',
  stuck: '助手卡在重复同一步，已停止。换个问法再试'
}

/** 工具参数里挑一个最能说明「在查什么」的短句（SQL / 名字 / 关键词），最多 60 字 */
export function argHint(args: unknown): string {
  let o: any = args
  if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return o.replace(/\s+/g, ' ').slice(0, 60) } }
  if (!o || typeof o !== 'object') return ''
  for (const k of ['sql', 'question', 'query', 'name', 'title', 'kp', 'keyword', 'format', 'targetName', 'id']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 60)
  }
  for (const v of Object.values(o)) if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 60)
  return ''
}

export class ChatModel {
  items: Item[] = []
  /** 清屏次数：界面用它当 key 重新挂载滚动区，旧内容才不会残留 */
  epoch = 0
  live: Live = { running: false, stream: '', tools: [], plan: [], pending: null, status: '', runStartedAt: 0 }
  sessionId: string | undefined
  /** 本对话累计（含已结束的几次提问） */
  usage: Usage = { tokensIn: 0, tokensOut: 0, money: 0 }
  /** 这一次提问的累计 */
  private run: Usage = { tokensIn: 0, tokensOut: 0, money: 0 }
  private seq = 0
  private lastPlanSig = ''
  private listeners = new Set<() => void>()
  private version = 0
  private readonly o: Required<ModelOpts>

  constructor(o: ModelOpts = {}) {
    this.o = { toolLabel: o.toolLabel ?? (n => n), now: o.now ?? Date.now }
  }

  subscribe(fn: () => void): () => void { this.listens(fn); return () => { this.listeners.delete(fn) } }
  private listens(fn: () => void): void { this.listeners.add(fn) }
  getVersion(): number { return this.version }
  private touch(): void { this.version++; for (const f of this.listeners) f() }
  /** 外部状态变了（角色 / 模式 / 模型）：通知界面重画 */
  refresh(): void { this.touch() }

  add(item: NewItem): void {
    this.items = [...this.items, { ...item, id: ++this.seq } as Item]
    this.touch()
  }
  notice(text: string, tone: Tone = 'info'): void { this.add({ kind: 'notice', text, tone }) }
  /** /clear：清掉已显示的内容 */
  clearItems(): void { this.items = []; this.epoch++; this.touch() }
  /** /new：新对话——清掉对话状态和用量 */
  resetSession(): void {
    this.sessionId = undefined
    this.usage = { tokensIn: 0, tokensOut: 0, money: 0 }
    this.run = { tokensIn: 0, tokensOut: 0, money: 0 }
    this.live = { running: false, stream: '', tools: [], plan: [], pending: null, status: '', runStartedAt: 0 }
    this.lastPlanSig = ''
    this.touch()
  }
  setSession(id: string | undefined, usage?: Usage): void { this.sessionId = id; if (usage) this.usage = usage; this.touch() }

  /** 开始一次提问（在调用 startRun 之前调用，事件可能在 startRun 返回前就到） */
  beginRun(text: string): void {
    this.add({ kind: 'user', text })
    this.run = { tokensIn: 0, tokensOut: 0, money: 0 }
    this.live = { ...this.live, running: true, stream: '', tools: [], pending: null, status: '', runStartedAt: this.o.now() }
    this.touch()
  }
  /** 启动失败（还没有产生事件） */
  failRun(message: string): void {
    this.live = { ...this.live, running: false, status: '' }
    this.notice(message, 'error')
  }

  private flushPlan(): void {
    const p = this.live.plan
    const sig = JSON.stringify(p)
    if (p.length && sig !== this.lastPlanSig) { this.lastPlanSig = sig; this.add({ kind: 'plan', items: p.map(x => ({ ...x })) }) }
  }

  /** 收一条助手事件（payload 和窗口的 agent:event 一样） */
  apply(p: Record<string, any>): void {
    if (typeof p.sessionId === 'string' && !this.sessionId) this.sessionId = p.sessionId
    const live = this.live
    switch (p.type) {
      case 'delta': live.stream += String(p.text ?? ''); break
      case 'reset': live.stream = ''; break
      case 'status': live.status = String(p.text ?? ''); break
      case 'tool-progress': {
        const t = live.tools.find(x => x.id === p.id)
        if (t) { t.done = p.done; t.total = p.total }
        break
      }
      case 'progress': {
        this.run = { tokensIn: p.tokensIn ?? 0, tokensOut: p.tokensOut ?? 0, money: typeof p.money === 'number' ? p.money : null }
        break
      }
      case 'approval': {
        const pv = p.preview as { target?: string; content?: string; privacyWarning?: string } | undefined
        live.pending = { type: 'approval', id: p.id, name: String(p.name ?? ''), summary: String(p.summary ?? ''), target: pv?.target, content: pv?.content, privacyWarning: pv?.privacyWarning }
        break
      }
      case 'step': this.step(p); return
      case 'done': this.done(p); return
      default: return
    }
    this.touch()
  }

  private step(p: Record<string, any>): void {
    const live = this.live
    const pl = p.payload ?? {}
    switch (p.kind) {
      case 'assistant':
        live.stream = ''
        if (pl.compacted) this.add({ kind: 'notice', text: '前面的内容太长，已整理成摘要继续', tone: 'info' })
        else if (String(pl.text ?? '').trim()) this.add({ kind: 'text', md: String(pl.text) })
        return
      case 'tool_call': {
        const name = String(pl.name ?? '')
        live.stream = ''
        live.tools = [...live.tools, { id: String(pl.id), name, label: this.o.toolLabel(name), hint: argHint(pl.args), t0: this.o.now() }]
        break
      }
      case 'tool_result': {
        const t = live.tools.find(x => x.id === pl.id)
        live.tools = live.tools.filter(x => x.id !== pl.id)
        // update_plan 的结果没有信息量，计划本身另外显示
        if (pl.name === 'update_plan' || pl.name === 'ask_user') break
        this.add({ kind: 'tool', label: t?.label ?? this.o.toolLabel(String(pl.name ?? '')), hint: t?.hint ?? '', ok: pl.ok !== false, ms: Number(p.ms) || 0, summary: String(pl.summary ?? '') })
        return
      }
      case 'plan':
        live.plan = Array.isArray(pl.items) ? pl.items.map((x: any) => ({ content: String(x.content ?? ''), status: x.status === 'done' || x.status === 'doing' ? x.status : 'todo' })) : []
        break
      case 'ask':
        live.stream = ''
        if (pl.planReview) this.flushPlan()
        live.pending = { type: 'ask', id: String(pl.id), question: String(pl.question ?? ''), options: Array.isArray(pl.options) ? pl.options.map(String) : [], allowOther: pl.allowOther !== false, planReview: !!pl.planReview }
        break
      case 'answer': {
        live.stream = ''
        this.flushPlan()
        if (String(pl.text ?? '').trim()) this.add({ kind: 'text', md: String(pl.text) })
        if (pl.stop && pl.stop !== 'answered' && STOP_TEXT[pl.stop]) this.add({ kind: 'notice', text: STOP_TEXT[pl.stop], tone: 'warn' })
        return
      }
      case 'error':
        live.stream = ''
        this.add({ kind: 'notice', text: String(pl.message ?? '出错了'), tone: 'error' })
        return
      default: break
    }
    this.touch()
  }

  private done(p: Record<string, any>): void {
    this.flushPlan()
    if (p.status === 'stopped') this.add({ kind: 'notice', text: STOP_TEXT.stopped, tone: 'warn' })
    this.usage = {
      tokensIn: this.usage.tokensIn + this.run.tokensIn, tokensOut: this.usage.tokensOut + this.run.tokensOut,
      money: this.usage.money === null || this.run.money === null ? null : this.usage.money + this.run.money
    }
    this.run = { tokensIn: 0, tokensOut: 0, money: 0 }
    this.live = { ...this.live, running: false, stream: '', tools: [], pending: null, status: '' }
    this.touch()
  }

  /** 状态栏用：本对话累计 + 正在进行的这次 */
  totalUsage(): Usage {
    return {
      tokensIn: this.usage.tokensIn + this.run.tokensIn, tokensOut: this.usage.tokensOut + this.run.tokensOut,
      money: this.usage.money === null || this.run.money === null ? null : this.usage.money + this.run.money
    }
  }
}

/** 12345 → 1.2k */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
export function fmtUsage(u: Usage, priced: boolean): string {
  const tok = `${fmtTokens(u.tokensIn + u.tokensOut)} tokens`
  if (u.money !== null && u.money !== undefined) return `${tok} · ¥${u.money < 0.01 && u.money > 0 ? '<0.01' : u.money.toFixed(2)}`
  return priced ? tok : `${tok} · 未设价格`
}
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 以前的对话（agent_steps）还原成界面上的内容。steps 里的代号已由 sessionView 还原成真名 */
export function itemsFromSteps(steps: Array<{ kind: string; payload: any; ms?: number }>, labelOf: (name: string) => string): NewItem[] {
  const out: NewItem[] = []
  const calls = new Map<string, any>()
  let lastPlan: PlanRow[] = []
  for (const s of steps) {
    const p = s.payload ?? {}
    switch (s.kind) {
      case 'user': out.push({ kind: 'user', text: String(p.text ?? '') }); break
      case 'assistant': if (!p.compacted && String(p.text ?? '').trim()) out.push({ kind: 'text', md: String(p.text) }); break
      case 'tool_call': calls.set(String(p.id), p); break
      case 'tool_result': {
        if (p.name === 'update_plan' || p.name === 'ask_user') break
        out.push({ kind: 'tool', label: labelOf(String(p.name ?? '')), hint: argHint(calls.get(String(p.id))?.args), ok: p.ok !== false, ms: Number(s.ms) || 0, summary: String(p.summary ?? '') })
        break
      }
      case 'plan': lastPlan = Array.isArray(p.items) ? p.items : []; break
      case 'answer':
        if (lastPlan.length) { out.push({ kind: 'plan', items: lastPlan.map(x => ({ content: String(x.content), status: x.status })) }); lastPlan = [] }
        if (String(p.text ?? '').trim()) out.push({ kind: 'text', md: String(p.text) })
        break
      case 'error': out.push({ kind: 'notice', text: String(p.message ?? '出错了'), tone: 'error' }); break
      default: break
    }
  }
  return out
}
