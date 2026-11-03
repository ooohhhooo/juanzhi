/**
 * 课程对照的数据指纹：报告勾了「加入课程对照」后，体系内容（rev）、启用状态、知识点对应（含老师确认 / 否决）任何一项变了，
 * 指纹就变，报告的缓存键随之变化 → 显示「已过期」（不自动重新生成）。纯读库，不依赖 electron。
 */
import crypto from 'node:crypto'

type Db = any

export function courseSig(db: Db, outlineIds: string[]): string {
  const ids = [...new Set(outlineIds)].sort()
  if (!ids.length) return ''
  const parts: string[] = []
  const o = db.prepare('SELECT rev, status, active FROM course_outlines WHERE id = ?')
  const m = db.prepare('SELECT kp_code, lesson_id, confidence, state FROM course_kp_map WHERE outline_id = ? ORDER BY kp_code, lesson_id')
  for (const id of ids) {
    const r = o.get(id) as any
    if (!r) { parts.push(`${id}:missing`); continue }
    const h = crypto.createHash('sha256')
    for (const x of m.all(id) as any[]) h.update(`${x.kp_code}|${x.lesson_id}|${x.confidence}|${x.state}\n`)
    parts.push(`${id}:${r.rev}:${r.status}:${r.active}:${h.digest('hex').slice(0, 16)}`)
  }
  return parts.join(';')
}
