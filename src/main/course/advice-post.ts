/**
 * 家长沟通话术（p5_course_advice / p5_course_hint）的程序侧收尾。纯函数模块。
 * AI 的话不能直接发出去：价格、营销、夸大承诺一律整句删掉；课程用 [课#12] 令牌交给 AI，输出后由程序换成完整课名，
 * 不在输入里的令牌删除并告警；字数不在范围内只告警、不自动裁剪；讲英语规则的句子过事实核对（在调用处做）。
 */
import { checkRules, markFindings } from '../../shared/factcheck.ts'

/** 价格 / 营销 / 夸大承诺（命中的句子整句删除）。注意：先在令牌还没换成课名的文本上检查，课名里的字不会误伤 */
export const FORBIDDEN_RE = new RegExp([
  '价格|价钱|学费|费用|收费|付费|优惠|折扣|打折|立减|特价|促销|秒杀|赠送|免费领|下单|购买|买课|报名|抢购|限时|限量|名额|早鸟|续费|团购|试听课?免费',
  '保证|保障|一定能|一定会|一定可以|一定有效|必定|必然提高|包过|包会|立刻见效|立竿见影|马上提分|快速提分|提分|提高\\s*\\d+\\s*分|提升\\s*\\d+\\s*分|最好|最佳|最强|最有效|唯一|绝对|百分之百|100\\s*%|无敌|秒懂|排名第一|行业第一|全国第一|第一名',
  '\\d+(?:\\.\\d+)?\\s*(?:元|块钱|折|%|％|百分点)'
].join('|'))

export const MIN_CHARS = 80
export const ADVICE_RANGE: [number, number] = [150, 200]

/** 只数「字」：去掉空白、标点和 Markdown 符号 */
export const countChars = (s: string): number => s.replace(/[\s　*_`#>\-\[\]（）()「」《》“”"'‘’、，。！？；：,.!?;:…—]/g, '').length

export interface AdviceFinish {
  text: string
  ok: boolean
  /** 不能用的原因（ok = false 时） */
  failReason: string | null
  warnings: string[]
  removedSentences: number
  unknownTokens: number
  /** 文字里用到的课（id） */
  usedLessonIds: number[]
  chars: number
}

const TOKEN_RE = /[\[［【]\s*课\s*#\s*(\d+)\s*[\]］】]/g

/** 按句切开，保留标点和换行 */
function sentences(text: string): string[] {
  return text.match(/[^。！？!?；;\n]+[。！？!?；;]*\n*|\n+/g) ?? [text]
}

export function stripMarkdownNoise(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/^\s*#{1,6}\s+.*$/gm, '').replace(/\*\*/g, '').replace(/^\s*[-*]\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 令牌换成课名；labels 里没有的令牌删除并计数 */
export function replaceLessonTokens(text: string, labels: Map<number, string>): { text: string; unknown: number; used: number[] } {
  let unknown = 0
  const used: number[] = []
  const out = text.replace(TOKEN_RE, (_m, id) => {
    const n = parseInt(id, 10)
    const l = labels.get(n)
    if (!l) { unknown++; return '' }
    if (!used.includes(n)) used.push(n)
    return `「${l}」`
  })
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/（\s*）|\(\s*\)/g, ''), unknown, used }
}

/**
 * 收尾。opts.range 给了就检查字数（话术 150–200；一句话建议不检查）。
 * opts.statements 是事实核对用的证据句子：给了就把对不上的规则句标「未核实」（返回的 text 里带标记）。
 */
export function finishAdvice(raw: string, labels: Map<number, string>, opts: { range?: [number, number] | null; minChars?: number; statements?: string[] } = {}): AdviceFinish & { findings: Array<{ sentence: string; kind: 'unverified' | 'conflict'; reason: string }> } {
  const warnings: string[] = []
  const range = opts.range === undefined ? ADVICE_RANGE : opts.range
  const minChars = opts.minChars ?? MIN_CHARS
  let text = stripMarkdownNoise(raw)
  // 1. 禁用词：整句删除（令牌还没换成课名，课名里的字不会误伤）
  let removed = 0
  text = sentences(text).filter(s => { if (FORBIDDEN_RE.test(s)) { removed++; return false } return true }).join('')
  if (removed) warnings.push(`已删除 ${removed} 句含价格、营销或夸大承诺的话`)
  // 字数按 AI 自己写的字算（课令牌不计：换成完整课名后会变长，那不是 AI 写的字）
  const chars = countChars(text.replace(TOKEN_RE, ''))
  // 2. 令牌
  const rep = replaceLessonTokens(text, labels)
  text = rep.text.replace(/\n{3,}/g, '\n\n').trim()
  if (rep.unknown) warnings.push(`已移除 ${rep.unknown} 处无法核对的课程引用（AI 写出了输入里没有的课）`)
  // 3. 事实核对
  let findings: Array<{ sentence: string; kind: 'unverified' | 'conflict'; reason: string }> = []
  if (opts.statements) {
    const f = checkRules(text, opts.statements)
    findings = f.map(x => ({ sentence: x.sentence, kind: x.kind, reason: x.reason }))
    text = markFindings(text, f).text
  }
  let ok = true
  let failReason: string | null = null
  if (chars < minChars) { ok = false; failReason = `删掉不合规的句子后只剩 ${chars} 字，内容太少，不能使用，请重新生成` }
  else if (range && (chars < range[0] || chars > range[1])) warnings.push(`${chars} 字，建议 ${range[0]}–${range[1]} 字`)
  return { text, ok, failReason, warnings, removedSentences: removed, unknownTokens: rep.unknown, usedLessonIds: rep.used, chars, findings }
}
