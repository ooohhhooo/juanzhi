/**
 * 「导入自动分流」的纯逻辑（不依赖 electron，可单测）：按扩展名和（能便宜拿到的）文字，判断一个文件该去哪。
 *  - 表格 → 数据（数据集）；
 *  - 图片 → 试卷（来不及看内容，一律当试卷）；
 *  - pdf / docx：有文字就判断像不像试卷，像 → 试卷库，不像 → 文档资料（并按文字认学科）；拿不到文字（扫描件）→ 试卷；
 *  - 其余可读文字的文件（md、html 等）→ 文档资料。
 */
import path from 'node:path'
import { detectDocSubject, looksLikePaper } from '../../shared/classify.ts'
import type { ContentSubject } from '../../shared/classify.ts'

export type RouteKind = 'table' | 'paper' | 'document' | 'unsupported'
export interface RoutePlan {
  route: RouteKind
  /** 文档资料的学科（route = document 时） */
  subject?: ContentSubject
  /** 要告诉用户的一句话（如「看起来是课程表」） */
  note?: string
}

const TABLE_EXT = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.heic']
const DOC_TEXT_EXT = ['.md', '.markdown', '.json', '.log', '.html', '.htm']
/** 需要先取文字再判断的类型 */
export const PEEK_EXT = ['.pdf', '.docx']

export const extOf = (file: string): string => path.extname(file).toLowerCase()
export const needsPeek = (file: string): boolean => PEEK_EXT.includes(extOf(file))

const COURSE_NAME_RE = /课程|大纲|课表|课时|教学计划|进度表/

/** text：pdf / docx 的文字（拿不到传 null / 空串） */
export function planRoute(file: string, text: string | null | undefined): RoutePlan {
  const ext = extOf(file)
  const name = path.basename(file)
  const stem = name.replace(/\.[^.]+$/, '')
  if (TABLE_EXT.includes(ext)) {
    return { route: 'table', note: COURSE_NAME_RE.test(name) ? `「${name}」看起来是课程表，也可以到「课程大纲」里导入` : undefined }
  }
  if (IMAGE_EXT.includes(ext)) return { route: 'paper' }
  if (PEEK_EXT.includes(ext)) {
    if (!text || !text.trim()) return { route: 'paper' }
    if (looksLikePaper(text, stem)) return { route: 'paper' }
    return { route: 'document', subject: detectDocSubject(text, stem) }
  }
  if (DOC_TEXT_EXT.includes(ext)) return { route: 'document' }
  return { route: 'unsupported' }
}
