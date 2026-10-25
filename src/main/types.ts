import { z } from 'zod'

export const GradeEnum = z.enum(['1', '2', '3', '4', '5', '6'])
export const SemesterEnum = z.enum(['上', '下'])
export const ExamTypeEnum = z.enum(['单元测试', '期中', '期末', '月考', '其他'])
export const PaperStatusEnum = z.enum(['imported', 'extracting', 'parsing', 'reviewing', 'done', 'failed'])
// pdf-text: PDF 文本层；ocr: 本机 OCR；docx: Word 文本；vision: 视觉模型（M2）；
// needs_ocr: 当前平台没有 OCR 能力；none: 已尝试但没有取得文字
export const TextSourceEnum = z.enum(['pdf-text', 'ocr', 'docx', 'vision', 'needs_ocr', 'none'])

export const PaperMetaSchema = z.object({
  grade: GradeEnum.nullable().optional(),
  semester: SemesterEnum.nullable().optional(),
  school_year_start: z.number().int().min(2000).max(2100).nullable().optional(),
  exam_type: ExamTypeEnum.nullable().optional(),
  textbook: z.string().max(100).nullable().optional(),
  region: z.string().max(100).nullable().optional(),
  school: z.string().max(200).nullable().optional(),
  total_score: z.number().int().min(0).max(200).nullable().optional(),
  title: z.string().max(500).optional()
})

export const PaperFilterSchema = z.object({
  grade: GradeEnum.optional(),
  semester: SemesterEnum.optional(),
  school_year_start: z.number().int().optional(),
  exam_type: ExamTypeEnum.optional(),
  textbook: z.string().optional(),
  region: z.string().optional(),
  status: PaperStatusEnum.optional()
})

export type PaperMeta = z.infer<typeof PaperMetaSchema>
export type PaperFilter = z.infer<typeof PaperFilterSchema>

export interface Paper {
  id: string
  title: string
  grade: string | null
  semester: string | null
  school_year_start: number | null
  exam_type: string | null
  textbook: string | null
  region: string | null
  school: string | null
  total_score: number | null
  file_name: string
  file_hash: string
  status: string
  error: string | null
  page_count: number
  ai_model: string | null
  created_at: string
  extracted_at: string | null
}

export interface PageRecord {
  id: number
  paper_id: string
  idx: number
  image_rel: string
  width: number
  height: number
  text_source: string
  lines_json: string
  text: string | null
  ocr_conf: number | null
}

export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  conf: number
}

export interface ImportResult {
  path: string
  fileName: string
  paperId?: string
  error?: string
}

export interface OcrResult {
  pages: Array<{
    index: number
    image: string
    width: number
    height: number
    source: string
    lines: OcrLine[]
  }>
}

export interface JobProgress {
  paperId: string
  stage: string
  progress: number
  message: string
}
