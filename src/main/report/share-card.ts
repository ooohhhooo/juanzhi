/**
 * 报告里的卡片出图：走新的分享卡片引擎（src/main/cards），模板默认取「助手设置 → 分享卡片」里的默认学生 / 家长模板。
 * 需要 electron（渲染在隐藏窗口里）。
 */
import { audienceOf, checkFinal, checkRaw, parseCardContent } from '../cards/schema'
import { findTemplate, listTemplates, prepareData, readCardSettings } from '../cards/templates'
import { renderCardPng } from '../cards/render'
import type { Mapped } from './share-card-content'

export function cardTemplateRows(dataDir: string) {
  const s = readCardSettings(dataDir)
  const row = (a: 'student' | 'parent') => listTemplates(a).map(t => ({ id: t.id, name: t.name, scene: t.scene, isDefault: t.id === s.defaults[a] }))
  return { student: row('student'), parent: row('parent') }
}

export async function renderMapped(dataDir: string, m: Mapped, templateId?: string): Promise<{ png: Buffer; width: number; height: number; templateId: string; notes: string[] }> {
  const audience = audienceOf(m.kind)
  const bad = checkRaw(audience, m.content)
  if (bad) throw new Error(bad)
  const parsed = parseCardContent(m.kind, m.content)
  if (!parsed.ok) throw new Error(parsed.error)
  const bad2 = checkFinal(audience, parsed.data)
  if (bad2) throw new Error(bad2)
  const tid = templateId || readCardSettings(dataDir).defaults[audience]
  const t = findTemplate(tid)
  if (!t || t.audience !== audience) throw new Error('没有找到这个卡片模板')
  const r = await renderCardPng(t, m.kind, prepareData(m.kind, parsed.data))
  return { png: r.png, width: r.width, height: r.height, templateId: t.id, notes: [...m.notes, ...parsed.notices] }
}
