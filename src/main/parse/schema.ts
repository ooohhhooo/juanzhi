/**
 * P1 输出的 zod 校验（提示词 v1「Schema」一节）。
 * 校验尺度：缺省的辅助字段给默认值（模型偶尔漏键不该让整批作废），但核心字段（题号、页码、难度、知识点主码、
 * questions 本身）缺失或类型不对就是失败，交给调用方「带着错误信息重试一次」。
 */
import { z } from 'zod'
import type { ZodError } from 'zod'

export const FLAGS_TEXT = ['ocr_unclear', 'underline_lost', 'needs_image', 'stem_incomplete', 'no_number', 'no_section', 'kp_uncertain'] as const
export const FLAGS_VISION = ['ocr_unclear', 'needs_image', 'stem_incomplete', 'no_number', 'no_section', 'kp_uncertain', 'bbox_uncertain'] as const
/** 程序自己追加的标记 */
export const FLAGS_PROGRAM = ['locate_failed', 'locate_fuzzy', 'locate_rescan', 'kp_invalid', 'qtype_invalid', 'duplicate'] as const

const nullableStr = z.string().nullable().default(null)

export const MetaSchema = z.object({
  title: nullableStr,
  grade: z.number().int().min(1).max(6).nullable().default(null),
  semester: z.enum(['上', '下']).nullable().default(null),
  school_year: nullableStr,
  exam_type: nullableStr,
  textbook: nullableStr,
  total_score: z.number().nullable().default(null)
}).default({})

export const SectionSchema = z.object({
  no: z.union([z.string(), z.number()]).transform(String),
  title: z.string().default(''),
  qtype: z.string().default('OTHER'),
  score_each: z.number().nullable().default(null),
  total_score: z.number().nullable().default(null),
  continued_from_prev: z.boolean().default(false)
})

export const MaterialSchema = z.object({
  id: z.string().min(1),
  section: z.string().default(''),
  kind: z.string().default('other'),
  text: z.string().default(''),
  page: z.number().int().min(1).default(1),
  continued_from_prev: z.boolean().default(false),
  continues_next: z.boolean().default(false)
})

const questionBase = {
  no: z.union([z.string().min(1), z.number()]).transform(String),
  section: z.union([z.string(), z.number()]).transform(String).default(''),
  qtype: z.string().default('OTHER'),
  material_id: z.string().nullable().default(null),
  stem: z.string().default(''),
  options: z.array(z.string()).default([]),
  answer: z.string().default(''),
  score: z.number().nullable().default(null),
  kp_main: z.string(),
  kp_secondary: z.array(z.string()).default([]),
  kp_suggestion: z.string().default(''),
  difficulty: z.number().int().min(1).max(5),
  error_prone: z.boolean().default(false),
  error_reason: z.string().default(''),
  page: z.number().int().min(1),
  continued_from_prev: z.boolean().default(false),
  continues_next: z.boolean().default(false),
  flags: z.array(z.string()).default([])
}

export const TextQuestionSchema = z.object({
  ...questionBase,
  anchor: z.string(),
  anchor_ref: z.string().default('')
})

const unit = z.number().min(0).max(1)
export const VisionQuestionSchema = z.object({
  ...questionBase,
  anchor: z.tuple([unit, unit, unit, unit]).nullable()
})

function outputSchema<Q extends z.ZodTypeAny>(q: Q) {
  return z.object({
    meta: MetaSchema,
    sections: z.array(SectionSchema).default([]),
    materials: z.array(MaterialSchema).default([]),
    questions: z.array(q),
    notes: z.array(z.string()).default([])
  })
}

export const TextOutputSchema = outputSchema(TextQuestionSchema)
export const VisionOutputSchema = outputSchema(VisionQuestionSchema)

export type Meta = z.infer<typeof MetaSchema>
export type Section = z.infer<typeof SectionSchema>
export type Material = z.infer<typeof MaterialSchema>
export type TextQuestion = z.infer<typeof TextQuestionSchema>
export type VisionQuestion = z.infer<typeof VisionQuestionSchema>
export type TextOutput = z.infer<typeof TextOutputSchema>
export type VisionOutput = z.infer<typeof VisionOutputSchema>
/** 合并/定位阶段统一使用的题目形状：anchor 文本版是字符串、视觉版是四元数组或 null */
export type AnyQuestion = Omit<TextQuestion, 'anchor' | 'anchor_ref'> & {
  anchor: string | [number, number, number, number] | null
  anchor_ref: string
}

/** 把 zod 错误整理成给模型（和日志）看的几行中文，最多 6 条 */
export function formatZodError(err: ZodError): string {
  const lines: string[] = []
  for (const issue of err.issues) {
    const p = issue.path.map(s => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('').replace(/^\./, '')
    // 给用户和模型看的都是中文；zod 自带的英文说明不外泄
    let msg = '取值不符合要求'
    if (issue.code === 'invalid_type') msg = issue.received === 'undefined' ? '缺少这个字段' : `类型应为 ${issue.expected}，实际是 ${issue.received}`
    else if (issue.code === 'too_small') msg = `不能小于 ${issue.minimum}`
    else if (issue.code === 'too_big') msg = `不能大于 ${issue.maximum}`
    else if (issue.code === 'invalid_enum_value') msg = `取值必须是 ${issue.options.join(' / ')} 之一`
    lines.push(`${p || '（根）'}：${msg}`)
    if (lines.length >= 6) break
  }
  if (err.issues.length > lines.length) lines.push(`……另有 ${err.issues.length - lines.length} 处问题`)
  return lines.join('\n')
}

/** 从模型输出里抠出 JSON 对象：容忍 ```json 围栏与前后多余文字（提示词已禁止，但真实模型偶尔会写） */
export function extractJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let s = content.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s)
  if (fence) s = fence[1].trim()
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch (e1) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try { return { ok: true, value: JSON.parse(s.slice(a, b + 1)) } } catch { /* 落到下面的统一报错 */ }
    }
    return { ok: false, error: (e1 as Error).message }
  }
}
