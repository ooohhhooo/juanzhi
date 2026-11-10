import type { SubjectId } from '../../shared/subject'
import type { EntryExample } from '../design/Entry'

/** 知识点的例子：英语是「英文例句 + 中文意思」；语文、数学只有一段「例子」（存在 example_zh 里） */
export function kpExamples(node: { example_en?: string | null; example_zh?: string | null } | undefined, subject: SubjectId): EntryExample[] | undefined {
  if (!node) return undefined
  if (subject === 'english') return node.example_en ? [{ en: node.example_en, zh: node.example_zh ?? undefined }] : undefined
  return node.example_zh ? [{ en: node.example_zh, lang: 'zh-CN' }] : undefined
}
