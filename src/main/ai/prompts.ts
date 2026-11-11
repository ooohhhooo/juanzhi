/**
 * 提示词管理：内置默认值来自 docs/prompts/v1-sonnet改写.md（scripts/extract-prompts.cjs 抽成 prompts/*.txt 资源文件），
 * 用户可在设置里改写；改写后的文本存在 settings.ai_prompts（id.part → 文本）。每次解析都记录用的是哪个版本。
 */
import crypto from 'node:crypto'
import { getDb } from '../db'
import { unknownPlaceholders } from '../parse/batch'
import { promptProblem, promptRefOf, sanitizeOverrides, splitPromptKey, SUBJECT_PROMPT_IDS } from './prompt-rules'
import { asSubject, SUBJECTS } from '../../shared/subject'
import type { SubjectId } from '../../shared/subject'
import type { PromptId, PromptPart, PromptView } from './types'
import { PROMPT_IDS } from './types'
import p1TextSystem from './prompts/p1_text.system.txt?raw'
import p1TextUser from './prompts/p1_text.user.txt?raw'
import p1VisionSystem from './prompts/p1_vision.system.txt?raw'
import p1VisionUser from './prompts/p1_vision.user.txt?raw'
import p2System from './prompts/p2_yoy.system.txt?raw'
import p2User from './prompts/p2_yoy.user.txt?raw'
import p3System from './prompts/p3_report.system.txt?raw'
import p3User from './prompts/p3_report.user.txt?raw'
import p3BossSystem from './prompts/p3_boss.system.txt?raw'
import p3BossUser from './prompts/p3_boss.user.txt?raw'
import p3ParentSystem from './prompts/p3_parent.system.txt?raw'
import p3ParentUser from './prompts/p3_parent.user.txt?raw'
import p3TeacherSystem from './prompts/p3_teacher.system.txt?raw'
import p3TeacherUser from './prompts/p3_teacher.user.txt?raw'
import p2KpSystem from './prompts/p2_kp.system.txt?raw'
import p2KpUser from './prompts/p2_kp.user.txt?raw'
import p3TricksSystem from './prompts/p3_tricks.system.txt?raw'
import p3TricksUser from './prompts/p3_tricks.user.txt?raw'
import p4GenSystem from './prompts/p4_variant_gen.system.txt?raw'
import p4GenUser from './prompts/p4_variant_gen.user.txt?raw'
import p4CheckSystem from './prompts/p4_variant_check.system.txt?raw'
import p4CheckUser from './prompts/p4_variant_check.user.txt?raw'
import p5ColsSystem from './prompts/p5_course_cols.system.txt?raw'
import p5ColsUser from './prompts/p5_course_cols.user.txt?raw'
import p5MatchSystem from './prompts/p5_course_match.system.txt?raw'
import p5MatchUser from './prompts/p5_course_match.user.txt?raw'
import p5AdviceSystem from './prompts/p5_course_advice.system.txt?raw'
import p5AdviceUser from './prompts/p5_course_advice.user.txt?raw'
import p5HintSystem from './prompts/p5_course_hint.system.txt?raw'
import p5HintUser from './prompts/p5_course_hint.user.txt?raw'
import p5ExtractSystem from './prompts/p5_course_extract.system.txt?raw'
import p5ExtractUser from './prompts/p5_course_extract.user.txt?raw'
import p5TextbookSystem from './prompts/p5_course_textbook.system.txt?raw'
import p5TextbookUser from './prompts/p5_course_textbook.user.txt?raw'
import p6ProposeSystem from './prompts/p6_classify_propose.system.txt?raw'
import p6ProposeUser from './prompts/p6_classify_propose.user.txt?raw'
import p6AssignSystem from './prompts/p6_classify_assign.system.txt?raw'
import p6AssignUser from './prompts/p6_classify_assign.user.txt?raw'
import p7RoleSystem from './prompts/p7_role_draft.system.txt?raw'
import p7RoleUser from './prompts/p7_role_draft.user.txt?raw'
// 语文 / 数学版本（文件名 <id>.<学科>.<part>.txt）
import cn_p1_text_system from './prompts/p1_text.chinese.system.txt?raw'
import cn_p1_text_user from './prompts/p1_text.chinese.user.txt?raw'
import cn_p1_vision_system from './prompts/p1_vision.chinese.system.txt?raw'
import cn_p1_vision_user from './prompts/p1_vision.chinese.user.txt?raw'
import cn_p2_yoy_system from './prompts/p2_yoy.chinese.system.txt?raw'
import cn_p2_yoy_user from './prompts/p2_yoy.chinese.user.txt?raw'
import cn_p2_kp_system from './prompts/p2_kp.chinese.system.txt?raw'
import cn_p2_kp_user from './prompts/p2_kp.chinese.user.txt?raw'
import cn_p3_report_system from './prompts/p3_report.chinese.system.txt?raw'
import cn_p3_report_user from './prompts/p3_report.chinese.user.txt?raw'
import cn_p3_boss_system from './prompts/p3_boss.chinese.system.txt?raw'
import cn_p3_boss_user from './prompts/p3_boss.chinese.user.txt?raw'
import cn_p3_parent_system from './prompts/p3_parent.chinese.system.txt?raw'
import cn_p3_parent_user from './prompts/p3_parent.chinese.user.txt?raw'
import cn_p3_teacher_system from './prompts/p3_teacher.chinese.system.txt?raw'
import cn_p3_teacher_user from './prompts/p3_teacher.chinese.user.txt?raw'
import cn_p3_tricks_system from './prompts/p3_tricks.chinese.system.txt?raw'
import cn_p3_tricks_user from './prompts/p3_tricks.chinese.user.txt?raw'
import cn_p4_variant_gen_system from './prompts/p4_variant_gen.chinese.system.txt?raw'
import cn_p4_variant_gen_user from './prompts/p4_variant_gen.chinese.user.txt?raw'
import cn_p4_variant_check_system from './prompts/p4_variant_check.chinese.system.txt?raw'
import cn_p4_variant_check_user from './prompts/p4_variant_check.chinese.user.txt?raw'
import cn_p5_course_cols_system from './prompts/p5_course_cols.chinese.system.txt?raw'
import cn_p5_course_cols_user from './prompts/p5_course_cols.chinese.user.txt?raw'
import cn_p5_course_match_system from './prompts/p5_course_match.chinese.system.txt?raw'
import cn_p5_course_match_user from './prompts/p5_course_match.chinese.user.txt?raw'
import cn_p5_course_advice_system from './prompts/p5_course_advice.chinese.system.txt?raw'
import cn_p5_course_advice_user from './prompts/p5_course_advice.chinese.user.txt?raw'
import cn_p5_course_hint_system from './prompts/p5_course_hint.chinese.system.txt?raw'
import cn_p5_course_hint_user from './prompts/p5_course_hint.chinese.user.txt?raw'
import ma_p1_text_system from './prompts/p1_text.math.system.txt?raw'
import ma_p1_text_user from './prompts/p1_text.math.user.txt?raw'
import ma_p1_vision_system from './prompts/p1_vision.math.system.txt?raw'
import ma_p1_vision_user from './prompts/p1_vision.math.user.txt?raw'
import ma_p2_yoy_system from './prompts/p2_yoy.math.system.txt?raw'
import ma_p2_yoy_user from './prompts/p2_yoy.math.user.txt?raw'
import ma_p2_kp_system from './prompts/p2_kp.math.system.txt?raw'
import ma_p2_kp_user from './prompts/p2_kp.math.user.txt?raw'
import ma_p3_report_system from './prompts/p3_report.math.system.txt?raw'
import ma_p3_report_user from './prompts/p3_report.math.user.txt?raw'
import ma_p3_boss_system from './prompts/p3_boss.math.system.txt?raw'
import ma_p3_boss_user from './prompts/p3_boss.math.user.txt?raw'
import ma_p3_parent_system from './prompts/p3_parent.math.system.txt?raw'
import ma_p3_parent_user from './prompts/p3_parent.math.user.txt?raw'
import ma_p3_teacher_system from './prompts/p3_teacher.math.system.txt?raw'
import ma_p3_teacher_user from './prompts/p3_teacher.math.user.txt?raw'
import ma_p3_tricks_system from './prompts/p3_tricks.math.system.txt?raw'
import ma_p3_tricks_user from './prompts/p3_tricks.math.user.txt?raw'
import ma_p4_variant_gen_system from './prompts/p4_variant_gen.math.system.txt?raw'
import ma_p4_variant_gen_user from './prompts/p4_variant_gen.math.user.txt?raw'
import ma_p4_variant_check_system from './prompts/p4_variant_check.math.system.txt?raw'
import ma_p4_variant_check_user from './prompts/p4_variant_check.math.user.txt?raw'
import ma_p5_course_cols_system from './prompts/p5_course_cols.math.system.txt?raw'
import ma_p5_course_cols_user from './prompts/p5_course_cols.math.user.txt?raw'
import ma_p5_course_match_system from './prompts/p5_course_match.math.system.txt?raw'
import ma_p5_course_match_user from './prompts/p5_course_match.math.user.txt?raw'
import ma_p5_course_advice_system from './prompts/p5_course_advice.math.system.txt?raw'
import ma_p5_course_advice_user from './prompts/p5_course_advice.math.user.txt?raw'
import ma_p5_course_hint_system from './prompts/p5_course_hint.math.system.txt?raw'
import ma_p5_course_hint_user from './prompts/p5_course_hint.math.user.txt?raw'

/** 内置提示词的版本号；改了资源文件就要同步提升，并在交付说明里记一笔 */
export const PROMPT_DEFAULT_VERSION = 'v2.0'
/** 升过版的提示词各自的内置版本号（没列出的用 PROMPT_DEFAULT_VERSION）：老师版 v3.0（做题方法 + 学习进步建议，其余由程序拼）和它的三个搭档 */
export const PROMPT_VERSIONS: Partial<Record<PromptId, string>> = { p3_teacher: 'v3.0', p3_tricks: 'v3.0', p4_variant_gen: 'v3.0', p4_variant_check: 'v3.0' }
/** 语文 / 数学提示词的内置版本号（docs/prompts/v6、v7），与英语版各自升级 */
export const SUBJECT_PROMPT_VERSION = 'v1.0'
export const defaultVersionOf = (id: PromptId, subject?: unknown): string => (asSubject(subject) === 'english' ? PROMPT_VERSIONS[id] ?? PROMPT_DEFAULT_VERSION : SUBJECT_PROMPT_VERSION)
/** 这个提示词在该学科有没有单独的版本（没有的与英语共用同一份，如课程表整理、文字归类） */
const hasSubjectVariant = (id: PromptId): boolean => (SUBJECT_PROMPT_IDS as readonly string[]).includes(id)
/** 实际存取用的 key：英语 / 没有学科版本的提示词 = 'p1_text.system'，语文数学 = 'math:p1_text.system' */
export function promptKey(id: PromptId, part: PromptPart, subject?: unknown): string {
  const s = asSubject(subject)
  return s !== 'english' && hasSubjectVariant(id) ? `${s}:${id}.${part}` : `${id}.${part}`
}
const SETTINGS_KEY = 'ai_prompts'
/** 用户保存自定义提示词时，记下当时内置默认版的版本号（key 同覆盖表）；没有记录的自定义版按 v2.0 算（beta.3 之前保存的都是基于 v2.0） */
const BASE_KEY = 'ai_prompt_bases'

// 资源文件末尾有换行（便于编辑器查看），发给模型前去掉，保证与 docs 里的提示词正文逐字一致
// （含 \r：Windows 上若被 git 转成 CRLF，也不能让 \r 进到发给模型的文本里）
const trimEnd = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '')
const DEFAULTS: Record<string, string> = {
  'p1_text.system': trimEnd(p1TextSystem), 'p1_text.user': trimEnd(p1TextUser),
  'p1_vision.system': trimEnd(p1VisionSystem), 'p1_vision.user': trimEnd(p1VisionUser),
  'p2_yoy.system': trimEnd(p2System), 'p2_yoy.user': trimEnd(p2User),
  'p3_report.system': trimEnd(p3System), 'p3_report.user': trimEnd(p3User),
  'p3_boss.system': trimEnd(p3BossSystem), 'p3_boss.user': trimEnd(p3BossUser),
  'p3_parent.system': trimEnd(p3ParentSystem), 'p3_parent.user': trimEnd(p3ParentUser),
  'p3_teacher.system': trimEnd(p3TeacherSystem), 'p3_teacher.user': trimEnd(p3TeacherUser),
  'p2_kp.system': trimEnd(p2KpSystem), 'p2_kp.user': trimEnd(p2KpUser),
  'p3_tricks.system': trimEnd(p3TricksSystem), 'p3_tricks.user': trimEnd(p3TricksUser),
  'p4_variant_gen.system': trimEnd(p4GenSystem), 'p4_variant_gen.user': trimEnd(p4GenUser),
  'p4_variant_check.system': trimEnd(p4CheckSystem), 'p4_variant_check.user': trimEnd(p4CheckUser),
  'p5_course_cols.system': trimEnd(p5ColsSystem), 'p5_course_cols.user': trimEnd(p5ColsUser),
  'p5_course_match.system': trimEnd(p5MatchSystem), 'p5_course_match.user': trimEnd(p5MatchUser),
  'p5_course_advice.system': trimEnd(p5AdviceSystem), 'p5_course_advice.user': trimEnd(p5AdviceUser),
  'p5_course_hint.system': trimEnd(p5HintSystem), 'p5_course_hint.user': trimEnd(p5HintUser),
  'p5_course_extract.system': trimEnd(p5ExtractSystem), 'p5_course_extract.user': trimEnd(p5ExtractUser),
  'p5_course_textbook.system': trimEnd(p5TextbookSystem), 'p5_course_textbook.user': trimEnd(p5TextbookUser),
  'p6_classify_propose.system': trimEnd(p6ProposeSystem), 'p6_classify_propose.user': trimEnd(p6ProposeUser),
  'p6_classify_assign.system': trimEnd(p6AssignSystem), 'p6_classify_assign.user': trimEnd(p6AssignUser),
  'p7_role_draft.system': trimEnd(p7RoleSystem), 'p7_role_draft.user': trimEnd(p7RoleUser),
  // ───── 语文（docs/prompts/v6-语文.md） ─────
  'chinese:p1_text.system': trimEnd(cn_p1_text_system), 'chinese:p1_text.user': trimEnd(cn_p1_text_user),
  'chinese:p1_vision.system': trimEnd(cn_p1_vision_system), 'chinese:p1_vision.user': trimEnd(cn_p1_vision_user),
  'chinese:p2_yoy.system': trimEnd(cn_p2_yoy_system), 'chinese:p2_yoy.user': trimEnd(cn_p2_yoy_user),
  'chinese:p2_kp.system': trimEnd(cn_p2_kp_system), 'chinese:p2_kp.user': trimEnd(cn_p2_kp_user),
  'chinese:p3_report.system': trimEnd(cn_p3_report_system), 'chinese:p3_report.user': trimEnd(cn_p3_report_user),
  'chinese:p3_boss.system': trimEnd(cn_p3_boss_system), 'chinese:p3_boss.user': trimEnd(cn_p3_boss_user),
  'chinese:p3_parent.system': trimEnd(cn_p3_parent_system), 'chinese:p3_parent.user': trimEnd(cn_p3_parent_user),
  'chinese:p3_teacher.system': trimEnd(cn_p3_teacher_system), 'chinese:p3_teacher.user': trimEnd(cn_p3_teacher_user),
  'chinese:p3_tricks.system': trimEnd(cn_p3_tricks_system), 'chinese:p3_tricks.user': trimEnd(cn_p3_tricks_user),
  'chinese:p4_variant_gen.system': trimEnd(cn_p4_variant_gen_system), 'chinese:p4_variant_gen.user': trimEnd(cn_p4_variant_gen_user),
  'chinese:p4_variant_check.system': trimEnd(cn_p4_variant_check_system), 'chinese:p4_variant_check.user': trimEnd(cn_p4_variant_check_user),
  'chinese:p5_course_cols.system': trimEnd(cn_p5_course_cols_system), 'chinese:p5_course_cols.user': trimEnd(cn_p5_course_cols_user),
  'chinese:p5_course_match.system': trimEnd(cn_p5_course_match_system), 'chinese:p5_course_match.user': trimEnd(cn_p5_course_match_user),
  'chinese:p5_course_advice.system': trimEnd(cn_p5_course_advice_system), 'chinese:p5_course_advice.user': trimEnd(cn_p5_course_advice_user),
  'chinese:p5_course_hint.system': trimEnd(cn_p5_course_hint_system), 'chinese:p5_course_hint.user': trimEnd(cn_p5_course_hint_user),
  // ───── 数学（docs/prompts/v7-数学.md） ─────
  'math:p1_text.system': trimEnd(ma_p1_text_system), 'math:p1_text.user': trimEnd(ma_p1_text_user),
  'math:p1_vision.system': trimEnd(ma_p1_vision_system), 'math:p1_vision.user': trimEnd(ma_p1_vision_user),
  'math:p2_yoy.system': trimEnd(ma_p2_yoy_system), 'math:p2_yoy.user': trimEnd(ma_p2_yoy_user),
  'math:p2_kp.system': trimEnd(ma_p2_kp_system), 'math:p2_kp.user': trimEnd(ma_p2_kp_user),
  'math:p3_report.system': trimEnd(ma_p3_report_system), 'math:p3_report.user': trimEnd(ma_p3_report_user),
  'math:p3_boss.system': trimEnd(ma_p3_boss_system), 'math:p3_boss.user': trimEnd(ma_p3_boss_user),
  'math:p3_parent.system': trimEnd(ma_p3_parent_system), 'math:p3_parent.user': trimEnd(ma_p3_parent_user),
  'math:p3_teacher.system': trimEnd(ma_p3_teacher_system), 'math:p3_teacher.user': trimEnd(ma_p3_teacher_user),
  'math:p3_tricks.system': trimEnd(ma_p3_tricks_system), 'math:p3_tricks.user': trimEnd(ma_p3_tricks_user),
  'math:p4_variant_gen.system': trimEnd(ma_p4_variant_gen_system), 'math:p4_variant_gen.user': trimEnd(ma_p4_variant_gen_user),
  'math:p4_variant_check.system': trimEnd(ma_p4_variant_check_system), 'math:p4_variant_check.user': trimEnd(ma_p4_variant_check_user),
  'math:p5_course_cols.system': trimEnd(ma_p5_course_cols_system), 'math:p5_course_cols.user': trimEnd(ma_p5_course_cols_user),
  'math:p5_course_match.system': trimEnd(ma_p5_course_match_system), 'math:p5_course_match.user': trimEnd(ma_p5_course_match_user),
  'math:p5_course_advice.system': trimEnd(ma_p5_course_advice_system), 'math:p5_course_advice.user': trimEnd(ma_p5_course_advice_user),
  'math:p5_course_hint.system': trimEnd(ma_p5_course_hint_system), 'math:p5_course_hint.user': trimEnd(ma_p5_course_hint_user)
}

const TITLES: Record<PromptId, string> = {
  p1_text: 'P1 解析（文本版）：OCR 文本 → 题目清单',
  p1_vision: 'P1 解析（视觉版）：页面图片 → 题目清单',
  p2_yoy: 'P2 年度变化分析',
  p3_report: 'P3 考情分析报告：完整数据版',
  p3_boss: 'P3 考情分析报告：老板版',
  p3_parent: 'P3 考情分析报告：家长版',
  p3_teacher: 'P3 考情分析报告：老师版',
  p2_kp: 'P2 单个考点分析（看板抽屉）',
  p3_tricks: 'P3 老师版：口诀大招',
  p4_variant_gen: 'P4 老师版：同类变形题（出题）',
  p4_variant_check: 'P4 老师版：变形题独立解答（第二次核对）',
  p5_course_cols: 'P5 课程对照：认列（只判断哪一列是什么，不复制内容）',
  p5_course_match: 'P5 课程对照：知识点 → 课次',
  p5_course_advice: 'P5 课程对照：家长沟通话术（看板）',
  p5_course_hint: 'P5 课程对照：家长版结尾一句课程建议',
  p5_course_extract: 'P5 课程对照：从 Word / PDF / 图片的文字里整理课程表',
  p5_course_textbook: 'P5 课程对照：教材 / 整本书按单元挑知识点',
  p6_classify_propose: 'P6 文字归类：从抽样文字里提出类别',
  p6_classify_assign: 'P6 文字归类：把每条文字归入类别',
  p7_role_draft: 'P7 助手角色：根据岗位和选择生成角色草稿'
}

const P1_COMMON = ['KNOWLEDGE_TREE', 'QUESTION_TYPES', 'FILE_NAME', 'KNOWN_META', 'BATCH_INFO', 'BATCH_PREFIX', 'PREV_CONTEXT']
const P3_PH = ['FILTER_DESC', 'PAPER_COUNT', 'QUESTION_COUNT', 'YEARS', 'SAMPLE_WARNING', 'KP_DIST', 'QTYPE_DIST', 'DIFF_DIST', 'ERROR_PRONE', 'YEAR_DIFF', 'EVIDENCE']
export const PLACEHOLDERS: Record<PromptId, string[]> = {
  p1_text: [...P1_COMMON, 'OCR_TEXT'],
  p1_vision: [...P1_COMMON, 'PAGE_LIST'],
  p2_yoy: ['FILTER_DESC', 'TARGET_YEAR', 'TARGET_PAPERS', 'BASE_YEARS', 'BASE_PAPERS', 'TARGET_TEXTBOOKS', 'BASE_TEXTBOOKS', 'SAMPLE_WARNING', 'ADDED', 'REMOVED', 'CHANGED', 'HOT', 'EVIDENCE'],
  p3_report: P3_PH, p3_boss: P3_PH, p3_parent: P3_PH, p3_teacher: [...P3_PH, 'ERROR_ITEMS'],
  p2_kp: ['FILTER_DESC', 'PAPER_COUNT', 'YEARS', 'SAMPLE_WARNING', 'KP_NAME', 'KP_DATA', 'KP_SAMPLES', 'EVIDENCE'],
  p3_tricks: ['ERROR_ITEMS', 'EVIDENCE'],
  p4_variant_gen: ['VARIANT_KPS', 'EVIDENCE'],
  p4_variant_check: ['QUESTIONS'],
  p5_course_cols: ['SHEET_NAME', 'SHEET_PREVIEW'],
  p5_course_match: ['OUTLINE_LINES', 'KP_BATCH'],
  p5_course_advice: ['SCENE', 'FILTER_DESC', 'SAMPLE_WARNING', 'LOST_POINTS', 'COURSE_MATCH', 'EVIDENCE'],
  p5_course_hint: ['SCENE', 'FILTER_DESC', 'SAMPLE_WARNING', 'LOST_POINTS', 'COURSE_MATCH', 'EVIDENCE'],
  p5_course_extract: ['SOURCE_KIND', 'SOURCE_TEXT'],
  p5_course_textbook: ['SUBJECT_NAME', 'UNIT_TITLE', 'UNIT_NO', 'UNIT_TOTAL', 'PAGE_RANGE', 'UNIT_HEADINGS', 'UNIT_OPENING', 'KP_CANDIDATES'],
  p6_classify_propose: ['FIELD_NAME', 'TOTAL_COUNT', 'SAMPLE_COUNT', 'TEXT_LINES', 'EXISTING_CATEGORIES'],
  p6_classify_assign: ['FIELD_NAME', 'CATEGORIES', 'TEXT_LINES'],
  p7_role_draft: ['SCENE', 'JOB', 'TASKS', 'REPORT_TO', 'STYLE', 'EXTRA', 'TOOL_LIST', 'SKILL_LIST']
}
function overrides(): Record<string, string> {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
  if (!row) return {}
  // 读到的可能是坏数据（手工改库、被破坏的数据包）：不是纯对象 / 值不是文本的一律当没有，回退内置默认，不让提示词读写报错
  try { return sanitizeOverrides(JSON.parse(row.value_json)) } catch { return {} }
}

function writeOverrides(o: Record<string, string>): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(o))
}

function bases(): Record<string, string> {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(BASE_KEY) as { value_json: string } | undefined
  try {
    const raw = row ? JSON.parse(row.value_json) : {}
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
  } catch { return {} }
}
const writeBases = (b: Record<string, string>): void => { getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(BASE_KEY, JSON.stringify(b)) }
/** 这条自定义版基于哪一版内置默认（没记录 = beta.3 之前保存的，基于 v2.0） */
export const baseVersionOf = (key: string, b: Record<string, string> = bases()): string => b[key] ?? (splitPromptKey(key).subject === 'english' ? PROMPT_DEFAULT_VERSION : SUBJECT_PROMPT_VERSION)

/** subject 缺省 = 英语（老调用方不用改） */
export function promptText(id: PromptId, part: PromptPart, subject?: unknown): string {
  const k = promptKey(id, part, subject)
  return overrides()[k] ?? DEFAULTS[k]
}

/** 全部提示词视图：先英语的全部，再语文、数学各自有学科版本的那些；非英语的 id 写成 'math:p1_text'，标题前加学科名 */
export function promptViews(): PromptView[] {
  const o = overrides()
  const b = bases()
  const views: PromptView[] = []
  const subjects: SubjectId[] = ['english', 'chinese', 'math']
  for (const subject of subjects) for (const id of PROMPT_IDS) {
    if (subject !== 'english' && !hasSubjectVariant(id)) continue
    for (const part of ['system', 'user'] as PromptPart[]) {
      const k = promptKey(id, part, subject)
      const text = o[k] ?? DEFAULTS[k]
      views.push({
        id: promptRefOf(id, subject), part, title: subject === 'english' ? TITLES[id] : `${SUBJECTS[subject].name} · ${TITLES[id]}`, text, defaultText: DEFAULTS[k], isCustom: o[k] !== undefined && o[k] !== DEFAULTS[k],
        version: defaultVersionOf(id, subject), defaultUpdated: o[k] !== undefined && o[k] !== DEFAULTS[k] && baseVersionOf(k, b) !== defaultVersionOf(id, subject),
        unknownPlaceholders: unknownPlaceholders(text, PLACEHOLDERS[id]), usedInM2: true   // 字段名沿用旧的；含义是「当前版本会被用到」：P1 两版（M2）、P2（M3）、P3/P4（报告）、课程对照四个现在都用
      })
    }
  }
  return views
}

export function savePrompt(id: PromptId, part: PromptPart, text: string, subject?: unknown): void {
  const k = promptKey(id, part, subject)
  const bad = promptProblem(k, text)
  if (bad) throw new Error(bad === '提示词不能为空' ? '提示词不能为空；想恢复内置版本请点「恢复默认」' : bad.startsWith('P1 的 system') ? 'P1 的 system 提示词里必须出现「JSON」字样（服务商的 JSON 模式要求提示词里提到 json），请保留原有的输出格式说明' : bad)
  const o = overrides()
  const b = bases()
  if (text === DEFAULTS[k]) { delete o[k]; delete b[k] }
  else {
    // 已经自定义过的：重新保存不等于采用了新默认版，保留原来的「基于哪一版」（没有记录的按 beta.3 之前的 v2.0）；
    // 要「采用新默认版」得先点「恢复默认」再改，那时才记当前版本
    b[k] = o[k] !== undefined ? baseVersionOf(k, b) : defaultVersionOf(id, subject)
    o[k] = text
  }
  writeOverrides(o)
  writeBases(b)
}

export function resetPrompt(id: PromptId, part: PromptPart, subject?: unknown): void {
  const k = promptKey(id, part, subject)
  const o = overrides()
  delete o[k]
  writeOverrides(o)
  const b = bases()
  delete b[k]
  writeBases(b)
}

/** 本次解析使用的提示词版本：全是内置 → 该提示词的内置版本号（如 "v2.0"、老师版 "v3.0"）；有改写 → "<基于的内置版本>+自定义·<哈希前 6 位>"，同一份改写得到同一个标识 */
export function promptVersionFor(id: PromptId, subject?: unknown): string {
  const o = overrides()
  const key = (p: PromptPart) => promptKey(id, p, subject)
  const parts = (['system', 'user'] as PromptPart[]).filter(p => o[key(p)] !== undefined && o[key(p)] !== DEFAULTS[key(p)])
  if (parts.length === 0) return defaultVersionOf(id, subject)
  const h = crypto.createHash('sha256').update((['system', 'user'] as PromptPart[]).map(p => promptText(id, p, subject)).join('\u0000')).digest('hex').slice(0, 6)
  return `${baseVersionOf(key(parts[0]))}+自定义·${h}`
}
