/**
 * 助手导入试卷时的分学科逻辑（纯函数，不依赖 electron，可单测）：
 * 每组卷子按附件文字各判各的学科；助手在参数里明确写了 subject 就以它为准；拿不准的用会话学科。
 */
import { detectSubject } from '../../shared/classify.ts'
import { subjectName } from '../../shared/subject.ts'
import type { SubjectId } from '../../shared/subject.ts'

export interface GroupSubject { subject: SubjectId; how: 'explicit' | 'detected' | 'session' }

export function pickGroupSubject(texts: string[], title: string | undefined, explicit: SubjectId | undefined, session: SubjectId): GroupSubject {
  if (explicit) return { subject: explicit, how: 'explicit' }
  const r = detectSubject(texts.join('\n'), title ?? '')
  if (r.sure && r.subject) return { subject: r.subject, how: 'detected' }
  return { subject: session, how: 'session' }
}

/** 返回文字里关于「导入到了别的学科」的说明；全在会话学科里时返回空数组 */
export function foreignSubjectNotes(imported: Array<{ fileName: string; subject: SubjectId }>, session: SubjectId): string[] {
  const foreign = imported.filter(x => x.subject !== session)
  if (!foreign.length) return []
  const bySub = new Map<SubjectId, string[]>()
  for (const f of foreign) bySub.set(f.subject, [...(bySub.get(f.subject) ?? []), f.fileName])
  return [...bySub].map(([sub, names]) => `其中 ${names.length} 份按内容判断是${subjectName(sub)}卷，已导入到${subjectName(sub)}学科（${names.map(n => `「${n}」`).join('、')}），不在当前${subjectName(session)}对话的试卷库里。请让用户切换到${subjectName(sub)}学科查看和审核。`)
}
