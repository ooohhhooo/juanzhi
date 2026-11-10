/** 提示词的校验规则（纯函数）：设置页保存时、数据包导入设置时用同一份，导入的提示词不能绕过保存时的检查 */
export const PROMPT_IDS_ALL = ['p1_text', 'p1_vision', 'p2_yoy', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p2_kp', 'p3_tricks', 'p4_variant_gen', 'p4_variant_check', 'p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint', 'p5_course_extract', 'p6_classify_propose', 'p6_classify_assign', 'p7_role_draft'] as const
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
  'p2_kp.user': ['KP_NAME', 'KP_DATA', 'EVIDENCE'],
  'p3_tricks.user': ['ERROR_ITEMS'],
  'p4_variant_gen.user': ['VARIANT_KPS'],
  'p4_variant_check.user': ['QUESTIONS'],
  'p5_course_cols.user': ['SHEET_NAME', 'SHEET_PREVIEW'],
  'p5_course_match.user': ['OUTLINE_LINES', 'KP_BATCH'],
  'p5_course_advice.user': ['LOST_POINTS', 'COURSE_MATCH'],
  'p5_course_hint.user': ['LOST_POINTS', 'COURSE_MATCH'],
  'p5_course_extract.user': ['SOURCE_KIND', 'SOURCE_TEXT'],
  'p6_classify_propose.user': ['TEXT_LINES'],
  'p6_classify_assign.user': ['CATEGORIES', 'TEXT_LINES'],
  'p7_role_draft.user': ['JOB', 'TOOL_LIST', 'SKILL_LIST']
}

/** 有语文 / 数学版本的提示词（其余三个——课程表整理、文字归类、角色草稿——与学科无关，只有一份） */
export const SUBJECT_PROMPT_IDS = ['p1_text', 'p1_vision', 'p2_yoy', 'p2_kp', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p3_tricks', 'p4_variant_gen', 'p4_variant_check', 'p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint'] as const
/** 非英语学科的 key 前缀；英语沿用无前缀的老 key（老用户存的改写、数据包都不用改） */
export const PROMPT_SUBJECT_PREFIXES = ['chinese', 'math'] as const

/** 'math:p1_text.system' → { subject: 'math', base: 'p1_text.system' }；无前缀 = 英语 */
export function splitPromptKey(k: string): { subject: 'english' | 'chinese' | 'math'; base: string } {
  const m = /^(chinese|math):(.+)$/.exec(k)
  return m ? { subject: m[1] as 'chinese' | 'math', base: m[2] } : { subject: 'english', base: k }
}
/** 界面 / IPC 里的提示词引用：英语 'p1_text'，其余 'math:p1_text' */
export const promptRefOf = (id: string, subject: string): string => (subject === 'chinese' || subject === 'math' ? `${subject}:${id}` : id)
export const splitPromptRef = (ref: string): { subject: 'english' | 'chinese' | 'math'; id: string } => { const { subject, base } = splitPromptKey(ref); return { subject, id: base } }

const BASE_KEY_RE = /^(p1_text|p1_vision|p2_yoy|p3_report|p3_boss|p3_parent|p3_teacher|p2_kp|p3_tricks|p4_variant_gen|p4_variant_check|p5_course_cols|p5_course_match|p5_course_advice|p5_course_hint|p5_course_extract|p6_classify_propose|p6_classify_assign|p7_role_draft)\.(system|user)$/
export const isPromptKey = (k: string): boolean => {
  const { subject, base } = splitPromptKey(k)
  if (!BASE_KEY_RE.test(base)) return false
  return subject === 'english' || (SUBJECT_PROMPT_IDS as readonly string[]).includes(base.replace(/\.(system|user)$/, ''))
}

/** 不合格返回原因，合格返回 null */
export function promptProblem(fullKey: string, text: string): string | null {
  if (!isPromptKey(fullKey)) return '不是已知的提示词'
  const key = splitPromptKey(fullKey).base
  if (typeof text !== 'string' || !text.trim()) return '提示词不能为空'
  if (text.length > MAX_PROMPT_CHARS) return '提示词过长（上限 6 万字）'
  if (/^p1_(text|vision)\.system$/.test(key) && !/json/i.test(text)) return 'P1 的 system 提示词里必须出现「JSON」字样'
  if (/^(p5_course_(cols|match)|p6_classify_(propose|assign)|p7_role_draft)\.system$/.test(key) && !/json/i.test(text)) return '这个提示词要求模型输出 JSON，system 里必须出现「JSON」字样'
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
