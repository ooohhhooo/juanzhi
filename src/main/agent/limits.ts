/**
 * 上下文上限（token）：按模型配置，默认 64k；已知模型给默认值；设置里可以改（agent_context_limit）。
 * 机构说明（agent-context.md）也在这里处理：限制长度，超出截断并提示。
 */
export const DEFAULT_CONTEXT_LIMIT = 64_000
export const MIN_CONTEXT_LIMIT = 8_000
export const MAX_CONTEXT_LIMIT = 1_000_000
export const ORG_CONTEXT_MAX = 4000

/** 已知模型的默认上下文上限（名字里含这些片段的）。没匹配上就 64k——宁可早点整理，也不要超窗口 */
const KNOWN: Array<[RegExp, number]> = [
  [/deepseek/i, 64_000], [/gpt-4o|gpt-4\.1|gpt-5|o[134]\b/i, 128_000], [/claude/i, 200_000], [/qwen-?(long|max|plus)|qwen3/i, 128_000], [/glm-4/i, 128_000], [/kimi|moonshot/i, 128_000]
]

export function contextLimitFor(model: string, override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override)) return Math.min(MAX_CONTEXT_LIMIT, Math.max(MIN_CONTEXT_LIMIT, Math.round(override)))
  for (const [re, n] of KNOWN) if (re.test(model)) return n
  return DEFAULT_CONTEXT_LIMIT
}

/** 机构说明：只取前 ORG_CONTEXT_MAX 字；超出的部分不进对话，并返回提示 */
export function clipOrgContext(text: string): { text: string; clipped: boolean } {
  const t = text.replace(/\r\n/g, '\n').trim()
  return t.length > ORG_CONTEXT_MAX ? { text: t.slice(0, ORG_CONTEXT_MAX), clipped: true } : { text: t, clipped: false }
}
