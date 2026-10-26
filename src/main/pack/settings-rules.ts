/**
 * 数据包里 settings 值的逐键校验（包是不可信输入：白名单只限制「哪几个键」，值长什么样也要管）。
 * 不合格的丢弃（保留本机的值或默认值），并在导入报告里说明。纯函数，单测直接加载。
 */
import { isPromptKey, promptProblem } from '../ai/prompt-rules.ts'

export interface SettingCheck { ok: boolean; value?: unknown; note?: string }

const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v)

export function checkPackSetting(key: string, valueJson: unknown): SettingCheck {
  let v: unknown
  try { v = JSON.parse(String(valueJson)) } catch { return { ok: false, note: `设置「${key}」的内容不是合法的 JSON，已忽略` } }
  switch (key) {
    case 'ai_prompts': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, note: '数据包里的自定义提示词格式不对，已忽略（保留本机的提示词）' }
      const out: Record<string, string> = {}
      const dropped: string[] = []
      for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
        if (typeof t !== 'string' || !isPromptKey(k) || promptProblem(k, t)) dropped.push(k)
        else out[k] = t
      }
      if (Object.keys(out).length === 0) return { ok: false, note: '数据包里的自定义提示词都不合格（缺必需占位符 / 格式不对），已忽略' }
      return { ok: true, value: out, note: dropped.length ? `数据包里有 ${dropped.length} 条自定义提示词不合格，已丢弃（${dropped.slice(0, 3).join('、')}）` : undefined }
    }
    case 'ui_theme':
    case 'ui_language':
      return short(v, 40) ? { ok: true, value: v } : { ok: false, note: `设置「${key}」的值不合法，已忽略` }
    case 'default_textbook':
      return short(v, 100) ? { ok: true, value: v } : { ok: false, note: '数据包里的默认教材不合法，已忽略' }
    default:
      return { ok: false, note: `未知的设置「${key}」，已忽略` }
  }
}
