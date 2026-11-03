/**
 * 助手的循环（Harness）：发 [system + 历史 + 提问 + 工具清单] → 模型要调工具就执行、把结果追加成 tool 消息 → 再发……
 * 直到模型给出普通文字（最终回答）。模型接口、审批、提问都通过 deps 注入，所以可以用假模型单测，不依赖 electron。
 *
 * 刹车：最多轮数 / token / 时间；连续 N 次同名同参数的调用判定卡住；用户随时停止（AbortSignal）。
 * 任何一种刹车触发，都把已有进展整理成「到目前为止的结果」返回（程序生成，不再问模型）。
 */
import { AiError } from '../ai/client.ts'
import type { ChatMessage, ToolCall } from '../ai/client.ts'
import { validateCitations } from './citations.ts'
import type { CiteChecker } from './citations.ts'
import { COMPACT_RATIO, applyCompaction, compressOldToolResults, estimateMessages, findCompactRange, programSummary, serializeForSummary, stateIndex, truncateResult, wrapToolResult } from './context.ts'
import type { ToolMeta } from './context.ts'
import type { ToolRegistry } from './registry.ts'
import { DEFAULT_BUDGET, DIRECT_MAX_ROUNDS, PLAN_APPROVE } from './types.ts'
import type { AgentEvent, AgentMode, ApprovalMode, Budget, ModelReply, ModelRequest, PlanItem, QueryRec, RunResult, SessionState, StopReason, ToolCtx, ToolOutput, ToolPreviewInfo } from './types.ts'

export interface RunDeps {
  callModel: (req: ModelRequest) => Promise<ModelReply>
  registry: ToolRegistry
  /** 这个角色能用的工具名单 */
  toolNames: string[]
  ctx: Pick<ToolCtx, 'db' | 'scene' | 'roleId' | 'sessionId' | 'playbook' | 'playbookNames'> & { dataDir?: string }
  /** 以前几轮留在会话记录里的状态（计划、查询记录、选择）：接着追问时查询编号接着往下排 */
  initialState?: SessionState
  /** 自动整理：对话估算超过 limitTokens × ratio（默认 70%）时，把较早的内容换成摘要；summarize 失败 / 没给就用程序生成的摘要 */
  compact?: { limitTokens: number; ratio?: number; summarize?: (text: string) => Promise<string> }
  /** 写操作：弹窗让用户同意；返回 true = 同意 */
  approve: (req: { id: string; name: string; args: unknown; summary: string; preview?: ToolPreviewInfo }) => Promise<boolean>
  /** ask_user：把问题交给界面，返回用户的选择 */
  askUser: (req: { id: string; question: string; options: string[]; allowOther: boolean }) => Promise<string>
  emit: (e: AgentEvent) => void
  signal: AbortSignal
  budget?: Partial<Budget>
  /** 运行模式，默认 auto */
  mode?: AgentMode
  /** 审批模式，默认 ask-all；只有 effect = export 的写操作才可能免问，其余写操作永远要用户同意 */
  approvalMode?: ApprovalMode
  cite: CiteChecker
  now?: () => number
}

export interface RunInput {
  system: string
  history: ChatMessage[]
  user: string
}

const STOP_TEXT: Record<StopReason, string> = {
  answered: '', stopped: '已按你的要求停止', rounds: '查询步骤太多，已自动停止', tokens: '本次用量已到上限，已自动停止',
  time: '用时太长，已自动停止', stuck: '助手在重复同一个查询，似乎卡住了，已自动停止', error: '调用模型时出错，已停止'
}

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AiError('aborted', '已取消'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiError('aborted', '已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v) }, e => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || (e instanceof AiError && e.code === 'aborted')

const PLAN_MARK: Record<string, string> = { todo: '[ ]', doing: '[~]', done: '[x]' }
/** 这几个工具不算「查询」：不编号、不进查询记录 */
const NOT_RECORDED = new Set(['update_plan', 'ask_user', 'session_state', 'load_playbook'])

/** 停止 / 刹车时的「到目前为止的结果」：计划完成情况 + 已经查过什么 + 模型最后说的一段 */
export function progressSummary(reason: StopReason, plan: PlanItem[], steps: Array<{ name: string; args: string; ok: boolean; note: string }>, lastText: string): string {
  const lines: string[] = [`${STOP_TEXT[reason] || '已停止'}。以下是到目前为止的结果：`]
  if (plan.length) lines.push('', '计划进度：', ...plan.map(p => `- ${PLAN_MARK[p.status] ?? '[ ]'} ${p.content}`))
  if (steps.length) {
    lines.push('', '已经查过的内容：')
    for (const s of steps.slice(-12)) lines.push(`- ${s.name} ${s.args.length > 80 ? s.args.slice(0, 80) + '…' : s.args}：${s.ok ? s.note : '没有成功（' + s.note + '）'}`)
    if (steps.length > 12) lines.push(`- （前面还有 ${steps.length - 12} 步）`)
  } else lines.push('', '还没有查到任何数据。')
  if (lastText.trim()) lines.push('', '助手最后写到的内容：', lastText.trim())
  lines.push('', '可以换个更具体的问法，或点推荐问题重新开始。')
  return lines.join('\n')
}

export async function runAgent(deps: RunDeps, input: RunInput): Promise<RunResult> {
  const mode: AgentMode = deps.mode ?? 'auto'
  const budget: Budget = { ...DEFAULT_BUDGET, ...(deps.budget ?? {}) }
  if (mode === 'direct') budget.maxRounds = Math.min(budget.maxRounds, DIRECT_MAX_ROUNDS)
  // 「先出计划」：用户确认计划之前，只有 planSafe 的工具（概况类只读 + 计划 / 提问 / 剧本）可用——程序层面限制，不靠提示词
  let phase: 'planning' | 'executing' = mode === 'plan' ? 'planning' : 'executing'
  const allowedNow = (name: string): boolean => {
    if (!deps.toolNames.includes(name)) return false
    if (mode === 'direct' && name === 'update_plan') return false
    if (phase === 'planning') return !!registry.get(name)?.planSafe
    return true
  }
  const now = deps.now ?? Date.now
  const t0 = now()
  const { registry, emit, signal } = deps

  const messages: ChatMessage[] = [{ role: 'system', content: input.system }, ...input.history, { role: 'user', content: input.user }]
  const startAt = messages.length - 1   // 本次新增的消息从用户提问开始
  const meta = new Map<string, ToolMeta>()
  const state: SessionState = { plan: [], queries: [...(deps.initialState?.queries ?? [])], choices: [...(deps.initialState?.choices ?? [])] }
  let nextN = state.queries.reduce((m, q) => Math.max(m, q.n), 0) + 1
  let plan: PlanItem[] = []
  const steps: Array<{ name: string; args: string; ok: boolean; note: string }> = []
  let lastText = ''
  let rounds = 0, tokensIn = 0, tokensOut = 0
  let lastSig = '', repeat = 0

  let currentCall = ''
  const ctx: ToolCtx = {
    ...deps.ctx,
    dataDir: deps.ctx.dataDir ?? '',
    progress: (done, total) => { if (currentCall) emit({ type: 'tool_progress', id: currentCall, done, total }) },
    signal,
    state: () => ({ plan, queries: state.queries, choices: state.choices }),
    setPlan: items => { plan = items.map(i => ({ ...i })); emit({ type: 'plan', items: plan }) },
    ask: async q => {
      const id = `ask_${rounds}_${steps.length}`
      emit({ type: 'ask', id, ...q })
      const answer = await raceAbort(deps.askUser({ id, ...q }), signal)
      emit({ type: 'asked', id, answer })
      state.choices.push({ question: q.question, answer })
      return answer
    }
  }

  const finish = (stop: StopReason, answer: string, removedRefs = 0, error?: { code: string; message: string }): RunResult => {
    emit({ type: 'answer', text: answer, removedRefs, stop })
    return { stop, answer, removedRefs, rounds, tokensIn, tokensOut, newMessages: messages.slice(startAt), plan, ...(error ? { error } : {}) }
  }
  const brake = (stop: StopReason, error?: { code: string; message: string }) => finish(stop, progressSummary(stop, plan, steps, lastText), 0, error)

  const execute = async (call: ToolCall): Promise<string> => {
    const name = call.function.name
    const rawArgs = call.function.arguments
    const parsed = registry.parseArgs(name, rawArgs)
    const tool = registry.get(name)
    const t1 = now()
    let argsJson: unknown = {}
    try { argsJson = rawArgs.trim() ? JSON.parse(rawArgs) : {} } catch { argsJson = { _raw: rawArgs.slice(0, 200) } }
    const recorded = !NOT_RECORDED.has(name)
    const n = recorded ? nextN++ : 0
    currentCall = call.id
    emit({ type: 'tool_call', id: call.id, n, name, args: argsJson, level: tool?.level ?? 'read' })
    const done = (ok: boolean, out: ToolOutput | string): string => {
      const text0 = typeof out === 'string' ? out : out.text
      const count = typeof out === 'string' ? null : out.count ?? null
      const tr = truncateResult(text0, budget.toolResultChars)
      const note = !ok ? text0.replace(/\s+/g, ' ').slice(0, 60) : count != null ? `${count} 条` : `${text0.length} 字`
      meta.set(call.id, { name, args: rawArgs || '{}', count })
      steps.push({ name, args: rawArgs || '{}', ok, note })
      if (recorded) state.queries.push({ n, id: call.id, name, args: rawArgs || '{}', ok, note, text: tr.text } satisfies QueryRec)
      emit({ type: 'tool_result', id: call.id, n, name, ok, summary: ok ? note : text0.slice(0, 80), text: tr.text, truncated: tr.truncated, ms: now() - t1 })
      const body = ok ? tr.text : `错误：${tr.text}`
      return wrapToolResult(recorded ? `（查询 #${n}）\n${body}` : body)
    }
    if (!parsed.ok || !tool) return done(false, parsed.ok ? '工具不存在' : parsed.error)
    if (!deps.toolNames.includes(name)) return done(false, `当前角色不能使用工具「${name}」。可用的工具：${deps.toolNames.join('、')}`)
    if (!allowedNow(name)) return done(false, mode === 'direct' && name === 'update_plan' ? '现在是「直接回答」模式，不需要写计划，请直接查询并回答。' : '现在是「先出计划」阶段：这个工具要等用户确认计划后才能用。请先用 update_plan 给出计划。')
    if (tool.level === 'write') {
      const skipAsk = deps.approvalMode === 'ask-external' && tool.effect === 'export'
      if (skipAsk) { try { return done(true, await tool.run(parsed.args, ctx)) } catch (e) { if (isAbort(e, signal)) throw e; return done(false, `工具运行出错：${(e as Error).message}`) } }
      const summary = tool.describe?.(parsed.args) ?? `执行「${name}」`
      let preview: ToolPreviewInfo | undefined
      if (tool.preview) {
        try {
          const pv = await tool.preview(parsed.args, ctx)
          preview = typeof pv === 'string' ? { target: summary, content: pv } : pv
        } catch (e) { if (isAbort(e, signal)) throw e; return done(false, `无法生成发送预览：${(e as Error).message}`) }
      }
      emit({ type: 'approval', id: call.id, name, args: argsJson, summary, ...(preview ? { preview } : {}) })
      const ok = await raceAbort(deps.approve({ id: call.id, name, args: argsJson, summary, ...(preview ? { preview } : {}) }), signal)
      emit({ type: 'approved', id: call.id, ok })
      if (!ok) return done(false, '用户没有同意这个操作，没有执行。请换一种方式，或直接问用户想怎么做。')
    }
    try {
      return done(true, await tool.run(parsed.args, ctx))
    } catch (e) {
      if (isAbort(e, signal)) throw e
      return done(false, `工具运行出错：${(e as Error).message}`)
    }
  }

  try {
    for (;;) {
      if (signal.aborted) return brake('stopped')
      if (rounds >= budget.maxRounds) return brake('rounds')
      if (now() - t0 > budget.maxMs) return brake('time')
      if (tokensIn + tokensOut >= budget.maxTokens) return brake('tokens')
      if (deps.compact && estimateMessages(messages) > deps.compact.limitTokens * (deps.compact.ratio ?? COMPACT_RATIO)) {
        const range = findCompactRange(messages, startAt)
        if (range) {
          const older = messages.slice(range.from, range.to)
          let by: 'ai' | 'program' = 'program'
          let text = ''
          if (deps.compact.summarize) {
            try { text = (await raceAbort(deps.compact.summarize(serializeForSummary(older)), signal)).trim(); if (text) by = 'ai' } catch (e) { if (isAbort(e, signal)) return brake('stopped') }
          }
          const summary = by === 'ai' ? `${text}\n\n${stateIndex({ ...state, plan })}` : programSummary({ ...state, plan }, older)
          applyCompaction(messages, range, summary)
          emit({ type: 'compacted', by, summary })
        }
      }
      compressOldToolResults(messages, meta, deps.compact ? deps.compact.limitTokens : budget.contextTokens)
      rounds++
      let reply: ModelReply
      try {
        reply = await deps.callModel({ messages: messages.slice(), tools: registry.specs(deps.toolNames.filter(allowedNow)), signal, onDelta: t => emit({ type: 'delta', text: t }) })
      } catch (e) {
        if (isAbort(e, signal)) return brake('stopped')
        const ae = e instanceof AiError ? e : new AiError('network', (e as Error).message)
        emit({ type: 'error', code: ae.code, message: ae.message })
        return brake('error', { code: ae.code, message: ae.message })
      }
      tokensIn += reply.usage.promptTokens
      tokensOut += reply.usage.completionTokens
      emit({ type: 'progress', rounds, tokensIn, tokensOut })
      if (reply.toolCalls.length === 0) {
        const v = validateCitations(reply.content, { ...deps.cite, query: id => state.queries.some(q => String(q.n) === id) })
        messages.push({ role: 'assistant', content: reply.content })
        return finish('answered', v.text, v.removed)
      }
      if (reply.content.trim()) { lastText = reply.content; emit({ type: 'thought', text: reply.content }) }
      messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls, ...(reply.reasoningText ? { reasoning_content: reply.reasoningText } : {}) })
      let planned = false
      for (const call of reply.toolCalls) {
        if (signal.aborted) return brake('stopped')
        if (now() - t0 > budget.maxMs) return brake('time')
        // 卡住检测：同名同参数连续出现 stuckRepeat 次
        const sig = call.function.name + '\u0000' + (() => { try { return canon(JSON.parse(call.function.arguments || '{}')) } catch { return call.function.arguments } })()
        repeat = sig === lastSig ? repeat + 1 : 1
        lastSig = sig
        if (repeat >= budget.stuckRepeat) return brake('stuck')
        const content = await execute(call)
        messages.push({ role: 'tool', tool_call_id: call.id, content })
        if (phase === 'planning' && call.function.name === 'update_plan' && plan.length > 0 && steps[steps.length - 1]?.ok) planned = true
      }
      // 先出计划：计划写好了就暂停，等用户「按这个做」或给修改意见
      if (phase === 'planning' && planned) {
        const id = `plan_${rounds}`
        const q = { question: '要按这个计划做吗？', options: [PLAN_APPROVE], allowOther: true }
        emit({ type: 'ask', id, ...q, planReview: true })
        const ans = await raceAbort(deps.askUser({ id, ...q }), signal)
        emit({ type: 'asked', id, answer: ans })
        if (ans === PLAN_APPROVE) { phase = 'executing'; messages.push({ role: 'user', content: '用户确认了计划，请按计划开始执行。' }) }
        else messages.push({ role: 'user', content: `用户想修改计划：${ans}。请根据意见重新调用 update_plan 给出新计划（用户确认前仍然只能用概况类查询）。` })
      }
    }
  } catch (e) {
    if (isAbort(e, signal)) return brake('stopped')
    throw e
  }
}
