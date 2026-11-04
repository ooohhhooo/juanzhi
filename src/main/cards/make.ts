/**
 * 出卡片的完整流程（不依赖 electron；渲染函数可注入，单测用假的）：
 * 检查原始内容（手机号 / 家长卡只能一个孩子）→ 代号还原成真名 → 按 schema 截断 → 孩子称呼规则 → 再检查（手机号 / 排名）→ 渲染 → 存成产出。
 */
import { restoreDeep } from '../agent/names.ts'
import path from 'node:path'
import fs from 'node:fs'
import { getEntry, replaceImage, saveImage, sessionDir } from '../agent/outputs/store.ts'
import type { Scope } from '../agent/outputs/store.ts'
import { applyNamePolicy, audienceOf, checkFinal, checkRaw, KIND_LABEL, parseCardContent } from './schema.ts'
import type { Audience, CardKind } from './schema.ts'
import { findTemplate, listTemplates, prepareData, readCardSettings } from './templates.ts'
import type { CardTemplate } from './templates.ts'

export type CardRenderer = (t: CardTemplate, kind: CardKind, data: Record<string, any>) => Promise<{ png: Buffer; width: number; height: number; scale: number }>
let renderer: CardRenderer | null = null
export function setCardRenderer(fn: CardRenderer | null): void { renderer = fn }
async function render(t: CardTemplate, kind: CardKind, data: Record<string, any>) {
  if (!renderer) {
    // electron 只在真正出图时才加载，单测不用
    const m = await import('./render.ts')
    renderer = m.renderCardPng
  }
  return renderer(t, kind, data)
}

export interface MakeInput { audience: Audience; kind: CardKind; templateId?: string; content: unknown }
export interface MakeResult { ok: true; outputId: string; name: string; path: string; templateId: string; templateName: string; notices: string[]; scale: number }

/** 人看的卡片名，用作产出名和文件名 */
function cardName(kind: CardKind, data: Record<string, any>): string {
  const t = String(data.title ?? '').trim()
  const who = String(data.student ?? '').trim()
  return (t || (who ? `${who}的${KIND_LABEL[kind]}` : KIND_LABEL[kind])).slice(0, 40)
}

export async function makeCard(scope: Scope, input: MakeInput): Promise<MakeResult> {
  const { kind } = input
  const audience = audienceOf(kind)
  if (audience !== input.audience) throw new Error(`版式「${kind}」是给${audience === 'student' ? '学生' : '家长'}的，和 audience=${input.audience} 对不上。学生用 knowledge / mnemonic / practice，家长用 weekly / progress / brief。`)
  const rawBad = checkRaw(audience, input.content)
  if (rawBad) throw new Error(rawBad)

  // 给模型看的是代号，做图时换回真名
  const restored = restoreDeep(scope.sessionId, input.content)
  const parsed = parseCardContent(kind, restored)
  if (!parsed.ok) throw new Error(parsed.error)

  const settings = readCardSettings(scope.dataDir)
  const data = audience === 'parent' ? applyNamePolicy(parsed.data, settings.childName) : parsed.data
  const finalBad = checkFinal(audience, data)
  if (finalBad) throw new Error(finalBad)

  const tid = input.templateId || settings.defaults[audience]
  const t = findTemplate(tid)
  if (!t) throw new Error(`没有编号为「${tid}」的模板。先调用 card_templates 看有哪些。`)
  if (t.audience !== audience) throw new Error(`模板 ${t.id} 是${t.audience === 'student' ? '学生' : '家长'}用的，这张卡是给${audience === 'student' ? '学生' : '家长'}的。`)

  const r = await render(t, kind, prepareData(kind, data))
  const name = cardName(kind, data)
  const e = saveImage(scope, name, r.png, { kind, audience, templateId: t.id, width: r.width, height: r.height })
  // 卡片内容（真名，只在本机）另存一份，给「换模板」重画用；不进 index.json，免得被 outputs_list 发给模型
  try { fs.writeFileSync(contentFile(scope, e.id), JSON.stringify({ kind, data })) } catch { /* 存不下就不能换模板 */ }
  return { ok: true, outputId: e.id, name: e.name, path: path.join(sessionDir(scope), e.file!), templateId: t.id, templateName: t.name, notices: parsed.notices, scale: r.scale }
}

const contentFile = (scope: Scope, id: string) => path.join(sessionDir(scope), 'exports', `${id}.card.json`)

/** 换模板：用同样的内容按另一个模板重画（不经过 AI），原地替换图片 */
export async function rerenderCard(scope: Scope, outputId: string, templateId: string): Promise<{ templateId: string; templateName: string }> {
  const e = getEntry(scope, outputId)
  if (!e || e.type !== 'image' || !e.card) throw new Error('找不到这张卡片')
  let saved: { kind: CardKind; data: Record<string, any> }
  try { saved = JSON.parse(fs.readFileSync(contentFile(scope, outputId), 'utf8')) } catch { throw new Error('这张卡片是旧版本做的，没有保存内容，换不了模板；可以让助手按新模板重做一张') }
  const t = findTemplate(templateId)
  if (!t) throw new Error('没有这个模板')
  if (t.audience !== audienceOf(saved.kind)) throw new Error('这个模板和卡片的对象（学生 / 家长）不一致')
  const r = await render(t, saved.kind, prepareData(saved.kind, saved.data))
  replaceImage(scope, outputId, r.png, { ...e.card, templateId: t.id, width: r.width, height: r.height })
  return { templateId: t.id, templateName: t.name }
}

export function templateRows(audience: Audience, dataDir: string) {
  const def = readCardSettings(dataDir).defaults[audience]
  return listTemplates(audience).map(t => ({ id: t.id, name: t.name, scene: t.scene, isDefault: t.id === def }))
}
