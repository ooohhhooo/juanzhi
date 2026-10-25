/**
 * PDF 文本层质量门：字数够不代表可信。
 * 字体缺 ToUnicode 时 pdf.js 会读出私有区字符 / U+FFFD，扫描件被加了页眉水印时文本层有字但正文是图。
 */
const MIN_CHARS = 50
const MIN_READABLE_RATIO = 0.8
const MAX_BAD_RATIO = 0.05

const READABLE = /[\p{L}\p{N}\p{P}\p{S}]/u
const BAD = /[�-]/

export interface TextLayerVerdict {
  usable: boolean
  chars: number
  reason?: string
}

export function judgeTextLayer(text: string): TextLayerVerdict {
  const visible = Array.from(text).filter(c => !/\s/.test(c))
  const chars = visible.length
  if (chars < MIN_CHARS) return { usable: false, chars, reason: `文本层只有 ${chars} 个字符` }

  const bad = visible.filter(c => BAD.test(c)).length
  if (bad / chars > MAX_BAD_RATIO) return { usable: false, chars, reason: '文本层含大量乱码字符（缺少 ToUnicode 映射）' }

  const readable = visible.filter(c => READABLE.test(c) && !BAD.test(c)).length
  if (readable / chars < MIN_READABLE_RATIO) return { usable: false, chars, reason: '文本层可读字符占比过低' }

  return { usable: true, chars }
}
