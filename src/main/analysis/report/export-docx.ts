/**
 * Word 简版汇报：把看板规格转成 Markdown，再交给现有的 buildDocx（report/docx.ts）。
 * 标题、核心发现、每章的解读 + 表格（图表输出为它的数据表，主进程没有可靠的 SVG→PNG 渲染，不嵌图）、口径说明。
 */
import { buildDocx } from '../../report/docx.ts'
import { chartToTable, formatCell, type Block, type BoardSpec, type Cell, type Column } from './spec.ts'

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\r?\n/g, ' ')

function mdTable(columns: Column[], rows: Array<Record<string, Cell>>): string {
  const head = `| ${columns.map(c => cell(c.label)).join(' | ')} |`
  const sep = `| ${columns.map(c => (c.format && c.format !== 'text' ? '---:' : '---')).join(' | ')} |`
  const body = rows.map(r => `| ${columns.map(c => cell(formatCell(r[c.key], c.format))).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function blockMd(b: Block): string {
  switch (b.type) {
    case 'chart': {
      const t = chartToTable(b.chart)
      return `**${b.chart.title}**\n\n${mdTable(t.columns, t.rows)}${b.chart.notes ? `\n\n${b.chart.notes}` : ''}`
    }
    case 'table': return `${b.title ? `**${b.title}**\n\n` : ''}${mdTable(b.columns, b.rows)}`
    case 'text': return b.markdown
    case 'kpi': return b.items.map(k => `- ${k.label}：**${k.value}**${k.delta ? `（${k.delta}）` : ''}`).join('\n')
  }
}

export function boardToMarkdown(spec: BoardSpec): string {
  const out: string[] = []
  if (spec.subtitle) out.push(spec.subtitle)
  if (spec.dataNote) out.push(`数据范围：${spec.dataNote}`)
  if (spec.findings.length) {
    out.push('## 核心发现')
    spec.findings.forEach((f, i) => out.push(`${i + 1}. **${f.title}**　${f.body}`))
  }
  for (const s of spec.sections) {
    out.push(`## ${s.title}`)
    if (s.intro) out.push(s.intro)
    for (const b of s.blocks) out.push(blockMd(b))
  }
  if (spec.caliber.length) {
    out.push('## 口径说明')
    spec.caliber.forEach((c, i) => out.push(`${i + 1}. ${c}`))
  }
  return out.join('\n\n')
}

export async function exportBoardDocx(spec: BoardSpec): Promise<Buffer> {
  return buildDocx({ title: spec.title, markdown: boardToMarkdown(spec), footer: '由卷知生成' })
}
