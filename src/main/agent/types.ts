/**
 * 内置助手（Agent）的公共类型。纯类型 + 少量常量，不依赖 electron，单测直接加载。
 */
import type { z } from 'zod'
import type { ChatMessage, ToolCall, ToolSpec } from '../ai/client.ts'

export type Scene = 'org' | 'school'
export type ToolLevel = 'read' | 'write'
/** 运行模式：direct 直接回答（最多 5 轮、不写计划）；plan 先出计划（默认，用户确认前只能用概况类只读工具）；auto 自动完成（不暂停，只在 ask_user 和写操作审批时停） */
export type AgentMode = 'direct' | 'plan' | 'auto'
export const AGENT_MODES: AgentMode[] = ['direct', 'plan', 'auto']
/** 审批模式：ask-all 每次询问（导出文件、对外发送都要点同意）；ask-external 只问对外发送（导出到本机文件不再询问）。没有「完全不问」——对外发送永远要确认，程序层面强制 */
export type ApprovalMode = 'ask-all' | 'ask-external'
export const APPROVAL_MODES: ApprovalMode[] = ['ask-all', 'ask-external']
export const DIRECT_MAX_ROUNDS = 5
export const PLAN_APPROVE = '按这个做'

export type PlanStatus = 'todo' | 'doing' | 'done'
export interface PlanItem { content: string; status: PlanStatus }

/** 工具返回：纯文本，或「文本 + 条数」（条数用来在上下文压缩时写成一句摘要） */
export type ToolOutput = string | { text: string; count?: number }

/** 一次查询（工具调用）的记录：编号 + 结果摘要。存在会话记录里，上下文被整理后用 session_state 随时取回 */
export interface QueryRec { n: number; id: string; name: string; args: string; ok: boolean; note: string; text: string }
/** 不靠上下文记住的会话状态：计划、查询记录、用户在提问里做的选择 */
export interface SessionState { plan: PlanItem[]; queries: QueryRec[]; choices: Array<{ question: string; answer: string }> }

/** 工具运行时能用到的东西（由 harness / service 填入） */
export interface ToolCtx {
  /** node:sqlite 数据库句柄 */
  db: any
  scene: Scene
  roleId: string
  signal: AbortSignal
  sessionId: string
  /** 更新计划清单（界面显示） */
  setPlan: (items: PlanItem[]) => void
  /** 暂停循环向用户提问，返回用户选的（或写的）答案；中止时抛错 */
  ask: (q: { question: string; options: string[]; allowOther: boolean }) => Promise<string>
  /** 取剧本全文（按名字） */
  playbook: (name: string) => { name: string; description: string; body: string } | null
  playbookNames: () => string[]
  /** 当前会话状态（计划、查询记录、选择） */
  state: () => SessionState
  /** 数据目录（看板草稿、产出、用户剧本放在这下面）；单测可以不给 */
  dataDir: string
  /** 长任务的进度（比如文字归类 done/total）；界面显示在这一步的工具条目里 */
  progress: (done: number, total: number) => void
  /** 子 Agent：几件独立的事同时交给子助手做（只能查询和写草稿，不能问用户、不能对外发送），返回各自的结论；没给就表示不支持 */
  spawn?: (tasks: SubTask[], onDone: (done: number, total: number) => void) => Promise<SubResult[]>
}

export interface SubTask { title: string; instructions: string }
export interface SubResult { title: string; ok: boolean; text: string; stop: StopReason }

/** 需要用户同意的对外发送：发到哪里 + 完整内容；含个人信息时 privacyWarning 非空，界面要醒目显示 */
export interface ToolPreviewInfo { target: string; content: string; privacyWarning?: string }

export interface ToolDef<A = any> {
  name: string
  /** 给模型看的说明：什么时候用、返回什么 */
  description: string
  /** 参数的 zod 校验；同时自动转成 JSON Schema 发给模型 */
  schema: z.ZodType<A, z.ZodTypeDef, any>
  /** read：直接执行；write：必须用户在界面点「同意」才执行 */
  level: ToolLevel
  run: (args: A, ctx: ToolCtx) => Promise<ToolOutput> | ToolOutput
  /** write 工具弹窗里显示的一句人话，说明将要做什么 */
  describe?: (args: A) => string
  /** 界面上显示的中文名 */
  label?: string
  /** 写操作的性质：export = 导出到本机文件（「只问对外发送」时不再询问）；external = 对外发送（发到企业微信 / 外部插件，永远询问）。没写 = 按对外发送处理 */
  effect?: 'export' | 'external'
  /** 「先出计划」模式下，用户确认计划前也能用的工具（只读的概况类 + 计划 / 提问 / 剧本）。没写 = 确认前被程序禁用 */
  planSafe?: boolean
  /** write 工具弹窗里显示的完整预览（对外发送必须有）；抛错 = 这次调用失败，不弹窗 */
  preview?: (args: A, ctx: ToolCtx) => Promise<ToolPreviewInfo | string> | ToolPreviewInfo | string
  /** 直接给模型看的参数 JSON Schema（外部 MCP 工具用）；没写就由 schema 生成 */
  inputSchema?: Record<string, unknown>
}

export interface Budget {
  /** 最多几轮（每次问模型算一轮） */
  maxRounds: number
  /** 本次提问累计 token 上限（输入 + 输出） */
  maxTokens: number
  /** 最长时间（毫秒） */
  maxMs: number
  /** 对话 token 估算超过这个值时压缩较早的工具结果 */
  contextTokens: number
  /** 单个工具结果的最大字符数 */
  toolResultChars: number
  /** 连续这么多次同名同参数的工具调用，判定卡住 */
  stuckRepeat: number
}

export const DEFAULT_BUDGET: Budget = {
  maxRounds: 25, maxTokens: 400_000, maxMs: 10 * 60_000, contextTokens: 60_000, toolResultChars: 6000, stuckRepeat: 3
}

export type StopReason = 'answered' | 'stopped' | 'rounds' | 'tokens' | 'time' | 'stuck' | 'error'

/** harness 发出的事件：界面实时显示，service 把它们落进 agent_steps */
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; n: number; name: string; args: unknown; level: ToolLevel }
  | { type: 'tool_result'; id: string; n: number; name: string; ok: boolean; summary: string; text: string; truncated: boolean; ms: number }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'ask'; id: string; question: string; options: string[]; allowOther: boolean; planReview?: boolean }
  | { type: 'asked'; id: string; answer: string }
  | { type: 'approval'; id: string; name: string; args: unknown; summary: string; preview?: ToolPreviewInfo }
  | { type: 'tool_progress'; id: string; done: number; total: number }
  | { type: 'approved'; id: string; ok: boolean }
  | { type: 'compacted'; by: 'ai' | 'program'; summary: string }
  | { type: 'progress'; rounds: number; tokensIn: number; tokensOut: number }
  | { type: 'answer'; text: string; removedRefs: number; stop: StopReason }
  | { type: 'error'; code: string; message: string }

export interface ModelReply {
  content: string
  toolCalls: ToolCall[]
  usage: { promptTokens: number; completionTokens: number }
  reasoningText?: string
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
  onDelta: (t: string) => void
}

export interface RunResult {
  stop: StopReason
  answer: string
  removedRefs: number
  rounds: number
  tokensIn: number
  tokensOut: number
  /** 本次新增的消息（不含 system 和旧历史） */
  newMessages: ChatMessage[]
  plan: PlanItem[]
  /** 调用模型出错时的原因（stop = 'error'） */
  error?: { code: string; message: string }
}
