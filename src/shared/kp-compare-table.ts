/** 知识点对比表的纯函数（主进程、界面、助手共用，不依赖 electron / React） */
import type { KpCompareResult } from '../main/stats/kp-compare.ts'

/** 一个考点被几份卷子考到的分类：每份都考 / 只有一份 / 其它（界面和导出共用同一套说法） */
export function overlapKind(papersHit: number, papersTotal: number): 'all' | 'one' | 'some' | 'none' {
  if (papersHit === 0) return 'none'
  if (papersTotal > 1 && papersHit === papersTotal) return 'all'
  if (papersHit === 1 && papersTotal > 1) return 'one'
  return 'some'
}
export const OVERLAP_LABEL = { all: '都考了', one: '只有一份考', some: '部分考', none: '都没考' } as const

type Cellv = string | number | null
/** 对比表 → 通用表格（给 xlsx 导出；也是单测的对象）。每份卷子一列，格子里写「题数 / 分值 / 易错」 */
export function compareToTable(r: KpCompareResult): { columns: Array<{ key: string; label: string; format?: 'text' | 'number' | 'score' }>; rows: Array<Record<string, Cellv>> } {
  const columns: Array<{ key: string; label: string; format?: 'text' | 'number' | 'score' }> = [{ key: 'group', label: '大类' }, { key: 'kp', label: '知识点' }, { key: 'hit', label: '几份卷子考了', format: 'number' }, { key: 'kind', label: '情况' }]
  r.papers.forEach((p, i) => columns.push({ key: `p${i}`, label: `${p.title}（题数 / 分值）` }))
  const cell = new Map(r.cells.map(c => [`${c.paper}|${c.kp}`, c]))
  const rows = r.kps.map(k => {
    const row: Record<string, Cellv> = { group: k.group, kp: k.name, hit: k.papers, kind: OVERLAP_LABEL[overlapKind(k.papers, r.papers.length)] }
    r.papers.forEach((p, i) => {
      const c = cell.get(`${p.id}|${k.code}`)
      row[`p${i}`] = c ? `${c.questions} 题${c.scored > 0 ? ` / ${c.score} 分` : ''}${c.errors > 0 ? ' / 易错' : ''}` : ''
    })
    return row
  })
  return { columns, rows }
}
