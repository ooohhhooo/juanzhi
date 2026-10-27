/** 提示词的校验规则（纯函数）：设置页保存时、数据包导入设置时用同一份，导入的提示词不能绕过保存时的检查 */
export const PROMPT_IDS_ALL = ['p1_text', 'p1_vision', 'p2_yoy', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p2_kp'] as const
export const MAX_PROMPT_CHARS = 60_000

/** 缺了这些占位符，对应的提示词就拿不到关键输入 */
export const REQUIRED: Record<string, string[]> = {
  'p1_text.user': ['KNOWLEDGE_TREE', 'QUESTION_TYPES', 'OCR_TEXT'],
  'p1_vision.user': ['KNOWLEDGE_TREE', 'QUESTION_TYPES', 'PAGE_LIST'],
  'p2_yoy.user': ['ADDED', 'REMOVED', 'CHANGED', 'HOT'],
  'p3_report.user': ['KP_DIST', 'QTYPE_DIST', 'DIFF_DIST', 'ERROR_PRONE'],
  'p3_boss.user': ['KP_DIST', 'ERROR_PRONE'],
  'p3_parent.user': ['KP_DIST', 'ERROR_PRONE'],
  'p3_teacher.user': ['KP_DIST', 'ERROR_PRONE'],
  'p2_kp.user': ['KP_NAME', 'KP_DATA', 'EVIDENCE']
}

export const isPromptKey = (k: string): boolean => /^(p1_text|p1_vision|p2_yoy|p3_report|p3_boss|p3_parent|p3_teacher|p2_kp)\.(system|user)$/.test(k)

/** 不合格返回原因，合格返回 null */
export function promptProblem(key: string, text: string): string | null {
  if (!isPromptKey(key)) return '不是已知的提示词'
  if (typeof text !== 'string' || !text.trim()) return '提示词不能为空'
  if (text.length > MAX_PROMPT_CHARS) return '提示词过长（上限 6 万字）'
  if (/^p1_(text|vision)\.system$/.test(key) && !/json/i.test(text)) return 'P1 的 system 提示词里必须出现「JSON」字样'
  const missing = (REQUIRED[key] ?? []).filter(p => !text.includes(`{{${p}}}`))
  if (missing.length) return `缺少必需的占位符：${missing.map(m => `{{${m}}}`).join('、')}`
  return null
}

/** 把存着的覆盖表（可能是坏数据）洗成「合格的 key → 文本」；整体不是纯对象就当没有 */
export function sanitizeOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isPromptKey(k) && typeof v === 'string' && v.trim() && v.length <= MAX_PROMPT_CHARS) out[k] = v
  }
  return out
}
