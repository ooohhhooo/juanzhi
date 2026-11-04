/**
 * 报告内容 → 新分享卡片（绘本主角 / 绘本来信）的内容映射。纯逻辑，不依赖 electron，单测直接跑。
 * 口诀卡 → mnemonic，答题卡 → practice，家长版正文 → brief（绘本来信）。
 */
import { parseBlocks, parseInline, trickFields } from '../../shared/markdown.ts'
import type { Inline } from '../../shared/markdown.ts'

export interface Mapped { kind: 'mnemonic' | 'practice' | 'brief'; content: Record<string, any>; notes: string[] }

const inlineText = (xs: Inline[]): string => xs.map(x => (x.type === 'cite' ? '' : x.text)).join('').replace(/\s+/g, ' ').trim()
const plainText = (s: string): string => inlineText(parseInline(s))

/** 把一句口诀切成 2–6 行，每行 ≤ max 字：先按标点切，太长的硬切，行数多于 6 时合并最短的相邻两行 */
export function splitMnemonic(s: string, max = 24): string[] {
  const pieces = s.split(/[，。；、！？,;!?]+|\.(?:\s|$)/).map(x => x.trim()).filter(Boolean)
  let out: string[] = []
  for (const p of pieces) for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max))
  while (out.length > 6) {
    let bi = 0
    let bl = Infinity
    for (let i = 0; i < out.length - 1; i++) { const l = out[i].length + out[i + 1].length; if (l < bl) { bl = l; bi = i } }
    out = [...out.slice(0, bi), out[bi] + ' ' + out[bi + 1], ...out.slice(bi + 2)]
  }
  if (out.length === 1) {
    const t = out[0]
    const h = Math.ceil(t.length / 2)
    out = t.length >= 2 ? [t.slice(0, h), t.slice(h)] : [t, t]
  }
  return out.map(x => x.slice(0, max))
}

type CardBlock = Extract<ReturnType<typeof parseBlocks>[number], { type: 'card' }>
const cardsOf = (markdown: string, kind: 'trick' | 'answercard'): CardBlock[] =>
  parseBlocks(markdown).filter((b): b is CardBlock => b.type === 'card' && b.kind === kind)

export function trickToCard(markdown: string, index: number): Mapped | null {
  const c = cardsOf(markdown, 'trick')[index]
  if (!c) return null
  const f = trickFields(c.raw)
  const main = plainText(f.main)
  const example = plainText(f.example)
  const from = plainText(f.from)
  const examples: Array<{ label: string; text: string }> = []
  if (example) examples.push({ label: '例句', text: example })
  if (from) examples.push({ label: '出自', text: from })
  if (examples.length < 2) examples.push({ label: '记住', text: '多念几遍，做题时就想起来' })
  if (examples.length < 2) examples.push({ label: '加油', text: '每天念一念，慢慢就会了' })
  if (!main) throw new Error('这张口诀卡里没有口诀内容')
  return { kind: 'mnemonic', content: { title: c.title || '口诀大招', lines: splitMnemonic(main).map(text => ({ text })), examples }, notes: [] }
}

export function answercardToCard(markdown: string, index: number): Mapped | null {
  const c = cardsOf(markdown, 'answercard')[index]
  if (!c) return null
  const notes: string[] = []
  if (c.items.length < 2) throw new Error('答题卡里至少要有 2 道题才能做成图片：请先在下面逐题勾「我核对过」')
  if (c.items.length > 4) notes.push(`图片版每张最多放 4 道题，这张答题卡共 ${c.items.length} 道，图片里只放了前 4 道`)
  const questions = c.items.slice(0, 4).map(it => {
    const a = it.answer
    const stem = inlineText(it.stem)
    const q = a && a.type !== 'choice' ? `${stem}（${a.type === 'blank' ? '填空' : '写一写'}）` : stem
    const options = a?.type === 'choice' ? a.options.slice(0, 4).map((o, i) => `${'ABCD'[i]}. ${o}`) : undefined
    return { q, ...(options ? { options } : {}) }
  })
  return { kind: 'practice', content: { title: c.title || '小练习', questions }, notes }
}

// ── 家长版 → 绘本来信（brief） ──
const SECTION_BODY_MAX = 80
const HEADING_MAX = 12
const SECTIONS_MAX = 4
const sentencesOf = (s: string): string[] => s.split(/(?<=[。！？!?])/).map(x => x.trim()).filter(Boolean)
const CN = '一二三四'

/**
 * 家长版纯文本（复制到微信的口径）→ brief 的 1–4 个分节。整句取舍，不会把一句话截成半句：
 * 每个编号要点按顺序放入完整句子直到 80 字；放不下的句子整句不要；第一句就超过 80 字的要点整条不要。
 */
export function parentTextToBrief(text: string): Mapped {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  const items = lines.map(l => /^\d+[.、)]\s*(.+)$/.exec(l)?.[1]).filter((x): x is string => !!x)
  const sources = items.length ? items : [lines.length > 2 ? lines.slice(1, -1).join('') : lines.join('')]
  let total = 0
  let used = 0
  const sections: Array<{ heading: string; body: string }> = []
  sources.forEach((src, i) => {
    const m = /^([^：:，。]{2,12})[：:]\s*(.+)$/.exec(src)
    const heading = m ? m[1] : `要点${CN[i] ?? i + 1}`
    const sents = sentencesOf(m ? m[2] : src)
    total += sents.length
    if (sections.length >= SECTIONS_MAX) return
    let body = ''
    let n = 0
    for (const s of sents) {
      if ([...(body + s)].length > SECTION_BODY_MAX) break
      body += s
      n++
    }
    if (!n) return
    used += n
    sections.push({ heading: [...heading].slice(0, HEADING_MAX).join(''), body })
  })
  if (!sections.length) throw new Error('这份家长版的句子都太长，放不进卡片，请改用复制到微信或导出')
  const notes: string[] = []
  if (used < total) notes.push(`文字较长，卡片上放了前 ${used} 句完整的话（共 ${total} 句），其余没有放进去`)
  return { kind: 'brief', content: { title: '给家长的话', sections }, notes }
}
