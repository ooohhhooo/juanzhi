/** 双向细目表导出 CSV。纯函数。带 BOM（Excel 直接打开不乱码）、CRLF；文本单元格防公式注入（= + - @ 开头会被 Excel 当公式执行）。 */
import type { MatrixResult } from './core.ts'

const BOM = '\uFEFF'
const needsPrefix = /^[=+\-@\t\r]/
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (typeof v === 'string' && needsPrefix.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** @param note 筛选条件的文字描述；文件一旦被转发，数字不能脱离口径，所以表后附一段说明 */
export function matrixToCsv(m: MatrixResult, note?: string): string {
  const header = ['知识点代码', '知识点', ...m.cols.flatMap(c => [`${c.name} 题数`, `${c.name} 分值`, `${c.name} 分值覆盖`]), '合计题数', '合计分值']
  const rows: Array<Array<string | number | null>> = [header]
  for (const r of m.rows) {
    const line: Array<string | number | null> = [r.code, r.path]
    for (const c of m.cols) {
      const cell = m.cells.find(x => x.row === r.code && x.col === c.code)
      if (!cell) { line.push(null, null, null); continue }
      // 分值覆盖 = 有分值的主知识点题数 / 主知识点题数。一个格子里只有部分题有分值时，分值只是那一部分的和——靠这一列看出来；
      // 主知识点题都没有分值 → 分值留空（不写 0，免得被当成「这道题 0 分」）；只作为次知识点出现 → 分值 0、覆盖写「仅次知识点」
      line.push(cell.questions, cell.prim > 0 && cell.scored === 0 ? null : cell.score, cell.prim === 0 ? '仅次知识点' : `${cell.scored}/${cell.prim}`)
    }
    line.push(r.questions, r.score)
    rows.push(line)
  }
  const foot: Array<string | number | null> = ['', '全部题目合计（含未标知识点的题）']
  for (const c of m.cols) foot.push(c.allQuestions, c.allScore, `${c.allScored}/${c.allQuestions}`)
  foot.push(m.cols.reduce((s, c) => s + c.allQuestions, 0), m.cols.reduce((s, c) => s + c.allScore, 0))
  rows.push(foot)
  const meta: Array<Array<string | number | null>> = [
    [], ['说明', `筛选范围：${note ?? '（未提供）'}`],
    ['', `计入试卷 ${m.papers} 份；分值覆盖 ${m.coverage.scored}/${m.coverage.questions} 题（分值为空的题不进分值统计）`],
    ['', '行 = 知识点（向上汇总）；一道题标了多个知识点会在多行各计一次题数，分值只在主知识点所在行计；表尾才是全卷真实合计。']
  ]
  return BOM + [...rows, ...meta].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
