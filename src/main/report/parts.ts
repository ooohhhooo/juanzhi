/**
 * 报告分段（M9 beta.3）：一份报告 = 主文 + 若干独立的附加段，每段单独调用、单独失败、单独重试，状态各自显示。
 * 本文件是纯模块（不依赖 electron 和数据库，单测直接加载）：段的元数据、拼装顺序、失败占位。
 * 真正去跑每一段（调用 AI、写库）的注册表在 parts-run.ts；后来的「课程对照」段在那里 registerReportPart 就能接入，不用改这里。
 *
 * 拼装规则：最终的 reports.markdown 由主文 + 各段按 placement 插入而成，所有旧的出口（复制 / 导出 / 删句 / 过期判断）继续只认这一份 Markdown。
 *   after_head     标题和说明之后、主文第一节之前（老师版：易错题集 / 易错知识点）
 *   after_methods  「做题方法」一节的末尾（老师版：口诀大招卡片）
 *   before_advice  「学习进步建议」（或旧版「备课建议」）之前（老师版：变形题和答题卡）
 *   tail           文末（课程对照等）
 * 主文里找不到对应小节时（用户自定义了提示词、旧结构）：after_methods 并入 before_advice，before_advice 并入 tail，保证每一段都有地方放。
 */
import type { ReportReader } from '../../shared/report-post.ts'

export type PartStatus = 'ok' | 'failed' | 'skipped' | 'running'
export type Placement = 'after_head' | 'after_methods' | 'before_advice' | 'tail'

export interface PartMeta {
  id: string
  /** 界面上的名字（进度条、状态标签、失败占位都用它） */
  label: string
  placement: Placement
  /** 同一个 placement 里的先后 */
  order: number
  readers: ReportReader[]
  /** 是否调用 AI（false = 程序拼装，不花钱） */
  ai: boolean
}

/** 内置的几段。其它段（课程对照……）由 registerReportPart 登记 */
export const CORE_PART_METAS: PartMeta[] = [
  { id: 'errors', label: '易错题集与易错知识点', placement: 'after_head', order: 10, readers: ['teacher'], ai: false },
  { id: 'tricks', label: '口诀大招', placement: 'after_methods', order: 20, readers: ['teacher'], ai: true },
  { id: 'variants', label: '同类变形题与答题卡', placement: 'before_advice', order: 30, readers: ['teacher'], ai: true }
]

export interface PartText {
  id: string
  status: PartStatus
  /** 这一段的 Markdown（status = ok 时才用） */
  markdown: string
}

/** 失败 / 未写完的段在报告里留一行说明（导出时也在，诚实告诉读者这里缺了一块） */
export function placeholderFor(label: string, status: PartStatus): string {
  if (status === 'running') return `> 「${label}」正在生成……`
  return `> 「${label}」这一部分没有生成。请在软件里点「重试这一部分」，不需要重新生成整份报告。`
}

const isAdvice = (title: string): boolean => /学习进步建议|备课建议/.test(title)
const isMethods = (title: string): boolean => /做题方法/.test(title)

/** 把主文切成「开头（第一个 ## 之前）」和若干 ## 小节 */
export function splitSections(main: string): { head: string; sections: Array<{ title: string; text: string }> } {
  const lines = main.replace(/\r\n/g, '\n').split('\n')
  const idx: number[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (!fence && /^##\s+\S/.test(l)) idx.push(i)
  })
  if (idx.length === 0) return { head: main.replace(/\s+$/, ''), sections: [] }
  const head = lines.slice(0, idx[0]).join('\n').replace(/\s+$/, '')
  const sections = idx.map((a, k) => ({ title: lines[a].replace(/^##\s+/, '').trim(), text: lines.slice(a, idx[k + 1] ?? lines.length).join('\n').replace(/\s+$/, '') }))
  return { head, sections }
}

/**
 * 主文 + 各段 → 最终 Markdown。纯函数。
 * @param parts 各段的状态与正文（没出现在这里的段 = 这次没安排，不占位）
 */
export function assembleReport(main: string, parts: PartText[], metas: PartMeta[]): string {
  const meta = new Map(metas.map(m => [m.id, m]))
  const { head, sections } = splitSections(main)
  const adviceAt = sections.findIndex(s => isAdvice(s.title))
  const methodsAt = sections.findIndex(s => isMethods(s.title))
  const hasAdvice = adviceAt >= 0
  const hasMethods = methodsAt >= 0

  const blocks: Record<Placement, string[]> = { after_head: [], after_methods: [], before_advice: [], tail: [] }
  const ordered = parts
    .filter(p => meta.has(p.id) && p.status !== 'skipped')
    .sort((a, b) => meta.get(a.id)!.order - meta.get(b.id)!.order)
  for (const p of ordered) {
    const m = meta.get(p.id)!
    let at: Placement = m.placement
    if (at === 'after_methods' && !hasMethods) at = 'before_advice'
    if (at === 'before_advice' && !hasAdvice) at = 'tail'
    const text = p.status === 'ok' && p.markdown.trim() ? p.markdown.trim() : placeholderFor(m.label, p.status)
    blocks[at].push(text)
  }

  const out: string[] = [head]
  if (blocks.after_head.length) out.push(blocks.after_head.join('\n\n'))
  sections.forEach((s, i) => {
    if (i === adviceAt && blocks.before_advice.length) out.push(blocks.before_advice.join('\n\n'))
    out.push(s.text)
    if (i === methodsAt && blocks.after_methods.length) out.push(blocks.after_methods.join('\n\n'))
  })
  if (blocks.tail.length) out.push(blocks.tail.join('\n\n'))
  return out.filter(x => x && x.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}
