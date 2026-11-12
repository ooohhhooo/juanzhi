/**
 * 书库：把一本书的逐页文字变成“书库数据”（纯逻辑，页文字从哪来由调用方注入，所以单测和本机验证脚本都能直接跑）。
 * 不用 AI 理解书的内容：存原文和页码；AI 只在“某页属于哪个单元”边界认不出时，从已认出的单元里选一个。
 */
import { cleanPage, looksLikeMappedPinyin } from './text.ts'
import { analyzeStructure, resolveUncertain } from './structure.ts'
import type { PageKind, PageIn, Structure, UnitClassifier } from './structure.ts'
import { parseAppendix } from './appendix.ts'
import type { AppendixItem } from './appendix.ts'
import { judgeTextLayer } from '../pipeline/textquality.ts'

export interface BookPage {
  page: number
  printed: number | null
  unitSeq: number | null
  kind: PageKind
  /** text = PDF 文字层；ocr = 文字识别；none = 没有文字 */
  via: 'text' | 'ocr' | 'none'
  text: string
  pinyinRemoved: number
}
export interface BookSummary {
  units: number
  words: number
  sentences: number
  chars: number
  writeChars: number
  phrases: number
  pages: number
  textPages: number
  ocrPages: number
  emptyPages: number[]
  pinyinPages: number
  unitVia: string
  notes: string[]
  /** 给界面显示的一句话 */
  line: string
}
export interface BookData {
  hash: string
  name: string
  pages: BookPage[]
  structure: Structure
  appendix: AppendixItem[]
  summary: BookSummary
}

export interface BuildInput {
  hash: string
  name: string
  /** 全书逐页的文字层（每页一个行数组；没有文字层的页给空数组）。长书分批读，这里一次交给我 */
  textLayer: () => Promise<string[][]>
  /** 文字识别一页（页码 1 起）；没有可用的识别就不传，没文字的页就记为“没有文字” */
  ocr?: (page: number) => Promise<string[]>
  classify?: UnitClassifier
  signal?: AbortSignal
  onProgress?: (done: number, total: number, what: string) => void
}

const MIN_TEXT_CHARS = 12
const visibleLen = (lines: string[]) => lines.join('').replace(/\s/g, '').length

/** 文字层这一页要不要改走文字识别：几乎没字，或者满是乱码 */
export function needsOcr(lines: string[]): boolean {
  const n = visibleLen(lines)
  if (n < MIN_TEXT_CHARS) return true
  if (n >= 50) return !judgeTextLayer(lines.join('\n')).usable
  return false
}

export async function buildBook(inp: BuildInput): Promise<BookData> {
  const raw = await inp.textLayer()
  const total = raw.length
  const strip = looksLikeMappedPinyin(raw)
  const pages: PageIn[] = []
  const meta: Array<{ via: 'text' | 'ocr' | 'none'; pinyin: number }> = []
  let ocrDone = 0
  for (let i = 0; i < total; i++) {
    if (inp.signal?.aborted) throw new Error('已取消')
    let lines = raw[i]
    let via: 'text' | 'ocr' | 'none' = visibleLen(lines) ? 'text' : 'none'
    if (needsOcr(lines) && inp.ocr) {
      try {
        const o = await inp.ocr(i + 1)
        if (visibleLen(o) > visibleLen(lines)) { lines = o; via = 'ocr'; ocrDone++ }
      } catch (e) {
        if (inp.signal?.aborted) throw e
        /* 这一页识别失败：保留文字层里有的 */
      }
      inp.onProgress?.(i + 1, total, '页（文字识别）')
    } else if (i % 20 === 0) inp.onProgress?.(i + 1, total, '页')
    const c = cleanPage(lines, strip)
    pages.push({ page: i + 1, text: c.text, lines: c.lines, empty: visibleLen(c.lines) < 3 })
    meta.push({ via: c.text ? via : 'none', pinyin: c.pinyinRemoved })
  }

  const structure = analyzeStructure(pages)
  const changed = await resolveUncertain(structure, pages, inp.classify)
  if (changed) structure.notes.push(`有 ${changed} 页的单元归属由 AI 在已认出的单元里选定`)
  const appendix = parseAppendix(pages, structure)

  const out: BookPage[] = pages.map((p, i) => ({
    page: p.page, printed: structure.printed[i], unitSeq: structure.pageUnit[i], kind: structure.kinds[i],
    via: meta[i].via, text: p.text, pinyinRemoved: meta[i].pinyin
  }))
  const count = (k: AppendixItem['kind']) => appendix.filter(a => a.kind === k).length
  const emptyPages = out.filter(p => p.via === 'none' && p.kind !== 'front' && p.kind !== 'back').map(p => p.page)
  const summary: BookSummary = {
    units: structure.units.length, words: count('word'), sentences: count('sentence'), chars: count('char-read'), writeChars: count('char-write'), phrases: count('phrase'),
    pages: total, textPages: out.filter(p => p.via === 'text').length, ocrPages: ocrDone, emptyPages,
    pinyinPages: meta.filter(m => m.pinyin > 0).length, unitVia: structure.via, notes: structure.notes, line: ''
  }
  summary.line = summaryLine(summary)
  return { hash: inp.hash, name: inp.name, pages: out, structure, appendix, summary }
}

export function summaryLine(s: BookSummary): string {
  const parts = [`${s.units} 个单元`]
  if (s.words) parts.push(`${s.words} 个单词`)
  if (s.sentences) parts.push(`${s.sentences} 个句子`)
  if (s.chars) parts.push(`${s.chars} 个识字`)
  if (s.writeChars) parts.push(`${s.writeChars} 个写字`)
  if (s.phrases) parts.push(`${s.phrases} 个词语`)
  parts.push(`共 ${s.pages} 页`)
  if (s.ocrPages) parts.push(`其中 ${s.ocrPages} 页靠文字识别`)
  if (s.emptyPages.length) parts.push(`第 ${s.emptyPages.slice(0, 8).join('、')} 页${s.emptyPages.length > 8 ? '等' : ''}没有文字`)
  if (s.unitVia !== 'toc') parts.push(s.unitVia === 'heading' ? '没有可用目录，单元按正文标题切' : '没认出单元，按每 10 页切了一块')
  return parts.join('，')
}
