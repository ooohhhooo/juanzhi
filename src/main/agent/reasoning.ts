/**
 * 思考强度（纯函数）：自动 / 关 / 低 / 中 / 高 → 请求里要带的参数。
 *  - 默认按 OpenAI 兼容的 reasoning_effort（low / medium / high）；
 *  - 已知需要别的参数的服务商写进 ADAPTERS（现在没有已确认的，不猜；有了再加）；
 *  - 「自动」和「关」都不发推理参数（「自动」由服务商默认；「关」对默认就会思考的模型关不掉，界面会提示）；
 *  - 不确定服务商认不认：发一个极小请求试探，带参数被 400 拒绝就记为不支持，界面隐藏低 / 中 / 高。结果按「服务地址 + 模型」缓存（由 service 读写）。
 */
import { AiError, chat } from '../ai/client.ts'
import type { ChatRequest } from '../ai/client.ts'
import { modelProfile } from '../ai/providers.ts'

export type Effort = 'auto' | 'off' | 'low' | 'medium' | 'high'
export const EFFORTS: Effort[] = ['auto', 'off', 'low', 'medium', 'high']
export const EFFORT_LABEL: Record<Effort, string> = { auto: '自动', off: '关', low: '低', medium: '中', high: '高' }
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as string[]).includes(v)

type Level = 'low' | 'medium' | 'high'
export interface Adapter { id: string; match: (host: string, model: string) => boolean; params: (e: Level) => Record<string, unknown> }
/** 已知需要特殊参数的服务商。目前没有已确认的——不确定的不要写在这里，交给「试探」 */
export const ADAPTERS: Adapter[] = []

const hostOf = (baseUrl: string): string => { try { return new URL(baseUrl).host } catch { return '' } }

/** 这次请求要并进请求体的推理参数；auto / off 返回空对象 */
export function effortBody(effort: Effort, baseUrl: string, model: string, adapters: Adapter[] = ADAPTERS): Record<string, unknown> {
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return {}
  const a = adapters.find(x => x.match(hostOf(baseUrl), model))
  return a ? a.params(effort) : { reasoning_effort: effort }
}

/** 这个模型的「关」能不能真的关掉思考：默认就思考的推理模型关不掉 */
export const canTurnOff = (model: string): boolean => !modelProfile(model).reasoning

/** 选项旁边的一句提示 */
export function effortHint(effort: Effort, model: string): string {
  if (effort === 'off') return canTurnOff(model) ? '不使用思考，最快、最省。' : `${model} 默认就会思考，这里选「关」只是不额外要求，无法真正关闭。`
  if (effort === 'auto') return '由服务商默认决定。'
  return '思考强度越高，回答越慢、用量越大。'
}

/** 界面该显示哪些选项：试探过且不支持 → 隐藏低 / 中 / 高；支持或没试探过 → 全部 */
export function availableEfforts(support: boolean | null | undefined): Effort[] {
  return support === false ? ['auto', 'off'] : [...EFFORTS]
}

/** 试探结果判定：带参数的极小请求成功 → 支持；被 400 拒绝且提到推理参数 → 不支持；其它错误和这件事无关 → 不知道 */
export function judgeEffortProbe(err: { code?: string; status?: number | null; detail?: string; message?: string } | null): 'supported' | 'unsupported' | 'unknown' {
  if (!err) return 'supported'
  if (err.code === 'bad_request' || err.status === 400 || err.status === 422) return 'unsupported'
  return 'unknown'
}

export const effortProbeKey = (baseUrl: string, model: string): string => `agent_effort_support:${baseUrl.trim().replace(/\/+$/, '')}|${model.trim()}`

/** 发一个极小的请求，带 low 档推理参数；返回 supported / unsupported / unknown（密钥无效、没网等不下结论） */
export async function probeEffort(base: Omit<ChatRequest, 'messages' | 'stream' | 'maxTokens' | 'extraBody'>, chatImpl: typeof chat = chat): Promise<'supported' | 'unsupported' | 'unknown'> {
  try {
    await chatImpl({ ...base, temperature: 0, maxTokens: 64, maxRetries: base.maxRetries ?? 1, messages: [{ role: 'user', content: '回复一个字：好' }], extraBody: effortBody('low', base.baseUrl, base.model) })
    return 'supported'
  } catch (e) {
    if (e instanceof AiError && e.code === 'truncated') return 'supported'   // 有回应，说明参数被接受
    return e instanceof AiError ? judgeEffortProbe(e) : 'unknown'
  }
}
