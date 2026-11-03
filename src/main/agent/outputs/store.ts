/**
 * 助手会话的产出文件：<数据目录>/agent-outputs/<sessionId>/，索引 index.json。
 * 文档是普通 .md（用户可在文件夹里直接打开），按节写入：每节前有一行 <!--sec:ID--> 标记，write_section 只覆盖这一节。
 * 纯 node:fs，不依赖 electron，单测直接跑。写文件一律「先写临时文件再改名」，写到一半断电不会留下半个文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { OutputContent, OutputEntry, OutputStatus, OutputType } from '../../../shared/agent-outputs.ts'

export interface Scope { dataDir: string; sessionId: string }
interface IndexFile { next: number; items: OutputEntry[] }

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/
const SECTION_RE = /^[A-Za-z0-9_-]{1,40}$/
const MARK = (id: string) => `<!--sec:${id}-->`
const MARK_RE = /^<!--sec:([A-Za-z0-9_-]{1,40})-->\s*$/

const listeners = new Set<(sessionId: string) => void>()
/** 产出有变化时通知（主进程转成 agent-outputs:changed 事件） */
export function onOutputsChanged(fn: (sessionId: string) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
const emit = (sid: string) => { for (const f of listeners) { try { f(sid) } catch { /* 监听者出错不影响写入 */ } } }

export function sessionDir(s: Scope): string {
  if (!SESSION_RE.test(s.sessionId)) throw new Error('会话编号不合法')
  return path.join(s.dataDir, 'agent-outputs', s.sessionId)
}

function atomicWrite(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readIndex(s: Scope): IndexFile {
  const dir = sessionDir(s)
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    if (raw && Array.isArray(raw.items)) return { next: Number(raw.next) > 0 ? Number(raw.next) : raw.items.length + 1, items: raw.items }
  } catch { /* 没有或损坏：当作空 */ }
  return { next: 1, items: [] }
}
function writeIndex(s: Scope, idx: IndexFile): void { atomicWrite(path.join(sessionDir(s), 'index.json'), JSON.stringify(idx, null, 2)); emit(s.sessionId) }

export function listOutputs(s: Scope): OutputEntry[] { return readIndex(s).items }
export function getEntry(s: Scope, id: string): OutputEntry | undefined { return readIndex(s).items.find(x => x.id === id) }

export function safeFileStem(name: string): string {
  const t = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60).trim()
  return t || '未命名'
}
const PREFIX: Record<OutputType, string> = { md: 'd', note: 'n', table: 't', board: 'b', image: 'i' }
const EXT: Record<OutputType, string> = { md: '.md', note: '.md', table: '.csv', board: '', image: '.png' }

function uniqueFile(idx: IndexFile, name: string, type: OutputType, id: string, dir: string): string {
  const stem = safeFileStem(name)
  let f = stem + EXT[type]
  if (idx.items.some(x => x.file === f && x.id !== id) || fs.existsSync(path.join(dir, f))) f = `${stem}-${id}${EXT[type]}`
  return f
}

function newEntry(s: Scope, idx: IndexFile, type: OutputType, name: string, extra: Partial<OutputEntry> = {}): OutputEntry {
  const id = `${PREFIX[type]}${idx.next++}`
  const file = type === 'board' ? null : uniqueFile(idx, name, type, id, sessionDir(s))
  const e: OutputEntry = { id, type, name: name.trim().slice(0, 80) || '未命名', file, updatedAt: Date.now(), status: 'writing', ...extra }
  idx.items.push(e)
  return e
}

// ───────────── 文档 ─────────────

interface Parsed { head: string; sections: Array<{ id: string; text: string }> }
export function parseDoc(md: string): Parsed {
  const head: string[] = []
  const sections: Parsed['sections'] = []
  let cur: { id: string; lines: string[] } | null = null
  for (const ln of md.split('\n')) {
    const m = MARK_RE.exec(ln)
    if (m) { if (cur) sections.push({ id: cur.id, text: cur.lines.join('\n').trim() }); cur = { id: m[1], lines: [] } }
    else if (cur) cur.lines.push(ln)
    else head.push(ln)
  }
  if (cur) sections.push({ id: cur.id, text: cur.lines.join('\n').trim() })
  return { head: head.join('\n').trim(), sections }
}
const buildDoc = (p: Parsed): string => [p.head, ...p.sections.map(x => `${MARK(x.id)}\n${x.text}`)].filter(Boolean).join('\n\n') + '\n'

/** 新建文档；同名同类型的文档已存在就直接返回它（模型重试时不会生出两份） */
export function createDoc(s: Scope, name: string, kind: 'md' | 'note' = 'md', plan?: string[]): OutputEntry {
  const idx = readIndex(s)
  const nm = name.trim().slice(0, 80)
  const old = idx.items.find(x => x.type === kind && x.name === nm)
  if (old) return old
  const e = newEntry(s, idx, kind, name, { total: plan?.length || undefined, written: 0 })
  atomicWrite(path.join(sessionDir(s), e.file!), `# ${e.name}\n`)
  writeIndex(s, idx)
  return e
}

export function writeSection(s: Scope, docId: string, sectionId: string, title: string, markdown: string, last = false): OutputEntry {
  if (!SECTION_RE.test(sectionId)) throw new Error('sectionId 只能用字母、数字、下划线和短横线（最长 40 位）')
  const idx = readIndex(s)
  const e = idx.items.find(x => x.id === docId && (x.type === 'md' || x.type === 'note'))
  if (!e || !e.file) throw new Error(`找不到文档 ${docId}`)
  const file = path.join(sessionDir(s), e.file)
  const p = parseDoc(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${e.name}\n`)
  const body = markdown.replace(/<!--\s*sec:[^>]*-->/g, '').trim()
  const text = (title.trim() ? `## ${title.trim().replace(/^#+\s*/, '')}\n\n` : '') + body
  const at = p.sections.findIndex(x => x.id === sectionId)
  if (at >= 0) p.sections[at].text = text
  else p.sections.push({ id: sectionId, text })
  atomicWrite(file, buildDoc(p))
  e.written = p.sections.length
  e.updatedAt = Date.now()
  e.status = last || (e.total != null && e.written >= e.total) ? 'done' : 'writing'
  writeIndex(s, idx)
  return e
}

export function readDoc(s: Scope, docId: string): { entry: OutputEntry; markdown: string; sections: Array<{ id: string; title: string }> } {
  const e = getEntry(s, docId)
  if (!e || !e.file || (e.type !== 'md' && e.type !== 'note')) throw new Error(`找不到文档 ${docId}`)
  const markdown = fs.readFileSync(path.join(sessionDir(s), e.file), 'utf8')
  const sections = parseDoc(markdown).sections.map(x => ({ id: x.id, title: (/^##\s+(.+)$/m.exec(x.text)?.[1] ?? '').trim() }))
  return { entry: e, markdown, sections }
}

/** 文件里的标记行对读者没有用：预览和导出用这个版本 */
export const cleanMarks = (md: string): string => md.replace(/^<!--sec:[A-Za-z0-9_-]{1,40}-->[ \t]*\n?/gm, '')

export function setStatus(s: Scope, id: string, status: OutputStatus): void {
  const idx = readIndex(s)
  const e = idx.items.find(x => x.id === id)
  if (!e) return
  e.status = status; e.updatedAt = Date.now()
  writeIndex(s, idx)
}

// ───────────── 图片（分享卡片）─────────────

/** 存一张图片产出：放在会话的 exports/ 下（企业微信发文件只认这个目录），每次新建一项，不覆盖旧图 */
export function saveImage(s: Scope, name: string, png: Buffer, card: NonNullable<OutputEntry['card']>): OutputEntry {
  const idx = readIndex(s)
  const e = newEntry(s, idx, 'image', name, { card })
  const dir = path.join(sessionDir(s), 'exports')
  let f = `exports/${safeFileStem(e.name)}.png`
  if (idx.items.some(x => x.file === f && x.id !== e.id) || fs.existsSync(path.join(sessionDir(s), f))) f = `exports/${safeFileStem(e.name)}-${e.id}.png`
  fs.mkdirSync(dir, { recursive: true })
  e.file = f
  atomicWrite(path.join(sessionDir(s), f), png)
  e.status = 'done'; e.updatedAt = Date.now()
  writeIndex(s, idx)
  return e
}

// ───────────── 表格 ─────────────

const MAX_COLS = 100
const MAX_ROWS = 100_000
/**
 * CSV 防公式：Excel 打开 csv 时会把 = 开头、或 + - @ 开头的文字当公式执行，所以前面补一个单引号。
 * 数值样式的值不加（-12.5%、+86 13812345678 这类，补了会显示错）：以 + - 开头且整串只有数字 / 小数点 / 逗号 / 百分号 / 空格 / 连字符，视为数值。
 * 原值本来就以 ' 开头且后面是触发字符时，多补一个 '，这样读回来能分清哪个 ' 是我们加的。
 */
const FORMULA_START = /^[=+\-@\t\r]/
const QUOTED_FORMULA = /^'+[=+\-@\t\r]/
const NUMBERISH = /^[+\-]\s?\.?\d[\d.,%\s\-]*$/
function csvCell(v: unknown): string {
  let t = v == null ? '' : String(v)
  if (FORMULA_START.test(t)) { if (!(t[0] !== '=' && NUMBERISH.test(t))) t = "'" + t }
  else if (QUOTED_FORMULA.test(t)) t = "'" + t
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
/** 读回时去掉 csvCell 加的防公式前缀（xlsx 用共享字符串，本来就不会被当公式，不需要它） */
export function unguardCell(t: string): string {
  return QUOTED_FORMULA.test(t) ? t.slice(1) : t
}
export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** 存名单 / 表格为 UTF-8 带 BOM 的 .csv（Excel 直接打开不乱码）；同名表格覆盖 */
export function saveTable(s: Scope, name: string, columns: string[], rows: unknown[][]): OutputEntry {
  if (!columns.length || columns.length > MAX_COLS) throw new Error(`列数要在 1 到 ${MAX_COLS} 之间`)
  if (rows.length > MAX_ROWS) throw new Error(`行数不能超过 ${MAX_ROWS}`)
  const idx = readIndex(s)
  const nm = name.trim().slice(0, 80) || '表格'
  let e = idx.items.find(x => x.type === 'table' && x.name === nm)
  if (!e) e = newEntry(s, idx, 'table', nm)
  atomicWrite(path.join(sessionDir(s), e.file!), '﻿' + toCsv(columns, rows))
  e.updatedAt = Date.now(); e.status = 'done'; e.written = rows.length
  writeIndex(s, idx)
  return e
}

/** 看板由看板模块创建；这里只登记，让它出现在产出列表里 */
export function registerBoard(s: Scope, boardId: string, name: string): OutputEntry {
  const idx = readIndex(s)
  let e = idx.items.find(x => x.type === 'board' && x.boardId === boardId)
  if (!e) e = newEntry(s, idx, 'board', name, { boardId })
  e.name = name.trim().slice(0, 80) || e.name; e.updatedAt = Date.now(); e.status = 'done'
  writeIndex(s, idx)
  return e
}

export function readTableRows(s: Scope, id: string): { columns: string[]; rows: string[][] } {
  const e = getEntry(s, id)
  if (!e || e.type !== 'table' || !e.file) throw new Error(`找不到表格 ${id}`)
  const all = parseCsv(fs.readFileSync(path.join(sessionDir(s), e.file), 'utf8'))
  return { columns: (all[0] ?? []).map(unguardCell), rows: all.slice(1).map(r => r.map(unguardCell)) }
}

/** 面板预览：表格只给前 200 行 */
export function readContent(s: Scope, id: string): OutputContent {
  const e = getEntry(s, id)
  if (!e) throw new Error(`找不到产出 ${id}`)
  if (e.type === 'board') return { type: 'board', boardId: e.boardId ?? e.id }
  if (e.type === 'table') { const t = readTableRows(s, id); return { type: 'table', columns: t.columns, rows: t.rows.slice(0, 200), totalRows: t.rows.length } }
  if (e.type === 'image') {
    if (!e.file) throw new Error('找不到图片文件')
    const buf = fs.readFileSync(path.join(sessionDir(s), e.file))
    return { type: 'image', dataUrl: 'data:image/png;base64,' + buf.toString('base64'), width: e.card?.width ?? 0, height: e.card?.height ?? 0 }
  }
  const d = readDoc(s, id)
  return { type: e.type, markdown: cleanMarks(d.markdown), written: d.sections.length, total: e.total }
}

export function entryPath(s: Scope, id: string): string | null {
  const e = getEntry(s, id)
  return e?.file ? path.join(sessionDir(s), e.file) : null
}
