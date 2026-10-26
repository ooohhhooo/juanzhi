/**
 * 报告导出的纯函数部分（不依赖 electron，单测直接跑）：
 *  - Markdown 导出：每个有效引用 `[卷名 · 题号]` 后面接一张裁切图的链接，图片放在「同名文件夹」里（report.md → report/q-001.png）；
 *  - 哪些引用要出图、图片文件名是什么、Markdown 里的相对路径怎么写（中文文件夹名要做 URL 编码）。
 */
import { CITATION_RE } from '../../shared/citation.ts'
import type { CitationRef } from '../../shared/citation.ts'

export interface ImagePlan {
  file: string
  ref: CitationRef
}

const fileName = (n: number) => `q-${String(n).padStart(3, '0')}.png`

/** 文件名里不允许的字符换成下划线；不能为空、不能以点开头、不超过 80 个字符 */
export function safeStem(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim()
  return s || '考情分析报告'
}

export function planMarkdownExport(markdown: string, refs: Array<CitationRef & { missing?: boolean }>, dirName: string): { markdown: string; images: ImagePlan[] } {
  const byToken = new Map(refs.filter(r => !r.missing).map(r => [r.token, r]))
  const images: ImagePlan[] = []
  const fileOf = new Map<string, string>()
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let inFence = false
  const out = lines.map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line }
    if (inFence) return line
    return line.replace(CITATION_RE, (tok) => {
      const r = byToken.get(tok)
      if (!r) return tok
      let f = fileOf.get(tok)
      if (!f) { f = fileName(images.length + 1); fileOf.set(tok, f); images.push({ file: f, ref: r }) }
      return `${tok} ![题目截图：${tok.replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()}](${encodeURIComponent(dirName)}/${f})`
    })
  })
  return { markdown: out.join('\n'), images }
}

/** PDF：同一个引用只出一次图的数据，页面里用 token 找 */
export function uniqueRefs(markdown: string, refs: Array<CitationRef & { missing?: boolean }>): CitationRef[] {
  const byToken = new Map(refs.filter(r => !r.missing).map(r => [r.token, r]))
  const seen = new Set<string>()
  const out: CitationRef[] = []
  for (const m of markdown.matchAll(CITATION_RE)) {
    const r = byToken.get(m[0])
    if (r && !seen.has(r.token)) { seen.add(r.token); out.push(r) }
  }
  return out
}

/**
 * 导出的 .md 里模型输出的 HTML 要中和：应用内渲染和 PDF 都是转义的，但 .md 会被别的 Markdown 查看器（有的会渲染 HTML）打开，
 * 裸的 `<script>` / `<img onerror=…>` 不能原样写出去。把正文里的 `<` 换成 `&lt;`（代码围栏里的内容、我们自己生成的图片链接不受影响——它们不含 `<`）。
 */
export function neutralizeHtml(markdown: string): string {
  let inFence = false
  return markdown.replace(/\r\n/g, '\n').split('\n').map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line }
    return inFence ? line : line.replace(/</g, '&lt;')
  }).join('\n')
}
