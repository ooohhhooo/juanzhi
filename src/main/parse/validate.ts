/**
 * 模型输出的二次校验：知识点代码必须在树里、题型必须在题型表里（提示词 §7.2）。
 * 不在树里的代码不会进库当作标注，改为「待归类」的 kp_suggestion，等老师在审核页处理。
 */
import type { AnyQuestion } from './schema.ts'

export interface Taxonomy {
  kps: Set<string>
  qtypes: Set<string>
}

/** 去掉末段逐级向上找存在的祖先：GR.TENSE.PAST.XYZ → GR.TENSE.PAST；找不到返回 null */
export function nearestAncestor(code: string, kps: Set<string>): string | null {
  const parts = code.split('.')
  for (let n = parts.length - 1; n >= 1; n--) {
    const cand = parts.slice(0, n).join('.')
    if (kps.has(cand)) return cand
  }
  return null
}

export interface NormalizedKps {
  kp_main: string
  kp_secondary: string[]
  kp_suggestion: string
  flags: string[]
}

export function normalizeKps(q: Pick<AnyQuestion, 'kp_main' | 'kp_secondary' | 'kp_suggestion' | 'flags'>, kps: Set<string>): NormalizedKps {
  const flags = new Set(q.flags)
  let suggestion = q.kp_suggestion.trim()
  const pending: string[] = []

  let main = q.kp_main.trim()
  if (main && !kps.has(main)) {
    const anc = nearestAncestor(main, kps)
    pending.push(main)
    main = anc ?? ''
    flags.add('kp_invalid')
    flags.add('kp_uncertain')
  }

  const secondary: string[] = []
  for (const raw of q.kp_secondary) {
    const code = raw.trim()
    if (!code) continue
    if (!kps.has(code)) { pending.push(code); flags.add('kp_invalid'); continue }
    if (code !== main && !secondary.includes(code)) secondary.push(code)
  }

  if (!suggestion && pending.length) suggestion = `待归类：${pending[0]}`
  if (!main) flags.add('kp_uncertain')
  return { kp_main: main, kp_secondary: secondary.slice(0, 2), kp_suggestion: suggestion.slice(0, 60), flags: [...flags] }
}

export function normalizeQtype(qtype: string, qtypes: Set<string>): { qtype: string; invalid: boolean } {
  const q = qtype.trim()
  if (qtypes.has(q)) return { qtype: q, invalid: false }
  return { qtype: 'OTHER', invalid: true }
}

const FLAG_PENALTY: Record<string, number> = {
  kp_uncertain: 0.25,
  kp_invalid: 0.1,
  ocr_unclear: 0.2,
  stem_incomplete: 0.35,   // 单独出现也要低于 0.7 阈值（审核页标黄），残缺题不能被当作完整题放过
  underline_lost: 0.1,
  no_number: 0.1,
  no_section: 0.15,
  bbox_uncertain: 0.25,
  locate_failed: 0.3,
  locate_fuzzy: 0.1,
  locate_rescan: 0.35,   // 重新扫描才定位到的位置可能是同文的另一处，要进「需关注」
  qtype_invalid: 0.1,
  duplicate: 0.3
}

/** 置信度由程序按标记与定位结果折算（不用模型自评，见提示词审阅意见 9）；低于 0.7 在审核页标黄 */
export function scoreConfidence(flags: string[], opts: { hasBbox: boolean; hasStem: boolean }): number {
  let c = 1
  for (const f of flags) c -= FLAG_PENALTY[f] ?? 0
  if (!opts.hasBbox && !flags.includes('locate_failed')) c -= 0.1
  if (!opts.hasStem) c -= 0.1
  return Math.round(Math.max(0.05, Math.min(1, c)) * 100) / 100
}

export const LOW_CONFIDENCE = 0.7

// ───────── 试卷元数据（AI 猜测）─────────

export interface AiMetaGuess {
  title?: string
  grade?: string
  semester?: string
  school_year_start?: number
  exam_type?: string
  textbook?: string
  total_score?: number
}

const EXAM_TYPE_MAP: Record<string, string> = {
  期中: '期中', 期末: '期末', 月考: '月考', 单元: '单元测试', 单元测试: '单元测试', 其他: '其他'
}

/** 把模型给的 meta 转成 papers 表字段；格式不对的字段直接丢弃，不猜 */
export function metaToPaperFields(meta: {
  title: string | null; grade: number | null; semester: string | null; school_year: string | null
  exam_type: string | null; textbook: string | null; total_score: number | null
}): AiMetaGuess {
  const out: AiMetaGuess = {}
  if (meta.title && meta.title.trim()) out.title = meta.title.trim().slice(0, 200)
  if (meta.grade && meta.grade >= 1 && meta.grade <= 6) out.grade = String(meta.grade)
  if (meta.semester === '上' || meta.semester === '下') out.semester = meta.semester
  if (meta.school_year) {
    const m = /(20\d{2})\s*[-–—/~～]\s*(20\d{2}|\d{2})/.exec(meta.school_year)
    if (m) {
      const start = Number(m[1])
      const end = m[2].length === 2 ? Number(String(start).slice(0, 2) + m[2]) : Number(m[2])
      if (end === start + 1) out.school_year_start = start
    }
  }
  if (meta.exam_type && EXAM_TYPE_MAP[meta.exam_type.trim()]) out.exam_type = EXAM_TYPE_MAP[meta.exam_type.trim()]
  if (meta.textbook && meta.textbook.trim()) out.textbook = meta.textbook.trim().slice(0, 100)
  if (meta.total_score != null && Number.isInteger(meta.total_score) && meta.total_score > 0 && meta.total_score <= 200) {
    out.total_score = meta.total_score
  }
  return out
}

export interface PaperMetaRow {
  title: string
  file_name: string
  grade: string | null
  semester: string | null
  school_year_start: number | null
  exam_type: string | null
  textbook: string | null
  total_score: number | null
}

/** 只给用户留空的字段预填；标题仍是导入时由文件名生成的默认值也算「没填」。返回要写入的字段与被 AI 填过的字段名 */
export function pickPrefill(paper: PaperMetaRow, guess: AiMetaGuess, previouslyAi: string[]): { fields: Record<string, string | number>; aiFields: string[] } {
  const fields: Record<string, string | number> = {}
  const ai = new Set(previouslyAi)
  const keys = ['grade', 'semester', 'school_year_start', 'exam_type', 'textbook', 'total_score'] as const
  for (const k of keys) {
    const cur = paper[k]
    const empty = cur === null || cur === undefined || cur === ''
    // 上一次是 AI 填的、用户没动过：允许这次用新的猜测覆盖
    if (guess[k] !== undefined && (empty || ai.has(k))) {
      fields[k] = guess[k] as string | number
      ai.add(k)
    }
  }
  const defaultTitle = paper.file_name.replace(/\.[^.]+$/, '')
  if (guess.title && (paper.title === defaultTitle || paper.title === '' || ai.has('title'))) {
    fields.title = guess.title
    ai.add('title')
  }
  return { fields, aiFields: [...ai] }
}

/** 提示词的 {{KNOWN_META}}：只列用户（或上一次确认过的）已有的字段 */
export function knownMetaText(paper: PaperMetaRow, aiFields: string[] = []): string {
  const parts: string[] = []
  const has = (k: string) => !aiFields.includes(k)
  if (paper.grade && has('grade')) parts.push(`年级=${paper.grade}`)
  if (paper.semester && has('semester')) parts.push(`学期=${paper.semester}`)
  if (paper.school_year_start && has('school_year_start')) parts.push(`学年=${paper.school_year_start}-${paper.school_year_start + 1}`)
  if (paper.exam_type && has('exam_type')) parts.push(`考试类型=${paper.exam_type}`)
  if (paper.textbook && has('textbook')) parts.push(`教材=${paper.textbook}`)
  if (paper.total_score && has('total_score')) parts.push(`满分=${paper.total_score}`)
  return parts.length ? parts.join('；') : '（无）'
}
