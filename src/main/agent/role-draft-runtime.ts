/**
 * 「让助手帮我生成角色」的运行时接线（依赖 electron 里的 AI 配置和网络，单测不加载它）。
 * 复用课程模块的 jsonCall（含用量记录、超时），kind 固定为 'agent-role-draft'。
 */
import { loadConfig } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { promptText } from '../ai/prompts'
import { parseModelOf } from '../ai/types'
import { jsonCall } from '../course/service'
import { allPlaybooks, getScene, toolList } from './service'
import { draftVars, fillTemplate, normalizeRoleDraft } from './role-draft'
import type { RoleDraft, RoleDraftAnswers } from './role-draft'

const running = new Map<string, AbortController>()

export function cancelRoleDraft(reqId: string): boolean {
  const c = running.get(reqId)
  if (!c) return false
  c.abort()
  return true
}

export async function generateRoleDraft(reqId: string, a: RoleDraftAnswers): Promise<RoleDraft> {
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  if (!cfg.base_url || !model || !getApiKey()) throw new Error('还没有配置 AI 服务，请先在设置里配置 AI 服务')
  const tools = toolList()
  const skills = allPlaybooks()
  const vars = draftVars(a, getScene(), tools, skills)
  const ctl = new AbortController()
  running.set(reqId, ctl)
  try {
    const r = await jsonCall({
      kind: 'agent-role-draft', model, signal: ctl.signal, maxTokens: 3000,
      system: promptText('p7_role_draft', 'system'), user: fillTemplate(promptText('p7_role_draft', 'user'), vars)
    })
    const draft = normalizeRoleDraft(r.content, new Set(tools.map(t => t.name)), new Set(skills.map(s => s.name)))
    if (!draft) throw new Error('AI 的回答不是有效的角色草稿，请再试一次，或改用模板')
    return draft
  } finally {
    running.delete(reqId)
  }
}
