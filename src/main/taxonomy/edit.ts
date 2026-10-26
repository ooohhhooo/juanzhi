/**
 * 知识点树编辑：新增 / 改名（及改说明、引入年级）/ 移动 / 合并 / 停用（启用）/ 删除。纯函数模块（数据库由调用方传入），单测直接加载。
 *
 * 原则：
 *  - **节点 ID（code）永远不变**。改名、移动都只改 name / parent_code / level，统计、题目标注、历史报告引用的 code 照旧有效；
 *  - 内置节点（builtin = 1，程序自带的种子）：可以改名、改说明，可以停用 / 重新启用（可逆，数据都在）；
 *    不能删除，不能移动，不能被合并掉（合并等于把它删了）。内置节点可以作合并的目标；
 *  - 合并 S → T：S 的题目标注全部迁到 T（一道题同时标了 S 和 T 时只留一条，主知识点优先）；S 的子节点挂到 T 下面；
 *    S 标记为 deprecated 并写 merged_into = T（以后任何指向 S 的旧数据，统计时都落到 T）；
 *  - 停用：该节点和它的所有子节点不再出现在 AI 提示词的知识点树和审核页的选择器里，但已有题目的标注保留、统计照常算；
 *  - 树最多 3 层。
 * 所有操作在一个事务里，一步失败整批回滚。修订号（data_rev）由 kps / question_kps 上的触发器自动推高，看板和 AI 缓存据此失效。
 */

import { kpTextProblem, stripInvisible, KP_NAME_MAX, KP_NOTE_MAX } from '../pack/kp-rules.ts'

export type TaxonomyOp =
  | { op: 'add'; parent_code: string | null; name: string; note?: string; intro_grade?: number | null }
  | { op: 'update'; code: string; name?: string; note?: string | null; intro_grade?: number | null }
  | { op: 'move'; code: string; parent_code: string | null }
  | { op: 'merge'; code: string; into: string }
  | { op: 'deprecate'; code: string; deprecated: boolean }
  | { op: 'delete'; code: string }

export interface KpRow {
  code: string
  parent_code: string | null
  name: string
  level: number
  intro_grade: number | null
  sort: number
  deprecated: number
  merged_into: string | null
  note: string | null
  builtin: number
}

export class TaxonomyError extends Error {}

const MAX_LEVEL = 3
const bad = (msg: string): never => { throw new TaxonomyError(msg) }

function load(db: any): Map<string, KpRow> {
  return new Map((db.prepare('SELECT code, parent_code, name, level, intro_grade, sort, deprecated, merged_into, note, builtin FROM kps').all() as KpRow[]).map(k => [k.code, k]))
}

function childrenOf(all: Map<string, KpRow>, code: string): KpRow[] {
  return [...all.values()].filter(k => k.parent_code === code)
}

/** 子树里所有节点（含自己） */
function subtree(all: Map<string, KpRow>, code: string): KpRow[] {
  const out: KpRow[] = []
  const stack = [code]
  const seen = new Set<string>()
  while (stack.length) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    const n = all.get(c)
    if (!n) continue
    out.push(n)
    for (const ch of childrenOf(all, c)) stack.push(ch.code)
  }
  return out
}

/** 子树的高度（只有自己 = 1） */
function height(all: Map<string, KpRow>, code: string, depth = 0): number {
  if (depth > 6) return 0
  const kids = childrenOf(all, code)
  return 1 + (kids.length ? Math.max(...kids.map(k => height(all, k.code, depth + 1))) : 0)
}

const cleanName = (n: unknown): string => {
  const s = typeof n === 'string' ? stripInvisible(n).trim() : ''   // 粘贴带来的零宽字符静默剔除
  if (!s) bad('名称不能为空')
  if (s.length > KP_NAME_MAX) bad(`名称不能超过 ${KP_NAME_MAX} 个字`)
  const p = kpTextProblem(s)
  if (p) bad(`名称${p}`)
  return s
}
/** 说明：去首尾空白；超长、含换行 / 控制字符 / 竖线一律拒绝（不再悄悄截断）；空串视为没有说明 */
const cleanNote = (n: unknown): string | null => {
  const s = typeof n === 'string' ? stripInvisible(n).trim() : ''
  if (!s) return null
  if (s.length > KP_NOTE_MAX) bad(`说明不能超过 ${KP_NOTE_MAX} 个字`)
  const p = kpTextProblem(s)
  if (p) bad(`说明${p}`)
  return s
}

function sameNameSibling(all: Map<string, KpRow>, parent: string | null, name: string, except?: string): KpRow | undefined {
  return [...all.values()].find(k => k.code !== except && (k.parent_code ?? null) === parent && k.deprecated === 0 && k.name === name)
}

function newCode(all: Map<string, KpRow>, parent: string | null): string {
  const prefix = parent ?? 'U'
  let n = 1
  while (all.has(`${prefix}.U${n}`)) n++
  return `${prefix}.U${n}`
}

function setLevels(db: any, all: Map<string, KpRow>, code: string, level: number): void {
  const n = all.get(code)!
  n.level = level
  db.prepare('UPDATE kps SET level = ? WHERE code = ?').run(level, code)
  for (const ch of childrenOf(all, code)) setLevels(db, all, ch.code, level + 1)
}

function applyOne(db: any, all: Map<string, KpRow>, op: TaxonomyOp): void {
  const need = (code: string): KpRow => all.get(code) ?? bad(`知识点不存在：${code}`)
  switch (op.op) {
    case 'add': {
      const name = cleanName(op.name)
      const parent = op.parent_code ? need(op.parent_code) : null
      if (parent && parent.deprecated) bad('不能在已停用的节点下新增')
      const level = (parent?.level ?? 0) + 1
      if (level > MAX_LEVEL) bad(`知识点树最多 ${MAX_LEVEL} 层，不能再往「${parent!.name}」下新增了`)
      if (sameNameSibling(all, parent?.code ?? null, name)) bad(`同一级下已经有叫「${name}」的知识点`)
      const code = newCode(all, parent?.code ?? null)
      const sibs = [...all.values()].filter(k => (k.parent_code ?? null) === (parent?.code ?? null))
      const sort = (sibs.length ? Math.max(...sibs.map(s => s.sort)) : (parent?.sort ?? 0)) + 1
      const row: KpRow = { code, parent_code: parent?.code ?? null, name, level, intro_grade: op.intro_grade ?? null, sort, deprecated: 0, merged_into: null, note: cleanNote(op.note), builtin: 0 }
      db.prepare(`INSERT INTO kps (code, parent_code, name, level, intro_grade, sort, deprecated, merged_into, note, builtin) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, 0)`)
        .run(code, row.parent_code, name, level, row.intro_grade, sort, row.note)
      all.set(code, row)
      return
    }
    case 'update': {
      const n = need(op.code)
      if (op.name !== undefined) {
        const name = cleanName(op.name)
        if (sameNameSibling(all, n.parent_code ?? null, name, n.code)) bad(`同一级下已经有叫「${name}」的知识点`)
        db.prepare('UPDATE kps SET name = ? WHERE code = ?').run(name, n.code); n.name = name
      }
      if (op.note !== undefined) {
        const note = op.note === null ? null : cleanNote(op.note)
        db.prepare('UPDATE kps SET note = ? WHERE code = ?').run(note, n.code); n.note = note
      }
      if (op.intro_grade !== undefined) {
        if (op.intro_grade !== null && !(Number.isInteger(op.intro_grade) && op.intro_grade >= 1 && op.intro_grade <= 6)) bad('引入年级必须是 1–6')
        db.prepare('UPDATE kps SET intro_grade = ? WHERE code = ?').run(op.intro_grade, n.code); n.intro_grade = op.intro_grade
      }
      return
    }
    case 'move': {
      const n = need(op.code)
      if (n.builtin) bad(`「${n.name}」是内置知识点，只能改名，不能移动`)
      const parent = op.parent_code ? need(op.parent_code) : null
      if ((n.parent_code ?? null) === (parent?.code ?? null)) return
      if (parent && subtree(all, n.code).some(k => k.code === parent.code)) bad('不能把节点移到它自己或它的子节点下面')
      if (parent && parent.deprecated) bad('不能移到已停用的节点下')
      const newLevel = (parent?.level ?? 0) + 1
      if (newLevel - 1 + height(all, n.code) > MAX_LEVEL) bad(`移动后知识点树会超过 ${MAX_LEVEL} 层`)
      if (sameNameSibling(all, parent?.code ?? null, n.name, n.code)) bad(`目标位置下已经有叫「${n.name}」的知识点`)
      db.prepare('UPDATE kps SET parent_code = ? WHERE code = ?').run(parent?.code ?? null, n.code)
      n.parent_code = parent?.code ?? null
      setLevels(db, all, n.code, newLevel)
      return
    }
    case 'merge': {
      const s = need(op.code)
      const t = need(op.into)
      if (s.code === t.code) bad('不能把知识点合并到它自己')
      if (s.merged_into) bad(`「${s.name}」已经合并到别的知识点了`)
      if (s.builtin) bad(`「${s.name}」是内置知识点，只能改名，不能合并掉（合并会让它消失）。可以把别的知识点合并进它，或者停用它`)
      if (t.deprecated) bad('合并的目标已停用，请选择一个正在使用的知识点')
      if (subtree(all, s.code).some(k => k.code === t.code)) bad('不能把节点合并到它自己的子节点里')
      // 子节点挂到目标下面，层数不能超
      for (const ch of childrenOf(all, s.code)) {
        if (t.level + height(all, ch.code) > MAX_LEVEL) bad(`「${ch.name}」挂到「${t.name}」下面会超过 ${MAX_LEVEL} 层，请先处理它`)
        if (sameNameSibling(all, t.code, ch.name, ch.code)) bad(`「${t.name}」下已经有叫「${ch.name}」的知识点，请先给其中一个改名`)
      }
      // 1. 题目标注迁移：同一道题已经标了目标 → 保留一条（主知识点优先）；否则改成目标
      db.prepare(`UPDATE question_kps SET is_primary = 1
        WHERE kp_code = ? AND question_id IN (SELECT question_id FROM question_kps WHERE kp_code = ? AND is_primary = 1)`).run(t.code, s.code)
      db.prepare('DELETE FROM question_kps WHERE kp_code = ? AND question_id IN (SELECT question_id FROM question_kps WHERE kp_code = ?)').run(s.code, t.code)
      db.prepare('UPDATE question_kps SET kp_code = ? WHERE kp_code = ?').run(t.code, s.code)
      // 2. 子节点挂过去
      for (const ch of childrenOf(all, s.code)) {
        db.prepare('UPDATE kps SET parent_code = ? WHERE code = ?').run(t.code, ch.code)
        ch.parent_code = t.code
        setLevels(db, all, ch.code, t.level + 1)
      }
      // 3. 以前合并到 S 的，现在指向 T
      db.prepare('UPDATE kps SET merged_into = ? WHERE merged_into = ?').run(t.code, s.code)
      for (const k of all.values()) if (k.merged_into === s.code) k.merged_into = t.code
      // 4. S 本身停用并记下去向
      db.prepare('UPDATE kps SET deprecated = 1, merged_into = ? WHERE code = ?').run(t.code, s.code)
      s.deprecated = 1; s.merged_into = t.code
      return
    }
    case 'deprecate': {
      const n = need(op.code)
      if (op.deprecated) {
        for (const k of subtree(all, n.code)) {
          db.prepare('UPDATE kps SET deprecated = 1 WHERE code = ?').run(k.code); k.deprecated = 1
        }
      } else {
        if (n.merged_into) bad(`「${n.name}」已经合并到别的知识点，不能重新启用`)
        const p = n.parent_code ? all.get(n.parent_code) : null
        if (p && p.deprecated) bad(`它的上级「${p.name}」还停用着，请先启用上级`)
        if (sameNameSibling(all, n.parent_code ?? null, n.name, n.code)) bad(`同一级下已经有叫「${n.name}」的知识点，先给其中一个改名再重新启用`)
        db.prepare('UPDATE kps SET deprecated = 0 WHERE code = ?').run(n.code); n.deprecated = 0
      }
      return
    }
    case 'delete': {
      const n = need(op.code)
      if (n.builtin) bad(`「${n.name}」是内置知识点，不能删除（可以停用）`)
      if (n.merged_into) bad(`「${n.name}」已经合并到别的知识点；它留在这里是为了让旧数据里指向它的标注能找到去向，不能删除`)
      if (childrenOf(all, n.code).length) bad(`「${n.name}」下面还有子节点，不能删除。请先处理子节点，或者改用「停用」`)
      const used = (db.prepare('SELECT COUNT(*) c FROM question_kps WHERE kp_code = ?').get(n.code) as any).c as number
      if (used) bad(`「${n.name}」下标注了 ${used} 道题，不能删除。可以把它合并到别的知识点，或者停用`)
      if ((db.prepare('SELECT COUNT(*) c FROM kps WHERE merged_into = ?').get(n.code) as any).c) bad(`有别的知识点已经合并到「${n.name}」，不能删除`)
      db.prepare('DELETE FROM kps WHERE code = ?').run(n.code)
      all.delete(n.code)
      return
    }
  }
}

export interface TaxonomyResult {
  ops: number
  /** 这次编辑改动了（或新增了）的知识点代码——界面用来定位 */
  touched: string[]
}

const rowSig = (k: KpRow) => JSON.stringify([k.parent_code, k.name, k.level, k.intro_grade, k.deprecated, k.merged_into, k.note])

/** 一批操作放在一个事务里：任何一步不合规，整批回滚，错误里带第几步 */
export function saveTaxonomy(db: any, ops: TaxonomyOp[]): TaxonomyResult {
  if (ops.length === 0) return { ops: 0, touched: [] }
  const all = load(db)
  const before = new Map([...all.values()].map(k => [k.code, rowSig(k)]))
  db.exec('BEGIN')
  try {
    ops.forEach((op, i) => {
      try { applyOne(db, all, op) } catch (e) {
        if (e instanceof TaxonomyError) throw new TaxonomyError(ops.length > 1 ? `第 ${i + 1} 步：${e.message}` : e.message)
        throw e
      }
    })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const touched = [...all.values()].filter(k => before.get(k.code) !== rowSig(k)).map(k => k.code)
  return { ops: ops.length, touched }
}
