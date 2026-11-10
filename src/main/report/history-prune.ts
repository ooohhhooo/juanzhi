/**
 * 报告历史的保留规则：每个学科各自最多留 max 条（英语的报告不会把数学的挤掉）。
 * 纯函数，数据库句柄由调用方传入，单测直接加载。
 */
export function pruneReportHistory(db: any, kind: string, subject: string, max: number): void {
  db.prepare(`DELETE FROM reports WHERE kind = ? AND subject = ? AND id NOT IN (SELECT id FROM reports WHERE kind = ? AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(kind, subject, kind, subject, max)
}
