/**
 * 提示词管理：内置默认值来自 docs/prompts/v1-sonnet改写.md（scripts/extract-prompts.cjs 抽成 prompts/*.txt 资源文件），
 * 用户可在设置里改写；改写后的文本存在 settings.ai_prompts（id.part → 文本）。每次解析都记录用的是哪个版本。
 */
import crypto from 'node:crypto'
import { getDb } from '../db'
import { unknownPlaceholders } from '../parse/batch'
import { promptProblem, sanitizeOverrides } from './prompt-rules'
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

/** 内置提示词的版本号；改了资源文件就要同步提升，并在交付说明里记一笔 */
export const PROMPT_DEFAULT_VERSION = 'v2.0'
/** 升过版的提示词各自的内置版本号（没列出的用 PROMPT_DEFAULT_VERSION）：老师版 v3.0（做题方法 + 学习进步建议，其余由程序拼）和它的三个搭档 */
export const PROMPT_VERSIONS: Partial<Record<PromptId, string>> = { p3_teacher: 'v3.0', p3_tricks: 'v3.0', p4_variant_gen: 'v3.0', p4_variant_check: 'v3.0' }
export const defaultVersionOf = (id: PromptId): string => PROMPT_VERSIONS[id] ?? PROMPT_DEFAULT_VERSION
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
  'p5_course_hint.system': trimEnd(p5HintSystem), 'p5_course_hint.user': trimEnd(p5HintUser)
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
  p5_course_hint: 'P5 课程对照：家长版结尾一句课程建议'
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
  p5_course_hint: ['SCENE', 'FILTER_DESC', 'SAMPLE_WARNING', 'LOST_POINTS', 'COURSE_MATCH', 'EVIDENCE']
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
export const baseVersionOf = (key: string, b: Record<string, string> = bases()): string => b[key] ?? PROMPT_DEFAULT_VERSION

export function promptText(id: PromptId, part: PromptPart): string {
  const k = `${id}.${part}`
  return overrides()[k] ?? DEFAULTS[k]
}

export function promptViews(): PromptView[] {
  const o = overrides()
  const b = bases()
  const views: PromptView[] = []
  for (const id of PROMPT_IDS) {
    for (const part of ['system', 'user'] as PromptPart[]) {
      const k = `${id}.${part}`
      const text = o[k] ?? DEFAULTS[k]
      views.push({
        id, part, title: TITLES[id], text, defaultText: DEFAULTS[k], isCustom: o[k] !== undefined && o[k] !== DEFAULTS[k],
        version: defaultVersionOf(id), defaultUpdated: o[k] !== undefined && o[k] !== DEFAULTS[k] && baseVersionOf(k, b) !== defaultVersionOf(id),
        unknownPlaceholders: unknownPlaceholders(text, PLACEHOLDERS[id]), usedInM2: true   // 字段名沿用旧的；含义是「当前版本会被用到」：P1 两版（M2）、P2（M3）、P3/P4（报告）、课程对照四个现在都用
      })
    }
  }
  return views
}

export function savePrompt(id: PromptId, part: PromptPart, text: string): void {
  const k = `${id}.${part}`
  const bad = promptProblem(k, text)
  if (bad) throw new Error(bad === '提示词不能为空' ? '提示词不能为空；想恢复内置版本请点「恢复默认」' : bad.startsWith('P1 的 system') ? 'P1 的 system 提示词里必须出现「JSON」字样（服务商的 JSON 模式要求提示词里提到 json），请保留原有的输出格式说明' : bad)
  const o = overrides()
  const b = bases()
  if (text === DEFAULTS[k]) { delete o[k]; delete b[k] }
  else {
    // 已经自定义过的：重新保存不等于采用了新默认版，保留原来的「基于哪一版」（没有记录的按 beta.3 之前的 v2.0）；
    // 要「采用新默认版」得先点「恢复默认」再改，那时才记当前版本
    b[k] = o[k] !== undefined ? baseVersionOf(k, b) : defaultVersionOf(id)
    o[k] = text
  }
  writeOverrides(o)
  writeBases(b)
}

export function resetPrompt(id: PromptId, part: PromptPart): void {
  const o = overrides()
  delete o[`${id}.${part}`]
  writeOverrides(o)
  const b = bases()
  delete b[`${id}.${part}`]
  writeBases(b)
}

/** 本次解析使用的提示词版本：全是内置 → 该提示词的内置版本号（如 "v2.0"、老师版 "v3.0"）；有改写 → "<基于的内置版本>+自定义·<哈希前 6 位>"，同一份改写得到同一个标识 */
export function promptVersionFor(id: PromptId): string {
  const o = overrides()
  const parts = (['system', 'user'] as PromptPart[]).filter(p => o[`${id}.${p}`] !== undefined && o[`${id}.${p}`] !== DEFAULTS[`${id}.${p}`])
  if (parts.length === 0) return defaultVersionOf(id)
  const h = crypto.createHash('sha256').update((['system', 'user'] as PromptPart[]).map(p => promptText(id, p)).join('\u0000')).digest('hex').slice(0, 6)
  return `${baseVersionOf(`${id}.${parts[0]}`)}+自定义·${h}`
}
