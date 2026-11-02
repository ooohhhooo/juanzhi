/**
 * 「测试连接」结果的白话解释（纯函数，不依赖 electron，单测直接加载）。
 */
import { AiError, FORBIDDEN_STEPS } from './client.ts'
import { redact } from './guard.ts'

/** 把一次失败翻成界面要的几段：一句话、怎么办的步骤、服务商原话。纯函数 */
export function explainTestError(e: unknown, model: string): { message: string; steps?: string[]; detail?: string } {
  if (e instanceof AiError) {
    if (e.code === 'forbidden') return { message: `这个密钥没有权限使用这个模型（${model}）`, steps: FORBIDDEN_STEPS, detail: e.detail ? redact(e.detail) : undefined }
    if (e.code === 'not_found') return { message: `找不到这个模型（${model}）：名字写错了，或者还没有开通`, detail: e.detail ? redact(e.detail) : undefined }
    if (e.code === 'auth') return { message: 'API Key 无效（密钥不对）：请重新复制，注意前后不要有空格，并确认它和所选服务商是一家的', detail: e.detail ? redact(e.detail) : undefined }
    if (e.code === 'rate_limit') {
      // 从响应原话里判断：额度不足 vs 请求太快；判断不了就两种都说
      const quota = /quota|balance|insufficient|余额|额度|欠费|arrear/i.test(e.detail)
      const fast = /rate|too many|频繁|速度|限流|per minute|rpm|tpm/i.test(e.detail)
      const msg = quota && !fast ? '账户额度不足或欠费了，请到服务商控制台充值或检查余额'
        : fast && !quota ? '请求太频繁，被服务商限流了，稍等一会儿再试'
          : '请求被限流，或者账户额度不够了：稍等一会儿再试，多次出现请检查账户余额'
      return { message: msg, detail: e.detail ? redact(e.detail) : undefined }
    }
    return { message: e.message, detail: e.detail ? redact(e.detail) : undefined }
  }
  return { message: (e as Error).message }
}

/** 视觉测试的判定：回答里同时有 7 和 K = 能看图；有回应但读不对 = 黄色提示（纯函数） */
export function judgeVisionAnswer(content: string): { sees: boolean; text: string } {
  let text = content
  try { const j = JSON.parse(content); if (j && typeof j.text === 'string') text = j.text } catch { /* 模型没按 JSON 回：直接在原文里找 */ }
  const compact = text.replace(/\s/g, '').toUpperCase()
  return { sees: compact.includes('7') && compact.includes('K'), text }
}

