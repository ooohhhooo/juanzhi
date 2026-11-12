/**
 * 试卷审核自动通过（纯函数，不用 AI）：
 * 题目被 AI 标好主知识点后，再用「标志词规则」（course-kp-rules.ts，和课程匹配是同一份）对题干、选项、答案认一遍；
 * 两边认的是同一个知识点（同一代码，或者是父子关系），这道题就自动标为审核通过，并带「自动通过」标记（存在 questions.flags_json 里，不加迁移）。
 * 不一致、规则认不出、或者 AI 标的把握低（置信度低、知识点不在树里、有待归类建议）的题，一律留在「待审核」。
 * 只对新解析出来的题生效；老数据不动；设置里可以关（auto_approve）。
 */
import { matchLessonRules } from '../course/rules.ts'

/** 存进 flags_json 的标记 */
export const AUTO_APPROVED_FLAG = 'auto_approved'
/** 规则认出的知识点要到这个分才算数（单个强标志词 72；只有弱词要 3 个以上才到 62） */
export const AUTO_RULE_MIN = 60
/** 和审核页的「低把握」线一致（validate.ts 的 LOW_CONFIDENCE） */
export const AUTO_MIN_CONFIDENCE = 0.7
const KP_FLAGS = new Set(['kp_uncertain', 'kp_invalid'])
/** 题目本身可能没认对（看不清、缺字、丢了下划线、要看图、重复、题型不对、定位失败）：不管知识点对不对，都要人看一眼 */
const CONTENT_FLAGS = new Set(['ocr_unclear', 'underline_lost', 'needs_image', 'stem_incomplete', 'qtype_invalid', 'duplicate', 'locate_failed'])

export interface AutoQuestion { stem: string; options: string[]; answer: string; kpMain: string | null; kpSuggestion?: string | null; confidence: number; flags: string[] }
export interface AutoVerdict { ok: boolean; /** 不通过的原因（测试用）；通过时写规则命中的词 */ why: string; /** 规则认出的、和 AI 一致的知识点 */ ruleCode?: string; hits?: string[] }

const isKin = (a: string, b: string, parentOf: (c: string) => string | null): boolean => {
  if (a === b) return true
  for (const [x, y] of [[a, b], [b, a]] as const) {
    let cur = parentOf(x)
    for (let i = 0; cur && i < 8; i++) { if (cur === y) return true; cur = parentOf(cur) }
  }
  return false
}

export function judgeAutoApprove(q: AutoQuestion, parentOf: (code: string) => string | null): AutoVerdict {
  if (!q.kpMain) return { ok: false, why: 'AI 没给出主知识点' }
  if (q.confidence < AUTO_MIN_CONFIDENCE) return { ok: false, why: 'AI 把握低（置信度低）' }
  if (q.flags.some(f => CONTENT_FLAGS.has(f))) return { ok: false, why: '题目内容可能没认对' }
  if ((q.kpSuggestion ?? '').trim() || q.flags.some(f => KP_FLAGS.has(f))) return { ok: false, why: 'AI 的知识点不确定' }
  const text = [q.stem, ...q.options, q.answer].filter(Boolean).join('\n')
  const hits = matchLessonRules(text).filter(m => m.score >= AUTO_RULE_MIN)
  if (!hits.length) return { ok: false, why: '规则认不出这道题的知识点' }
  const same = hits.find(h => isKin(h.code, q.kpMain!, parentOf))
  if (!same) return { ok: false, why: `AI 和规则认的不一致（规则认为是 ${hits[0].code}）` }
  return { ok: true, why: `规则命中 ${same.hits.map(h => h.word).join('、')}`, ruleCode: same.code, hits: same.hits.map(h => h.word) }
}

/** 一批新解析出来的题：返回每题是否自动通过 */
export const autoApproveAll = (qs: AutoQuestion[], parentOf: (code: string) => string | null): AutoVerdict[] => qs.map(q => judgeAutoApprove(q, parentOf))
