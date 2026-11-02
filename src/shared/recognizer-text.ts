/**
 * 「这一页是怎么识别的、为什么」的白话（M9 D2）：试卷详情、审核页的「识别方式」小卡用。
 * 纯函数，主进程和界面共用，单测直接加载。给运营 / 老师看，不出现 OCR、token 之类的词。
 */

export interface PageRec {
  idx: number
  recognizer: string | null
  ocrLang: string | null
  reason: string | null
  /** 本机识别质量不好 */
  low: boolean
}

/** Windows 语言包的教程（应用内没有文档查看器，直接指向仓库里的文档） */
export const OCR_TUTORIAL_URL = 'https://github.com/ooohhhooo/juanzhi/blob/main/docs/Windows%E4%B8%AD%E6%96%87%E8%AF%86%E5%88%AB%E5%AE%89%E8%A3%85.md'

const isZh = (lang: string | null | undefined) => !!lang && /^zh/i.test(lang)

export function recognizerTitle(p: Pick<PageRec, 'recognizer' | 'ocrLang'>): string {
  switch (p.recognizer) {
    case 'pdf-text': return 'PDF 自带文字层'
    case 'mac-vision': return 'Mac 自带识别'
    case 'win-ocr':
      if (!p.ocrLang) return 'Windows 自带识别'
      return isZh(p.ocrLang) ? 'Windows 自带识别（中文）' : `Windows 自带识别（${/^en/i.test(p.ocrLang) ? 'English' : p.ocrLang}）`
    case 'docx-text': return 'Word 文件：直接读取文字，不经过识别'
    case 'vision-model': return 'AI 读图'
    default: return '未记录'
  }
}

/** 这一页的识别有什么要注意的（空 = 没有） */
export function recognizerNote(p: Pick<PageRec, 'recognizer' | 'ocrLang' | 'reason' | 'low'>): string {
  if (p.recognizer === 'win-ocr' && p.ocrLang && !isZh(p.ocrLang)) return '没装中文语言包，中文可能认不全'
  if (p.low && p.recognizer !== 'vision-model') return '识别效果不太好，可能有认错或漏掉的字'
  return ''
}

export function reasonText(reason: string | null): string {
  switch (reason) {
    case 'text-layer-ok': return '文字层可信，直接使用，不需要识别'
    case 'docx-text': return 'Word 里的文字可以直接读出来'
    case 'ocr-ok': return '本机识别的文字够用'
    case 'low-quality': return '本机识别的文字乱码多或太少，所以交给 AI 读图'
    case 'lang-mismatch': return '这台电脑没装中文识别，中文认不全，所以交给 AI 读图'
    case 'low-conf': return '本机识别把握不大，所以交给 AI 读图'
    case 'policy-images-always': return '你在设置里选了「图片和扫描件一律交给 AI 读图」'
    case 'ocr-failed': return '本机识别没有成功，所以交给 AI 读图'
    case 'no-text': return '本机没有识别出文字，所以交给 AI 读图'
    case 'no-vision-model': return '识别效果不好，但还没有设置能读图的 AI 模型，只能用现有的文字'
    case 'vision-never': return '你在设置里选了「从不读图」，所以只用本机识别的文字'
    case 'vision-forbidden': return 'AI 读图时这个密钥没有权限，已改用本机识别的文字'
    default: return ''
  }
}

export interface RecGroup { from: number; to: number; title: string; note: string; why: string; needsZhPack: boolean; /** 旧版本提取的 Windows 识别，没有记录识别语言：重新提取后才能检查中文够不够 */ legacyWin: boolean }

/** 把相邻、方式和原因都相同的页并成一条：「第 1–3 页：Windows 自带识别（English）　中文可能认不全」 */
export function groupPages(pages: PageRec[]): RecGroup[] {
  const out: RecGroup[] = []
  for (const p of [...pages].sort((a, b) => a.idx - b.idx)) {
    const title = recognizerTitle(p)
    const note = recognizerNote(p)
    const why = reasonText(p.reason)
    const last = out[out.length - 1]
    if (last && last.title === title && last.note === note && last.why === why && last.to === p.idx - 1) { last.to = p.idx; continue }
    out.push({ from: p.idx, to: p.idx, title, note, why, needsZhPack: p.recognizer === 'win-ocr' && !!p.ocrLang && !isZh(p.ocrLang), legacyWin: p.recognizer === 'win-ocr' && !p.ocrLang })
  }
  return out
}

export function rangeText(g: Pick<RecGroup, 'from' | 'to'>): string {
  return g.from === g.to ? `第 ${g.from} 页` : `第 ${g.from}–${g.to} 页`
}

/** 整份卷子的识别可能不完整吗：有本机识别不好、又没有改用 AI 读图的页，或者引擎不是中文 */
export function paperIncomplete(pages: PageRec[]): boolean {
  return pages.some(p => p.low && p.recognizer !== 'vision-model')
}
