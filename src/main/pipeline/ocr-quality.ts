/**
 * 本机识别的质量判断，以及「这一页交给本机文字还是 AI 读图」的决定（M9 D1/D2）。纯函数，不依赖 electron，单测直接加载。
 *
 * 为什么需要它：Windows 自带 OCR 不给置信度（ocr.ps1 固定写 0.8），原来只有「置信度 < 0.55」才改用视觉模型，
 * 于是 Windows 上只要识别出几行字（哪怕引擎是 en-US、中文全成了乱码）就永远不会用到视觉模型。
 * 现在改成看文字本身：引擎语言对不对、乱码占多少、行数和字数够不够——不再相信那个固定的 0.8。
 */

/** 一页的识别方式 */
export type Recognizer = 'pdf-text' | 'mac-vision' | 'win-ocr' | 'docx-text' | 'vision-model'

/** 为什么这一页用了这种方式（界面再翻成白话，见 shared/recognizer-text.ts） */
export type RecReason =
  | 'text-layer-ok'          // PDF 自带文字层可信
  | 'docx-text'              // Word 直接读取文字
  | 'ocr-ok'                 // 本机识别质量够用
  | 'low-quality'            // 本机识别乱码多 / 行数太少 → 读图
  | 'lang-mismatch'          // Windows 没有中文识别引擎 → 读图
  | 'low-conf'               // 识别置信度低 → 读图
  | 'policy-images-always'   // 设置里选了「图片和扫描件一律交给 AI 读图」
  | 'ocr-failed'             // 本机识别没成功 → 读图
  | 'no-text'                // 本机识别没读出文字 → 读图
  | 'no-vision-model'        // 识别不好，但没有可用的视觉模型，仍用本机文字
  | 'vision-never'           // 设置里选了「从不读图」，识别不好也用本机文字
  | 'vision-forbidden'       // 读图时密钥没有权限，已改用本机文字

export interface PageQuality {
  low: boolean
  /** low 时的原因（只在 low 为 true 时有意义） */
  why: 'ok' | 'lang-mismatch' | 'garbled' | 'sparse' | 'low-conf' | 'empty'
  /** 乱码字符占比 */
  garbled: number
  /** 中日韩字符占比 */
  cjk: number
  lines: number
  chars: number
}

const CJK_RE = /[㐀-鿿豈-﫿]/
const SPACE_RE = /\s/
/** 乱码字符：替换符、私有区、控制字符 */
const BAD_RE = /[�-\u0000-\u0008\u000b\u000c\u000e-\u001f]/
/** 正常文字里会出现的字符：字母、数字、标点、常见符号、中日韩 */
const OK_RE = /[\p{L}\p{N}\p{P}\p{Sc}\p{Sm}\p{Sk}\p{So}]/u

export const MIN_LINES = 3
export const MIN_CHARS = 30
export const MAX_GARBLED = 0.08
export const LOW_OCR_CONF = 0.55
/** 同一份卷子里 CJK 占比达到它，就认为这份卷子「本应含中文」 */
export const CJK_EXPECT_RATIO = 0.08

export function textStats(texts: string[]): { chars: number; cjk: number; garbled: number; lines: number } {
  let chars = 0, cjk = 0, bad = 0
  for (const t of texts) {
    for (const c of t) {
      if (SPACE_RE.test(c)) continue
      chars++
      if (CJK_RE.test(c)) cjk++
      else if (BAD_RE.test(c) || !OK_RE.test(c)) bad++
    }
  }
  return { chars, cjk: chars ? cjk / chars : 0, garbled: chars ? bad / chars : 0, lines: texts.filter(t => t.trim()).length }
}

/**
 * 判断一页本机识别结果的质量。
 *  - lang：引擎实际使用的语言（Windows 才有；如 zh-Hans-CN / en-US）。非 zh* 且这份卷子本应含中文 → 直接判低，不用看文字
 *  - paperExpectsCjk：这份卷子是否本应含中文（见 paperExpectsCjk）。不确定时传 false——只在有证据时才下结论
 *  - conf：识别置信度（macOS 有；Windows 的固定值不可信，调用方传 null）
 */
export function ocrQuality(texts: string[], opts: { lang?: string | null; paperExpectsCjk: boolean; nameHasCjk?: boolean; conf?: number | null }): PageQuality {
  const st = textStats(texts)
  const base = { garbled: st.garbled, cjk: st.cjk, lines: st.lines, chars: st.chars }
  if (st.chars === 0) return { low: true, why: 'empty', ...base }
  if (opts.lang && !/^zh/i.test(opts.lang)) {
    // 有页面证据表明卷子里有中文 → 直接判。只有文件名 / 标题里有中文是弱证据（英文卷也可能叫「2024海淀期末英语.pdf」），
    // 要再加上别的坏信号（乱码多 / 行数字数太少）才判
    if (opts.paperExpectsCjk) return { low: true, why: 'lang-mismatch', ...base }
    if (opts.nameHasCjk && (st.garbled > MAX_GARBLED / 2 || st.lines < MIN_LINES || st.chars < MIN_CHARS)) return { low: true, why: 'lang-mismatch', ...base }
  }
  if (st.garbled > MAX_GARBLED) return { low: true, why: 'garbled', ...base }
  if (st.lines < MIN_LINES || st.chars < MIN_CHARS) return { low: true, why: 'sparse', ...base }
  if (opts.conf != null && opts.conf < LOW_OCR_CONF) return { low: true, why: 'low-conf', ...base }
  return { low: false, why: 'ok', ...base }
}

/** 文件名 / 标题里有中文（弱证据，见 ocrQuality） */
export function namesHaveCjk(names: string[]): boolean {
  return names.some(n => CJK_RE.test(n))
}

/**
 * 这份卷子本应含中文吗：任何一页（PDF 文字层、中文引擎的识别结果）里中文占比达到阈值。
 * 纯英文卷子没有这些证据 → false，不乱提示。
 */
export function paperExpectsCjk(args: { pageTexts: Array<{ texts: string[]; trustedForCjk: boolean }> }): boolean {
  return args.pageTexts.some(p => p.trustedForCjk && textStats(p.texts).cjk >= CJK_EXPECT_RATIO)
}

/**
 * 封面、答案页、最后一页本来就很短：同一份卷子里有别的正常的页时，「太短」的页不算识别不好。
 * quals：每页的质量（没有质量的页 = PDF 文字层 / Word，当作正常）。返回处理后的质量（顺序不变）。
 */
export function relaxSparse<T extends PageQuality | null>(quals: T[]): T[] {
  const hasNormal = quals.some(q => q === null || !q.low)
  if (!hasNormal) return quals
  return quals.map(q => (q && q.low && q.why === 'sparse' ? ({ ...q, low: false, why: 'ok' } as T) : q))
}

export type VisionPolicy = 'auto' | 'images_always' | 'never'

export interface PageFacts {
  textSource: string
  hasImage: boolean
  /** 本页有几行可用文字（经过整理后的行） */
  rowTexts: string[]
  lang: string | null
  /** 本机识别的置信度；Windows 传 null（固定值不可信） */
  conf: number | null
  /** 之前存下的质量判断（提取时算好的）；没有就现场算 */
  quality?: PageQuality | null
}

export interface PageChoice {
  mode: 'text' | 'vision' | 'skip'
  reason: RecReason
  quality: PageQuality | null
  /** 本页识别质量不好（不管最后有没有改用读图） */
  low: boolean
}

/**
 * 每页走文本还是读图（默认策略 auto：只有本机识别不好的页才交给视觉模型）。
 * visionReady = 配了视觉模型、有可用的密钥、这页有页面图。
 */
export function decidePage(f: PageFacts, ctx: { policy: VisionPolicy; visionReady: boolean; expectsCjk: boolean; nameHasCjk?: boolean }): PageChoice {
  const canVision = ctx.visionReady && f.hasImage && ctx.policy !== 'never'
  const none = (mode: PageChoice['mode'], reason: RecReason, q: PageQuality | null, low: boolean): PageChoice => ({ mode, reason, quality: q, low })
  if (f.textSource === 'docx') return none(f.rowTexts.length ? 'text' : 'skip', 'docx-text', null, false)
  if (f.textSource === 'pdf-text') return none(f.rowTexts.length ? 'text' : canVision ? 'vision' : 'skip', 'text-layer-ok', null, false)

  // 本机识别没成功 / 没读出字：只能读图
  if (f.textSource === 'ocr_failed' || f.textSource === 'needs_ocr') return none(canVision ? 'vision' : 'skip', 'ocr-failed', null, true)
  if (f.textSource === 'none' || f.rowTexts.length === 0) return none(canVision ? 'vision' : 'skip', 'no-text', null, true)

  // 本机识别出了文字（图片 / 扫描件 / 扫描 PDF）
  const q = f.quality ?? ocrQuality(f.rowTexts, { lang: f.lang, paperExpectsCjk: ctx.expectsCjk, nameHasCjk: ctx.nameHasCjk, conf: f.conf })
  if (ctx.policy === 'images_always' && canVision) return none('vision', 'policy-images-always', q, q.low)
  if (!q.low) return none('text', 'ocr-ok', q, false)
  // 只是置信度偏低（macOS 的置信度整体偏低，干净的页面也常在 0.5 上下）：有视觉模型就读图（老行为），没有就照用本机文字，不报「识别不完整」
  if (q.why === 'low-conf' && !canVision) return none('text', 'ocr-ok', q, false)
  const reason: RecReason = q.why === 'lang-mismatch' ? 'lang-mismatch' : q.why === 'low-conf' ? 'low-conf' : 'low-quality'
  if (canVision) return none('vision', reason, q, true)
  return none('text', ctx.policy === 'never' ? 'vision-never' : 'no-vision-model', q, true)
}
