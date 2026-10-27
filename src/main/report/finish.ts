/**
 * 模型输出 → 最终报告正文（M6）。纯流程，不碰数据库、网络和 electron；单测直接加载。
 * 顺序：去反引号 → 去内部代码 → 去模型写的标题 → 校验引用 → 家长版先删矛盾句、再净化统计词 → 写标题 → 补样本提示 → 事实核对写回「未核实」标记。
 */
import { stripUnknownCitations } from '../../shared/citation.ts'
import { checkRules, markFindings, removeSentence } from '../../shared/factcheck.ts'
import { fixBackticks, hasBossReviewLine, markdownToWechat, parentBodyLength, parentItemCount, PARENT_MIN_CHARS, PARENT_MIN_ITEMS, sanitizeParent, setBossReviewLine, stripInternalCodes, topScoreGapWarning } from '../../shared/report-post.ts'
import { bossJargon, fixParent, fixTeacherExamples, softenOverclaims } from '../../shared/parent-fix.ts'
import type { KpEvidence } from '../../shared/parent-fix.ts'
import type { ReportReader } from '../../shared/report-post.ts'
import { ensureSampleWarning } from '../stats/p3.ts'
import type { UnverifiedItem } from '../ai/chunk.ts'

/** 各版本在默认提示词里规定的最后一节（缺了很可能被截断；家长版没有固定小节，不检查） */
const FINAL_SECTION: Record<ReportReader, RegExp | null> = { full: /^#{1,3}\s*教学建议/m, boss: /^#{1,3}\s*风险提示/m, teacher: /^#{1,3}\s*备课建议/m, parent: null }
const FINAL_NAME: Record<ReportReader, string> = { full: '教学建议', boss: '风险提示', teacher: '备课建议', parent: '' }

/** 去掉模型自己写的一级标题（标题由程序按年级 / 学期 / 学年 / 日期统一生成） */
export function dropLeadingH1(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length && /^#\s/.test(lines[i])) lines.splice(i, 1)
  return lines.join('\n').replace(/^\s*\n/, '')
}

/**
 * 模型输出 → 最终报告正文（纯流程，不碰数据库和网络；单测直接跑）。
 * 顺序：去反引号 → 去内部代码 → 去模型写的标题 → 校验引用 → 家长版净化 → 写标题 → 补样本提示 → 事实核对写回标记。
 */
export function finishReport(o: {
  raw: string; reader: ReportReader; title: string; knownRefs: Set<string>; knownCodes: string[]; sampleWarning: string; evidence: string[]; usedDefaultPrompt: boolean
  /** 每个知识点的白话 / 例句（家长版、老师版校对例句用）；不传就不校对例句 */
  evidenceKps?: KpEvidence[]
  /** 老板版标题下面那一行（程序写）；不传就沿用模型写的说明 */
  bossLine?: string
  /** 范围里的卷子份数（样本少于 3 份时不能写难点结论） */
  papers?: number
  /** 分值最高的大类（占总分的比例 0–1）：老板版没把它放进重点、结论里又没提时给一条提示 */
  topScore?: { name: string; share: number } | null
  /** 考试类型（期中 / 期末……）：家长版开头问候里写；不传就不写具体类型 */
  examLabel?: string | null
}): { text: string; warnings: string[]; unverified: UnverifiedItem[] } {
  const warnings: string[] = []
  let body = stripInternalCodes(fixBackticks(o.raw), o.knownCodes)
  body = dropLeadingH1(body)
  const stripped = stripUnknownCitations(body, o.knownRefs)
  body = stripped.text
  if (stripped.removed.length) warnings.push(`已移除 ${stripped.removed.length} 处无法核对的引用（模型写出了输入里没有的试卷或题号）`)

  // 事实核对：规则句对证据。家长版里和题目解释矛盾的句子整句删掉（不能让错的规则发给家长），再净化统计词；核对结果以最终正文为准
  if (o.reader === 'parent') {
    const conflicts = checkRules(body, o.evidence).filter(f => f.kind === 'conflict')
    for (const c of conflicts) body = removeSentence(body, c.sentence)
    if (conflicts.length) {
      // 删完再核对一遍：以实际结果为准，提示不能比事实乐观（句子里夹着别的东西时可能没删干净）
      const left = checkRules(body, o.evidence).filter(f => f.kind === 'conflict').length
      if (left === 0) warnings.push(`有 ${conflicts.length} 句讲英语规则的话和审核过的题目解释矛盾，已从家长版里删掉`)
      else warnings.push(`有 ${conflicts.length} 句讲英语规则的话和审核过的题目解释矛盾，其中 ${left} 句没能自动删掉，已在正文里标出「与题目解释矛盾」；这份家长版不能核对通过，请重新生成`)
    }
    const clean = sanitizeParent(body)
    body = clean.text
    if (clean.removed) warnings.push(`家长版里有 ${clean.removed} 句含统计词或百分比，已删掉`)
    // 例句和要点对得上、没有家长看不懂的写法、开头问候、条与条空一行、字数按「复制到微信」的口径 ≤ 300
    const fixed = fixParent(body, o.evidenceKps ?? [], md => markdownToWechat(md, { spaced: true }).length, 300, o.examLabel)
    body = fixed.text
    warnings.push(...fixed.warnings)
    const n = markdownToWechat(body, { spaced: true }).length
    if (n > 300) warnings.push(`家长版复制到微信有 ${n} 字，超过了 300 字的要求，不能核对通过，请重新生成`)
    const nItems = parentItemCount(body)
    if (nItems < PARENT_MIN_ITEMS || parentBodyLength(body) < PARENT_MIN_CHARS) warnings.push(`家长版内容太少（只剩 ${nItems} 条要点，可能被删减或没写完），不能核对通过，请重新生成`)
  }
  if (o.reader === 'boss') {
    // 样本少时程序已经声明「不下难点结论」，正文不能再写「可能全部易错」这类结论
    if ((o.papers ?? 99) < 3) {
      const soft = softenOverclaims(body)
      body = soft.text
      if (soft.changed) warnings.push(`老板版里有 ${soft.changed} 处写了难点结论，但只有 ${o.papers} 份卷子，已改成「AI 估计」的说法`)
    }
    const gap = topScoreGapWarning(body, o.topScore)
    if (gap) warnings.push(gap)
    const jargon = bossJargon(body)
    if (jargon.length) warnings.push(`老板版里还有老板看不懂的词（${jargon.join('、')}），发出去之前请改成大白话`)
  }
  if (o.reader === 'teacher' && o.evidenceKps) {
    const fixedT = fixTeacherExamples(body, o.evidenceKps)
    body = fixedT.text
    warnings.push(...fixedT.warnings)
  }
  const remaining = checkRules(body, o.evidence)
  // 家长版不写标题（老师口吻：开头就是「各位家长好」）；其他版本标题由程序写
  let text = o.reader === 'parent' ? body.replace(/^\s+/, '') : `# ${o.title}\n\n${body.replace(/^\s+/, '')}`
  if (o.reader === 'boss' && o.bossLine) {
    // 老板版：标题下面只留程序写的一行（几份卷子、哪几个学年、仅作方向参考），模型自己写的「说明」去掉
    const lines = text.split('\n')
    let i = 1
    while (i < lines.length && lines[i].trim() === '') i++
    let j = i
    while (j < lines.length && /^>/.test(lines[j].trim())) j++
    text = [...lines.slice(0, i), `> ${o.bossLine}`, '', ...lines.slice(j)].join('\n').replace(/\n{3,}/g, '\n\n')
  } else if (o.reader !== 'parent') {
    const ens = ensureSampleWarning(text, o.sampleWarning)
    text = ens.text
  }
  // 老板版不逐句挂「未核实」：清单（unverified）照常保留给核对框，正文只在「三句话结论」后面统一放一行
  const marked = o.reader === 'boss' ? { text, missed: [] as typeof remaining } : markFindings(text, remaining)
  text = marked.text
  if (o.reader === 'boss' && remaining.length) text = setBossReviewLine(text, remaining.length)
  const unverified: UnverifiedItem[] = remaining.map(f => ({ sentence: f.sentence, kind: f.kind, reason: f.reason }))
  // 「有 N 句……没能对上」不再写进 warnings：界面已经有一条按 unverified 清单实时计数的提示，两处都写就成了同一条黄条出现两次；
  // 只有「标记没能落到正文里」这种清单里看不出来的情况才单独说一句
  if (marked.missed.length) warnings.push(`有 ${marked.missed.length} 句未核实的话在正文里定位不到标记位置，只列在「未核实」清单里`)
  const fin = FINAL_SECTION[o.reader]
  if (o.usedDefaultPrompt && fin && !fin.test(text)) warnings.push(`输出里没有最后一节「${FINAL_NAME[o.reader]}」，内容可能不完整，建议重新生成`)
  return { text, warnings, unverified }
}


/**
 * 老师在核对时「从报告里删掉这一句」（未核实 / 矛盾的句子）：正文里连同它后面的标记一起删，清单里去掉这一条。
 * 纯函数；句子必须是清单里的（不能借这个接口删任意文字）。找不到这一句 / 不在清单里返回 null。
 */
export function dropReportSentence(markdown: string, unverified: UnverifiedItem[], sentence: string): { markdown: string; unverified: UnverifiedItem[] } | null {
  if (!unverified.some(u => u.sentence === sentence)) return null
  const next = removeSentence(markdown, sentence)
  if (next === markdown) return null
  const left = unverified.filter(u => u.sentence !== sentence)
  // 老板版：「还有 N 处没核对」那一行跟着清单的数量走（清单空了就去掉）
  return { markdown: hasBossReviewLine(next) ? setBossReviewLine(next, left.length) : next, unverified: left }
}

const VERIFY_WARNING_RE = /句讲英语规则的话在审核过的题目解释里找不到依据，已标「未核实」/

/** 「有 N 句……未核实」那条提示的文字（生成时和删句后重算都用它，数字永远和清单一致） */
export function verifyWarning(unverified: UnverifiedItem[], missed = 0): string {
  return `有 ${unverified.length} 句讲英语规则的话在审核过的题目解释里找不到依据，已标「未核实」，请老师核对后再用${unverified.some(u => u.kind === 'conflict') ? '（其中有和题目解释矛盾的）' : ''}${missed ? `；其中 ${missed} 句在正文里定位不到标记位置，只列在「未核实」清单里` : ''}`
}

/** 删句之后重写 warnings：去掉旧的「有 N 句未核实」那条，按现在的清单重算（清单空了就不留这条）；其余提示（样本、引用、家长版删句记录……）原样保留 */
export function refreshVerifyWarnings(warnings: string[], unverified: UnverifiedItem[]): string[] {
  const rest = warnings.filter(w => !VERIFY_WARNING_RE.test(w))
  return unverified.length ? [...rest, verifyWarning(unverified)] : rest
}
