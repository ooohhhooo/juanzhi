/**
 * 报告页「加入课程对照」的选择规则（纯函数，渲染端和单测共用）：
 *  · 勾上以后不再默认全选：默认选上次生成报告时用的那份（还在可用列表里才算），没有记录就选最近更新的一份；
 *  · 一份报告最多选 3 份；
 *  · 可用大纲超过 5 份时改成可搜索的多选（按名字、学期搜），5 份以内仍然用对勾。
 * 只有已匹配过（done / partial）的大纲可选。
 */
export const MAX_COURSE_PICK = 3
export const SEARCH_ABOVE = 5
export const MAX_PICK_TEXT = '最多选 3 份'

export interface PickOutline { id: string; name: string; termNote?: string; updatedAt?: string; match?: { state: string } | null }

export const isPickable = (o: PickOutline): boolean => o.match?.state === 'done' || o.match?.state === 'partial'
export const needsSearchSelect = (usable: PickOutline[]): boolean => usable.length > SEARCH_ABOVE

/** 默认选哪一份：上次用过的（还可选的）；没有就是最近更新的一份可选大纲 */
export function defaultCoursePick(usable: PickOutline[], last: string[] = []): string[] {
  const ok = usable.filter(isPickable)
  const prev = last.filter(id => ok.some(o => o.id === id)).slice(0, MAX_COURSE_PICK)
  if (prev.length) return prev
  const newest = [...ok].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
  return newest ? [newest.id] : []
}

/** 搜索：名字或学期里包含关键字（忽略大小写和空格） */
export function searchOutlines<T extends PickOutline>(list: T[], query: string): T[] {
  const q = query.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  if (!q) return list
  return list.filter(o => `${o.name}${o.termNote ?? ''}`.normalize('NFKC').toLowerCase().replace(/\s+/g, '').includes(q))
}

/** 改选：超过上限时保留已选的、不加新的，并给出提示 */
export function nextPick(current: string[], id: string, on: boolean): { ids: string[]; notice?: string } {
  if (!on) return { ids: current.filter(x => x !== id) }
  if (current.includes(id)) return { ids: current }
  if (current.length >= MAX_COURSE_PICK) return { ids: current, notice: MAX_PICK_TEXT }
  return { ids: [...current, id] }
}

/** 多选框一次给出整组：超过上限就截到前 3 个并提示 */
export function clampPick(ids: string[]): { ids: string[]; notice?: string } {
  const uniq = [...new Set(ids)]
  return uniq.length > MAX_COURSE_PICK ? { ids: uniq.slice(0, MAX_COURSE_PICK), notice: MAX_PICK_TEXT } : { ids: uniq }
}

/** 按学期分组（课程大纲页用）：学期说明相同的放一起，没写学期的归「未标学期」，组按最近更新排 */
export function groupByTerm<T extends PickOutline>(list: T[]): Array<{ term: string; items: T[] }> {
  const by = new Map<string, T[]>()
  for (const o of list) { const t = (o.termNote ?? '').trim() || '未标学期'; if (!by.has(t)) by.set(t, []); by.get(t)!.push(o) }
  const newest = (xs: T[]) => xs.reduce((m, o) => (String(o.updatedAt ?? '') > m ? String(o.updatedAt ?? '') : m), '')
  return [...by].map(([term, items]) => ({ term, items })).sort((a, b) => (a.term === '未标学期' ? 1 : b.term === '未标学期' ? -1 : newest(b.items).localeCompare(newest(a.items))))
}
