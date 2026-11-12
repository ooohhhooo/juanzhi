/**
 * 修订建议的 AI 小结（纯函数部分：提示词、回答校验）。依据由程序算出（research-table.ts 的 AdviceItem.basis），
 * AI 只把依据写成一两句话；回答里出现依据里没有的数字、或超长、或不是 JSON，一律丢掉，只保留规则结论（不编造）。
 * 发给 AI 的内容：课名、依据、课件文字摘录（用户自己配置的 AI 服务）；不含学员信息。
 */
import { ADVICE_LABEL } from './research-table.ts'
import type { RLesson } from './research-table.ts'

export const AI_ADVICE_VERSION = 'research-advice-1'
export const CW_EXCERPT_CHARS = 1500
/** 小结最长字数：提示词里写的 120 字，校验也按它 */
export const MAX_SUMMARY_CHARS = 120
/** 一次最多给多少节课写 AI 小结 */
export const MAX_AI_LESSONS = 60

export const AI_ADVICE_SYSTEM = [
  '你是教研老师的助手。下面给你机构大纲里一节课的「修订建议依据」，这些依据是程序算出来的事实。',
  '请把依据写成 1 到 2 句话的小结，告诉教研这节课件该怎么改。',
  '规则：只能使用依据里出现过的知识点、卷名、题号、教材位置和数字，不许补充依据里没有的内容，不许编数字；',
  `每一句都要点明依据（例如“校内 3/5 份卷子考过”“教材五年级上册第 2 单元有”）；不要写学生信息；总共不超过 ${MAX_SUMMARY_CHARS} 字；`,
  '课件摘录只是帮你理解这节课讲了什么，不能当作依据以外的事实。',
  '只输出一个 JSON 对象：{"summary":"……"}。'
].join('\n')

export function buildAdviceUser(l: Pick<RLesson, 'levelName' | 'label' | 'advice'>, cwText: string): string {
  const lines = l.advice.map((a, i) => `${i + 1}. 【${ADVICE_LABEL[a.kind]}】${a.basis.join('；')}`)
  return [`课：${l.levelName} ${l.label}`, '依据：', ...lines, cwText.trim() ? `\n课件摘录（仅供理解）：\n${cwText.trim().slice(0, CW_EXCERPT_CHARS)}` : ''].filter(Boolean).join('\n')
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 汉字数字（一到九十九、一百……、两）→ 阿拉伯数字；认不出来返回 null */
export function cnToNumber(t: string): number | null {
  if (!t) return null
  let total = 0, cur = 0, seen = false
  for (const ch of t) {
    if (ch in CN_DIGIT) { cur = CN_DIGIT[ch]; seen = true }
    else if (ch === '十') { total += (seen && cur ? cur : 1) * 10; cur = 0; seen = true }
    else if (ch === '百') { total += (seen && cur ? cur : 1) * 100; cur = 0; seen = true }
    else return null
  }
  return seen ? total + cur : null
}
/**
 * 文字里出现的数字：阿拉伯数字 + 带量词 / 「第」「分之」的汉字数字（“三份”“第二节”“五分之二”，转成阿拉伯数字再比对；“一般”“一些”不算数）。
 * “几十”“十几”“数十”这类模糊说法无法核对，记成不可能出现在依据里的 token，整句丢掉。
 */
export function numbersIn(s: string): string[] {
  const out: string[] = s.match(/\d+(?:\.\d+)?/g) ?? []
  const Q = '份节课题个道页册次年级单元遍倍分成条套种位名人天周月日张篇项'
  const re = new RegExp(`(?:(?<=第|分之)[零〇一二两三四五六七八九十百]+|[零〇一二两三四五六七八九十百]+(?=[${Q}]))`, 'g')
  for (const m of s.matchAll(re)) { const n = cnToNumber(m[0]); if (n !== null) out.push(String(n)) }
  if (/几十|十几|数十|几百|数百|几十几/.test(s)) out.push('模糊数量')
  return out
}

/** 校验 AI 的回答：JSON、有 summary、不超长、里面的数字都在依据 / 课名里出现过。通过返回小结文字，否则返回 null（只保留规则结论） */
export function parseAdviceReply(content: string, l: Pick<RLesson, 'levelName' | 'label' | 'advice'>): string | null {
  let obj: any
  try { obj = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) } catch {
    const m = /\{[\s\S]*\}/.exec(content)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  const s = typeof obj?.summary === 'string' ? obj.summary.replace(/\s+/g, ' ').trim() : ''
  if (!s || s.length > MAX_SUMMARY_CHARS) return null
  const allowed = new Set(numbersIn([l.levelName, l.label, ...l.advice.flatMap(a => [a.text, ...a.basis])].join(' ')))
  if (numbersIn(s).some(n => !allowed.has(n))) return null
  return s
}
