/**
 * 按文字判断学科、判断像不像试卷。纯函数，不依赖 electron，主进程、界面、单测都直接加载。
 *
 * 原则：判错学科会把卷子拦下来问用户，所以 sure（有把握）要保守——
 * 只有「卷头明说学科」或「内容特征压倒性领先」才算有把握；其余情况只给倾向（subject），不打扰用户。
 */
import { SUBJECT_IDS, isSubjectId } from './subject.ts'
import type { SubjectId } from './subject.ts'

/** 文档、数据集的学科：三个学科之一，或「通用」（所有学科的对话都能看到） */
export type ContentSubject = SubjectId | 'general'
export const CONTENT_SUBJECTS: readonly ContentSubject[] = [...SUBJECT_IDS, 'general']
export const isContentSubject = (v: unknown): v is ContentSubject => v === 'general' || isSubjectId(v)
/** 缺省 / 不认识的值一律当通用 */
export const asContentSubject = (v: unknown): ContentSubject => (isContentSubject(v) ? v : 'general')

/** 在某个学科的对话里能不能看到这条内容：本学科的和「通用」的可见；没指定会话学科 = 不过滤 */
export function visibleInSubject(item: unknown, session: SubjectId | string | undefined | null): boolean {
  if (!session) return true
  const s = asContentSubject(item)
  return s === 'general' || s === session
}

export interface DetectResult {
  subject: SubjectId | null
  /** 有把握：卷头明说，或内容特征压倒性领先。拿不准时 false */
  sure: boolean
  scores: Record<SubjectId, number>
  /** 给人看的依据，如「卷头写着『数学』」 */
  reason: string
}

const zeroScores = (): Record<SubjectId, number> => ({ english: 0, chinese: 0, math: 0 })

/** 有效字数：汉字、字母、数字 */
export function validChars(text: string): number {
  return (text.match(/[一-鿿A-Za-z0-9]/g) ?? []).length
}
/** 少于这么多有效字，一律不给「有把握」 */
export const MIN_VALID_CHARS = 30
/** 内容特征要拿到这个分数、并且是第二名的 3 倍以上，才算压倒性领先 */
const SURE_SCORE = 12
const SURE_RATIO = 3

// ───────── 卷头 ─────────
const HEADER_CN: Array<[SubjectId, RegExp]> = [
  ['chinese', /语文/], ['math', /数学/], ['english', /英语/]
]
const HEADER_LATIN: Array<[SubjectId, RegExp]> = [
  ['chinese', /\bchinese\b/i], ['math', /\bmath(s|ematics)?\b/i], ['english', /\benglish\b/i]
]
/** 卷头 = 标题 + 正文开头一小段（汉字学科名看前 120 字，英文学科名只看标题和第一行，免得正文里的单词误判） */
function headerSubjects(text: string, title: string): SubjectId[] {
  const head = (title + '\n' + text.slice(0, 120))
  const firstLine = title + '\n' + (text.split('\n').find(l => l.trim()) ?? '').slice(0, 60)
  const hit = new Set<SubjectId>()
  for (const [id, re] of HEADER_CN) if (re.test(head)) hit.add(id)
  for (const [id, re] of HEADER_LATIN) if (re.test(firstLine)) hit.add(id)
  return [...hit]
}

// ───────── 内容特征 ─────────
const CN_KEYWORDS = ['看拼音', '读拼音', '拼音', '组词', '古诗', '诗句', '默写', '习作', '作文', '阅读短文', '阅读下面', '课内阅读', '课外阅读', '近义词', '反义词', '成语', '修辞', '比喻', '拟人', '病句', '标点', '偏旁', '部首', '笔画', '造句', '多音字', '形近字', '词语', '课文', '句子', '日积月累', '口语交际']
const MATH_KEYWORDS = ['计算', '口算', '笔算', '脱式', '竖式', '应用题', '解决问题', '解方程', '方程', '小数', '分数', '百分数', '面积', '周长', '体积', '厘米', '千克', '分米', '平方米', '立方', '公顷', '算式', '得数', '商是', '余数', '比大小', '图形', '统计图', '平均数', '倍数', '因数', '约分', '通分', '最简分数', '列式']
const EN_KEYWORDS = ['听力', '笔试', '补全对话', '完形', '根据首字母', '单词', '情景交际', '选出', 'Listen', 'Choose', 'Look and', 'Read and', 'Fill in', 'Circle', 'Match', 'Write the', 'Translate']

/** 英文单词里不算英语的单位和符号词 */
const UNIT_WORDS = new Set(['cm', 'mm', 'km', 'kg', 'ml', 'dm', 'min', 'sec', 'hm', 'mg', 'cm2', 'ms'])
/** 带声调的拼音字母 */
const TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüê]/
const LATIN_TOKEN_RE = /[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüê]+/g

function countOf(text: string, kw: string): number {
  let n = 0
  for (let i = text.indexOf(kw); i >= 0; i = text.indexOf(kw, i + kw.length)) n++
  return n
}
/** 每个不同的关键词 3 分，重复出现再加（最多再加 2 分） */
function keywordScore(text: string, kws: string[], ci = false): number {
  const t = ci ? text.toLowerCase() : text
  let s = 0
  for (const k of kws) {
    const n = countOf(t, ci ? k.toLowerCase() : k)
    if (n > 0) s += 3 + Math.min(2, n - 1)
  }
  return s
}

/** 只看内容算三个学科的分 */
export function contentScores(text: string): Record<SubjectId, number> {
  const sc = zeroScores()
  sc.chinese += keywordScore(text, CN_KEYWORDS)
  sc.math += keywordScore(text, MATH_KEYWORDS)
  sc.english += keywordScore(text, EN_KEYWORDS, true)

  // 带声调的拼音：语文
  const tokens = text.match(LATIN_TOKEN_RE) ?? []
  const pinyin = tokens.filter(t => TONE_RE.test(t)).length
  sc.chinese += Math.min(12, pinyin * 0.5)

  // 算式：数字、运算符、数字（含分数 a/b、等号）
  const exprs = (text.match(/\d+(?:\.\d+)?\s*[+\-−×÷*/＋－＝=]\s*\d+/g) ?? []).length
  sc.math += Math.min(15, exprs)
  const units = new Set((text.match(/\d\s*(cm|mm|km|kg|ml|dm|m²|cm²|元|角|分米|千克|克|吨|升|毫升)(?![A-Za-z])/g) ?? []).map(s => s.replace(/[\d\s]/g, '')))
  sc.math += Math.min(6, units.size * 2)

  // 英文单词：长度 ≥ 2、不是单位、不带声调
  const words = tokens.filter(t => t.length >= 2 && !TONE_RE.test(t) && !UNIT_WORDS.has(t.toLowerCase()))
  const latinLetters = words.reduce((n, w) => n + w.length, 0)
  const valid = Math.max(1, validChars(text))
  const frac = latinLetters / valid
  if (words.length >= 15) sc.english += Math.min(20, words.length / 4)
  if (frac >= 0.5 && words.length >= 15) sc.english += 10
  return sc
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** 按卷面文字（和标题 / 文件名）判断学科；有把握才 sure=true */
export function detectSubject(text: string, title = ''): DetectResult {
  const body = text ?? ''
  const sc = contentScores(body)
  for (const id of SUBJECT_IDS) sc[id] = round1(sc[id])
  const ranked = [...SUBJECT_IDS].sort((a, b) => sc[b] - sc[a])
  const top = ranked[0]
  const topScore = sc[top]
  const second = sc[ranked[1]]
  const enough = validChars(body) >= MIN_VALID_CHARS
  const overwhelming = enough && topScore >= SURE_SCORE && topScore >= SURE_RATIO * second

  const head = headerSubjects(body, title)
  if (head.length === 1) {
    const h = head[0]
    // 卷头说 A，内容却压倒性像 B：自相矛盾，不给把握
    if (overwhelming && top !== h && topScore >= SURE_RATIO * Math.max(1, sc[h])) {
      return { subject: h, sure: false, scores: sc, reason: `卷头写着「${nameOf(h)}」，但内容更像${nameOf(top)}` }
    }
    return { subject: h, sure: enough, scores: sc, reason: `卷头写着「${nameOf(h)}」` }
  }
  if (head.length > 1) return { subject: null, sure: false, scores: sc, reason: '卷头同时出现多个学科' }

  if (overwhelming) return { subject: top, sure: true, scores: sc, reason: `内容特征明显是${nameOf(top)}` }
  if (topScore >= 4 && topScore > second * 1.5) return { subject: top, sure: false, scores: sc, reason: `内容有点像${nameOf(top)}，但把握不大` }
  return { subject: null, sure: false, scores: sc, reason: enough ? '看不出是哪个学科' : '文字太少，看不出是哪个学科' }
}

const NAMES: Record<SubjectId, string> = { english: '英语', chinese: '语文', math: '数学' }
const nameOf = (s: SubjectId) => NAMES[s]

/** 文档资料的学科：有把握才归到具体学科，其余（判断不出、混合、太短）一律通用 */
export function detectDocSubject(text: string, title = ''): ContentSubject {
  const r = detectSubject(text, title)
  return r.sure && r.subject ? r.subject : 'general'
}

/** 表格里有「科目 / 学科」这类列时，写进说明的话；没有返回 null */
export function subjectColumnNote(labels: string[]): string | null {
  const hit = labels.map(l => (l ?? '').trim()).find(l => l.length <= 6 && /科目|学科/.test(l))
  return hit ? `表里有「${hit}」列，请按该列区分学科（分析时先按它筛选）。` : null
}

// ───────── 像不像试卷 ─────────
const PAPER_TITLE_RE = /试卷|试题|测试|测验|期中|期末|月考|检测|考试|练习卷|模拟|真题|质量调研|学业水平/
const PLAN_CUES = ['教学目标', '教学重点', '教学难点', '教学过程', '教学反思', '教案', '板书设计', '教学准备', '课时安排', '教学设计']

/**
 * 像不像一份试卷：大题编号、答题括号、分值、姓名班级得分、试卷类字眼。
 * 宁可判成试卷（试卷库里能删）；文字太少看不出来时也当试卷。教案类文档（有「教学目标 / 教学过程」）除外。
 */
export function looksLikePaper(text: string, title = ''): boolean {
  const t = text ?? ''
  if (validChars(t) < 20) return true
  let pts = 0
  const sections = (t.match(/^\s*(?:[一二三四五六七八九十]{1,3}\s*[、．.]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[、．.]|第[一二三四五六七八九十]+[部大]分|第[ⅠⅡⅢⅣ一二]卷)/gm) ?? []).length
  if (sections >= 2) pts += 2
  else if (sections === 1) pts += 1
  const slots = (t.match(/[（(][\s　]{2,}[）)]|[_＿]{3,}|[（(]\s*[）)]/g) ?? []).length
  if (slots >= 3) pts += 2
  else if (slots >= 1) pts += 1
  if (/[（(]\s*每?[小]?题?\s*\d+(?:\.\d+)?\s*分\s*[）)]|共\s*\d+\s*分|满分|[（(]\s*分\s*[）)]|本大题共|总分/.test(t)) pts += 2
  const fields = ['姓名', '班级', '得分', '学号', '学校', '座号', '考号'].filter(k => t.includes(k)).length
  if (fields >= 2) pts += 2
  else if (fields === 1) pts += 1
  if (PAPER_TITLE_RE.test(title) || PAPER_TITLE_RE.test(t.slice(0, 80))) pts += 2
  else if (/单元/.test(title + t.slice(0, 80))) pts += 1
  const plan = PLAN_CUES.filter(k => t.includes(k)).length
  if (plan >= 2) pts -= 3
  return pts >= 2
}
