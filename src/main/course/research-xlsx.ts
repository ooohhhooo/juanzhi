/**
 * 教研对照表 → Excel（用仓库已有的 xlsx 写法 buildXlsx，不加依赖）。
 * 工作表：「对照表」（一节课多行时合并课程列 / 课件列 / 修订建议列，自动换行，冻结首行）、「只有A只有B」（选了 B 才有）、「教材有机构没讲」、「说明」。
 * 不含任何学员个人信息：里面只有课程大纲、教材目录、试卷题目和统计数字。
 */
import { buildXlsx } from '../analysis/report/export-xlsx.ts'
import type { XCell, XRow, XSheet } from '../analysis/report/export-xlsx.ts'
import { ADVICE_LABEL, adviceCell } from './research-table.ts'
import type { ExampleQ, RKp, RLesson, ResearchTable, TbLoc } from './research-table.ts'

const HEAD: XCell['s'] = { bold: true, fill: 'E4E3F8', border: true, wrap: true }
const BODY: XCell['s'] = { border: true, wrap: true }
const LESSON_FILL: XCell['s'] = { border: true, wrap: true, fill: 'F4F4FB' }
const ADVICE_FILL: XCell['s'] = { border: true, wrap: true, fill: 'FFF8E1' }

export const lessonTitleOf = (l: Pick<RLesson, 'levelName' | 'label'>): string => `${l.levelName} ${l.label}`
export const locText = (l: TbLoc): string => `${l.outlineName === l.levelName ? '' : `${l.outlineName}：`}${l.levelName} ${l.label}${l.pages ? `（${l.pages}）` : ''}${l.coarse ? ' · 较粗' : ''}`.replace(/\s+/g, ' ').trim()
export const schoolCell = (k: RKp): string => k.papers === 0 ? '范围内没有考到' : `${k.questions} 题 · ${k.papers}/${k.paperTotal} 份卷子${k.frequent ? ' · 常考' : ''}${k.errorCount ? ` · 易错 ${k.errorCount} 题` : ''}`
export function exampleText(e: ExampleQ, i: number): string {
  const stem = e.stem.replace(/\s+/g, ' ').trim().slice(0, 300)
  const opts = e.options.map(o => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean)
  return [`${i + 1}.《${e.paperTitle}》第 ${e.no} 题${e.errorProne ? '【易错】' : ''}`, stem, ...opts, e.answer ? `答案：${e.answer}` : ''].filter(Boolean).join('\n')
}
export const examplesCell = (k: RKp): string => k.examples.length ? k.examples.map(exampleText).join('\n\n') : '（范围内没有这个知识点的题）'
export const tbCell = (k: RKp, hasBooks: boolean): string => !hasBooks ? '' : k.locs.length ? k.locs.map(locText).join('\n') : '教材里没有找到'
export const bCell = (k: RKp): string => k.bLessons.length ? k.bLessons.map(b => `${b.levelName} ${b.label}${b.coarse ? ' · 较粗' : ''}`).join('\n') : '（B 里没讲）'

/** 估算一格要几行（CJK 算 2 个宽度） */
const visualLen = (s: string): number => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
const linesOf = (text: string, width: number): number => text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(visualLen(ln) / Math.max(8, width - 1))), 0)
const heightOf = (lines: number): number => Math.min(409, Math.max(18, lines * 15 + 4))

export interface ResearchXlsxMeta { filterDesc: string; generatedAt: string }

export function researchSheetRows(t: ResearchTable): { header: string[]; widths: number[]; rows: XRow[]; merges: string[]; flat: string[][] } {
  const hasB = !!t.courseB, hasBooks = t.textbooks.length > 0
  const header = ['课', '课件', '知识点大类', '知识点', ...(hasBooks ? ['教材位置'] : []), '校内试卷考察', '校内例题', ...(hasB ? [`「${t.courseB!.name}」里对应的课`] : []), '修订建议']
  const widths = [24, 18, 14, 18, ...(hasBooks ? [34] : []), 22, 62, ...(hasB ? [24] : []), 56]
  const adviceCol = header.length - 1
  const rows: XRow[] = [{ cells: header.map(h => ({ v: h, s: HEAD })), ht: 22 }]
  const merges: string[] = []
  const flat: string[][] = []
  const col = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }
  for (const l of t.lessons) {
    const start = rows.length
    const title = `${lessonTitleOf(l)}${l.title && !l.label.includes(l.title) ? `\n${l.title}` : ''}`
    const cw = l.courseware.length ? l.courseware.map(c => c.name).join('\n') : '（没挂课件）'
    const adv = adviceCell(l)
    const kps = l.kps
    const n = Math.max(1, kps.length)
    const kpRowsText = kps.length ? kps : [null]
    const rowHeights: number[] = []
    kpRowsText.forEach((k, i) => {
      const cells: XCell[] = [
        { v: i === 0 ? title : '', s: LESSON_FILL }, { v: i === 0 ? cw : '', s: LESSON_FILL },
        { v: k ? k.group : '（这节课没有对应的知识点）', s: BODY }, { v: k ? k.name : '', s: BODY },
        ...(hasBooks ? [{ v: k ? tbCell(k, hasBooks) : '', s: BODY }] : []),
        { v: k ? schoolCell(k) : '', s: BODY }, { v: k ? examplesCell(k) : '', s: BODY },
        ...(hasB ? [{ v: k ? bCell(k) : '', s: BODY }] : []),
        { v: i === 0 ? adv : '', s: ADVICE_FILL }
      ]
      let ln = 1
      cells.forEach((c, ci) => { if (ci !== 0 && ci !== 1 && ci !== adviceCol && c.v) ln = Math.max(ln, linesOf(String(c.v), widths[ci])) })
      rowHeights.push(heightOf(ln))
      rows.push({ cells, ht: rowHeights[i] })
      flat.push([lessonTitleOf(l), l.courseware.map(c => c.name).join('、'), k?.group ?? '', k?.name ?? '', ...(hasBooks ? [k ? tbCell(k, hasBooks).replace(/\n/g, '；') : ''] : []), k ? schoolCell(k) : '', k ? examplesCell(k) : '', ...(hasB ? [k ? bCell(k).replace(/\n/g, '；') : ''] : []), i === 0 ? adv : ''])
    })
    // 合并的格子（课 / 课件 / 修订建议）要够高：不够就把最后一行撑高
    const need = Math.max(linesOf(title, widths[0]), linesOf(cw, widths[1]), linesOf(adv, widths[adviceCol]))
    const have = rowHeights.reduce((s, h) => s + h, 0)
    if (heightOf(need) > have) rows[rows.length - 1].ht = Math.min(409, rowHeights[rowHeights.length - 1] + (heightOf(need) - have))
    if (n > 1) for (const c of [0, 1, adviceCol]) merges.push(`${col(c)}${start + 1}:${col(c)}${start + n}`)
  }
  return { header, widths, rows, merges, flat }
}

const table = (name: string, header: string[], widths: number[], body: string[][]): XSheet => ({
  name, freeze: true, widths,
  rows: [{ cells: header.map(h => ({ v: h, s: HEAD })), ht: 22 }, ...body.map(r => ({ cells: r.map(v => ({ v, s: BODY })), ht: heightOf(Math.max(...r.map((v, i) => linesOf(v, widths[i] ?? 20)))) }))]
})

export async function researchXlsx(t: ResearchTable, meta: ResearchXlsxMeta): Promise<Buffer> {
  const main = researchSheetRows(t)
  const sheets: XSheet[] = [{ name: '对照表', rows: main.rows, widths: main.widths, merges: main.merges, freeze: true }]
  if (t.courseB) {
    const a = t.course!.name, b = t.courseB.name
    sheets.push(table('只有A、只有B', ['类型', '知识点大类', '知识点', '在哪几节课', '校内考过'], [18, 14, 20, 40, 22],
      [...t.onlyA.map(r => [`只有「${a}」讲`, r.group, r.name, r.lessons.join('；'), r.papers ? `${r.papers}/${r.paperTotal} 份卷子` : '范围内没有考到']),
        ...t.onlyB.map(r => [`只有「${b}」讲`, r.group, r.name, r.lessons.join('；'), r.papers ? `${r.papers}/${r.paperTotal} 份卷子` : '范围内没有考到'])]))
  }
  if (t.textbooks.length) {
    sheets.push(table('教材有机构没讲', ['知识点大类', '知识点', '教材位置', '校内考过', '常考', '易错题数'], [14, 22, 44, 18, 8, 10],
      t.tbNotInA.map(r => [r.group, r.name, r.units.join('；'), r.papers ? `${r.papers}/${r.paperTotal} 份卷子` : '范围内没有考到', r.frequent ? '是' : '', r.errorCount ? String(r.errorCount) : ''])))
  }
  const info: string[][] = [
    ['数据范围', meta.filterDesc || '全部试卷'],
    ['试卷份数', `${t.papers} 份（只含老师已审核的试卷）`],
    ['机构大纲 A', t.course?.name ?? ''],
    ...(t.courseB ? [['机构大纲 B', t.courseB.name]] : []),
    ['学校教材', t.textbooks.map(b => b.name).join('、') || '（没选）'],
    ['每个知识点的例题数', `最多 ${t.perKp} 道`],
    ['生成时间', meta.generatedAt],
    ['', ''],
    ['列含义', ''],
    ['课', '机构大纲 A 的一节课（级别 / 编号 / 标题）'],
    ['课件', '这一节挂的课件文件名（只在本机读取文字）'],
    ['知识点大类 / 知识点', '这节课对应的知识点，只含高 / 中把握和老师确认过的对应，否决的不算；大类是知识点树的顶层'],
    ['教材位置', '知识点在所选教材的哪一册哪个单元（上传的教材带页码范围）；「较粗」= 只有更大的类别对得上'],
    ['校内试卷考察', '范围内考到这个知识点的题数、几份卷子考过；「常考」= 在不少于一定份数的卷子里出现；易错是 AI 估计、老师审核过的'],
    ['校内例题', '范围内考到这个知识点的原题（易错的优先，尽量来自不同卷子），含卷名、题号、题干、选项、答案'],
    ...(t.courseB ? [['B 里对应的课', '机构大纲 B 里讲到同一个知识点的课']] : []),
    ['修订建议', '要补 / 要对齐 / 换例题 / 可减或超前，每条都写着依据（程序算出来的数字和位置）；「小结」是 AI 根据这些依据写的，供参考'],
    ['', ''],
    ['注意', '知识点对应是 AI 匹配的结果（内置教材的对应来自目录），请教研核对后再改课件。本表不含任何学员个人信息。']
  ]
  sheets.push({ name: '说明', widths: [24, 90], rows: info.map(([k, v], i) => ({ cells: [{ v: k, s: { bold: true, wrap: true } }, { v, s: { wrap: true } }], ht: i === 0 ? undefined : heightOf(linesOf(v, 90)) })) })
  return buildXlsx(sheets)
}

export { ADVICE_LABEL }
