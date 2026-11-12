/**
 * 机构课件（按节挂在机构大纲上的 PDF / Word / PPT）：只在本机读出文字，按节存在数据目录的文件里（不进数据库、不改表）。
 * 目录：<数据目录>/courseware/<大纲 id>/index.json + <课件 id>.txt。课的键是「级别名|课次」（替换大纲后课 id 会变，这个键不变）。
 * 纯 node 模块（不依赖 electron）；pptx 的文字用 jszip 直接读 zip 里的 XML。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import JSZip from 'jszip'
import { readText } from './table-read.ts'

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

const CW_ID_RE = /^[0-9a-f]{4,20}$/

/** 导出数据包用：某份大纲的课件文件（index.json + 各份文字），只含索引里登记、文件真实存在的 */
export function coursewareFilesOf(dataDir: string, outlineId: string): Array<{ abs: string; name: string; size: number }> {
  const dir = dirOf(dataDir, outlineId)
  const items = readIndex(dir).filter(x => CW_ID_RE.test(x.id))
  if (!items.length) return []
  const out: Array<{ abs: string; name: string; size: number }> = []
  const kept: CwItem[] = []
  for (const it of items) {
    const abs = path.join(dir, `${it.id}.txt`)
    try { const st = fs.statSync(abs); if (st.isFile()) { out.push({ abs, name: `${it.id}.txt`, size: st.size }); kept.push(it) } } catch { /* 文件丢了：不带 */ }
  }
  if (!kept.length) return []
  // 索引只写真实存在的；放在数据目录之外的临时位置不方便，这里直接指向原索引（多出的条目导入时会因缺文件被跳过）
  const idx = path.join(dir, 'index.json')
  return [{ abs: idx, name: 'index.json', size: fs.statSync(idx).size }, ...out]
}

/**
 * 导入数据包里的课件（srcDir = 解包后的 courseware/<大纲 id>）：本机已有的不覆盖——同 id、或同一节同名的跳过，只补本机没有的。
 * 数据包内容不信任：id 必须是十六进制、名字 / 键截断、文字限长。返回新增份数。
 */
export function importCoursewareDir(dataDir: string, outlineId: string, srcDir: string): number {
  const src = readIndex(srcDir)
  if (!src.length) return 0
  const dir = dirOf(dataDir, outlineId)
  const items = readIndex(dir)
  let added = 0
  for (const it of src.slice(0, 2000)) {
    if (!CW_ID_RE.test(it.id)) continue
    const key = String(it.key).slice(0, 200), name = String(it.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || '课件'
    if (items.some(x => x.id === it.id || (x.key === key && x.name === name))) continue
    let text: string
    try { text = fs.readFileSync(path.join(srcDir, `${it.id}.txt`), 'utf8').slice(0, MAX_CW_CHARS) } catch { continue }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${it.id}.txt`), text, 'utf8')
    items.push({ id: it.id, name, key, chars: text.length, addedAt: typeof it.addedAt === 'string' ? it.addedAt.slice(0, 40) : new Date().toISOString() })
    added++
  }
  if (added) writeIndex(dir, items)
  return added
}

/** 覆盖导入：整个课件目录清掉（和“大纲整体被包里的替换”保持一致） */
export function dropAllCourseware(dataDir: string): void {
  try { fs.rmSync(path.join(dataDir, 'courseware'), { recursive: true, force: true }) } catch { /* 忽略 */ }
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
  if (xml.length > 2_000_000) xml = xml.slice(0, 2_000_000) // 单页 XML 不会这么大，截断后再跑正则
  const lines: string[] = []
  for (const p of xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) ?? []) {
    const t = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => xmlText(m[1])).join('')
    if (t.trim()) lines.push(t.trim())
  }
  return lines
}

export const PPTX_LIMITS = { entryBytes: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, slides: 500 } as const
const TOO_BIG = '这个文件太大（解压后体积异常），不像正常的课件，已拒绝读取'

/** .pptx → 文字（每页一段，含备注）。不是 pptx 时抛错；防压缩炸弹：单条目 / 累计解压体积、幻灯片数、文字总量都有上限 */
export async function pptxText(buf: Uint8Array): Promise<string> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buf) } catch { throw new Error('这个 PPT 打不开，可能已损坏，或者不是 .pptx（旧版 .ppt 请另存为 .pptx 或 PDF）') }
  const entries = Object.values(zip.files)
  if (entries.length > 5000) throw new Error(TOO_BIG)
  let declared = 0
  for (const e of entries) {
    const sz = Number((e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0)
    if (sz > PPTX_LIMITS.entryBytes) throw new Error(TOO_BIG)
    declared += sz
  }
  if (declared > PPTX_LIMITS.totalBytes) throw new Error(TOO_BIG)
  const budget = { used: 0 }
  const rd = async (n: string): Promise<string> => {
    try { return (await readText(zip, n, budget, { entryBytes: PPTX_LIMITS.entryBytes, totalBytes: PPTX_LIMITS.totalBytes })) ?? '' } catch { throw new Error(TOO_BIG) }
  }
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0)
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b))
  if (!slides.length) throw new Error('这个文件里没有找到幻灯片，请确认是 .pptx')
  if (slides.length > PPTX_LIMITS.slides) throw new Error(`这个 PPT 有 ${slides.length} 页，超过 ${PPTX_LIMITS.slides} 页，请拆开后再传`)
  const parts: string[] = []
  let chars = 0
  for (const n of slides) {
    const i = num(n)
    const lines = slideLines(await rd(n))
    const note = zip.files[`ppt/notesSlides/notesSlide${i}.xml`]
    const nl = note ? slideLines(await rd(`ppt/notesSlides/notesSlide${i}.xml`)).filter(l => !/^\d+$/.test(l)) : []
    if (lines.length || nl.length) {
      const part = `【第 ${i} 页】\n${lines.join('\n')}${nl.length ? `\n（备注）${nl.join(' ')}` : ''}`
      parts.push(part); chars += part.length + 2
      if (chars > MAX_CW_CHARS) break // 文字已经够多，后面的页不再读
    }
  }
  return parts.join('\n\n').slice(0, MAX_CW_CHARS)
}
