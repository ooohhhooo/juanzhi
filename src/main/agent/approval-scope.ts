/**
 * 「本次对话都允许」的范围规则（纯函数，单测直接加载）。
 *
 * 范围 = 同一个对话（session）里，同一个工具 + 同一个去向（比如同一个企业微信群、同一个外部 MCP 工具）。
 * 换一个群、换一个工具、换一个对话，都要重新问；软件重启后全部作废（只放在内存里，不写数据库）。
 * 不开放这个选项的情况：
 *  - 发送内容里查出含个人信息（privacyWarning）：每次都要看一眼；
 *  - 名字里带删除 / 清空这类字眼的工具（现在没有，预留）；
 *  - 没标明性质的写操作（导入试卷、生成报告这类会花 AI 额度的）：每次问。
 */
import type { ToolPreviewInfo } from './types.ts'

export type ApprovalChoice = 'once' | 'session' | 'deny'
/** 记在步骤里的审批结果：auto = 这个对话里之前已选过「都允许」，这次没再询问 */
export type ApprovalRecord = 'once' | 'session' | 'auto' | 'deny'

const DESTRUCTIVE = /(delete|remove|clear|drop|purge|erase|wipe|del_|删除|清空|清除)/i

export function sessionScopeKey(tool: { level?: string; effect?: string } | undefined, name: string, args: unknown, preview?: ToolPreviewInfo): string | null {
  if (!tool || tool.level !== 'write') return null
  if (tool.effect !== 'external' && tool.effect !== 'export') return null
  if (DESTRUCTIVE.test(name)) return null
  if (preview?.privacyWarning) return null
  const kind = args && typeof args === 'object' && (args as any).kind === 'file' ? 'file' : ''
  return [name, preview?.target ?? '', kind].join('|')
}

/** 每个对话一份「已允许」名单；纯内存 */
export class SessionGrants {
  private m = new Map<string, Set<string>>()
  of(sessionId: string): Set<string> {
    let s = this.m.get(sessionId)
    if (!s) { s = new Set(); this.m.set(sessionId, s) }
    return s
  }
  clear(sessionId: string): void { this.m.delete(sessionId) }
}
