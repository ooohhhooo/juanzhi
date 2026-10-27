/**
 * 数据包里的知识点树校验（M4 复审 P2-1）。规则和 taxonomy/edit.ts 的手工编辑一致：
 * 层级 1–3、子节点层级 = 父节点层级 + 1、根节点层级 = 1、父节点必须存在于包内、不能成环、名称 1–30 字、说明 ≤ 500 字、引入年级 1–6 或空。
 * 纯函数，不依赖 electron / 数据库连接，单测直接加载。
 */
import { PackError } from './errors.ts'

export const KP_MAX_LEVEL = 3
export const KP_NAME_MAX = 30
export const KP_NOTE_MAX = 500
/** 白话释义 / 例句 / 例词的长度上限（内置的都在 25 / 60 / 40 / 40 以内；自建节点放宽一点） */
export const KP_PLAIN_MAX = 40
export const KP_EXAMPLE_EN_MAX = 120
export const KP_EXAMPLE_ZH_MAX = 80
export const KP_HINT_MAX = 60
export const KP_CODE_MAX = 80
export const KP_MAX_COUNT = 5000

/** 代码只允许大写字母 / 数字 / 下划线，用点分段（和内置代码、自建节点的 <上级>.U<n> 一致）；不接受空格、换行、竖线、引号等 */
export const KP_CODE_RE = /^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/
// 控制字符（含换行、制表、DEL、C1）、行 / 段分隔符，以及看不见的格式字符（零宽、双向控制、BOM）：名称和说明里都不允许
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
/** 知识点树会逐行写进给 AI 的提示词（`代码 | 路径 | 年级 | 说明`）和报告表格：竖线、换行会把一行拆成几行，让人为写的文字冒充另一条记录 */
const PIPE_RE = /\|/

import { looksLikeCode } from '../../shared/code-guard.ts'

/** 名称 / 说明的字符检查：合格返回 null，否则返回给老师看的原因（不含「名称」「说明」前缀，由调用方拼） */
export function kpTextProblem(s: string): string | null {
  if (CONTROL_RE.test(s)) return '不能包含换行、制表符等控制字符或看不见的特殊字符'
  if (PIPE_RE.test(s)) return '不能包含竖线「|」（它在给 AI 的知识点表里是分隔符）'
  return null
}

/** 名称的检查：除了字符，名称不能是内部代码（界面上显示的就是名称，代码会泄漏给老师） */
export function kpNameProblem(s: string): string | null {
  const p = kpTextProblem(s)
  if (p) return p
  if (looksLikeCode(s)) return '不能是英文代码，请写一个中文名称（如「看法与态度」）'
  return null
}

const INVISIBLE_RE_G = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
/** 去掉看不见的格式字符（零宽、双向控制、BOM）：从微信 / 网页 / Word 粘贴的文字常带它们，老师看不见也改不了，所以静默剔除、不报错 */
export const stripInvisible = (t: string): string => t.replace(INVISIBLE_RE_G, '')
/**
 * 把名称 / 说明折成一行（旧版本允许输入换行和竖线；提示词、数据包导出都用它）：
 * 看不见的字符直接去掉；控制字符（含换行、制表）和竖线变成空格，连续空格合并，去首尾空白。不能把一行拆成几行。
 */
export const flatKpText = (t: string): string => stripInvisible(t).replace(new RegExp(`${CONTROL_RE.source}|\\|`, 'g'), ' ').replace(/ {2,}/g, ' ').trim()

/** 老师采纳 AI 建议时的新节点名称：AI 给的文字折成一行（不让换行、竖线、零宽字符进树），折完不能为空、不能超长（taxonomy:approveSuggestion 用） */
export function cleanSuggestedName(raw: string): string {
  const name = flatKpText(raw)
  if (!name) throw new Error('名称不能为空（只有换行、竖线或看不见的字符不行）')
  if (name.length > KP_NAME_MAX) throw new Error(`名称不能超过 ${KP_NAME_MAX} 个字`)
  const np = kpNameProblem(name)
  if (np) throw new Error(`名称${np}`)
  return name
}

export interface KpRowLike { code: unknown; parent_code?: unknown; name?: unknown; level?: unknown; intro_grade?: unknown; note?: unknown; plain?: unknown; example_en?: unknown; example_zh?: unknown; hint_words?: unknown }

export const KP_PLAIN_FIELDS = [['plain', KP_PLAIN_MAX], ['example_en', KP_EXAMPLE_EN_MAX], ['example_zh', KP_EXAMPLE_ZH_MAX], ['hint_words', KP_HINT_MAX]] as const

const bad = (msg: string): never => { throw new PackError('bad_content', `数据包里的知识点树不合格：${msg}，已拒绝导入`) }

export function validateKpRows(rows: KpRowLike[]): void {
  if (rows.length > KP_MAX_COUNT) bad(`知识点超过 ${KP_MAX_COUNT} 个`)
  const byCode = new Map<string, KpRowLike>()
  for (const k of rows) {
    if (typeof k.code !== 'string' || !k.code || k.code.length > KP_CODE_MAX) bad('有知识点的代码为空或过长')
    if (!KP_CODE_RE.test(k.code as string)) bad(`知识点代码「${String(k.code).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 40)}」含有不允许的字符（只能是大写字母、数字、下划线，用点分段）`)
    if (byCode.has(k.code as string)) bad(`知识点代码「${k.code}」重复`)
    byCode.set(k.code as string, k)
  }
  for (const k of rows) {
    const code = k.code as string
    if (typeof k.name !== 'string' || !k.name.trim()) bad(`知识点「${code}」没有名称`)
    if ((k.name as string).length > KP_NAME_MAX) bad(`知识点「${code}」的名称超过 ${KP_NAME_MAX} 个字`)
    const np = kpTextProblem(k.name as string)   // 数据包里旧数据的名称可能就是代码（旧版本的 bug）：这里不拒绝，导入时改成「待命名的考点」
    if (np) bad(`知识点「${code}」的名称${np}`)
    if (k.note != null && (typeof k.note !== 'string' || k.note.length > KP_NOTE_MAX)) bad(`知识点「${code}」的说明超过 ${KP_NOTE_MAX} 个字`)
    if (typeof k.note === 'string') { const op = kpTextProblem(k.note); if (op) bad(`知识点「${code}」的说明${op}`) }
    // 白话 / 例句 / 例词也会逐行写进给 AI 的提示词：和名称、说明同样的字符规则
    for (const [f, max] of KP_PLAIN_FIELDS) {
      const v = (k as any)[f]
      if (v == null) continue
      const label = f === 'plain' ? '白话释义' : f === 'hint_words' ? '例词' : '例句'
      if (typeof v !== 'string' || v.length > max) bad(`知识点「${code}」的${label}不是文字或超过 ${max} 个字`)
      const p = kpTextProblem(v)
      if (p) bad(`知识点「${code}」的${label}${p}`)
    }
    const g = k.intro_grade
    if (g != null && !(typeof g === 'number' && Number.isInteger(g) && g >= 1 && g <= 6)) bad(`知识点「${code}」的引入年级不在 1–6 之间`)
    const lv = k.level
    if (typeof lv !== 'number' || !Number.isInteger(lv) || lv < 1 || lv > KP_MAX_LEVEL) bad(`知识点「${code}」的层级不在 1–${KP_MAX_LEVEL} 之间`)
    const pc = k.parent_code
    if (pc == null || pc === '') {
      if (lv !== 1) bad(`知识点「${code}」没有上级却不是第 1 层`)
    } else {
      const p = typeof pc === 'string' ? byCode.get(pc) : undefined
      if (!p) bad(`知识点「${code}」的上级「${String(pc)}」不存在`)
      if (lv !== (p!.level as number) + 1) bad(`知识点「${code}」的层级和上级对不上`)
    }
  }
  // 环：沿 parent_code 往上走，最多 KP_MAX_LEVEL 步必须到根（层级校验已保证严格递增，这里是兜底，防止层级字段被一起伪造）
  for (const k of rows) {
    let cur: KpRowLike | undefined = k
    for (let i = 0; i <= KP_MAX_LEVEL + 1 && cur; i++) {
      const pc: unknown = cur.parent_code
      if (pc == null || pc === '') { cur = undefined; break }
      cur = byCode.get(pc as string)
    }
    if (cur) bad(`知识点「${String(k.code)}」的上级关系成环或层数过深`)
  }
}
