/** 连接器框架：把卷知的产出发到外部（企业微信群等）。纯类型，不依赖 electron。 */
import type { ZodTypeAny } from 'zod'

export interface ActionCtx {
  signal?: AbortSignal
  /** 当前助手会话和数据目录（发文件时用来限定可发范围） */
  sessionId?: string
  dataDir?: string
}

export interface ActionResult { ok: boolean; message: string }

export interface ConnectorAction {
  name: string
  description: string
  params: ZodTypeAny
  run(args: any, config: any, ctx: ActionCtx): Promise<ActionResult>
}

export interface Connector {
  id: string
  name: string
  description: string
  /** 完整配置的校验（含密钥字段） */
  configSchema: ZodTypeAny
  /** 配置里属于密钥的字段名：加密存放，界面只显示掩码 */
  secretFields: string[]
  test(config: any): Promise<ActionResult>
  actions: ConnectorAction[]
  /** 界面上用的掩码描述（不含密钥） */
  mask?(config: any): string
}

export interface ToolPreview {
  /** 发到哪里，例如「企业微信群：三年级辅导群」 */
  target: string
  /** 将发送的完整内容 */
  content: string
  /** 内容可能含个人信息时为提示文字（内核要醒目显示） */
  privacyWarning?: string
}

/** 给 Agent 的工具定义。level 'external'：每次执行前必须由内核弹窗让用户看 preview 并点「发送」 */
export interface AgentTool {
  name: string
  description: string
  params: ZodTypeAny
  level: 'external'
  /** 参数的 JSON Schema（MCP 工具带） */
  inputSchema?: unknown
  preview(args: any): Promise<ToolPreview>
  run(args: any, ctx?: ActionCtx): Promise<ActionResult>
}
