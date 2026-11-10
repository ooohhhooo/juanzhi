import { isSubjectId, type SubjectId } from '../../shared/subject.ts'

/** 从 queryKey 里认出学科：key 里直接放了学科名，或放了带 subject 的筛选对象（筛选里不写学科 = 英语） */
export function subjectOfKey(key: readonly unknown[] | undefined): SubjectId | null {
  if (!key) return null
  for (const part of key) {
    if (isSubjectId(part)) return part
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const o = part as { subject?: unknown; filter?: { subject?: unknown } }
      if ('subject' in o) return isSubjectId(o.subject) ? o.subject : 'english'
      if (o.filter && typeof o.filter === 'object') return isSubjectId(o.filter.subject) ? o.filter.subject : 'english'
    }
  }
  return null
}

/**
 * 代替 keepPreviousData：换筛选条件时先留着上一份结果（不闪空白），但**换了学科就不留**——
 * 否则切到数学的那几百毫秒里，页面上显示的还是英语的数字和报告。
 */
export const keepSameSubject = (subject: SubjectId) =>
  <T>(prev: T | undefined, prevQuery?: { queryKey: readonly unknown[] }): T | undefined => {
    const s = subjectOfKey(prevQuery?.queryKey)
    return s === null || s === subject ? prev : undefined
  }
