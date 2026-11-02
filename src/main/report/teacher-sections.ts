/**
 * 老师版 v2 里由程序拼装的几块（M9 §2.3）：易错题集、易错知识点、口诀卡、变形题和答题卡。纯函数，单测直接加载。
 * 原则（§0.4）：数据库里有的东西（题、截图引用、易错说明、白话释义、例句）全部由程序拼，不经过 AI；AI 只写口诀、变形题这类必须由它写的部分。
 */

/** 一个易错点（程序从「重难点」里取出的前几个）及它的样本题 */
export interface ErrorItem {
  code: string
  name: string
  /** AI 估计的易错原因（已去重，可能为空） */
  reasons: string
  /** 出现份数 / 总份数，如 "2/3" */
  papers: string
  /** 样本题的题型名（去重） */
  qtypes: string[]
  /** 最多 2 道样本题；token 是 `[卷名 · 题号]` 引用 */
  questions: Array<{ token: string; questionId: string; qtypeName: string }>
}

/** 知识点的白话释义和例句（取自证据包，审核过的内容） */
export interface KpLite { code: string; name: string; plain: string; example_en: string; example_zh: string; hint_words: string }

const clean = (s: string): string => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** 价格 / 营销 / 夸大的说法（§0.4）：老师版里 AI 写的话命中就整句去掉 */
export const OVERCLAIM_RE = /价格|学费|优惠|折扣|打折|限时|名额|报名|\d+\s*元|保证|一定能|包过|必过|提分|提高\s*\d+\s*分|最好的|第一名|唯一|立竿见影|立刻见效|100\s*%|百分之百/
export const hasOverclaim = (s: string): boolean => OVERCLAIM_RE.test(s)

// ───────────────────────── 易错题集 + 易错知识点 ─────────────────────────

/**
 * 「易错题集」「易错知识点」两节（程序拼，不调用 AI）。
 * @param answerOf 题目 id → 参考答案；只有老师审核过的卷子里的题才给（其余返回 null，不显示答案）
 */
export function buildErrorsSection(items: ErrorItem[], kps: KpLite[], opts: { answerOf?: (questionId: string) => string | null } = {}): string {
  if (items.length === 0) {
    return ['## 易错题集（AI 估计）', '', '> 这个范围内没有 AI 估计的易错题，所以没有易错题集；口诀和变形题也就没有生成。'].join('\n')
  }
  const kpOf = new Map(kps.map(k => [k.code, k]))
  const L: string[] = ['## 易错题集（AI 估计）', '', '> 这些题是 AI 根据题目内容估计“容易错”的，不是学生的真实成绩。']
  items.forEach((it, i) => {
    L.push('', `### ${i + 1}. ${clean(it.name)}`)
    if (it.reasons) L.push(`- **易错原因（AI 估计）**：${clean(it.reasons)}`)
    if (it.questions.length) {
      L.push(`- **原卷例题**：${it.questions.map(q => q.token).join('；')}`)
      if (it.qtypes.length) L.push(`- **题型**：${it.qtypes.join('、')}`)
      const answers = it.questions.map(q => ({ token: q.token, a: opts.answerOf?.(q.questionId) ?? null })).filter(x => x.a && clean(x.a))
      if (answers.length) L.push(`- **参考答案**（老师审核过的卷子）：${answers.map(x => `${x.token.replace(/[\[\]]/g, '')} 答案 ${clean(x.a!)}`).join('；')}`)
    }
  })
  L.push('', '## 易错知识点')
  items.forEach((it, i) => {
    const kp = kpOf.get(it.code)
    L.push('', `### ${i + 1}. ${clean(it.name)}`)
    if (kp?.plain) L.push(`- **白话**：${clean(kp.plain)}`)
    if (kp?.example_en) L.push(`- **例句**：${clean(kp.example_en)} ${clean(kp.example_zh || '')}`.trimEnd())
    if (kp?.hint_words) L.push(`- **例词**：${clean(kp.hint_words)}`)
    L.push(`- **出现**：${it.papers} 份卷子`)
  })
  return L.join('\n')
}

// ───────────────────────── 口诀 ─────────────────────────

/** 宽松地从模型输出里取出 JSON（容忍代码围栏、前后多余的话） */
export function parseJsonLoose(text: string): unknown {
  const t = text.replace(/^﻿/, '').trim()
  const tries: string[] = [t]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) tries.push(fence[1].trim())
  const a = t.search(/[\[{]/)
  const z = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (a >= 0 && z > a) tries.push(t.slice(a, z + 1))
  for (const s of tries) { try { return JSON.parse(s) } catch { /* 试下一种 */ } }
  return null
}

export interface TrickResult { markdown: string; cards: number; dropped: string[] }

/**
 * 口诀 JSON → 口诀卡 Markdown。`{"tricks":[{"n":1,"trick":"一句话口诀"}]}`。
 * 口诀文字由 AI 写；「例」一律取自证据里这个知识点的例句（程序填，AI 不写英文句子）；含价格 / 夸大说法的口诀去掉。
 */
export function buildTricksSection(content: string, items: ErrorItem[], kps: KpLite[]): TrickResult {
  const j = parseJsonLoose(content) as any
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.tricks) ? j.tricks : []
  const kpOf = new Map(kps.map(k => [k.code, k]))
  const seen = new Set<number>()
  const cards: string[] = []
  const dropped: string[] = []
  for (const t of list) {
    const n = Number(t?.n)
    const trick = typeof t?.trick === 'string' ? clean(t.trick) : ''
    if (!Number.isInteger(n) || n < 1 || n > items.length || seen.has(n) || !trick) continue
    if (trick.length > 60 || hasOverclaim(trick) || /\[[^\]]*·[^\]]*\]/.test(trick)) { dropped.push(trick.slice(0, 40)); continue }
    seen.add(n)
    const it = items[n - 1]
    const kp = kpOf.get(it.code)
    const eg = kp?.example_en ? `${clean(kp.example_en)} ${clean(kp.example_zh || '')}`.trim() : ''
    cards.push(['::: trick 口诀大招', `**一句话**：${trick}`, ...(eg ? [`**例**：${eg}`] : []), `**出自考点**：${clean(it.name)}`, ':::'].join('\n'))
  }
  return { markdown: cards.join('\n\n'), cards: cards.length, dropped }
}

// ───────────────────────── 变形题 + 答题卡 ─────────────────────────

export interface VariantRow {
  id: string
  seq: number
  kp_code: string | null
  qtype: string
  stem: string
  options: string[]
  answer: string
  explanation: string
  changed: string
  status: 'checked' | 'flagged' | 'dropped'
  teacher_ok: boolean
}

const noBrace = (s: string): string => clean(s).replace(/[{}|]/g, ' ').replace(/\s+/g, ' ').trim()

/** 能进答题卡的题：没被程序剔除，且老师逐题勾过「我核对过」（第二次解答不一致的题勾了就是「仍然使用」） */
export const inCard = (v: Pick<VariantRow, 'status' | 'teacher_ok'>): boolean => v.status !== 'dropped' && v.teacher_ok

export function buildVariantsSection(rows: VariantRow[], kpName: (code: string | null) => string): string {
  const usable = rows.filter(r => r.status !== 'dropped')
  const picked = usable.filter(inCard).sort((a, b) => a.seq - b.seq)
  const heading = usable.length === 3 ? '## 3 道同类变形题' : '## 同类变形题'
  const L: string[] = [heading, '', '> 这几道题是 AI 根据考点和题型改编的，不是原卷里的题；程序和第二次 AI 解答都核对过，但使用前请老师先做一遍，并在软件里逐题勾「我核对过」，勾了的题才会放进答题卡。']
  if (picked.length === 0) {
    L.push('', usable.length ? `> 答题卡还没有题目：${usable.length} 道变形题都还没有核对。` : '> 这次没有可用的变形题。')
    return L.join('\n')
  }
  L.push('', '::: answercard 答题卡 | 同类变形题')
  picked.forEach((v, i) => {
    const tail = v.qtype === 'choice' ? ` {choice: ${v.options.map(noBrace).join(' | ')}}` : ' {blank: 1}'
    L.push(`${i + 1}. ${noBrace(v.stem)}${tail}`)
  })
  L.push(':::', '', '### 参考答案与讲解（教师用）')
  picked.forEach((v, i) => {
    L.push(`${i + 1}. **答案**：${clean(v.answer)}。${clean(v.explanation)}${v.kp_code ? `（考点：${clean(kpName(v.kp_code))}）` : ''}${v.status === 'flagged' ? '（第二次解答与出题答案不一致，老师确认后仍使用）' : ''}`)
  })
  const left = usable.length - picked.length
  if (left > 0) L.push('', `> 另有 ${left} 道变形题没有放进答题卡（还没核对，或第二次 AI 解答与出题答案不一致），在软件里逐题查看。`)
  return L.join('\n')
}
