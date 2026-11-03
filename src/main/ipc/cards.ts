import { ipcMain, nativeImage } from 'electron'
import { z } from 'zod'
import { getDataDir } from '../db'
import { findTemplate, listTemplates, prepareData, readCardSettings, writeCardSettings } from '../cards/templates'
import { renderCardPng } from '../cards/render'
import { ALL_KINDS } from '../cards/schema'
import type { CardKind } from '../cards/schema'

const IdSchema = z.string().regex(/^[a-z0-9-]{1,24}$/)

/** 设置页预览用的示例内容（虚构的，不含任何真实信息） */
const WEEKLY = {
  student: '小雨', grade: '四年级', week: '11 月第 1 周',
  metrics: [{ value: '4/4', label: '按时到课' }, { value: '86%', label: '练习正确率' }, { value: '↑12%', label: '比上周' }],
  learned: '一般过去时：说昨天的事，动词要变成过去式。', good: '课上主动举手，规则动词加 -ed 基本不出错。', improve: 'go → went、eat → ate 偶尔会写错，已经安排了 5 道小练习。',
  tips: '每天 5 分钟，请孩子用英语说一件昨天做的事。', teacher: '辅导老师 林老师', date: '11 月 3 日'
}
/** 各版式的示例内容（虚构的，不含任何真实信息）；设置页预览用 knowledge / weekly，其余供测试看版式 */
const SAMPLES: Record<CardKind, Record<string, any>> = {
  knowledge: {
    title: '动词「变身」啦！', hook: '说昨天发生的事，这些词要换个样子',
    items: [{ left: 'go', right: 'went' }, { left: 'see', right: 'saw' }, { left: 'eat', right: 'ate' }, { left: 'have', right: 'had' }],
    example: { en: 'I **went** to the park yesterday.', zh: '我昨天去了公园。' }, warning: 'goed、eated 别写错哦', signature: '小雨的英语小卡', date: '11 月 3 日'
  },
  mnemonic: {
    title: 'some 还是 any？',
    lines: [{ text: '肯定句里用 some', highlight: 'some' }, { text: '否定疑问 any 来', highlight: 'any' }, { text: '请人吃喝客气点' }, { text: 'some 也能用起来', highlight: 'some' }],
    examples: [{ label: '肯定', text: 'I have some apples.' }, { label: '否定', text: "I don't have any milk." }, { label: '邀请', text: 'Would you like some tea?' }], signature: '小雨的口诀卡', date: '11 月 3 日'
  },
  practice: {
    title: '过去式小挑战',
    questions: [{ q: 'I ____ to school yesterday.', options: ['(go)'] }, { q: 'She ____ an apple.', options: ['(eat)'] }, { q: 'We ____ a dog last year.', options: ['A. have', 'B. had'] }],
    encourage: '全对点亮 ★★★ 拍照发给老师', signature: '小雨的小练习', date: '11 月 3 日'
  },
  weekly: WEEKLY,
  progress: {
    student: '小雨', grade: '四年级', period: '11 月',
    items: [{ name: '单词听写', from: '62%', to: '88%', fromPct: 62, toPct: 88 }, { name: '阅读理解', from: '70%', to: '81%', fromPct: 70, toPct: 81 }],
    summary: '这个月小雨每节课都准时来，练习也越做越稳。最让我开心的是，她开始主动举手了：从每节课 1 次，到现在每节课 3 次。',
    next: '下个月我们会学一般过去时，周末可以请她用英语讲讲去了哪里，说错也没关系，多鼓励就好。', teacher: '林老师', date: '11 月 3 日'
  },
  brief: {
    student: '小雨', title: '十一月学习简报', period: '11 月第 1 周',
    sections: [{ heading: '到课与作业', body: '本周 4 节课全勤，课后作业按时完成。' }, { heading: '课堂表现', body: '主动回答问题，愿意开口说英语。' }, { heading: '需要关注', body: '不规则动词过去式还不太稳定。' }, { heading: '下周安排', body: '继续做过去式练习，开始学一般将来时。' }],
    teacher: '辅导老师 林老师', date: '11 月 3 日'
  }
}
const SAMPLE_KIND = { student: 'knowledge', parent: 'weekly' } as const

const cache = new Map<string, Buffer>()

let chain: Promise<unknown> = Promise.resolve()
/** 一次只渲染一张（每张开一个隐藏窗口，同时开十几个太占内存） */
function samplePng(id: string, kind?: CardKind): Promise<Buffer> {
  const p = chain.then(() => samplePngNow(id, kind))
  chain = p.catch(() => undefined)
  return p
}
async function samplePngNow(id: string, kind?: CardKind): Promise<Buffer> {
  const t = findTemplate(id)
  if (!t) throw new Error('没有这个模板')
  const k = kind ?? SAMPLE_KIND[t.audience]
  const key = id + ':' + k + ':' + t.style.accent
  const hit = cache.get(key)
  if (hit) return hit
  const r = await renderCardPng(t, k, prepareData(k, SAMPLES[k]))
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
  ipcMain.handle('cards:preview', async (_e, rawId: unknown, rawThumb: unknown, rawKind?: unknown) => {
    const id = IdSchema.parse(rawId)
    const png = await samplePng(id, rawKind === undefined ? undefined : z.enum(ALL_KINDS as [CardKind, ...CardKind[]]).parse(rawKind))
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
