/**
 * 内部代码（GR.NOUN.PLURAL、PH_DIFF、RD.INFER.OPINION）不能出现在老师、老板、家长看得到的任何地方（M6 验收返工 R4）。
 * 这里是「数据层」的统一出口：界面上每一处显示知识点名的地方都应该过 safeKpName / safeText；主进程返回给界面的名称、AI 给的建议文字也都先过这里。
 * 纯函数，不依赖 electron，单测直接加载。
 */

/** 一个知识点代码（至少两段，用点连）或题型代码（至少两段，用下划线连） */
// 知识点代码必须以已知的一级前缀开头（内置树的 GR / FN / LS / MC / PH / RD / VO / WR），这样「A.M」「P.M」「P.E」「T.V」「U.S」这类正常缩写不会被当成代码
const KP_CODE = /(?:GR|FN|LS|MC|PH|RD|VO|WR)(?:\.[A-Z][A-Z0-9_]*)+/
const QTYPE_CODE = /[A-Z]{2,}(?:_[A-Z0-9]+)+/
const WHOLE = new RegExp(`^(?:${KP_CODE.source}|${QTYPE_CODE.source})$`)
const ANYWHERE = new RegExp(`(?<![A-Za-z0-9_.])(?:${KP_CODE.source}|${QTYPE_CODE.source})(?![A-Za-z0-9_])`, 'g')

/** 整个字符串就是一个内部代码（名称不能是它） */
export const looksLikeCode = (s: string): boolean => WHOLE.test(s.trim())

/** 字符串里含有内部代码 */
export const hasCode = (s: string): boolean => new RegExp(ANYWHERE.source).test(s)

/** 把文字里的内部代码换成 replacement（默认直接去掉，并清理留下的空括号 / 多余空格） */
export function stripCodes(text: string, replacement = ''): string {
  return text.replace(ANYWHERE, replacement).replace(/[（(]\s*[）)]/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}

export const UNNAMED_KP = '待命名的考点'

/** 知识点名称：本身是代码（老师采纳 AI 的「待归类：RD.INFER.OPINION」时曾被当成名称）就换成「待命名的考点」；名称里夹着代码就去掉 */
export function safeKpName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  if (!n || looksLikeCode(n)) return UNNAMED_KP
  return hasCode(n) ? stripCodes(n) || UNNAMED_KP : n
}

/**
 * AI 给的「新增知识点建议」文字：形如「待归类：<代码>」说明 AI 返回的分类不在知识点树里——
 * 老师需要的是「请手动选一个」，不是那个代码。其余建议文字里夹的代码也去掉。
 */
export function safeSuggestion(text: string | null | undefined): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  if (/^待归类[：:]/.test(t)) return '待归类（AI 给的分类不在知识点树里，请手动选一个）'
  return hasCode(t) ? stripCodes(t) : t
}

/** 老师在界面上看到的一句话里夹着代码时的统一处理（提示、说明、错误信息都可以过它） */
export const safeText = (text: string): string => (hasCode(text) ? stripCodes(text) : text)

/** 代码 → 知识点名称（树里没有就写「待命名的考点」），给「…已经被去掉」这类提示用 */
export const labelsOf = (codes: string[], nameOf: (code: string) => string | null | undefined): string[] => codes.map(c => safeKpName(nameOf(c) ?? ''))
