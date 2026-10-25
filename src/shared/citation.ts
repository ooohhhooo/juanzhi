/**
 * P2/P3 输出里的样本题引用：`[试卷标题 · 题号]`。
 * token 由程序生成并建立索引（提示词约定 §7.5），模型只能原样复制；输出后按索引校验，不在索引里的引用被移除。
 * 主进程（生成与校验）和渲染端（把引用渲染成可点击的截图卡片）共用这一份定义。
 */

export const CITATION_RE = /\[([^\[\]\n·]{1,60}?) · ([^\[\]\n·]{1,30}?)\]/g

const clean = (s: string, max: number) => s.replace(/[\[\]·\n\r|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export const makeToken = (title: string, no: string) => `[${clean(title, 40) || '未命名试卷'} · ${clean(no, 20) || '?'}]`

export interface CitationRef {
  token: string
  questionId: string
  paperId: string
  paperTitle: string
  no: string
  qtypeName: string
  page_idx: number | null
  pageRel: string | null
  pageW: number
  pageH: number
  bbox: number[] | null
}

export interface TextPiece { type: 'text'; text: string }
export interface CitePiece { type: 'cite'; token: string }

/** 把一段文字切成「普通文字 / 引用」 */
export function splitCitations(text: string): Array<TextPiece | CitePiece> {
  const out: Array<TextPiece | CitePiece> = []
  let last = 0
  for (const m of text.matchAll(CITATION_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ type: 'text', text: text.slice(last, i) })
    out.push({ type: 'cite', token: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** 校验模型输出里的引用：不在索引里的（模型自造或改写的）整个移除，返回处理后的文本和被移除的数量 */
export function stripUnknownCitations(markdown: string, known: Set<string>): { text: string; removed: string[] } {
  const removed: string[] = []
  const text = markdown.replace(CITATION_RE, (m) => {
    if (known.has(m)) return m
    removed.push(m)
    return ''
  })
  return { text, removed }
}
