/**
 * 助手里生成考情报告：调用「报告」页同一套生成流程（同样的提示词、事实核对、课程对照段），生成后出现在报告页。
 * 依赖 electron（AI 配置、数据库），不进纯逻辑的工具清单；在 all-tools.ts 里加进去。
 */
import crypto from 'node:crypto'
import { z } from 'zod'
import { getDb } from '../db'
import { generateReport } from '../report/service'
import { withSpend } from '../ipc/cost'
import { READER_LABEL } from '../../shared/report-post'
import type { ReportReader } from '../../shared/report-post'
import type { AgentTool } from './tool-types'

const Params = z.object({
  reader: z.enum(['parent', 'teacher', 'boss', 'full']).describe('版本：parent 家长版、teacher 老师版、boss 老板版、full 完整数据版'),
  grade: z.enum(['1', '2', '3', '4', '5', '6']).optional(),
  semester: z.enum(['上', '下']).optional(),
  school_year_start: z.number().int().min(2000).max(2100).optional(),
  exam_type: z.enum(['单元测试', '期中', '期末', '月考', '其他']).optional(),
  paperIds: z.array(z.string().uuid()).min(1).max(200).optional().describe('只用这几份试卷（不写 = 按上面的筛选）'),
  withCourse: z.boolean().optional().describe('有启用的课程大纲时带上课程对照段，默认带')
})
type Args = z.infer<typeof Params>

const scopeText = (a: Args) => [a.paperIds?.length ? `选中的 ${a.paperIds.length} 份试卷` : '', a.grade ? `${a.grade} 年级` : '', a.semester ? `${a.semester}学期` : '', a.school_year_start ? `${a.school_year_start} 学年` : '', a.exam_type ?? ''].filter(Boolean).join('、') || '全部已审核的试卷'

export const reportGenerate: AgentTool<Args> = {
  name: 'report_generate',
  description: '生成一份考情分析报告（和「报告」页的生成完全一样：老板版 / 家长版 / 老师版 / 完整数据版），会调用 AI、需要一两分钟，生成后保存在「报告」页。用户明确要「出一份报告」时才用；先用 papers_list 确认范围里有已审核的试卷。返回报告编号和开头一段，需要全文用 report_read。',
  params: Params,
  level: 'write',
  preview: a => `生成一份${READER_LABEL[a.reader as ReportReader]}报告（范围：${scopeText(a)}），会调用 AI，保存在「报告」页`,
  async run(a, ctx) {
    const filter: Record<string, unknown> = {}
    for (const k of ['grade', 'semester', 'school_year_start', 'exam_type', 'paperIds'] as const) if (a[k] !== undefined) filter[k] = a[k]
    let outlineIds: string[] = []
    if (a.withCourse !== false) { try { outlineIds = (getDb().prepare("SELECT id FROM course_outlines WHERE active = 1 AND status = 'active'").all() as any[]).map(r => String(r.id)) } catch { /* 没有课程表 */ } }
    const r = await withSpend('report', () => generateReport(filter as any, a.reader as ReportReader, crypto.randomUUID(), () => { /* 进度不推给助手界面 */ },
      cb => { if (ctx.signal?.aborted) { cb(); return () => {} } ctx.signal?.addEventListener('abort', cb, { once: true }); return () => ctx.signal?.removeEventListener('abort', cb) },
      outlineIds.length ? { course: { outlineIds } } : {}))
    if (!r.ok || !r.reportId) return { ok: false, message: r.message ?? '报告没有生成成功' }
    const md = String((r as any).markdown ?? '')
    return { ok: true, message: `已生成${READER_LABEL[a.reader as ReportReader]}报告（编号 ${r.reportId}，范围：${scopeText(a)}），保存在「报告」页${a.reader === 'parent' ? '；家长版要老师在报告页点「我已核对」后才能导出或复制' : ''}。开头：\n${md.slice(0, 800)}${md.length > 800 ? '…' : ''}`, data: { reportId: r.reportId } }
  }
}
