/**
 * 导入自动分流 / 自动认学科：界面用到的主进程接口。
 * 接口签名以 env.d.ts 为准；这里只放汇总、提示用的纯函数和类型。
 * 纯函数、不依赖 React，单测直接加载（import 带 .ts 后缀）。
 */
import { SUBJECT_IDS, asSubject, isSubjectId, subjectName, type SubjectId } from '../../shared/subject.ts'

/** 文档、数据集的学科：三个学科或「通用」 */
export type DataSubject = SubjectId | 'general'
export const DATA_SUBJECTS: DataSubject[] = [...SUBJECT_IDS, 'general']
export const dataSubjectName = (s: unknown): string => (isSubjectId(s) ? subjectName(s) : '通用')
export const asDataSubject = (v: unknown): DataSubject => (isSubjectId(v) ? v : 'general')

export interface AutoPaperResult { file: string; /** 完整路径（重复导入时拿它重导） */ path?: string; paperId?: string; subject: SubjectId; hinted?: SubjectId; error?: string; code?: string }
export interface AutoImportResult {
  papers: AutoPaperResult[]
  datasets: Array<{ file: string; id?: string; error?: string }>
  documents: Array<{ file: string; id?: string; subject: DataSubject; error?: string }>
  notes: string[]
}
export type SetSubjectResult = { needConfirm: true; reviewed: number } | { needConfirm?: false } | void

/** 卷子上的学科建议（papers.list 返回的 subject_hint）；没有或不认识返回 null */
export function hintOf(p: object): SubjectId | null {
  const h = (p as { subject_hint?: unknown }).subject_hint
  return isSubjectId(h) ? h : null
}

export interface AutoSummary {
  /** 汇总文字，如「3 份数学卷、1 份英语卷进了试卷库；1 张表进了数据」 */
  text: string
  /** 进了别的学科的卷子：学科 → 份数 */
  others: Array<{ subject: SubjectId; count: number }>
  /** 等用户确认学科的份数 */
  hinted: number
  /** 重复的文件（沿用「仍然导入」弹窗） */
  duplicates: string[]
  errors: string[]
  notes: string[]
  /** 什么都没进 */
  empty: boolean
}

/** 把 importAuto 的返回汇总成一条提示 */
export function summarizeAuto(r: AutoImportResult, current: SubjectId): AutoSummary {
  const papers = r.papers ?? [], datasets = r.datasets ?? [], documents = r.documents ?? []
  const okPapers = papers.filter(p => p.paperId && !p.error)
  const bySubject = new Map<SubjectId, number>()
  let hinted = 0
  for (const p of okPapers) {
    if (p.hinted) hinted++
    // 带建议的卷子还留在它被导入的学科里（等用户确认），按实际所在的学科算
    const s = asSubject(p.subject)
    bySubject.set(s, (bySubject.get(s) ?? 0) + 1)
  }
  const parts: string[] = []
  const order = [current, ...SUBJECT_IDS.filter(s => s !== current)]
  const paperBits = order.filter(s => bySubject.has(s)).map(s => `${bySubject.get(s)} 份${subjectName(s)}卷`)
  if (paperBits.length) parts.push(`${paperBits.join('、')}进了试卷库`)
  const okDatasets = datasets.filter(d => d.id && !d.error)
  const okDocs = documents.filter(d => d.id && !d.error)
  const dataBits: string[] = []
  if (okDatasets.length) dataBits.push(`${okDatasets.length} 张表`)
  if (okDocs.length) dataBits.push(`${okDocs.length} 份文档`)
  if (dataBits.length) parts.push(`${dataBits.join('、')}进了数据`)
  const errors = [
    ...papers.filter(p => p.error && p.code !== 'duplicate').map(p => `${p.file}：${p.error}`),
    ...datasets.filter(d => d.error).map(d => `${d.file}：${d.error}`),
    ...documents.filter(d => d.error).map(d => `${d.file}：${d.error}`)
  ]
  return {
    text: parts.join('；'),
    others: order.filter(s => s !== current && bySubject.has(s)).map(s => ({ subject: s, count: bySubject.get(s)! })),
    hinted,
    duplicates: papers.filter(p => p.code === 'duplicate').map(p => p.path ?? p.file),
    errors,
    notes: r.notes ?? [],
    empty: parts.length === 0
  }
}
