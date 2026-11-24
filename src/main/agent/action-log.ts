/**
 * 「它是怎么得出这个结论的」：把一次提问（从用户的问题到助手的回答）里已经落库的步骤整理成白话时间线。
 * 纯函数，只用 agent_steps 里原有的内容，所以老对话也能看；一次遍历，长对话也快。
 * 界面和单测都直接用这里的结果；原始输入输出在点开某一步时才格式化（formatRaw）。
 */
import type { ApprovalRecord } from './approval-scope.ts'

export interface LogStep { seq: number; kind: string; payload: any; ms?: number; createdAt?: string }

export type LogItemKind = 'tool' | 'plan' | 'ask' | 'nudge' | 'error'
export interface LogItem {
  seq: number
  kind: LogItemKind
  /** 白话名称：查了什么 / 做了什么 */
  label: string
  /** 用了什么条件（一句话，可能为空） */
  argText: string
  /** 结果一句话 */
  resultText: string
  ok: boolean
  ms: number
  /** 写操作的确认情况；只读查询没有 */
  approval?: ApprovalRecord
  approvalText?: string
  /** 点开才用：原始输入输出（还没脱敏、没截断） */
  raw?: { name: string; args: unknown; output: string; truncated: boolean }
}
export interface TurnLog {
  answerSeq: number
  summary: string
  counts: { reads: number; writes: number; confirms: number; autos: number; denies: number; errors: number; seconds: number }
  items: LogItem[]
}

/** 不算「查数据 / 用工具」的内部步骤 */
const META = new Set(['update_plan', 'ask_user', 'session_state', 'load_playbook'])
const NOUN: Record<string, string> = { papers_list: '份卷子', reports_list: '份报告', kp_questions: '道题', list_datasets: '个数据集', outputs_list: '个产出', connectors_list: '个连接', course_coverage: '门课' }
const ARG_KEY: Record<string, string> = { targetName: '发到', kind: '类型', datasetId: '数据集', format: '格式', reader: '读者', title: '标题', query: '关键词', keyword: '关键词', name: '名称', grade: '年级', semester: '学期' }
const SKIP_ARG = /^(content|text|body|sql|fileRef|path|id|ids|paperIds)$/

export function plainFail(summary: string): string {
  const t = String(summary ?? '').trim()
  if (/没有同意|不同意/.test(t)) return '你没有同意，已取消'
  const keep = t.split(/(?<=[。！？!?])/).map(x => x.trim()).filter(x => x && !/请(换|重|改|再)|换一种|直接问|用户想/.test(x))
  const first = (keep[0] ?? '').replace(/[。！？!?]+$/, '')
  return first ? (first.length > 36 ? first.slice(0, 35) + '…' : first) : '没做成'
}

export function resultSentence(name: string, ok: boolean, summary: string): string {
  if (!ok) return plainFail(summary)
  const s = String(summary ?? '').trim()
  const m = /^(\d+) 条$/.exec(s)
  if (m) return `找到 ${m[1]} ${NOUN[name] ?? '条结果'}`
  const c = /^(\d+) 字$/.exec(s)
  if (c) return `拿到了内容（${c[1]} 字）`
  return s || '完成'
}

const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n - 1) + '…' : v)

export function argSentence(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (typeof a.sql === 'string') return '按条件查询数据'
  const parts: string[] = []
  for (const [k, v] of Object.entries(a)) {
    if (parts.length >= 2) break
    if (SKIP_ARG.test(k) || v == null || v === '') continue
    let val = ''
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') val = String(v)
    else if (Array.isArray(v)) val = `${v.length} 项`
    else continue
    if (/^(api|secret|token|pass|auth|key)/i.test(k)) continue
    parts.push(ARG_KEY[k] ? `${ARG_KEY[k]}：${clip(val, 24)}` : clip(val, 24))
  }
  return parts.join('，')
}

const APPROVAL_TEXT: Record<ApprovalRecord, string> = {
  once: '你确认了（仅这一次）', session: '你选了「本次对话都允许」', auto: '这个对话里已允许，没有再询问', deny: '你没有同意'
}

export function formatSeconds(s: number): string {
  if (s < 1) return '不到 1 秒'
  if (s < 60) return `${Math.round(s)} 秒`
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`
}

const parseTime = (t?: string): number | null => {
  if (!t) return null
  const d = Date.parse(t.replace(' ', 'T'))
  return Number.isFinite(d) ? d : null
}

export function summaryText(c: TurnLog['counts']): string {
  const parts: string[] = []
  if (c.reads) parts.push(`查了 ${c.reads} 次数据`)
  if (c.writes) parts.push(`用了 ${c.writes} 个工具`)
  if (c.confirms) parts.push(`你确认了 ${c.confirms} 次`)
  if (c.autos) parts.push(`本次对话已允许 ${c.autos} 次`)
  if (c.denies) parts.push(`你拒绝了 ${c.denies} 次`)
  if (c.errors) parts.push(`出错 ${c.errors} 次`)
  if (!parts.length) parts.push('直接回答，没有查数据')
  parts.push(`用时 ${formatSeconds(c.seconds)}`)
  return parts.join(' · ')
}

/**
 * @param steps 当前能看到的这条线上的全部步骤（按先后排好）
 * @param labelOf 工具名 → 白话名称
 * @returns 回答步骤的 seq → 这一轮的行动记录
 */
export function buildTurnLogs(steps: LogStep[], labelOf: (name: string) => string): Map<number, TurnLog> {
  const out = new Map<number, TurnLog>()
  let turn: LogStep[] = []
  const flush = (answer: LogStep) => {
    out.set(answer.seq, buildOne(turn, answer, labelOf))
    turn = []
  }
  for (const s of steps) {
    if (s.kind === 'user') turn = [s]
    else if (s.kind === 'answer') flush(s)
    else turn.push(s)
  }
  return out
}

function buildOne(turn: LogStep[], answer: LogStep, labelOf: (n: string) => string): TurnLog {
  const results = new Map<string, LogStep>()
  for (const s of turn) if (s.kind === 'tool_result') results.set(String(s.payload?.id), s)
  const items: LogItem[] = []
  const c = { reads: 0, writes: 0, confirms: 0, autos: 0, denies: 0, errors: 0, seconds: 0 }
  let toolMs = 0
  for (const s of turn) {
    const p = s.payload ?? {}
    if (s.kind === 'tool_call') {
      const name = String(p.name)
      const r = results.get(String(p.id))
      const ok = r ? r.payload?.ok !== false : false
      const ms = r?.ms ?? 0
      toolMs += ms
      if (name === 'update_plan' || name === 'session_state') continue
      if (name === 'ask_user') continue   // 提问有自己的一步（kind = ask）
      const summary = String(r?.payload?.summary ?? '')
      let approval: ApprovalRecord | undefined = p.approval
      if (!approval && p.level === 'write' && !ok && /没有同意|不同意/.test(summary)) approval = 'deny'
      const isMeta = META.has(name)
      if (!isMeta) { if (p.level === 'write') c.writes++; else c.reads++ }
      if (approval === 'once' || approval === 'session') c.confirms++
      else if (approval === 'auto') c.autos++
      else if (approval === 'deny') c.denies++
      if (r && !ok && approval !== 'deny') c.errors++
      items.push({
        seq: s.seq, kind: 'tool', label: labelOf(name), argText: argSentence(p.args), resultText: r ? resultSentence(name, ok, summary) : '没有等到结果', ok: r ? ok : false, ms,
        ...(approval ? { approval, approvalText: APPROVAL_TEXT[approval] } : {}),
        raw: { name, args: p.args ?? {}, output: String(r?.payload?.text ?? ''), truncated: !!r?.payload?.truncated }
      })
    } else if (s.kind === 'plan') {
      const n = Array.isArray(p.items) ? p.items.length : 0
      if (n) items.push({ seq: s.seq, kind: 'plan', label: '列了计划', argText: '', resultText: `${n} 步`, ok: true, ms: 0 })
    } else if (s.kind === 'ask' && !p.planReview) {
      items.push({ seq: s.seq, kind: 'ask', label: '向你确认', argText: clip(String(p.question ?? ''), 40), resultText: p.answer ? `你选了：${clip(String(p.answer), 30)}` : '没有等到你的回答', ok: true, ms: 0 })
    } else if (s.kind === 'ask' && p.planReview && p.answer) {
      items.push({ seq: s.seq, kind: 'ask', label: '确认计划', argText: '', resultText: p.answer === '按这个做' ? '你确认了计划' : '你提了修改意见', ok: true, ms: 0 })
    } else if (s.kind === 'assistant' && p.nudge) {
      items.push({ seq: s.seq, kind: 'nudge', label: '自动提醒', argText: '', resultText: '它说要做却没动手，软件自动提醒了它一次', ok: true, ms: 0 })
    } else if (s.kind === 'error') {
      c.errors++
      items.push({ seq: s.seq, kind: 'error', label: '出错', argText: '', resultText: plainFail(String(p.message ?? '')), ok: false, ms: 0 })
    }
  }
  const startT = parseTime(turn[0]?.createdAt), endT = parseTime(answer.createdAt)
  c.seconds = answer.ms && answer.ms > 0 ? answer.ms / 1000 : startT != null && endT != null && endT >= startT ? (endT - startT) / 1000 : toolMs / 1000
  return { answerSeq: answer.seq, summary: summaryText(c), counts: c, items }
}

// ───────── 原始输入输出（点开某一步才用） ─────────
const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|cookie|webhook)/i
export function redactText(t: string): string {
  return t
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ***')
    .replace(/([?&](?:key|token|secret|access_token|api_key|apikey|sign)=)[^&\s"'<>]+/gi, '$1***')
}
export function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 8) return '…'
  if (typeof v === 'string') return redactText(v)
  if (Array.isArray(v)) return v.slice(0, 200).map(x => redactDeep(x, depth + 1))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : redactDeep(x, depth + 1)]))
  return v
}
export const RAW_MAX = 3000
/** 把某一步的输入 / 输出变成给人看的文本：脱敏、格式化 JSON、超长截断 */
export function formatRaw(value: unknown, max = RAW_MAX): { text: string; truncated: boolean } {
  let t: string
  if (typeof value === 'string') {
    try { t = JSON.stringify(redactDeep(JSON.parse(value)), null, 2) } catch { t = redactText(value) }
  } else t = JSON.stringify(redactDeep(value ?? {}), null, 2)
  return t.length > max ? { text: t.slice(0, max) + '\n……（太长，已截断）', truncated: true } : { text: t, truncated: false }
}
