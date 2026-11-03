/**
 * 文字归类的运行时接线（依赖 electron 里的 AI 配置和网络，所以不放进纯逻辑文件里，单测不加载它）。
 * 复用课程模块的 jsonCall（含用量记录、超时、长度自动加大），kind 固定为 'analysis-classify'。
 */
import { loadConfig } from '../../ai/config'
import { promptText } from '../../ai/prompts'
import { parseModelOf } from '../../ai/types'
import { jsonCall } from '../../course/service'
import type { ClassifyAi, ClassifyPrompts } from './classify.ts'

export const runtimeClassifyAi: ClassifyAi = async o => {
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  if (!cfg.base_url || !model) throw new Error('还没有配置 AI 服务，文字归类需要先在“AI 服务”里配置')
  const r = await jsonCall({ kind: o.kind, model, system: o.system, user: o.user, signal: o.signal, maxTokens: o.maxTokens })
  return { content: r.content }
}

/** 读当前生效的提示词（用户在设置里改过就用改过的） */
export function runtimeClassifyPrompts(): ClassifyPrompts {
  return {
    proposeSystem: promptText('p6_classify_propose', 'system'), proposeUser: promptText('p6_classify_propose', 'user'),
    assignSystem: promptText('p6_classify_assign', 'system'), assignUser: promptText('p6_classify_assign', 'user')
  }
}
