/**
 * 「现在能不能动整个数据」：导入数据包（覆盖）、更改数据目录之前要确认没有后台任务在读写数据——
 * 提取 / 解析队列里有任务、或者 AI 分析 / 报告正在生成，都先等它们结束（或取消）。
 */
import { getDb } from './db'
import { extractQueueState } from './pipeline/queue'
import { parseQueueState } from './parse/queue'
import { analysisBusy } from './stats/analysis'
import { reportBusy } from './report/service'

export function busyReason(): string | null {
  const ex = extractQueueState()
  if (ex.running || ex.waiting.length) return '有试卷正在提取文字，请等它们处理完（或到「处理队列」暂停 / 取消）再操作'
  const ps = parseQueueState()
  if (ps.running.length || ps.waiting.length) return '有试卷正在 AI 解析，请等它们处理完（或到「处理队列」取消）再操作'
  const n = (getDb().prepare("SELECT COUNT(*) c FROM papers WHERE status IN ('extracting','parsing')").get() as any).c as number
  if (n > 0) return '有试卷正在处理中，请稍后再操作'
  if (analysisBusy() || reportBusy()) return '有 AI 分析 / 报告正在生成，请等它结束或先取消'
  return null
}
