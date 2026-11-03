/**
 * 课程表的「列映射」与确定性套用。纯函数模块（不依赖 electron），单测直接加载。
 *
 * 设计要点（M9 §1.4）：AI 只负责认列——哪几行是表头、哪一列是什么；课程内容本身由这里的程序
 * 从单元格原文逐字复制，不经过 AI 改写，所以不会出现「AI 编出一节课」。
 * 没有 AI（或不想发送）时，用户在预览里手动给每一列选类型；也可以用 guessMapping 按表头文字猜一遍。
 */
import { cleanCell } from './table-read.ts'
import type { Sheet } from './table-read.ts'

export const COL_FIELDS = ['seq', 'level', 'title', 'theme', 'textbook_ref', 'phonics', 'word', 'pattern', 'expression', 'skill', 'note', 'ignore'] as const
export type ColField = (typeof COL_FIELDS)[number]

/** 列类型的白话名（界面的下拉、预览表头用） */
export const FIELD_LABEL: Record<ColField, string> = {
  seq: '课次', level: '级别', title: '课程标题', theme: '主题', textbook_ref: '教材对标',
  phonics: '字母与语音', word: '词汇', pattern: '句型', expression: '实用表达', skill: '能力目标', note: '备注', ignore: '忽略'
}

export type PointKind = 'word' | 'pattern' | 'phonics' | 'expression' | 'skill' | 'other'
const POINT_FIELDS: Partial<Record<ColField, PointKind>> = { phonics: 'phonics', word: 'word', pattern: 'pattern', expression: 'expression', skill: 'skill', note: 'other' }

export interface SheetMapping {
  /** 表头占几行（数据从第 headerRows+1 行开始） */
  headerRows: number
  /** 这张表对应的级别名；空 = 用 sheet 名（或「级别」列） */
  levelName: string
  /** 0 起算的列号 → 列类型；没写的列等同忽略 */
  columns: Array<{ col: number; field: ColField }>
  /** 整行是这类标记字样（如赛季标记）就跳过 */
  skipMarkers: string[]
  /** 拿不准的地方（白话，给预览显示） */
  uncertain: string[]
}

export interface ParsedLesson {
  seq: number
  noLabel: string
  title: string
  theme: string
  textbookRef: string
  points: Array<{ kind: PointKind; label: string; text: string }>
  /** 原行单元格（列名 → 原文），保真，预览 / 追溯用 */
  raw: Record<string, string>
}
export interface ParsedLevel { name: string; lessons: ParsedLesson[] }

export type WarnKind = 'skip_no_seq' | 'auto_seq' | 'dup_seq' | 'empty_level' | 'merged_filled' | 'price_ignored' | 'marker_skip' | 'hidden_sheet' | 'no_lessons' | 'unverified'
export interface MapWarning { kind: WarnKind; sheet: string; /** 1 起算的表格行号，没有就是 0 */ row: number; text: string }

export interface ParsedOutline { levels: ParsedLevel[]; warnings: MapWarning[] }

// ───────────────────────── 表头文字 ─────────────────────────

/** 价格类列：卷知不使用价格信息，一律忽略（表头含这些词） */
const PRICE_RE = /价格|学费|费用|优惠|折扣|售价|报名费|人民币|单价|总价|\bprice\b|\bfee\b|\bcost\b|\bdiscount\b|\d\s*元|元\s*\/|^元$/i
export const isPriceHeader = (label: string): boolean => PRICE_RE.test(label)

/** 每一列的表头文字：表头多行时把非空的格子按行拼起来（相同的相邻文字只留一份） */
export function headerLabels(sheet: Sheet, headerRows: number): string[] {
  const n = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const out: string[] = []
  for (let c = 0; c < n; c++) {
    const parts: string[] = []
    for (let r = 0; r < Math.min(headerRows, sheet.rows.length); r++) {
      const v = (sheet.rows[r][c] ?? '').replace(/\s+/g, ' ').trim()
      if (v && parts[parts.length - 1] !== v) parts.push(v)
    }
    out.push(parts.join('·'))
  }
  return out
}

const GUESS_RULES: Array<[ColField, RegExp]> = [
  ['textbook_ref', /对标|教材|课本|教科书|版本|textbook/i],
  ['level', /级别|等级|阶段|\blevel\b/i],
  ['seq', /课次|课时|课序|序号|节次|第几课|课号|周次|单元序|^lesson\b|^no\.?$|^#$|^unit$|^week$/i],
  ['title', /标题|课名|课题|课程名|课程名称|名称|\btitle\b/i],
  ['theme', /主题|话题|场景|\btopic\b|\btheme\b/i],
  ['phonics', /字母|语音|自然拼读|拼读|自拼|phonics/i],
  ['word', /词汇|单词|生词|词语|\bvocab|\bwords?\b/i],
  ['pattern', /句型|句式|语法|句子|pattern|sentence/i],
  ['expression', /实用表达|表达|口语|交际|expression/i],
  ['skill', /能力|目标|技能|\bgoal|\bskill/i],
  ['note', /备注|说明|收获|\bnote|remark/i]
]

/** 按表头文字猜列类型（本地规则，不调用 AI） */
export function guessField(label: string): ColField | null {
  const t = label.trim()
  if (!t) return null
  if (isPriceHeader(t)) return 'ignore'
  for (const [f, re] of GUESS_RULES) if (re.test(t)) return f
  return null
}

const SEQ_NUM = /(\d+)/
/** 课次单元格 → 数字（「第 5 课」「L5」「5.0」「Unit 3」都取第一个数字）；认不出返回 null */
export function parseSeq(cell: string): number | null {
  const m = SEQ_NUM.exec(cell)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null
}

/**
 * 按表头文字猜一份映射。表头行数在 1–4 之间找：第一个让「课次列的下一行是数字」成立的行数。
 * 猜不出课次或标题列时返回 null。
 */
export function guessMapping(sheet: Sheet): SheetMapping | null {
  const maxH = Math.min(4, Math.max(1, sheet.rows.length - 1))
  for (let h = 1; h <= maxH; h++) {
    const labels = headerLabels(sheet, h)
    const columns: SheetMapping['columns'] = []
    labels.forEach((l, col) => { const f = guessField(l); if (f) columns.push({ col, field: f }) })
    const seqCols = columns.filter(c => c.field === 'seq')
    const hasTitle = columns.some(c => c.field === 'title')
    if (!seqCols.length && !hasTitle) continue
    const next = sheet.rows[h]
    const dataLooksRight = seqCols.length ? seqCols.some(c => parseSeq(next?.[c.col] ?? '') !== null) : true
    if (dataLooksRight) return { headerRows: h, levelName: '', columns, skipMarkers: [], uncertain: [] }
  }
  return null
}

// ───────────────────────── 套用 ─────────────────────────

const isEmptyRow = (r: string[]) => r.every(c => !c.trim())

/** 一张 sheet 套用映射：返回按级别分组的课次和警告（不含 sheet 间合并，见 buildOutline） */
export function applyMapping(sheet: Sheet, m: SheetMapping): { levels: Map<string, ParsedLesson[]>; warnings: MapWarning[] } {
  const warnings: MapWarning[] = []
  const levels = new Map<string, ParsedLesson[]>()
  const labels = headerLabels(sheet, m.headerRows)
  // 价格类列：不管 AI / 用户怎么选，都按忽略处理，并提示
  const ignored = new Set<number>()
  const cols = new Map<number, ColField>()
  for (const { col, field } of m.columns) {
    if (col < 0) continue
    if (isPriceHeader(labels[col] ?? '')) { ignored.add(col); continue }
    if (field !== 'ignore') cols.set(col, field)
  }
  for (const col of ignored) warnings.push({ kind: 'price_ignored', sheet: sheet.name, row: 0, text: `「${labels[col]}」这一列看起来是价格 / 费用信息，卷知不使用，已忽略` })
  if (sheet.mergedFilled) warnings.push({ kind: 'merged_filled', sheet: sheet.name, row: 0, text: '这张表有合并单元格，合并区域里已经向下 / 向右填充了同样的内容' })

  const colsOf = (f: ColField) => [...cols].filter(([, x]) => x === f).map(([c]) => c)
  const seqCols = colsOf('seq'), levelCols = colsOf('level'), titleCols = colsOf('title'), themeCols = colsOf('theme'), refCols = colsOf('textbook_ref')
  const markers = new Set(m.skipMarkers.map(s => s.trim()).filter(Boolean))
  const base = m.levelName.trim() || sheet.name
  const dedupLabel = new Map<string, number>()
  const rawKey = (col: number) => {
    const l = labels[col] || `第${col + 1}列`
    const n = (dedupLabel.get(l) ?? 0) + 1
    dedupLabel.set(l, n)
    return n > 1 ? `${l}#${n}` : l
  }
  const rawKeys = labels.map((_, c) => rawKey(c))
  const joinCells = (row: string[], cs: number[], sep = ' / ') => [...new Set(cs.map(c => (row[c] ?? '').trim()).filter(Boolean))].join(sep)

  const lastSeq = new Map<string, number>()
  const dups = new Map<string, Array<{ seq: number; row: number }>>()   // 课次重复：只重复一两处时逐条说明，很多（比如不同学期各自从 1 编号）时合成一条
  const seen = new Map<string, Set<number>>()
  let markerSkips = 0
  for (let r = m.headerRows; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]
    const filled = row.filter((c, i) => c.trim() && !ignored.has(i)).length   // 价格这类被忽略的列不算「这一行有内容」
    if (isEmptyRow(row) || filled === 0) continue
    const seqText = joinCells(row, seqCols, ' ')
    const title = joinCells(row, titleCols)
    const levelCell = levelCols.length ? joinCells(row, levelCols, ' ') : ''
    // 标记行（赛季 / 学期标记之类）：只有一两个格子有字、没有课次数字，或者命中了 AI 认出的标记字样
    const seq0 = parseSeq(seqText)
    const hitMarker = row.some(c => markers.has(c.trim())) && filled <= 2
    if (hitMarker || (seq0 === null && !title && filled <= 1)) { markerSkips++; continue }
    const level = levelCell || base
    if (!lastSeq.has(level)) { lastSeq.set(level, 0); seen.set(level, new Set()) }
    let seq = seq0
    if (seq === null) {
      if (!title) { warnings.push({ kind: 'skip_no_seq', sheet: sheet.name, row: r + 1, text: `第 ${r + 1} 行没有课次编号也没有标题，已跳过` }); continue }
      seq = (lastSeq.get(level) ?? 0) + 1
      warnings.push({ kind: 'auto_seq', sheet: sheet.name, row: r + 1, text: `第 ${r + 1} 行的课次不是数字，已按顺序编为第 ${seq} 课` })
    }
    lastSeq.set(level, seq)
    if (seen.get(level)!.has(seq)) { if (!dups.has(level)) dups.set(level, []); dups.get(level)!.push({ seq, row: r + 1 }) }
    seen.get(level)!.add(seq)

    const points: ParsedLesson['points'] = []
    for (const f of ['phonics', 'word', 'pattern', 'expression', 'skill', 'note'] as ColField[]) {
      const cs = colsOf(f)
      const text = joinCells(row, cs, '；')
      if (text) points.push({ kind: POINT_FIELDS[f]!, label: cs.map(c => labels[c]).find(Boolean) || FIELD_LABEL[f], text })
    }
    const raw: Record<string, string> = {}
    row.forEach((v, c) => { if (v.trim() && !ignored.has(c)) raw[rawKeys[c]] = v.trim() })
    if (!levels.has(level)) levels.set(level, [])   // 级别在真正有课的时候才出现（被跳过的行不会造出空级别）
    levels.get(level)!.push({
      seq, noLabel: seqText || String(seq), title, theme: joinCells(row, themeCols), textbookRef: joinCells(row, refCols), points, raw
    })
  }
  for (const [level, list] of dups) {
    warnings.push(list.length === 1
      ? { kind: 'dup_seq', sheet: sheet.name, row: list[0].row, text: `「${level}」里第 ${list[0].seq} 课出现了不止一次（第 ${list[0].row} 行），请核对` }
      : { kind: 'dup_seq', sheet: sheet.name, row: list[0].row, text: `「${level}」里有 ${list.length} 课的课次编号和前面重复（常见于不同学期各自从 1 编号），已按表里的顺序全部保留，请核对` })
  }
  if (markerSkips) warnings.push({ kind: 'marker_skip', sheet: sheet.name, row: 0, text: `跳过了 ${markerSkips} 个标记行（只有一两个格子有字、没有课次的行）` })
  return { levels, warnings }
}

/** 全部 sheet → 课程体系：同名级别合并；隐藏 sheet 跳过并提示；某级别一课都没有会提示 */
export function buildOutline(sheets: Sheet[], mappings: Record<string, SheetMapping | null | undefined>): ParsedOutline {
  const warnings: MapWarning[] = []
  const byLevel = new Map<string, ParsedLesson[]>()
  const order: string[] = []
  for (const s of sheets) {
    if (s.hidden) { warnings.push({ kind: 'hidden_sheet', sheet: s.name, row: 0, text: `「${s.name}」是隐藏的工作表，已跳过` }); continue }
    const m = mappings[s.name]
    if (!m) continue
    const r = applyMapping(s, m)
    warnings.push(...r.warnings)
    if (r.levels.size === 0) warnings.push({ kind: 'empty_level', sheet: s.name, row: 0, text: `「${s.name}」里没有识别出任何一课，请检查表头行数和列类型` })
    for (const [name, lessons] of r.levels) {
      if (!byLevel.has(name)) { byLevel.set(name, []); order.push(name) }
      byLevel.get(name)!.push(...lessons)
    }
  }
  // 课次没有重复就按课次排序；有重复（不同学期各自从 1 编号）就保持表里的顺序，免得穿插错乱
  const levels: ParsedLevel[] = order.map(name => {
    const ls = byLevel.get(name)!
    const unique = new Set(ls.map(l => l.seq)).size === ls.length
    return { name, lessons: unique ? ls.slice().sort((a, b) => a.seq - b.seq) : ls }
  })
  if (!levels.some(l => l.lessons.length)) warnings.push({ kind: 'no_lessons', sheet: '', row: 0, text: '没有识别出任何一课。可以下载模板重新整理一份，或手动指定每一列的类型' })
  return { levels, warnings }
}

/** 标题里已经写着「第 N 课」时，显示时去掉这个重复的开头（「第 3 课 Last weekend」→「Last weekend」） */
export function titleWithoutHead(head: string, title: string): string {
  const esc = [...head.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')   // 字与字之间允许有空格
  if (!esc) return title
  const rest = title.replace(new RegExp(`^\\s*${esc}[\\s:：、.\\-—]*`), '')
  return rest.trim() ? rest : title
}

/** 要显示给人看的一课的标签：第 N 课《标题》 */
export function lessonName(l: { seq: number; noLabel?: string | null; title?: string | null }): string {
  const no = (l.noLabel ?? '').trim()
  const head = !no || /^\d+$/.test(no) ? `第 ${no || l.seq} 课` : no
  const raw = (l.title ?? '').trim()
  const t = titleWithoutHead(head, raw)
  return t && t !== head ? `${head}《${t.length > 30 ? t.slice(0, 30) + '…' : t}》` : head
}

/** 预览给 AI 用的清理 */
export const cellForAi = (s: string, max = 60): string => cleanCell(s).replace(/\s+/g, ' ').slice(0, max)
