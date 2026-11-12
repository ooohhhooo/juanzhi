/**
 * 教材桥（纯函数）：机构课程写了「对标教材」（如「人教PEP 四年级上册 Unit 1」「PEP 四上 第1单元」），
 * 并且能和内置教材目录里的某个单元对上（版本 + 年级 + 学期 + 单元号），就沿用该单元的知识点，给匹配加分。
 * 认不出版本、年级、学期或单元号的一律不桥（宁可少，不要错）。目录里没有的版本也不桥。
 */
import type { CatalogEdition } from './textbook-builtin.ts'
import { bookLabel } from './textbook-builtin.ts'

const CN = '一二三四五六七八九'
const ALIASES: Array<[RegExp, (ed: CatalogEdition) => boolean]> = [
  [/人教\s*PEP|PEP|人教版|人教/i, ed => ed.edition === '人教PEP' || ed.edition === '人教版' || ed.textbookValue === '人教PEP' || ed.textbookValue === '人教版'],
  [/外研/, ed => ed.textbookValue === '外研版'],
  [/北师大/, ed => ed.textbookValue === '北师大版'],
  [/译林/, ed => ed.edition.startsWith('译林')],
  [/统编|部编/, ed => ed.edition === '统编版'],
  [/苏教/, ed => ed.textbookValue === '苏教版'],
  [/冀教/, ed => ed.textbookValue === '冀教版'],
  [/沪教/, ed => ed.textbookValue === '沪教版'],
  [/青岛/, ed => ed.textbookValue.startsWith('青岛')]
]

export interface BridgeHit { editionId: string; edition: string; book: string; unitNo: number; unitTitle: string; kps: string[]; label: string }

/** 从对标文字里认出 (年级, 学期, 单元号)；认不全返回 null */
export function parseRef(ref: string): { grade: number; semester: '上' | '下'; unit: number } | null {
  const t = (ref ?? '').replace(/\s+/g, '')
  let grade = 0, sem: '上' | '下' | '' = ''
  const g1 = new RegExp(`([${CN}])年级(上|下)册?`).exec(t)
  const g2 = new RegExp(`([${CN}])(上|下)(?![A-Za-z])`).exec(t)
  const g3 = /(?:grade|G)([1-9])(上|下|book[12])?/i.exec(t)
  if (g1) { grade = CN.indexOf(g1[1]) + 1; sem = g1[2] as '上' | '下' }
  else if (g2) { grade = CN.indexOf(g2[1]) + 1; sem = g2[2] as '上' | '下' }
  else if (g3 && g3[2]) { grade = Number(g3[1]); sem = /下|2/.test(g3[2]) ? '下' : '上' }
  if (!grade || !sem) return null
  const u = /第(\d+)(?:单元|模块)|(?:Unit|Module|U)(\d+)/i.exec(t)
  const unit = Number(u?.[1] ?? u?.[2] ?? 0)
  return unit > 0 ? { grade, semester: sem, unit } : null
}

export function resolveBridge(ref: string, subject: string, catalog: CatalogEdition[]): BridgeHit | null {
  const p = parseRef(ref)
  if (!p) return null
  const names = ALIASES.filter(([re]) => re.test(ref))
  if (!names.length) return null
  for (const ed of catalog) {
    if (ed.subject !== subject || !names.some(([, f]) => f(ed))) continue
    const b = ed.books.find(x => x.grade === p.grade && x.semester === p.semester)
    const u = b?.units.find(x => x.no === p.unit)
    if (b && u && u.kps.length) return { editionId: ed.id, edition: ed.edition, book: bookLabel(b), unitNo: p.unit, unitTitle: u.title, kps: [...u.kps], label: `${ed.edition} ${bookLabel(b)} ${u.no ? `第${u.no}单元` : ''} ${u.title}`.replace(/\s+/g, ' ').trim() }
  }
  return null
}
