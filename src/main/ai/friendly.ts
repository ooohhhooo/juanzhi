/**
 * 把 AI 调用的错误翻成给运营 / 老师看的白话（M6）：不出现 token、输出上限、HTTP 状态码这类词。
 * 技术细节（原因、字数、上限、HTTP 状态）放在 detail 里，界面收在「查看详情」折叠中，给管理员排查用。
 * 纯函数，不依赖 electron，单测直接加载。
 */
import { AiError, NO_TIME_TO_RETRY } from './client.ts'

export const RETRY_HINT = '可以点「重试」，多次失败请联系管理员'

export interface FriendlyError { message: string; detail: string }

export function friendlyAiError(e: unknown): FriendlyError {
  if (!(e instanceof AiError)) return { message: `AI 这次没有成功。${RETRY_HINT}`, detail: (e as Error)?.message ?? String(e) }
  const d = [e.code, e.status ? `HTTP ${e.status}` : '', e.message, e.detail].filter(Boolean).join('；')
  switch (e.code) {
    case 'truncated': return { message: e.detail.includes(NO_TIME_TO_RETRY) ? `AI 这次写得太慢、没写完，剩下的时间也不够再自动加长重试了；已保留写出的部分；${RETRY_HINT}` : `AI 这次没写完，已经自动重试过；${RETRY_HINT}`, detail: d }
    case 'empty': return { message: `AI 这次没有返回内容，已经自动重试过；${RETRY_HINT}`, detail: d }
    case 'timeout': return { message: e.detail === 'total-timeout' ? `AI 这次写了太久，已经停止；${RETRY_HINT}` : `AI 等了太久没有回应；${RETRY_HINT}`, detail: d }
    case 'network': return { message: `连不上 AI 服务，请检查网络；${RETRY_HINT}`, detail: d }
    case 'server': return { message: `AI 服务暂时不可用，请稍后再试；${RETRY_HINT}`, detail: d }
    case 'rate_limit': return { message: 'AI 服务太忙，或账户额度不够了。请稍后再试，多次失败请联系管理员检查账户', detail: d }
    case 'auth': return { message: 'AI 的密钥无效或没有权限，请联系管理员检查「设置 → 管理员设置 → AI 服务」', detail: d }
    case 'not_found': return { message: '找不到设置里的 AI 模型，请联系管理员检查「设置 → 管理员设置 → AI 服务」', detail: d }
    case 'bad_request': return { message: `AI 拒绝了这次请求；${RETRY_HINT}`, detail: d }
    case 'aborted': return { message: '已取消', detail: d }
    default: return { message: `AI 这次没有成功；${RETRY_HINT}`, detail: d }
  }
}

/** 「自动」输出上限被服务商拒绝、已降到安全值重试成功时，给老师看的一句话（放进报告 / 分析的提示里） */
export const limitFallbackNotice = (to: number): string => `AI 服务不接受默认的输出长度，这次已自动改用较小的长度（${to}）重试成功；内容长的话可能写不全，可以请管理员在「设置 → 管理员设置 → AI 服务」里调整`
