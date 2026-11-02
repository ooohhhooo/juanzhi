/**
 * AI 变形题的程序侧校验（M9 §2.5）。纯函数，单测直接加载。
 * 出题只给 AI 考点和题型（不给原题原文）；这里把关三件事：结构对不对、有没有照抄原卷、用词有没有超纲；
 * 第二次独立解答的比对（compareAnswers）也在这里：答案不一致的题标 flagged，不进答题卡，除非老师逐题核对后仍然使用。
 */
import { hasOverclaim, parseJsonLoose } from './teacher-sections.ts'

export type VariantType = 'choice' | 'blank'

export interface DraftVariant {
  seq: number
  kp_code: string | null
  qtype: VariantType
  stem: string
  options: string[]
  answer: string
  explanation: string
  changed: string
  /** 不阻断、只提示的问题（超纲词、讲解太长……） */
  hints: string[]
  /** 阻断的问题：非空 = 这道题被剔除（status = dropped） */
  problems: string[]
}

const clean = (s: unknown): string => (typeof s === 'string' ? s : '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
const LETTERS = ['A', 'B', 'C', 'D']

/** 词集：英文单词按小写词算，中文按单字算 */
export function tokensOf(text: string): Set<string> {
  const s = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z]+(?:'[a-z]+)?/g)) s.add(m[0])
  for (const m of text.matchAll(/[一-龥]/g)) s.add(m[0])
  return s
}

/** Jaccard 相似度（词集） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export const COPY_THRESHOLD = 0.8

/** 小学范围常见的功能词：永远不算超纲 */
const FUNCTION_WORDS = new Set(('a an the i you he she it we they me him her us them my your his its our their this that these those is am are was were be been do does did have has had will can may must should would could ' +
  'not no yes and or but so if when what who where which how why in on at to of for with from by about up down out into over under there here very too also some any many much more most one two three four five six seven eight nine ten ' +
  'please thank thanks hello hi good morning afternoon evening night name like want go see look let s t d ll m re ve don doesn isn aren am').split(/\s+/))

/**
 * 词汇范围：题干和选项里的英文词不在白名单（已审核试卷里出现过的词 + 知识点例词 + 功能词）里 → 只提示，不阻断。
 * 白名单太小（< MIN_VOCAB 个词）时不检查。
 */
/** 白名单太小（库里试卷太少）时检查没意义，只会满屏误报：不检查 */
export const MIN_VOCAB = 80
export function outOfVocab(texts: string[], vocab: Set<string>, minSize = MIN_VOCAB): string[] {
  if (vocab.size < minSize) return []
  const out: string[] = []
  for (const t of texts) for (const m of t.toLowerCase().matchAll(/[a-z]+(?:'[a-z]+)?/g)) {
    const w = m[0]
    if (w.length <= 1 || FUNCTION_WORDS.has(w) || vocab.has(w) || vocab.has(w.replace(/(es|s|ed|ing)$/, '')) || out.includes(w)) continue
    out.push(w)
  }
  return out
}

const normAnswer = (s: string): string => s.toLowerCase().replace(/[\s.,!?;:'"。，！？]/g, '')

/**
 * 校验 AI 一次出的几道题。
 * @param raw 模型原始输出（JSON 文本）
 * @param ctx.kpCodes 本次传给 AI 的考点（序号 n → 代码），AI 用序号 `n` 指回考点
 * @param ctx.originals 原卷里这些考点的题干 + 选项原文（只在本机用来查抄袭，不发给 AI）
 * @param ctx.vocab 词汇白名单
 */
export function validateVariants(raw: string, ctx: { kpCodes: string[]; originals: string[]; vocab: Set<string>; max?: number }): { variants: DraftVariant[]; error: string | null } {
  const j = parseJsonLoose(raw) as any
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.questions) ? j.questions : []
  if (list.length === 0) return { variants: [], error: '模型没有给出可以读取的题目' }
  const origSets = ctx.originals.map(tokensOf)
  const out: DraftVariant[] = []
  const max = ctx.max ?? 3
  for (const q of list.slice(0, Math.max(max, 3) + 2)) {
    const problems: string[] = []
    const hints: string[] = []
    const qtype: VariantType = q?.qtype === 'blank' || q?.qtype === 'fill' ? 'blank' : 'choice'
    const stem = clean(q?.stem)
    let options = Array.isArray(q?.options) ? q.options.map((o: unknown) => clean(o).replace(/^[A-D][.、:：)）]\s*/i, '')) : []
    let answer = clean(q?.answer)
    const explanation = clean(q?.explanation)
    const changed = clean(q?.changed)
    const n = Number(q?.kp)
    const kp_code = Number.isInteger(n) && n >= 1 && n <= ctx.kpCodes.length ? ctx.kpCodes[n - 1] : null
    if (!stem) problems.push('题干是空的')
    if (qtype === 'choice') {
      options = options.filter((o: string) => o)
      if (options.length !== 4) problems.push('选择题必须正好 4 个选项')
      const dup = new Set(options.map((o: string) => o.toLowerCase()))
      if (options.length === 4 && dup.size < 4) problems.push('选项有重复')
      const letter = /^[A-D]$/i.test(answer) ? answer.toUpperCase() : (/^([A-D])[.、:：)）\s]/i.exec(answer)?.[1]?.toUpperCase() ?? '')
      if (!letter) problems.push('答案不是 A–D 里的一个')
      answer = letter
    } else {
      options = []
      if (!answer) problems.push('填空题没有答案')
      if (!/_{2,}|＿{2,}|（\s*）|\(\s*\)/.test(stem)) problems.push('填空题的题干里没有空格（____）')
      // 题干括号里给的是首字母时，答案必须以它开头
      const hint = /[（(]\s*([A-Za-z])\s*[）)]/.exec(stem)?.[1]
      if (hint && answer && answer[0].toLowerCase() !== hint.toLowerCase()) problems.push('答案和题干给的首字母对不上')
    }
    if (hasOverclaim(`${stem} ${options.join(' ')} ${explanation} ${changed}`)) problems.push('出现了价格 / 营销 / 夸大的说法')
    // 抄原卷：与任何一道原题的词集相似度 ≥ 0.8 就剔除
    const mine = tokensOf(`${stem} ${options.join(' ')}`)
    if (origSets.some(o => jaccard(mine, o) >= COPY_THRESHOLD)) problems.push('和原卷的题太像（疑似照抄）')
    const oov = outOfVocab([stem, ...options], ctx.vocab)
    if (oov.length) hints.push(`含超出范围的词：${oov.slice(0, 6).join('、')}`)
    if (explanation.length > 80) hints.push('讲解偏长')
    if (!explanation) hints.push('没有讲解')
    out.push({ seq: 0, kp_code, qtype, stem, options, answer, explanation, changed, hints, problems })
  }
  // 题干重复的只留第一道
  const seen = new Set<string>()
  for (const v of out) {
    const key = v.stem.toLowerCase().replace(/\W+/g, '')
    if (key && seen.has(key)) v.problems.push('和另一道变形题重复')
    seen.add(key)
  }
  // 答案位置不能全一样：选择题 ≥ 2 道且答案字母全相同时，把后面的题的选项循环移位，使答案字母不同（只改位置，不改内容）
  const choices = out.filter(v => v.problems.length === 0 && v.qtype === 'choice')
  if (choices.length >= 2 && new Set(choices.map(v => v.answer)).size === 1) {
    choices.forEach((v, i) => {
      if (i === 0) return
      const at = LETTERS.indexOf(v.answer)
      const shift = i % 4
      if (!shift || at < 0) return
      v.options = v.options.map((_, k) => v.options[(k - shift + 4) % 4])
      v.answer = LETTERS[(at + shift) % 4]
      v.hints.push('已调整选项顺序，让答案位置不全相同')
    })
  }
  // 取前 max 道没被剔除的；被剔除的也保留（status = dropped，供老师在界面里看到“为什么没进”）
  let kept = 0
  const final: DraftVariant[] = []
  for (const v of out) {
    if (v.problems.length === 0) { if (kept >= max) continue; kept++ }
    final.push(v)
  }
  final.forEach((v, i) => { v.seq = i + 1 })
  return { variants: final, error: null }
}

/** 第二次独立解答：{"answers":[{"i":1,"answer":"B","reason":"…"}]} → 序号 → 答案 */
export function parseCheckAnswers(raw: string): Map<number, string> {
  const j = parseJsonLoose(raw) as any
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.answers) ? j.answers : []
  const m = new Map<number, string>()
  for (const a of list) {
    const i = Number(a?.i ?? a?.n)
    const ans = clean(a?.answer)
    if (Number.isInteger(i) && ans) m.set(i, ans)
  }
  return m
}

/** 出题答案与第二次解答是否一致（选择题比字母；填空题忽略大小写和标点） */
export function sameAnswer(v: Pick<DraftVariant, 'qtype' | 'answer'>, second: string | undefined): boolean {
  if (!second) return false
  if (v.qtype === 'choice') return (/^([A-D])/i.exec(second.trim())?.[1] ?? '').toUpperCase() === v.answer.toUpperCase()
  return normAnswer(second) === normAnswer(v.answer)
}
