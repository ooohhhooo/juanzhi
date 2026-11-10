import { asSubject, type SubjectId } from '../../shared/subject'

/** 试卷所属学科（旧数据没有这一列时按英语） */
export const paperSubject = (p: object): SubjectId => asSubject((p as { subject?: unknown }).subject)

/**
 * 只留某个学科的试卷。主进程的 papers:list 已按 subject 过滤，这里再兜一层：
 * 即使后端漏了，不同学科的卷子也不会混进同一个页面。
 */
export const inSubject = <T extends object>(papers: T[], subject: SubjectId): T[] => papers.filter(p => paperSubject(p) === subject)
