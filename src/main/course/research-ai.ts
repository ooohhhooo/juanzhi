/**
 * 修订建议的 AI 小结（纯函数部分：提示词、回答校验）。依据由程序算出（research-table.ts 的 AdviceItem.basis），
 * AI 只把依据写成一两句话；回答里出现依据里没有的数字、或超长、或不是 JSON，一律丢掉，只保留规则结论（不编造）。
 * 发给 AI 的内容：课名、依据、课件文字摘录（用户自己配置的 AI 服务）；不含学员信息。
 */
import { ADVICE_LABEL } from './research-table.ts'
import type { RLesson } from './research-table.ts'

export const AI_ADVICE_VERSION = 'research-advice-1'
export const CW_EXCERPT_CHARS = 1500

export const AI_ADVICE_SYSTEM = [
  '你是教研老师的助手。下面给你机构大纲里一节课的「修订建议依据」，这些依据是程序算出来的事实。',
  '请把依据写成 1 到 2 句话的小结，告诉教研这节课件该怎么改。',
  '规则：只能使用依据里出现过的知识点、卷名、题号、教材位置和数字，不许补充依据里没有的内容，不许编数字；',
  '每一句都要点明依据（例如“校内 3/5 份卷子考过”“教材五年级上册第 2 单元有”）；不要写学生信息；总共不超过 120 字；',
  '课件摘录只是帮你理解这节课讲了什么，不能当作依据以外的事实。',
  '只输出一个 JSON 对象：{"summary":"……"}。'
].join('\n')

export function buildAdviceUser(l: Pick<RLesson, 'levelName' | 'label' | 'advice'>, cwText: string): string {
  const lines = l.advice.map((a, i) => `${i + 1}. 【${ADVICE_LABEL[a.kind]}】${a.basis.join('；')}`)
  return [`课：${l.levelName} ${l.label}`, '依据：', ...lines, cwText.trim() ? `\n课件摘录（仅供理解）：\n${cwText.trim().slice(0, CW_EXCERPT_CHARS)}` : ''].filter(Boolean).join('\n')
}

const numbersIn = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? []

/** 校验 AI 的回答：JSON、有 summary、不超长、里面的数字都在依据 / 课名里出现过。通过返回小结文字，否则返回 null（只保留规则结论） */
export function parseAdviceReply(content: string, l: Pick<RLesson, 'levelName' | 'label' | 'advice'>): string | null {
  let obj: any
  try { obj = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) } catch {
    const m = /\{[\s\S]*\}/.exec(content)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  const s = typeof obj?.summary === 'string' ? obj.summary.replace(/\s+/g, ' ').trim() : ''
  if (!s || s.length > 240) return null
  const allowed = new Set(numbersIn([l.levelName, l.label, ...l.advice.flatMap(a => [a.text, ...a.basis])].join(' ')))
  if (numbersIn(s).some(n => !allowed.has(n))) return null
  return s
}
