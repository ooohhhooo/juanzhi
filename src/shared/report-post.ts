/**
 * 报告文本的程序侧收尾（M6）：纯函数，不依赖 electron，单测直接加载。
 *  - stripInternalCodes：把知识点 / 题型的内部代码（GR.NOUN、PH_DIFF）从报告里去掉，表格里的「代码」列整列删除；
 *  - fixBackticks：去掉 AI 套在引用外面的多余反引号；
 *  - sanitizeParent：家长版里不许出现统计词和百分比，含这些的句子整句删掉；
 *  - markdownToWechat：家长版「复制到微信」用的纯文本（带换行和序号，没有任何 Markdown 符号）；
 *  - reportTitle：标题含年级 / 学期 / 学年 / 日期，不再出现「全部年级」（除非真的是全部）。
 */
import { parseBlocks } from './markdown.ts'
import type { Inline } from './markdown.ts'
import { CITATION_RE } from './citation.ts'
import { MARK_RE } from './factcheck.ts'

export type ReportReader = 'boss' | 'parent' | 'teacher' | 'full'
export const READERS: ReportReader[] = ['boss', 'parent', 'teacher', 'full']
export const READER_LABEL: Record<ReportReader, string> = { boss: '老板版', parent: '家长版', teacher: '老师版', full: '完整数据版' }
export const READER_HINT: Record<ReportReader, string> = {
  boss: '开头三句话结论，然后是教研重点、课程卖点和风险；不铺表格、不出代码。给老板看。',
  parent: '300 字以内的大白话：孩子要练什么、为什么、在家怎么陪练，每点一个例句。老师核对后可以复制到微信。',
  teacher: '易错点 + 原卷例题 + 练法和讲解要点。给辅导老师备课用。',
  full: '完整的数据报告：分布、题型、难度、重难点、易错点、年度变化。给运营和教研核对数字用。'
}
export const isReader = (v: unknown): v is ReportReader => typeof v === 'string' && (READERS as string[]).includes(v)

// ───────────────────────── 去重复的说法 ─────────────────────────

const normClause = (x: string) => x.replace(/[\s+＋]/g, '').toLowerCase()

/**
 * 把几条「易错原因」合成一格时去掉重复的说法：按「；」切成小句，一个小句如果被另一个小句包含（「time to + 动词」被「time to + 动词原形」包含）或完全一样，只留长的那个。
 * 保持原来的先后顺序。纯函数，单测直接加载。
 */
export function dedupeClauses(texts: string[]): string {
  const clauses: string[] = []
  for (const t of texts) for (const c of t.split(/[；;]/)) { const x = c.trim(); if (x) clauses.push(x) }
  const keep = clauses.filter((c, i) => {
    const n = normClause(c)
    return !clauses.some((o, j) => {
      if (i === j) return false
      const m = normClause(o)
      return m === n ? j < i : m.includes(n)
    })
  })
  return keep.join('；')
}

// ───────────────────────── 去代码 ─────────────────────────

/** 知识点代码（至少有一个点：GR.NOUN.PLURAL）和题型代码（带下划线：PH_DIFF）。一级节点的单段代码（RD、FN）只在已知代码表里认 */
const KP_CODE_RE = /\b[A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*)+\b/g
const QTYPE_CODE_RE = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/g

function dropCodeColumns(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]
    const sep = lines[i + 1]
    if (head.includes('|') && sep && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(sep) && sep.includes('|')) {
      const cells = (l: string) => { let t = l.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|')) t = t.slice(0, -1); return t.split('|') }
      const idx = cells(head).findIndex(c => c.trim() === '代码')
      let j = i
      const block: string[] = []
      while (j < lines.length && lines[j].includes('|')) { block.push(lines[j]); j++ }
      if (idx >= 0) {
        for (const l of block) {
          const c = cells(l)
          if (idx < c.length) c.splice(idx, 1)
          out.push(`| ${c.map(x => x.trim()).join(' | ')} |`)
        }
      } else out.push(...block)
      i = j - 1
      continue
    }
    out.push(head)
  }
  return out
}

/** @param known 已知的全部知识点 / 题型代码（含一级节点的单段代码）；只用来认「单段」代码，带点或下划线的代码不用查表 */
export function stripInternalCodes(md: string, known: Iterable<string> = []): string {
  const set = new Set(known)
  const single = [...set].filter(c => /^[A-Z][A-Z0-9_]*$/.test(c) && c.length >= 2).sort((a, b) => b.length - a.length)
  let lines = md.replace(/\r\n/g, '\n').split('\n')
  lines = dropCodeColumns(lines)
  let inFence = false
  lines = lines.map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line }
    if (inFence) return line
    let l = line
    // `### 代码｜名称` → `### 名称`；`代码｜名称` 列表项 → `名称`
    l = l.replace(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.、)]\s*)?)(?:\*\*)?`?[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*`?(?:\*\*)?\s*[｜|]\s*/, (m, pre) => (m.includes('｜') ? pre : m))
    l = l.replace(KP_CODE_RE, '').replace(QTYPE_CODE_RE, '')
    // 单段代码里，一级知识点代码（RD、FN、GR……，2–3 个字母）基本不会是正常单词：裸写也去；
    // 题型代码（MATCH、ORDER、FILL、WRITE、OTHER……）和正常的大写英文单词长得一样：只在明确是「代码」的位置去——
    // 括号 / 方括号 / 反引号里单独一个代码，或后面紧跟全角「｜」（代码｜名称）；正文和题干摘录里裸写的大写单词原样保留
    for (const c of single) {
      l = l.replace(new RegExp(`[（(\\[【]\\s*${c}\\s*[）)\\]】]`, 'g'), '')
        .replace(new RegExp(`\`${c}\``, 'g'), '')
        .replace(new RegExp(`(?<![A-Za-z0-9_])${c}\\s*｜\\s*`, 'g'), '')
      if (c.length <= 3) l = l.replace(new RegExp(`(?<![A-Za-z0-9_])${c}(?![A-Za-z0-9_])`, 'g'), '')
    }
    // 去掉代码后留下的空括号、空反引号、孤零零的分隔符
    l = l.replace(/[（(]\s*[、，,/\s]*[）)]/g, '').replace(/`\s*`/g, '').replace(/(^|\s)｜\s*(?=\S)/g, (m, a) => (a === '' ? '' : ' '))
      .replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '')
    return l
  })
  return lines.join('\n')
}

/** 去掉 AI 套在引用外面的反引号（`[卷名 · 题号]`），以及不成对的、行内的单个反引号；代码围栏里的不动 */
export function fixBackticks(md: string): string {
  let inFence = false
  return md.replace(/\r\n/g, '\n').split('\n').map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line }
    if (inFence) return line
    let l = line.replace(/`([^`\n]*)`/g, '$1')
    l = l.replace(/`/g, '')
    return l
  }).join('\n')
}

// ───────────────────────── 家长版 ─────────────────────────

/** 只拦统计词和百分比；「难点」「重点」这类家长也看得懂的话不拦（以前拦了，整份被删空） */
const PARENT_BANNED = /\d+(?:\.\d+)?\s*%|百分点|出现率|分值|占比|基线|样本|AI\s*估计|平均难度|综合得分|同比|统计|置信|份卷|知识点分布/

/** 家长版：含统计词或百分比的句子整句删掉。返回删了几句 */
export function sanitizeParent(md: string): { text: string; removed: number } {
  let removed = 0
  const out: string[] = []
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim() || /^\s*#{1,6}\s/.test(line) || /^\s*>/.test(line)) { out.push(line); continue }
    const lead = /^(\s*(?:[-*+]|\d+[.、)])\s*)/.exec(line)?.[1] ?? ''
    const body = line.slice(lead.length)
    const pieces = body.split(/(?<=[。！？!?])/)
    const keep = pieces.filter(p => { const bad = PARENT_BANNED.test(p.replace(/\*\*/g, '')); if (bad) removed++; return !bad })
    const kept = keep.join('')
    if (keep.length === 0) continue
    out.push(lead + kept)
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed }
}

/** 家长版正文少于这么多字，就当作「没写出东西」：不让核对、复制和导出，请重新生成 */
export const PARENT_MIN_CHARS = 40
/** 复制到微信的字数上限；超过就不让核对 / 复制 / 导出（后处理删不动时只能重新生成） */
export const PARENT_MAX_WECHAT = 300

/**
 * 这份报告现在不能「我已核对」、复制、导出的原因（白话）；可以用时返回 null。目前只有家长版会被拦：
 *  - 正文被净化到几乎只剩标题（统计词、矛盾句都删光了）；
 *  - 里面还有和题目解释矛盾的句子（没能自动删干净）。
 */
export function confirmBlockReason(r: { reader: string; markdown: string; unverified?: Array<{ kind: string }> }): string | null {
  if (r.reader !== 'parent') return null
  const items = parentItemCount(r.markdown)
  if (items < PARENT_MIN_ITEMS) return `这份家长版只剩 ${items} 条要点（至少要 ${PARENT_MIN_ITEMS} 条），可能是不通顺的条目被程序去掉了，建议重新生成一份`
  if (parentBodyLength(r.markdown) < PARENT_MIN_CHARS) return '这份家长版内容太少（可能被删减或没写完），建议重新生成一份'
  const n = markdownToWechat(r.markdown, { spaced: true }).length
  if (n > PARENT_MAX_WECHAT) return `这份家长版复制到微信有 ${n} 字，超过了 ${PARENT_MAX_WECHAT} 字，家长不爱读长消息，建议重新生成一份`
  if ((r.unverified ?? []).some(u => u.kind === 'conflict')) return '这份家长版里还有和题目解释矛盾的句子，没能自动处理干净，建议重新生成一份'
  return null
}

/**
 * 家长版「我已核对」时，还有哪些「未核实」的句子老师既没有确认无误、也没有删掉（返回这些句子；空数组 = 可以确认）。
 * 矛盾（conflict）的不在这里管：有矛盾句本来就不能确认（confirmBlockReason）。其他版本不要求逐句确认。
 * acknowledged = 老师在确认框里勾了「已确认无误」的句子（原文，和 unverified[].sentence 逐字相同）。
 */
export function unacknowledgedSentences(r: { reader: string; unverified?: Array<{ sentence: string; kind: string }> }, acknowledged: string[] = []): string[] {
  if (r.reader !== 'parent') return []
  const ok = new Set(acknowledged)
  return (r.unverified ?? []).filter(u => u.kind === 'unverified' && !ok.has(u.sentence)).map(u => u.sentence)
}

/** 家长版里编号要点的条数（`1. …`）；程序补的问候和结尾不算 */
export const PARENT_MIN_ITEMS = 2
const ITEM_LINE = /^\s*\d+[.、)]\s*\S/
export function parentItemCount(md: string): number {
  return md.replace(/\r\n/g, '\n').split('\n').filter(l => ITEM_LINE.test(l)).length
}

/** 家长版编号要点的字数（不含空白和 Markdown 记号）。问候和结尾是程序可能补的，不计入——否则空壳家长版也能凑够字数 */
export function parentBodyLength(md: string): number {
  let n = 0
  for (const l of md.replace(/\r\n/g, '\n').split('\n')) {
    if (!ITEM_LINE.test(l)) continue
    n += l.replace(/\*\*/g, '').replace(MARK_RE, '').replace(/^\s*\d+[.、)]\s*/, '').replace(/\s+/g, '').length
  }
  return n
}

// ───────────────────────── 老板版：未核实统一一行 / 分值最高的大类要有交代 ─────────────────────────

/** 老板版里不逐句挂「未核实」标记，统一在「三句话结论」后面放这一行（确认后去掉）。 */
const BOSS_REVIEW_RE = /^>\s*有\s*\d+\s*处说法还没经老师核对。?\s*$/
export const bossReviewLine = (n: number): string => `> 有 ${n} 处说法还没经老师核对`
export const hasBossReviewLine = (md: string): boolean => md.split('\n').some(l => BOSS_REVIEW_RE.test(l.trim()))
/** 老板版里「没核对的说法」的数量：n = 0 就去掉这一行；已有就改数字；没有就放在「三句话结论」这一节的末尾（下一个 ## 之前） */
export function setBossReviewLine(md: string, n: number): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n').filter(l => !BOSS_REVIEW_RE.test(l.trim()))
  if (n > 0) {
    const h = lines.findIndex(l => /^##\s*三句话结论/.test(l))
    let at = lines.length
    if (h >= 0) { at = lines.findIndex((l, i) => i > h && /^##\s/.test(l)); if (at < 0) at = lines.length }
    else { const first = lines.findIndex(l => /^##\s/.test(l)); at = first >= 0 ? first : lines.length }
    // 插在这一节最后一个非空行之后，前后各留一个空行
    let k = at
    while (k > 0 && lines[k - 1].trim() === '') k--
    lines.splice(k, at - k, '', bossReviewLine(n), '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
}

/** 「先投 A、B、C 三块」里的 A、B、C（取「三句话结论」第一句） */
export function bossPicked(md: string): string[] {
  const sec = /##\s*三句话结论[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(md)?.[1] ?? ''
  const m = /(?:先投入|优先投入|重点投入|先投|优先投|重点投|押)([^。\n]*?)(?:三块|几块|[，,；;]其他|。|$)/.exec(sec)
  return m ? m[1].split(/[、，,和及与]/).map(x => x.replace(/[\s*“”"「」]/g, '')).filter(x => x.length >= 2) : []
}
const nameKeys = (name: string): string[] => [name, ...name.split(/[与和、及/]/)].map(x => x.trim()).filter(x => x.length >= 2)
/**
 * 分值最高的大类没进"先投"的三块、「三句话结论」里也没提到它 → 返回一句提示（老板会问"占三成的为什么不投"）。
 * share = 占总分的比例（0–1）；占比太小（< 15%）不查。
 */
export function topScoreGapWarning(md: string, top: { name: string; share: number } | null | undefined): string | null {
  if (!top || top.share < 0.15) return null
  const keys = nameKeys(top.name)
  const picked = bossPicked(md)
  if (picked.some(p => keys.some(k => p.includes(k) || k.includes(p)))) return null
  const sec = /##\s*三句话结论[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(md)?.[1] ?? md
  if (keys.some(k => sec.includes(k))) return null
  return `分值最高的「${top.name}」（约占总分 ${Math.round(top.share * 100)}%）没有进"先投"的重点，三句话结论里也没有解释为什么先不投，老板会问；请补半句话（例如"……分值最高，但……先维持现有课程"）或重新生成`
}

// ───────────────────────── 复制到微信 ─────────────────────────

const inlineText = (items: Inline[]): string => items.map(it => (it.type === 'cite' ? '' : it.text)).join('').replace(/\s+/g, ' ').trim()

const LIST_LINE = /^(\s*)(?:[-*+]|\d+[.、)])\s+/

/**
 * 嵌套的列表拍平：「- **教研重点**：」下面缩进着几条子项时，上面那条是小标题（不编号），子项另起一个列表重新编号。
 * 以前整段列表一起编号，小标题成了「1.」，后面的条目接着编 2、3、4。
 */
export function flattenNestedLists(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  const indent = (l: string) => /^(\s*)/.exec(l)![1].length
  for (let i = 0; i < lines.length;) {
    if (!LIST_LINE.test(lines[i])) { out.push(lines[i]); i++; continue }
    const run: string[] = []
    while (i < lines.length && LIST_LINE.test(lines[i])) run.push(lines[i++])
    const base = Math.min(...run.map(indent))
    if (run.every(l => indent(l) === base)) { out.push(...run); continue }
    for (let k = 0; k < run.length;) {
      const top = run[k++]
      const kids: string[] = []
      while (k < run.length && indent(run[k]) > base) kids.push(run[k++].replace(/^\s+/, ''))
      if (kids.length) out.push('', top.replace(LIST_LINE, ''), '', ...kids, '')
      else out.push(top)
    }
  }
  return out.join('\n')
}

/**
 * 纯文本：标题单独一行，列表按 1. 2. 3. 编号（嵌套列表的小标题不编号），段落之间空一行；没有 # * > | ` 这些 Markdown 符号，也没有核对标记、引用和图片。
 * spaced = 列表的条与条之间也空一行（家长版：手机上一条一条看得清）。
 */
export function markdownToWechat(md: string, opts: { keepMarks?: boolean; spaced?: boolean } = {}): string {
  const base = (opts.keepMarks ? fixBackticks(md) : fixBackticks(md).replace(MARK_RE, '')).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(new RegExp(CITATION_RE.source, 'g'), '')
  const cleaned = flattenNestedLists(base)
  const out: string[] = []
  for (const b of parseBlocks(cleaned)) {
    switch (b.type) {
      case 'heading': out.push(b.text.replace(/[*`]/g, '').trim(), ''); break
      case 'p': { const t = inlineText(b.inline); if (t) out.push(t, ''); break }
      case 'ul': case 'ol': b.items.forEach((it, i) => { const t = inlineText(it); if (t) out.push(`${i + 1}. ${t}`); if (t && opts.spaced) out.push('') }); out.push(''); break
      case 'quote': break   // 引用块是给老师看的说明（样本提示、AI 草稿提醒），不进给家长的文字
      case 'code': out.push(b.text, ''); break
      case 'table': for (const r of b.rows) out.push(r.map(inlineText).join(' ')); out.push(''); break
      default: break
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

// ───────────────────────── 标题 ─────────────────────────

const GRADE_CN = ['', '一', '二', '三', '四', '五', '六']

export interface TitleInput {
  filter: { grade?: string; semester?: string; exam_type?: string; sample?: boolean }
  /** 范围里实际有的年级 / 学期 / 考试类型 / 学年起始（取自数据；筛选里指定了的以筛选为准） */
  grades: string[]
  semesters: string[]
  examTypes: string[]
  years: number[]
  reader: ReportReader
  /** YYYY-MM-DD */
  date: string
}

function gradeText(grades: string[]): string {
  const g = [...new Set(grades)].filter(x => /^[1-6]$/.test(x)).sort()
  if (g.length === 0) return ''
  if (g.length === 6) return '全部年级'
  return `${g.map(x => GRADE_CN[Number(x)]).join('、')}年级`
}

export function reportTitle(t: TitleInput): string {
  const parts: string[] = []
  if (t.filter.sample) parts.push('示例数据')
  const g = t.filter.grade ? gradeText([t.filter.grade]) : gradeText(t.grades)
  if (g) parts.push(g)
  const sem = t.filter.semester ? [t.filter.semester] : [...new Set(t.semesters)]
  if (sem.length === 1) parts.push(`${sem[0]}学期`)
  if (t.years.length) {
    const lo = Math.min(...t.years), hi = Math.max(...t.years)
    parts.push(lo === hi ? `${lo}-${lo + 1}学年` : `${lo}–${hi + 1}学年`)
  }
  const ex = t.filter.exam_type ? [t.filter.exam_type] : [...new Set(t.examTypes)]
  if (ex.length === 1) parts.push(ex[0])
  return `${parts.join(' ')} 考情分析报告（${READER_LABEL[t.reader]}）· ${t.date}`.replace(/^\s+/, '')
}
