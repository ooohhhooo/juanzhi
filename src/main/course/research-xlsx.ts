/**
 * 教研对照表 → Excel（用仓库已有的 xlsx 写法 buildXlsx，不加依赖）。
 * 工作表：「对照表」（一节课多行时合并课程列 / 课件列 / 修订建议列，自动换行，冻结首行）、「只有A只有B」（选了 B 才有）、「教材有机构没讲」、「说明」。
 * 不含任何学员个人信息：里面只有课程大纲、教材目录、试卷题目和统计数字。
 */
import { MAX_AI_LESSONS } from './research-ai.ts'
import { buildXlsx } from '../analysis/report/export-xlsx.ts'
import type { XCell, XRow, XSheet } from '../analysis/report/export-xlsx.ts'
import { formatLoc, formatLocs, locItem } from '../../shared/tb-loc.ts'
import { ADVICE_LABEL, adviceCell } from './research-table.ts'
import type { ExampleQ, RKp, RLesson, ResearchTable, TbLoc, UnitRef } from './research-table.ts'

const HEAD: XCell['s'] = { bold: true, fill: 'E4E3F8', border: true, wrap: true }
const BODY: XCell['s'] = { border: true, wrap: true }
const LESSON_FILL: XCell['s'] = { border: true, wrap: true, fill: 'F4F4FB' }
const ADVICE_FILL: XCell['s'] = { border: true, wrap: true, fill: 'FFF8E1' }

export const lessonTitleOf = (l: Pick<RLesson, 'levelName' | 'label'>): string => `${l.levelName} ${l.label}`
export const locText = (l: TbLoc): string => formatLoc(l)
/** 校内约占几分（每份卷子平均，题目分值按主知识点算）+ 几份卷子考过 */
export const schoolCell = (k: RKp, hasScores = true): string => k.papers === 0 ? '范围内没有考到' : `${hasScores && k.avgScore > 0 ? `校内约占 ${k.avgScore} 分 · ` : ''}${k.papers}/${k.paperTotal} 份卷子考过 · 共 ${k.questions} 题${k.frequent ? ' · 常考' : ''}${k.errorCount ? ` · 易错 ${k.errorCount} 题` : ''}`
/** 匹配把握：老师看得懂的文字，括号里保留 0–100 的分数；下面一行是依据 */
export const matchCell = (k: RKp): string => `${k.matchLabel}（${k.matchScore}）${k.evidence ? `\n${k.evidence}` : ''}`
/** 这节课对应的教材单元：每行一个，写明很像 / 有点像和依据；只是按目录概括的单元标「按目录」 */
export const unitsCell = (l: RLesson, hasBooks: boolean): string => !hasBooks ? '' : l.units.length ? l.units.map((u: UnitRef) => `${u.edition}  ${locItem(u)}（${u.similarity}（${u.score}）${u.byCatalog ? '，按目录' : ''}${u.byBook ? '，课本原文' : ''}）\n  依据：${u.evidence}`).join('\n') : '没有找到足够像的单元'
export function exampleText(e: ExampleQ, i: number): string {
  const stem = e.stem.replace(/\s+/g, ' ').trim().slice(0, 300)
  const opts = e.options.map(o => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean)
  return [`${i + 1}.《${e.paperTitle}》第 ${e.no} 题${e.errorProne ? '【易错】' : ''}`, stem, ...opts, e.answer ? `答案：${e.answer}` : '', e.why ? `（挂在这节课下的原因：${e.why}）` : ''].filter(Boolean).join('\n')
}
export const examplesCell = (k: RKp): string => k.examples.length ? k.examples.map(exampleText).join('\n\n') : ''
export const tbCell = (k: RKp, hasBooks: boolean): string => !hasBooks ? '' : k.locs.length ? formatLocs(k.locs) : '教材里没有找到'
export const bCell = (k: RKp): string => k.bLessons.length ? k.bLessons.map(b => `${b.levelName} ${b.label}${b.coarse ? ' · 较粗' : ''}`).join('\n') : '（B 里没讲）'

/** 估算一格要几行（CJK 算 2 个宽度） */
const visualLen = (s: string): number => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
const linesOf = (text: string, width: number): number => text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(visualLen(ln) / Math.max(8, width - 1))), 0)
const heightOf = (lines: number): number => Math.min(409, Math.max(18, lines * 15 + 4))

export interface ResearchXlsxMeta { filterDesc: string; generatedAt: string; /** 范围里把「待审核（AI 结果未确认）」的卷子也算进来了 */ includeReviewing?: boolean }

/** 试卷范围的说法：按筛选里有没有包含待审核的卷子写 */
export const papersScopeText = (includeReviewing?: boolean): string => includeReviewing ? '含老师已审核和待审核（AI 结果未确认）的试卷' : '只含老师已审核的试卷'

export function researchSheetRows(t: ResearchTable): { header: string[]; widths: number[]; rows: XRow[]; merges: string[]; flat: string[][] } {
  const hasB = !!t.courseB, hasBooks = t.textbooks.length > 0
  const header = ['课', '课件', '知识点大类', '知识点', '匹配把握', ...(hasBooks ? ['教材位置'] : []), '校内约占几分', '校内例题', ...(hasB ? [`「${t.courseB!.name}」里对应的课`] : []), '修订建议']
  const widths = [24, 18, 14, 18, 26, ...(hasBooks ? [40] : []), 24, 62, ...(hasB ? [24] : []), 56]
  const adviceCol = header.length - 1
  const unitsCol = hasBooks ? 5 : -1
  const mergedCols = [0, 1, ...(hasBooks ? [unitsCol] : []), adviceCol]
  const rows: XRow[] = [{ cells: header.map(h => ({ v: h, s: HEAD })), ht: 22 }]
  const merges: string[] = []
  const flat: string[][] = []
  const col = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }
  for (const l of t.lessons) {
    const start = rows.length
    const title = `${lessonTitleOf(l)}${l.title && !l.label.includes(l.title) ? `\n${l.title}` : ''}`
    const cw = l.courseware.length ? l.courseware.map(c => c.name).join('\n') : '（没挂课件）'
    const adv = adviceCell(l)
    const units = unitsCell(l, hasBooks)
    const kps = l.kps
    const n = Math.max(1, kps.length)
    const kpRowsText = kps.length ? kps : [null]
    const rowHeights: number[] = []
    kpRowsText.forEach((k, i) => {
      const cells: XCell[] = [
        { v: i === 0 ? title : '', s: LESSON_FILL }, { v: i === 0 ? cw : '', s: LESSON_FILL },
        { v: k ? k.group : '（这节课没有对应的知识点）', s: BODY }, { v: k ? k.name : '', s: BODY }, { v: k ? matchCell(k) : '', s: BODY },
        ...(hasBooks ? [{ v: i === 0 ? units : '', s: BODY }] : []),
        { v: k ? schoolCell(k, t.hasScores) : '', s: BODY }, { v: k ? examplesCell(k) : '', s: BODY },
        ...(hasB ? [{ v: k ? bCell(k) : '', s: BODY }] : []),
        { v: i === 0 ? adv : '', s: ADVICE_FILL }
      ]
      let ln = 1
      cells.forEach((c, ci) => { if (!mergedCols.includes(ci) && c.v) ln = Math.max(ln, linesOf(String(c.v), widths[ci])) })
      rowHeights.push(heightOf(ln))
      rows.push({ cells, ht: rowHeights[i] })
      flat.push([lessonTitleOf(l), l.courseware.map(c => c.name).join('、'), k?.group ?? '', k?.name ?? '', k ? matchCell(k).replace(/\n/g, '；') : '', ...(hasBooks ? [i === 0 ? units.replace(/\n/g, '；') : ''] : []), k ? schoolCell(k, t.hasScores) : '', k ? examplesCell(k) : '', ...(hasB ? [k ? bCell(k).replace(/\n/g, '；') : ''] : []), i === 0 ? adv : ''])
    })
    // 合并的格子（课 / 课件 / 教材位置 / 修订建议）要够高：不够就把最后一行撑高
    const need = Math.max(linesOf(title, widths[0]), linesOf(cw, widths[1]), linesOf(adv, widths[adviceCol]), hasBooks ? linesOf(units, widths[unitsCol]) : 1)
    const have = rowHeights.reduce((s, h) => s + h, 0)
    if (heightOf(need) > have) rows[rows.length - 1].ht = Math.min(409, rowHeights[rowHeights.length - 1] + (heightOf(need) - have))
    if (n > 1) for (const c of mergedCols) merges.push(`${col(c)}${start + 1}:${col(c)}${start + n}`)
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
  const adviceLessons = t.lessons.filter(l => l.advice.length > 0).length, aiLessons = t.lessons.filter(l => l.aiAdvice).length
  const info: string[][] = [
    ['数据范围', meta.filterDesc || '全部试卷'],
    ['试卷份数', `${t.papers} 份（${papersScopeText(meta.includeReviewing)}）`],
    ...(aiLessons > 0 && aiLessons < adviceLessons ? [['AI 小结范围', `只有 ${aiLessons}/${adviceLessons} 节有建议的课写了 AI 小结，其余只有规则结论（AI 小结一次最多写 ${MAX_AI_LESSONS} 节，或中途取消、个别节没写成）`]] : []),
    ['机构大纲 A', t.course?.name ?? ''],
    ...(t.courseB ? [['机构大纲 B', t.courseB.name]] : []),
    ['学校教材', t.textbooks.map(b => b.name).join('、') || '（没选）'],
    ['每节课的例题数', `最多 ${t.perKp} 道`],
    ...(t.weakCount > 0 ? [['未列出的匹配', `另有 ${t.weakCount} 条把握不高，没列入对照（界面里点开可以看）`]] : []),
    ['生成时间', meta.generatedAt],
    ['', ''],
    ['列含义', ''],
    ['课', '机构大纲 A 的一节课（级别 / 编号 / 标题）'],
    ['课件', '这一节挂的课件文件名（只在本机读取文字）'],
    ['知识点大类 / 知识点', '这节课主要讲的知识点（每节课最多 3 个），按「校内重要度 × 匹配把握」从高到低排；把握不高的没有列出'],
    ['匹配把握', '很像 / 比较像，括号里是 0–100 的匹配分（程序算：标志词命中越强越多分越高，教材对标对得上加分，老师确认 100）；下面一行是依据：命中的词、课里的原文或对标的教材单元'],
    ['教材位置', '程序拿这节课的话题、词汇、句型、知识点和教材每个单元直接比，每个版本只给最像的 1–2 个单元并写依据；「按目录」= 教材目录只有概括，没有逐课核对，仅供参考'],
    ['校内约占几分', '范围内每份卷子平均有多少分考这个知识点（题目分值按主知识点算）、几份卷子考过；「常考」= 在不少于一定份数的卷子里出现；易错是 AI 估计、老师审核过的'],
    ['校内例题', '这节课最相关的几道校内原题：题里有课上的词 / 句型，或者题目的知识点和这节课对得上；每道写明为什么挂在这里'],
    ...(t.courseB ? [['B 里对应的课', '机构大纲 B 里讲到同一个知识点的课']] : []),
    ['修订建议', '要补 / 要对齐 / 换例题 / 可减或超前，每条都写着依据（程序算出来的数字和位置）；「小结」是 AI 根据这些依据写的，供参考'],
    ['', ''],
    ['注意', '知识点对应由程序按标志词先认、AI 只补充认不出来的课（内置教材的对应来自目录），请教研核对后再改课件。本表不含任何学员个人信息。']
  ]
  sheets.push({ name: '说明', widths: [24, 90], rows: info.map(([k, v], i) => ({ cells: [{ v: k, s: { bold: true, wrap: true } }, { v, s: { wrap: true } }], ht: i === 0 ? undefined : heightOf(linesOf(v, 90)) })) })
  return buildXlsx(sheets)
}

export { ADVICE_LABEL }
