/**
 * 分享卡片的内容 schema（zod）。纯逻辑，不依赖 electron。
 * 每个字段有长度上限：超了不报错，截断并记一条提示（返回给 Agent，让它下次写短一点）；数量不够（少于下限）才报错。
 * 学生卡：knowledge 知识点 / mnemonic 口诀 / practice 小练习；家长卡：weekly 本周学情 / progress 阶段进步 / brief 学习简报。
 */
import { z } from 'zod'

export const STUDENT_KINDS = ['knowledge', 'mnemonic', 'practice'] as const
export const PARENT_KINDS = ['weekly', 'progress', 'brief'] as const
export type CardKind = (typeof STUDENT_KINDS)[number] | (typeof PARENT_KINDS)[number]
export type Audience = 'student' | 'parent'
export const ALL_KINDS: CardKind[] = [...STUDENT_KINDS, ...PARENT_KINDS]
export const audienceOf = (k: CardKind): Audience => ((STUDENT_KINDS as readonly string[]).includes(k) ? 'student' : 'parent')

export const KIND_LABEL: Record<CardKind, string> = {
  knowledge: '知识点卡', mnemonic: '口诀卡', practice: '小练习卡', weekly: '本周学情', progress: '阶段进步', brief: '学习简报'
}

// ── 截断提示收集（zod 的 transform 是同步的，用模块级收集器）──
let notes: string[] | null = null
const note = (m: string) => { if (notes && !notes.includes(m) && notes.length < 12) notes.push(m) }

/** 字符串：去首尾空白，超过 max 个字就截断（加「…」）并记一条提示 */
const str = (max: number, label: string) => z.string().transform(v => {
  const t = v.replace(/\s+/g, ' ').trim()
  const chars = [...t]
  if (chars.length <= max) return t
  note(`「${label}」超过 ${max} 字，已截断`)
  return chars.slice(0, max - 1).join('') + '…'
})
const opt = (max: number, label: string) => str(max, label).optional()
/** 数组：多于 max 项截断并提示；少于 min 项报错 */
const arr = <T extends z.ZodTypeAny>(item: T, min: number, max: number, label: string) =>
  z.array(item).min(min, `「${label}」至少要 ${min} 项`).transform(a => {
    if (a.length <= max) return a
    note(`「${label}」最多 ${max} 项，多出的已去掉`)
    return a.slice(0, max)
  })

const foot = { signature: opt(16, '署名'), date: opt(12, '日期') }

export const KnowledgeSchema = z.object({
  tag: opt(8, '小标'),
  /** 学科（english / chinese / math，缺省英语）：决定没写小标时的默认小标「英语小卡 / 语文小卡 / 数学小卡」 */
  subject: z.enum(['english', 'chinese', 'math']).optional(),
  title: str(14, '标题'),
  hook: str(26, '引导语'),
  items: arr(z.object({ left: str(14, '要点左侧'), right: str(14, '要点右侧') }), 2, 6, '要点'),
  example: z.object({ en: str(70, '例句'), zh: str(40, '例句翻译') }),
  warning: opt(30, '易错提醒'),
  ...foot
})
export const MnemonicSchema = z.object({
  tag: opt(8, '小标'),
  title: str(14, '标题'),
  lines: arr(z.object({ text: str(24, '口诀行'), highlight: opt(10, '高亮词') }), 2, 6, '口诀行'),
  examples: arr(z.object({ label: str(8, '例句标签'), text: str(50, '例句') }), 2, 4, '例句'),
  ...foot
})
export const PracticeSchema = z.object({
  tag: opt(8, '小标'),
  title: str(14, '标题'),
  questions: arr(z.object({ q: str(60, '题目'), options: z.array(str(16, '选项')).max(4).optional() }), 2, 4, '题目'),
  encourage: opt(30, '鼓励语'),
  ...foot
})
export const WeeklySchema = z.object({
  student: opt(12, '学生称呼'),
  grade: opt(16, '年级'),
  week: opt(16, '周次'),
  metrics: arr(z.object({ value: str(8, '指标数值'), label: str(12, '指标名称') }), 2, 3, '指标'),
  learned: str(80, '本周学了'),
  good: str(80, '做得好的'),
  improve: str(80, '还要加强'),
  tips: str(100, '家庭配合建议'),
  teacher: opt(16, '老师署名'),
  date: opt(12, '日期')
})
export const ProgressSchema = z.object({
  student: opt(12, '学生称呼'),
  grade: opt(16, '年级'),
  period: opt(16, '阶段'),
  items: arr(z.object({ name: str(12, '项目名'), from: str(8, '起点'), to: str(8, '现在'), fromPct: z.number().min(0).max(100), toPct: z.number().min(0).max(100) }), 2, 4, '对比项'),
  summary: str(130, '进步小结'),
  next: opt(80, '下阶段预告'),
  teacher: opt(16, '老师署名'),
  date: opt(12, '日期')
})
export const BriefSchema = z.object({
  student: opt(12, '学生称呼'),
  title: opt(16, '标题'),
  period: opt(16, '时间范围'),
  sections: arr(z.object({ heading: str(12, '分节标题'), body: str(80, '分节正文') }), 1, 4, '分节'),
  teacher: opt(16, '老师署名'),
  date: opt(12, '日期')
})

export const KIND_SCHEMA: Record<CardKind, z.ZodTypeAny> = {
  knowledge: KnowledgeSchema, mnemonic: MnemonicSchema, practice: PracticeSchema,
  weekly: WeeklySchema, progress: ProgressSchema, brief: BriefSchema
}

/** 给模型看的各版式字段说明（写进 card_make 的描述） */
export const KIND_HELP: Record<CardKind, string> = {
  knowledge: 'knowledge（学生·知识点卡）：{title≤14字, hook≤26字 一句引导, items:[{left≤14, right≤14}] 2–6 组词或要点, example:{en≤70, zh≤40}, warning≤30字 易错提醒(可选), tag≤8字(可选), subject(可选，english/chinese/math，决定默认小标；语文数学的 example.en 写例子本身，zh 写说明), signature≤16(可选), date≤12(可选)}',
  mnemonic: 'mnemonic（学生·口诀卡）：{title≤14, lines:[{text≤24, highlight≤10 要高亮的关键词(可选，须是 text 里的原文)}] 2–6 行, examples:[{label≤8, text≤50}] 2–4 个, signature, date}',
  practice: 'practice（学生·小练习卡）：{title≤14, questions:[{q≤60, options:["A. …"…最多4个](可选)}] 2–4 道, encourage≤30 鼓励语(可选), signature, date}',
  weekly: 'weekly（家长·本周学情）：{student 孩子称呼(可选), grade≤16, week≤16, metrics:[{value≤8, label≤12}] 2–3 个指标, learned≤80 本周学了, good≤80 做得好的, improve≤80 还要加强, tips≤100 家庭配合建议, teacher≤16 老师署名, date}',
  progress: 'progress（家长·阶段进步）：{student, grade, period≤16, items:[{name≤12, from≤8, to≤8, fromPct 0–100, toPct 0–100}] 2–4 项前→后对比, summary≤130 一段话, next≤80 下阶段预告(可选), teacher, date}',
  brief: 'brief（家长·学习简报）：{student, title≤16, period≤16, sections:[{heading≤12, body≤80}] 1–4 个分节(显示为 01–04), teacher, date}'
}

export interface ParsedCard { ok: true; kind: CardKind; data: Record<string, any>; notices: string[] }
export interface ParseFail { ok: false; error: string }

export function parseCardContent(kind: CardKind, content: unknown): ParsedCard | ParseFail {
  const schema = KIND_SCHEMA[kind]
  if (!schema) return { ok: false, error: `没有叫「${kind}」的版式。可用：${ALL_KINDS.join('、')}` }
  notes = []
  try {
    const r = schema.safeParse(content)
    if (!r.success) {
      const msg = r.error.issues.map(i => `${i.path.join('.') || '（整体）'}：${i.message}`).join('；')
      return { ok: false, error: `内容不符合「${KIND_LABEL[kind]}」的要求：${msg}。字段说明：${KIND_HELP[kind]}` }
    }
    return { ok: true, kind, data: r.data as Record<string, any>, notices: [...notes] }
  } finally { notes = null }
}

// ── 隐私规则 ──

/** 手机号（含 +86、空格 / 短横线分隔），以及数据集里的「手机0001」代号 */
const PHONE_RES = [/(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/, /手机\d{4,}/]
export const hasPhone = (text: string): boolean => PHONE_RES.some(re => re.test(text))
/** 排名 / 与其他孩子比较的说法 */
const RANK_RE = /排名|名次|第\s*[一二三四五六七八九十\d]+\s*名|班级第|全班第|年级第|超过了?\s*\d+\s*%\s*的(?:同学|孩子|学生)|比(?:其他|别的|班上|同班)?(?:同学|孩子)/
const PERSON_CODE_RE = /人员[A-Z]+\d{3}/g

/** 把内容里所有字符串拼起来（检查用）；skip 里的字段不算 */
export function allStrings(v: unknown, skip: string[] = []): string[] {
  const out: string[] = []
  const walk = (x: unknown, key?: string) => {
    if (typeof x === 'string') { if (!key || !skip.includes(key)) out.push(x) }
    else if (Array.isArray(x)) x.forEach(i => walk(i, key))
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k)
  }
  walk(v)
  return out
}

/** 还原真名之前对原始内容做的检查：手机号（含代号）、几个孩子 */
export function checkRaw(audience: Audience, content: unknown): string | null {
  const all = allStrings(content)
  if (all.some(hasPhone)) return '卡片里不能出现手机号。请删掉手机号后重新生成。'
  if (audience === 'parent') {
    const codes = new Set(allStrings(content, ['teacher', 'signature']).flatMap(s => s.match(PERSON_CODE_RE) ?? []))
    if (codes.size > 1) return '家长卡只能写这一个孩子的信息，里面出现了多位学员。请只保留这个孩子，其他孩子的名字和情况都不要写。'
  }
  return null
}

/** 还原真名之后的检查：手机号、家长卡里的排名 / 比较 */
export function checkFinal(audience: Audience, data: unknown): string | null {
  const all = allStrings(data)
  if (all.some(hasPhone)) return '卡片里不能出现手机号。请删掉手机号后重新生成。'
  if (audience === 'parent' && all.some(s => RANK_RE.test(s))) return '家长卡不能写排名，也不能拿这个孩子和其他同学比较。请改成只和孩子自己的过去比。'
  return null
}

// ── 孩子称呼 ──
export type ChildNameMode = 'first' | 'none'
const COMPOUND = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '令狐', '长孙', '夏侯', '宇文', '司徒', '轩辕']

/** 去掉姓：王小明 → 小明；两个字的（李雨）用「小 + 名」→ 小雨；欧阳小雨 → 小雨；已经是「小雨」这样的称呼就保持；英文名取第一个词 */
export function givenName(full: string): string {
  const n = full.trim()
  if (!n) return ''
  if (/^[A-Za-z][A-Za-z .'-]*$/.test(n)) return n.split(/\s+/)[0]
  const chars = [...n]
  if (chars.length <= 1) return n
  if (/^[小阿]/.test(n) && chars.length <= 3) return n
  if (chars.length === 2) return '小' + chars[1]   // 单姓单名：李雨 → 小雨
  if (chars.length >= 4 && COMPOUND.includes(chars.slice(0, 2).join(''))) return chars.slice(2).join('')
  if (chars.length === 3 && COMPOUND.includes(chars.slice(0, 2).join(''))) return chars.slice(2).join('')
  return chars.slice(1).join('')
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 按「孩子称呼」设置处理：student 字段改成只写名（或“孩子”），全文里出现的全名一并替换。
 * 只对家长卡有意义；学生卡不含学生姓名字段，但全文里出现的 student 以外的内容不动。
 */
export function applyNamePolicy<T extends Record<string, any>>(data: T, mode: ChildNameMode): T {
  const full = typeof data.student === 'string' ? data.student.trim() : ''
  const given = full ? givenName(full) : ''
  const shown = mode === 'none' ? '孩子' : given
  const swap = (s: string): string => {
    let t = s
    if (full && full !== shown) t = t.replace(new RegExp(escRe(full), 'g'), shown || '孩子')
    if (mode === 'none' && given && given !== full) t = t.replace(new RegExp(escRe(given), 'g'), '孩子')
    return t
  }
  const walk = (x: any): any => typeof x === 'string' ? swap(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x
  const out = walk(data)
  if (full) out.student = mode === 'none' ? '' : given
  return out
}
