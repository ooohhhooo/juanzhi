/**
 * 教材位置的短写法（界面和 Excel 共用）：按版本分组、一行一个单元。
 *   人教PEP  三上 U2 Different families
 *            四上 U1 Helping at home
 * 版本名只写一次；册写成「三上 / 四下」；单元写「U2 标题」；上传教材带页码「p.12–18」；较粗的标「（较粗）」。
 * 同一版本超过 4 个单元时只显示前 4 个，再加「等 N 处」。
 */
export interface LocLike { edition?: string; outlineName: string; levelName: string; label: string; title: string; pages: string; coarse: boolean }
export const MAX_UNITS_PER_EDITION = 4

const GRADE = '一二三四五六七八九'
/** 「三年级上册」→「三上」，「六年级全一册」→「六全」；认不出来就原样 */
export function shortLevel(name: string): string {
  const m = /^([一二三四五六七八九])年级(上|下|全一|全)册?$/.exec(name.trim())
  if (!m || !GRADE.includes(m[1])) return name.trim()
  return `${m[1]}${m[2] === '全一' ? '全' : m[2]}`
}

const UNIT_HEAD = /^(Unit|Module)\s*(\d+)/i
const shortenHead = (t: string): string => t.replace(/\b(Unit|Module)\s*(\d+)/gi, (_m, a: string, n: string) => `${a[0].toUpperCase()}${n}`).replace(/^([MU]\d+)\s*[:：.、]\s*/, '$1 ')

/** 单元短写：标题以 Unit / Module 开头 → 缩成 U2 / M6（不重复编号）；以 Lesson 等其他词开头 → 原标题；否则「U + 编号 + 标题」 */
export function shortUnit(l: Pick<LocLike, 'label' | 'title'>): string {
  const title = (l.title ?? '').replace(/\s+/g, ' ').trim()
  const label = (l.label ?? '').replace(/\s+/g, ' ').trim()
  if (UNIT_HEAD.test(title)) return shortenHead(title)
  if (/^(Lesson|Story|Review|Revision|Recycle|Part|Topic)\b/i.test(title)) return title
  const no = /^第\s*(\d+)\s*(?:单元|课|模块)/.exec(label)?.[1]
  const head = no ? `U${no}` : label.replace(/《.*$/, '').trim()
  return [head, title].filter(Boolean).join(' ')
}

const pageText = (p: string): string => { const m = /(\d+)(?:\s*[–\-—~～]\s*(\d+))?/.exec(p ?? ''); return m ? `p.${m[1]}${m[2] ? `–${m[2]}` : ''}` : '' }

export interface LocGroup { edition: string; items: string[]; more: number }

export function editionOfLoc(l: Pick<LocLike, 'edition' | 'outlineName'>): string { return (l.edition || l.outlineName || '').trim() }

/** 一个单元一行：「三上 U2 Different families p.12–18（较粗）」 */
export function locItem(l: LocLike): string {
  return [shortLevel(l.levelName), shortUnit(l), pageText(l.pages)].filter(Boolean).join(' ') + (l.coarse ? '（较粗）' : '')
}

export function groupLocs(locs: LocLike[], maxPerEdition = MAX_UNITS_PER_EDITION): LocGroup[] {
  const by = new Map<string, string[]>()
  for (const l of locs) {
    const e = editionOfLoc(l), it = locItem(l)
    if (!by.has(e)) by.set(e, [])
    if (!by.get(e)!.includes(it)) by.get(e)!.push(it)
  }
  return [...by].map(([edition, all]) => ({ edition, items: all.slice(0, maxPerEdition), more: Math.max(0, all.length - maxPerEdition) }))
}

/** 纯文本版（Excel 单元格用，换行分隔；版本名后接两个空格，后续行用空格对齐缩进） */
export function formatLocs(locs: LocLike[]): string {
  const lines: string[] = []
  for (const g of groupLocs(locs)) {
    const pad = ' '.repeat(Math.max(2, g.edition.length * 2 + 2))
    g.items.forEach((it, i) => lines.push(`${i === 0 ? `${g.edition}  ` : pad}${it}`))
    if (g.more) lines.push(`${pad}等 ${g.items.length + g.more} 处`)
  }
  return lines.join('\n')
}

/** 单条（建议文字、助手回答里用）：「人教PEP 三上 U2 Different families」 */
export function formatLoc(l: LocLike): string { return `${editionOfLoc(l)} ${locItem(l)}`.trim() }
