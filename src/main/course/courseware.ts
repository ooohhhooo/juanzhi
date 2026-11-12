/**
 * 机构课件（按节挂在机构大纲上的 PDF / Word / PPT）：只在本机读出文字，按节存在数据目录的文件里（不进数据库、不改表）。
 * 目录：<数据目录>/courseware/<大纲 id>/index.json + <课件 id>.txt。课的键是「级别名|课次」（替换大纲后课 id 会变，这个键不变）。
 * 纯 node 模块（不依赖 electron）；pptx 的文字用 jszip 直接读 zip 里的 XML。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import JSZip from 'jszip'

export interface CwItem { id: string; name: string; key: string; chars: number; addedAt: string }
export const MAX_CW_CHARS = 200_000
export const lessonKey = (levelName: string, seq: number): string => `${levelName}|${seq}`

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
const dirOf = (dataDir: string, outlineId: string): string => path.join(dataDir, 'courseware', safeId(outlineId))
const readIndex = (dir: string): CwItem[] => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    return Array.isArray(v?.items) ? v.items.filter((x: any) => x && typeof x.id === 'string' && typeof x.key === 'string') : []
  } catch { return [] }
}
const writeIndex = (dir: string, items: CwItem[]): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items }, null, 1), 'utf8')
}

export function listCourseware(dataDir: string, outlineId: string): CwItem[] { return readIndex(dirOf(dataDir, outlineId)) }

/** 存一份课件的文字；同一节下同名文件覆盖 */
export function addCourseware(dataDir: string, outlineId: string, key: string, name: string, text: string): CwItem {
  const dir = dirOf(dataDir, outlineId)
  const items = readIndex(dir)
  const nm = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || '课件'
  const body = text.replace(/\r\n/g, '\n').slice(0, MAX_CW_CHARS)
  let it = items.find(x => x.key === key && x.name === nm)
  if (!it) { it = { id: crypto.randomBytes(5).toString('hex'), name: nm, key, chars: 0, addedAt: new Date().toISOString() }; items.push(it) }
  it.chars = body.length; it.addedAt = new Date().toISOString()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${it.id}.txt`), body, 'utf8')
  writeIndex(dir, items)
  return it
}

export function removeCourseware(dataDir: string, outlineId: string, id: string): boolean {
  const dir = dirOf(dataDir, outlineId)
  const items = readIndex(dir)
  const it = items.find(x => x.id === safeId(id))
  if (!it) return false
  try { fs.rmSync(path.join(dir, `${it.id}.txt`), { force: true }) } catch { /* 忽略 */ }
  writeIndex(dir, items.filter(x => x !== it))
  return true
}

/** 删除整份大纲时一并清掉它的课件 */
export function dropCoursewareOf(dataDir: string, outlineId: string): void {
  try { fs.rmSync(dirOf(dataDir, outlineId), { recursive: true, force: true }) } catch { /* 忽略 */ }
}

export function readCoursewareText(dataDir: string, outlineId: string, id: string): { item: CwItem; text: string } | null {
  const dir = dirOf(dataDir, outlineId)
  const item = readIndex(dir).find(x => x.id === safeId(id))
  if (!item) return null
  try { return { item, text: fs.readFileSync(path.join(dir, `${item.id}.txt`), 'utf8') } } catch { return null }
}

/** 某一节挂的课件（带全文） */
export function coursewareOfLesson(dataDir: string, outlineId: string, key: string): Array<CwItem & { text: string }> {
  const out: Array<CwItem & { text: string }> = []
  for (const it of readIndex(dirOf(dataDir, outlineId)).filter(x => x.key === key)) {
    const r = readCoursewareText(dataDir, outlineId, it.id)
    if (r) out.push({ ...it, text: r.text })
  }
  return out
}

const xmlText = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
/** 一页幻灯片 XML → 按段落的文字行 */
export function slideLines(xml: string): string[] {
  const lines: string[] = []
  for (const p of xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) ?? []) {
    const t = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => xmlText(m[1])).join('')
    if (t.trim()) lines.push(t.trim())
  }
  return lines
}

/** .pptx → 文字（每页一段，含备注）。不是 pptx 时抛错 */
export async function pptxText(buf: Uint8Array): Promise<string> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buf) } catch { throw new Error('这个 PPT 打不开，可能已损坏，或者不是 .pptx（旧版 .ppt 请另存为 .pptx 或 PDF）') }
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0)
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b))
  if (!slides.length) throw new Error('这个文件里没有找到幻灯片，请确认是 .pptx')
  const parts: string[] = []
  for (const n of slides) {
    const i = num(n)
    const lines = slideLines(await zip.files[n].async('string'))
    const note = zip.files[`ppt/notesSlides/notesSlide${i}.xml`]
    const nl = note ? slideLines(await note.async('string')).filter(l => !/^\d+$/.test(l)) : []
    if (lines.length || nl.length) parts.push(`【第 ${i} 页】\n${lines.join('\n')}${nl.length ? `\n（备注）${nl.join(' ')}` : ''}`)
  }
  return parts.join('\n\n')
}
