import { ipcMain, nativeImage } from 'electron'
import { z } from 'zod'
import { getDataDir } from '../db'
import { findTemplate, listTemplates, prepareData, readCardSettings, writeCardSettings } from '../cards/templates'
import { renderCardPng } from '../cards/render'
import type { CardKind } from '../cards/schema'

const IdSchema = z.string().regex(/^[a-z]\d{2}$/)

/** 设置页预览用的示例内容（虚构的，不含任何真实信息） */
const SAMPLE: Record<'student' | 'parent', { kind: CardKind; data: Record<string, any> }> = {
  student: {
    kind: 'knowledge',
    data: {
      title: '不规则动词过去式', hook: '说昨天的事，动词要「变身」！',
      items: [{ left: 'go', right: 'went' }, { left: 'see', right: 'saw' }, { left: 'eat', right: 'ate' }, { left: 'have', right: 'had' }],
      example: { en: 'I **went** to the park yesterday.', zh: '我昨天去了公园。' }, warning: '小心！不是 goed，也不是 eated', signature: '小雨的英语小卡', date: '11 月 3 日'
    }
  },
  parent: {
    kind: 'weekly',
    data: {
      student: '小雨', grade: '四年级', week: '11 月第 1 周',
      metrics: [{ value: '4/4', label: '按时到课' }, { value: '86%', label: '课后练习正确率' }, { value: '+12%', label: '比上周' }],
      learned: '一般过去时：说昨天的事，动词要变成过去式。', good: '课堂上主动回答问题，规则动词加 -ed 基本不出错。', improve: '不规则动词（go→went、eat→ate）偶尔还会写错。',
      tips: '每天 5 分钟，请孩子用英语说一件昨天做的事。', teacher: '辅导老师 林老师', date: '11 月 3 日'
    }
  }
}

const cache = new Map<string, Buffer>()

let chain: Promise<unknown> = Promise.resolve()
/** 一次只渲染一张（每张开一个隐藏窗口，同时开十几个太占内存） */
function samplePng(id: string): Promise<Buffer> {
  const p = chain.then(() => samplePngNow(id))
  chain = p.catch(() => undefined)
  return p
}
async function samplePngNow(id: string): Promise<Buffer> {
  const t = findTemplate(id)
  if (!t) throw new Error('没有这个模板')
  const key = id + ':' + (t.style.accent)
  const hit = cache.get(key)
  if (hit) return hit
  const s = SAMPLE[t.audience]
  const r = await renderCardPng(t, s.kind, prepareData(s.kind, s.data))
  cache.set(key, r.png)
  return r.png
}

export function registerCardsIpc(): void {
  ipcMain.handle('cards:templates', async () => ({
    student: listTemplates('student').map(t => ({ id: t.id, name: t.name, scene: t.scene, accent: t.style.accent })),
    parent: listTemplates('parent').map(t => ({ id: t.id, name: t.name, scene: t.scene, accent: t.style.accent })),
    settings: readCardSettings(getDataDir())
  }))
  /** 示例预览（实时渲染，内存里缓存）：thumb = 小图 JPEG，否则大图 JPEG；返回 data: 地址 */
  ipcMain.handle('cards:preview', async (_e, rawId: unknown, rawThumb: unknown) => {
    const id = IdSchema.parse(rawId)
    const png = await samplePng(id)
    const img = nativeImage.createFromBuffer(png)
    const out = rawThumb ? img.resize({ width: 270, quality: 'good' }) : img
    return 'data:image/jpeg;base64,' + out.toJPEG(rawThumb ? 80 : 88).toString('base64')
  })
  ipcMain.handle('cards:setDefault', async (_e, rawAudience: unknown, rawId: unknown) => {
    const audience = z.enum(['student', 'parent']).parse(rawAudience)
    return writeCardSettings(getDataDir(), { defaults: { [audience]: IdSchema.parse(rawId) } })
  })
  ipcMain.handle('cards:setChildName', async (_e, raw: unknown) => writeCardSettings(getDataDir(), { childName: z.enum(['first', 'none']).parse(raw) }))
}
