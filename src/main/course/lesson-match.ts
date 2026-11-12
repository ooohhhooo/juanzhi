/**
 * 「课 ↔ 教材单元」「课 ↔ 校内原题」的直接匹配（纯函数，不调用 AI，同样的输入每次结果一样）。
 *
 * 防瞎匹配的硬规则：只有满足下面任一条才算数——
 *   ① 至少一条「原文逐字命中」：课里的词汇或句型原样出现在对方文字里；
 *   ② 至少两类不同的依据同时成立（话题、知识点代码、教材句型（概括）、强规则命中等）。
 * 只靠一类弱信号的一律不进表。教材目录里标「句型（概括）」的是概括写法，不是课本原文：可以拿来比，但依据写「教材句型（概括）」，不算原文命中。
 */

export interface LessonText {
  title: string
  theme: string
  points: Array<{ kind: string; text: string }>
}

const STOP = new Set(['unit', 'lesson', 'review', 'module', 'story', 'time', 'with', 'this', 'that', 'what', 'where', 'when', 'have', 'like', 'your', 'they', 'them', 'there', 'here', 'from', 'about', 'some', 'name', 'good', 'part', 'topic', 'revision', 'recycle', 'practice'])
const CJK_STOP = new Set(['单元', '课程', '复习', '练习', '综合', '实践', '第一', '第二', '第三', '活动', '内容', '学习', '认识', '整理', '应用', '解决', '问题', '课时'])

const norm = (s: string) => s.normalize('NFKC').toLowerCase()
/** 句型比较用：小写、去标点和省略号、空格合并 */
const normSentence = (s: string) => norm(s).replace(/[…….,!?;:"“”‘’()（）[\]{}\-—_~～]+/g, ' ').replace(/\s+/g, ' ').trim()
const segs = (s: string) => s.split(/[；;、，,\/\n]+/).map(x => x.trim()).filter(Boolean)

/** 词汇：英文单词（≥4 个字母、不是常用虚词）和中文词（≥3 个汉字） */
export function vocabTerms(l: LessonText): string[] {
  const out = new Set<string>()
  for (const p of l.points.filter(p => p.kind === 'word' || p.kind === 'phonics' || p.kind === 'skill' || p.kind === 'other')) {
    for (const seg of segs(p.text)) {
      const low = norm(seg)
      for (const w of low.match(/[a-z]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w)
      for (const c of seg.match(/[一-鿿]{3,10}/g) ?? []) if (!CJK_STOP.has(c)) out.add(c)
    }
  }
  return [...out]
}

/** 句型：英文至少 2 个单词，中文至少 4 个汉字；含省略号的按省略号拆开取片段 */
export function patternTerms(l: LessonText): string[] {
  const out = new Set<string>()
  for (const p of l.points.filter(p => p.kind === 'pattern' || p.kind === 'expression')) {
    for (const seg of p.text.split(/[；;。?？!！\n]+/)) {
      for (const frag of seg.split(/[……]+|\.{3,}|_{2,}/)) {
        const n = normSentence(frag)
        const words = n.match(/[a-z']+/g) ?? []
        if (words.length >= 2 && n.length >= 5) out.add(n)
        else if ((n.match(/[一-鿿]/g) ?? []).length >= 4) out.add(n.replace(/\s+/g, ''))
      }
    }
  }
  return [...out]
}

/** 话题词：标题 / 主题里的英文单词（≥4 字母）和中文双字组 */
export function topicTerms(text: string): string[] {
  const out = new Set<string>()
  const low = norm(text)
  for (const w of low.match(/[a-z]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w)
  for (const run of text.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) { const g = run.slice(i, i + 2); if (!CJK_STOP.has(g)) out.add(g) }
  return [...out]
}

const hasWord = (hay: string, w: string): boolean => (/^[a-z]+$/.test(w) ? new RegExp(`(?<![a-z])${w}(?![a-z])`).test(hay) : hay.includes(w))
const joinWords = (xs: string[], n = 3) => xs.slice(0, n).join('、')

// ───────────────────────── 课 ↔ 教材单元 ─────────────────────────

export interface UnitInfo {
  id: number
  /** 教材单元的标题 */
  title: string
  /** 单元的内容行（话题、核心问题、句型、课文名…），每行一条 */
  lines: string[]
  kps: string[]
  /** 目录里标了「句型（概括）」或「未逐课核对」：内容不是课本原文，只能当话题提示（不参与逐字 / 句型匹配） */
  unverified?: boolean
}
export interface UnitMatch {
  unitId: number
  score: number
  /** 老师看得懂的：同话题：家庭 · 同句型：Who's he? · 同词汇：father、mother · 同知识点：一般过去时 */
  evidence: string
  /** 命中了几类不同的依据 */
  kinds: string[]
  verbatim: boolean
  /** 单元信息只是按目录概括的（界面在教材位置后加小字「按目录」） */
  byCatalog: boolean
}

export const UNIT_MIN_SCORE = 35
export const UNIT_STRONG = 60
const isSummaryLine = (l: string) => /^句型[（(]概括[）)]/.test(l.trim())

/** 目录里的这条单元说明是不是「未逐课核对 / 概括」 */
export const isUnverifiedNote = (note: string): boolean => /未逐课核对|未逐字核对|未查到原文|按单元主题概括|句型（概括）/.test(note ?? '')

export function matchUnit(lesson: LessonText, lessonKps: Array<{ code: string; name: string }>, unit: UnitInfo, kpNear: (a: string, b: string) => boolean): UnitMatch | null {
  const unverified = !!unit.unverified
  // 「句型（概括）」行和未核对的单元：只当话题提示，不参与逐字 / 句型匹配
  const body = unverified ? [] : unit.lines.filter(l => !isSummaryLine(l))
  const hint = unverified ? unit.lines : unit.lines.filter(isSummaryLine)
  const hayOrig = norm([unit.title, ...body].join('\n'))
  const hayOrigSent = normSentence([unit.title, ...body].join('\n'))
  const parts: string[] = [], kinds: string[] = []
  let score = 0, verbatim = false

  if (!unverified) {
    const vocab = vocabTerms(lesson).filter(w => hasWord(hayOrig, w))
    if (vocab.length) { score += Math.min(40, 15 * vocab.length); parts.push(`同词汇：${joinWords(vocab)}`); kinds.push('vocab'); verbatim = true }
    const patOrig = patternTerms(lesson).filter(p => hayOrigSent.includes(p))
    if (patOrig.length) { score += Math.min(60, 40 + 10 * (patOrig.length - 1)); parts.push(`同句型：${joinWords(patOrig, 2)}`); kinds.push('pattern'); verbatim = true }
  }
  // 话题：课的标题 / 主题 与 单元标题 / 「话题：」行（含概括行里的话题字眼）
  const topicLine = [...unit.lines, ...hint].find(l => /^话题[：:]/.test(l)) ?? ''
  const unitTopic = new Set(topicTerms(`${unit.title} ${topicLine}`))
  const topic = topicTerms(`${lesson.title} ${lesson.theme}`).filter(t => unitTopic.has(t))
  if (topic.length) { score += Math.min(30, 20 + 5 * (topic.length - 1)); parts.push(`同话题：${joinWords(topic, 2)}`); kinds.push('topic') }
  // 知识点代码：课的主知识点 与 单元的知识点 相同或有父子关系
  const near = lessonKps.filter(k => unit.kps.some(u => kpNear(k.code, u)))
  if (near.length) { score += Math.min(30, 15 * near.length); parts.push(`同知识点：${joinWords(near.map(k => k.name), 2)}`); kinds.push('kp') }

  if (!(verbatim || kinds.length >= 2)) return null   // 只靠一类弱信号：不进表
  score = Math.min(100, score)
  if (score < UNIT_MIN_SCORE) return null
  return { unitId: unit.id, score, evidence: parts.join(' · '), kinds, verbatim, byCatalog: unverified }
}

/** 一个版本（一组单元）里最像的 1–2 个：第一名一定给；第二名要不低于第一名的 75% 且过线 */
export function pickUnits(ms: UnitMatch[]): UnitMatch[] {
  const sorted = [...ms].sort((a, b) => b.score - a.score || a.unitId - b.unitId)
  if (!sorted.length) return []
  const out = [sorted[0]]
  if (sorted[1] && sorted[1].score >= Math.max(UNIT_MIN_SCORE, sorted[0].score * 0.75)) out.push(sorted[1])
  return out
}

export const similarityLabel = (score: number): string => (score >= UNIT_STRONG ? '很像' : '有点像')

// ───────────────────────── 课 ↔ 校内原题 ─────────────────────────

export interface QuestionInfo { id: string; stem: string; options: string[]; errorProne: boolean; /** 题目已审核的知识点代码（主知识点 isPrimary） */ kps: Array<{ code: string; primary: boolean }> }
export interface ExampleMatch { id: string; score: number; evidence: string; kinds: string[]; verbatim: boolean; /** 关联到的课的知识点（用来把例题排到对应知识点下面） */ kpCode: string | null }

/**
 * 一道题和一节课：词汇 / 句型在题干（含选项）里逐字找，加分；再用题目已审核的知识点代码和课的知识点对上。
 * lessonKps.strong = 这条「课 ↔ 知识点」本身有原文依据（规则命中强词，或老师确认过）——知识点代码相同 + 这个依据，算两类依据。
 */
export function matchExample(lesson: LessonText, lessonKps: Array<{ code: string; name: string; strong: boolean }>, q: QuestionInfo, kpNear: (a: string, b: string) => boolean): ExampleMatch | null {
  const hay = norm([q.stem, ...q.options].join('\n'))
  const haySent = normSentence([q.stem, ...q.options].join('\n'))
  const parts: string[] = [], kinds: string[] = []
  let score = 0, verbatim = false
  const vocab = vocabTerms(lesson).filter(w => hasWord(hay, w))
  if (vocab.length) { score += Math.min(30, 10 * vocab.length); parts.push(`题里有课上的词：${joinWords(vocab)}`); kinds.push('vocab'); verbatim = true }
  const pats = patternTerms(lesson).filter(p => haySent.includes(p))
  if (pats.length) { score += Math.min(50, 30 + 10 * (pats.length - 1)); parts.push(`题里有课上的句型：${joinWords(pats, 2)}`); kinds.push('pattern'); verbatim = true }
  let kpCode: string | null = null
  let strongKp = false
  for (const lk of lessonKps) {
    const hit = q.kps.find(k => kpNear(lk.code, k.code))
    if (!hit) continue
    if (!kpCode || (hit.primary && lk.strong)) kpCode = lk.code
    if (lk.strong) strongKp = true
    score += hit.primary ? 20 : 8
    parts.push(`知识点相同：${lk.name}`)
    break
  }
  if (kpCode) kinds.push('kp')
  if (kpCode && strongKp) { kinds.push('kp-evidence'); score += 10 }
  if (!(verbatim || new Set(kinds).size >= 2)) return null
  if (q.errorProne) score += 3
  return { id: q.id, score: Math.min(100, score), evidence: parts.join(' · '), kinds, verbatim, kpCode }
}
