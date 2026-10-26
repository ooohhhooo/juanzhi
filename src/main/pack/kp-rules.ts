/**
 * 数据包里的知识点树校验（M4 复审 P2-1）。规则和 taxonomy/edit.ts 的手工编辑一致：
 * 层级 1–3、子节点层级 = 父节点层级 + 1、根节点层级 = 1、父节点必须存在于包内、不能成环、名称 1–30 字、说明 ≤ 500 字、引入年级 1–6 或空。
 * 纯函数，不依赖 electron / 数据库连接，单测直接加载。
 */
import { PackError } from './errors.ts'

export const KP_MAX_LEVEL = 3
export const KP_NAME_MAX = 30
export const KP_NOTE_MAX = 500
export const KP_CODE_MAX = 80
export const KP_MAX_COUNT = 5000

export interface KpRowLike { code: unknown; parent_code?: unknown; name?: unknown; level?: unknown; intro_grade?: unknown; note?: unknown }

const bad = (msg: string): never => { throw new PackError('bad_content', `数据包里的知识点树不合格：${msg}，已拒绝导入`) }

export function validateKpRows(rows: KpRowLike[]): void {
  if (rows.length > KP_MAX_COUNT) bad(`知识点超过 ${KP_MAX_COUNT} 个`)
  const byCode = new Map<string, KpRowLike>()
  for (const k of rows) {
    if (typeof k.code !== 'string' || !k.code || k.code.length > KP_CODE_MAX) bad('有知识点的代码为空或过长')
    if (byCode.has(k.code as string)) bad(`知识点代码「${k.code}」重复`)
    byCode.set(k.code as string, k)
  }
  for (const k of rows) {
    const code = k.code as string
    if (typeof k.name !== 'string' || !k.name.trim()) bad(`知识点「${code}」没有名称`)
    if ((k.name as string).length > KP_NAME_MAX) bad(`知识点「${code}」的名称超过 ${KP_NAME_MAX} 个字`)
    if (k.note != null && (typeof k.note !== 'string' || k.note.length > KP_NOTE_MAX)) bad(`知识点「${code}」的说明超过 ${KP_NOTE_MAX} 个字`)
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
