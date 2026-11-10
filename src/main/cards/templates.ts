/**
 * 卡片模板资源：manifest.json（每套模板的底图、区域、配色、字体）+ layouts/<kind>.html（版式）+ layouts/base.css。
 * 模板和版式都是 resources/card-templates/ 下的普通文件，整体替换即可换风格，不用改代码。
 * 纯 node:fs，不依赖 electron：打包后的目录由主进程启动时 setCardRoot() 告知（见 index.ts），单测直接用仓库里的目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { escapeHtml, renderTemplate } from './engine.ts'
import type { Audience, CardKind } from './schema.ts'
import { asSubject, SUBJECTS } from '../../shared/subject.ts'

export interface CardTemplate {
  id: string
  audience: Audience
  name: string
  /** 适合的场景（给 Agent / 设置页看） */
  scene: string
  file: string
  width: number
  height: number
  /** 相对坐标 [x0, y0, x1, y1]：纸张（便签 / 信纸）区域，仅供参考 */
  paper: number[]
  /** 相对坐标：已内缩的安全文字区，标题、正文、署名都排在这里面 */
  content: number[]
  style: {
    accent: string
    /** 辅色：高亮荧光笔底、对比条、小标等 */
    accent2?: string
    paperBg?: string
    /** 覆盖这套模板的字体栈（title / body / latin / hand / serif） */
    fonts?: Record<string, string>
    /** 直接覆盖任意 CSS 变量，如 { "--ink": "#222" } */
    vars?: Record<string, string>
  }
}
/** audiences：只在这些受众的卡片里内嵌（字体文件大，用不到就不放进页面） */
export interface FontFile { family: string; file: string; audiences?: Audience[]; weight?: number | string; style?: string }
export interface Manifest {
  version: number
  fonts: { files: FontFile[]; stacks: Record<string, string> }
  templates: CardTemplate[]
}

let root: string | null = null
export function setCardRoot(dir: string): void { root = dir; manifestCache = null }
export function cardRoot(): string { return root ?? path.resolve('resources', 'card-templates') }

let manifestCache: Manifest | null = null
export function loadManifest(): Manifest {
  if (!manifestCache) manifestCache = JSON.parse(fs.readFileSync(path.join(cardRoot(), 'manifest.json'), 'utf8')) as Manifest
  return manifestCache
}
export const listTemplates = (audience?: Audience): CardTemplate[] => loadManifest().templates.filter(t => !audience || t.audience === audience)
export const findTemplate = (id: string): CardTemplate | undefined => loadManifest().templates.find(t => t.id === id)
export const templateImagePath = (t: CardTemplate): string => path.join(cardRoot(), t.file)

// ── 设置：默认模板、孩子称呼 ──
export interface CardSettings { defaults: { student: string; parent: string }; childName: 'first' | 'none' }
const settingsFile = (dataDir: string) => path.join(dataDir, 'share-cards.json')
export function readCardSettings(dataDir: string): CardSettings {
  const ts = (a: Audience) => listTemplates(a)
  let raw: any = {}
  try { raw = JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8')) } catch { /* 没设置过 */ }
  const pick = (a: Audience, v: unknown): string => (typeof v === 'string' && ts(a).some(t => t.id === v) ? v : ts(a)[0]?.id ?? '')
  return { defaults: { student: pick('student', raw?.defaults?.student), parent: pick('parent', raw?.defaults?.parent) }, childName: raw?.childName === 'none' ? 'none' : 'first' }
}
export function writeCardSettings(dataDir: string, patch: { defaults?: Partial<CardSettings['defaults']>; childName?: string }): CardSettings {
  const cur = readCardSettings(dataDir)
  const next: CardSettings = { defaults: { ...cur.defaults }, childName: cur.childName }
  for (const a of ['student', 'parent'] as const) {
    const id = patch.defaults?.[a]
    if (id !== undefined) { if (!listTemplates(a).some(t => t.id === id)) throw new Error('没有这个模板'); next.defaults[a] = id }
  }
  if (patch.childName === 'first' || patch.childName === 'none') next.childName = patch.childName
  fs.mkdirSync(dataDir, { recursive: true })
  const f = settingsFile(dataDir)
  fs.writeFileSync(f + '.tmp', JSON.stringify(next, null, 2))
  fs.renameSync(f + '.tmp', f)
  return next
}

// ── 版式 ──
export interface Layout { css: string; content: string }
const layoutCache = new Map<string, Layout>()
export function loadLayout(kind: CardKind): Layout {
  const hit = layoutCache.get(kind + '@' + cardRoot())
  if (hit) return hit
  const src = fs.readFileSync(path.join(cardRoot(), 'layouts', `${kind}.html`), 'utf8')
  const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  const zone = (n: string) => new RegExp(`<zone name="${n}">([\\s\\S]*?)</zone>`).exec(src)?.[1] ?? ''
  const l: Layout = { css, content: zone('content') }
  layoutCache.set(kind + '@' + cardRoot(), l)
  return l
}
export function clearLayoutCache(): void { layoutCache.clear(); manifestCache = null }

/** 给版式补上程序算出来的字段（高亮片段已转义，供 {{{ }}} 使用） */
export function prepareData(kind: CardKind, data: Record<string, any>): Record<string, any> {
  const d: Record<string, any> = { ...data }
  if (kind === 'knowledge') {
    d.defaultTag = `${SUBJECTS[asSubject(d.subject)].name}小卡`
    const ex = d.example ?? { en: '', zh: '' }
    d.example = { ...ex, enHtml: escapeHtml(ex.en).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') }
  } else if (kind === 'mnemonic') {
    d.lines = (d.lines as Array<{ text: string; highlight?: string }>).map(l => {
      const text = escapeHtml(l.text)
      const h = l.highlight ? escapeHtml(l.highlight) : ''
      return { ...l, html: h && text.includes(h) ? text.replace(h, `<em>${h}</em>`) : text }
    })
  }
  // 底部署名 + 日期、副标题（版式里直接用 {{foot}} / {{sub}}）
  d.foot = [d.signature ?? d.teacher, d.date].filter(Boolean).join(' · ')
  if (kind === 'weekly') d.sub = [d.grade, d.week].filter(Boolean).join(' · ')
  else if (kind === 'progress') d.sub = [d.grade, d.period].filter(Boolean).join(' · ')
  else if (kind === 'brief') d.sub = [d.title ? d.student : '', d.period].filter(Boolean).join(' · ')
  return d
}

const px = (v: number) => Math.round(v * 100) / 100
const pos = (r: number[], w: number, h: number, pad = 0) => `left:${px(r[0] * w + pad)}px;top:${px(r[1] * h + pad)}px;width:${px((r[2] - r[0]) * w - 2 * pad)}px;height:${px((r[3] - r[1]) * h - 2 * pad)}px`

function fontFaces(audience: Audience): string {
  return loadManifest().fonts.files.filter(f => !f.audiences || f.audiences.includes(audience)).map(f => {
    try {
      const buf = fs.readFileSync(path.join(cardRoot(), 'fonts', f.file))
      const mime = /\.woff2$/i.test(f.file) ? 'font/woff2' : /\.woff$/i.test(f.file) ? 'font/woff' : /\.otf$/i.test(f.file) ? 'font/otf' : 'font/ttf'
      return `@font-face{font-family:${JSON.stringify(f.family)};src:url(data:${mime};base64,${buf.toString('base64')});font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`
    } catch { return '' }
  }).join('\n')
}

const hexOk = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c)

/** 完整页面 HTML：底图（data:）+ 三个区域；scale 是整体缩放。内容一律经模板引擎转义 */
export function buildCardPage(t: CardTemplate, kind: CardKind, data: Record<string, any>, scale: number): string {
  const m = loadManifest()
  const lay = loadLayout(kind)
  const base = fs.readFileSync(path.join(cardRoot(), 'layouts', 'base.css'), 'utf8')
  const a = hexOk(t.style.accent) ? t.style.accent : '#4A6CF7'
  const a2 = t.style.accent2 && hexOk(t.style.accent2) ? t.style.accent2 : a
  const fonts = { ...m.fonts.stacks, ...(t.style.fonts ?? {}) }
  const vars: Record<string, string> = {
    '--accent': a, '--accent2': a2, '--accent-soft': a + '1f', '--hl': a2 + '66',
    '--paper': t.style.paperBg ?? '#ffffff',
    '--ink': '#2B2A3D', '--muted': '#6B6A82',
    '--font-title': fonts.title, '--font-body': fonts.body, '--font-latin': fonts.latin, '--font-hand': fonts.hand ?? fonts.body, '--font-serif': fonts.serif ?? fonts.body,
    '--s': String(scale),
    ...(t.style.vars ?? {})
  }
  const varCss = Object.entries(vars).filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && v !== undefined).map(([k, v]) => `${k}:${String(v).replace(/[<>{};]/g, '')}`).join(';')
  const bg = `data:image/jpeg;base64,${fs.readFileSync(templateImagePath(t)).toString('base64')}`
  const W = t.width, H = t.height
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<style>${fontFaces(t.audience)}
body{${varCss}}
${base}
${lay.css}</style></head><body>
<img class="bg" alt="" src="${bg}">
<div class="z content" id="zc" style="${pos(t.content, W, H)}"><div class="fit">${renderTemplate(lay.content, data)}</div></div>
</body></html>`
}
