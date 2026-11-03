/**
 * 重新上传同名课程体系时的「替换」比对。纯函数模块。
 * 按（级别名 + 课次）配对：配上的看内容哈希变没变；配不上的是新增 / 删除。同一级别里课次重复的，按出现顺序配。
 */
import crypto from 'node:crypto'
import type { ParsedLesson, ParsedLevel } from './map.ts'

export const lessonHash = (l: Pick<ParsedLesson, 'seq' | 'noLabel' | 'title' | 'theme' | 'textbookRef' | 'points'>): string =>
  crypto.createHash('sha1').update(JSON.stringify([l.seq, l.noLabel, l.title, l.theme, l.textbookRef, l.points.map(p => [p.kind, p.label, p.text])])).digest('hex').slice(0, 16)

export interface OldLesson { id: number; levelName: string; seq: number; hash: string }
export interface NewLesson { levelName: string; lesson: ParsedLesson; hash: string }

export interface ReplacePlan {
  added: NewLesson[]
  /** 配上了、内容变了：旧课次 id → 新内容 */
  changed: Array<{ id: number; next: NewLesson }>
  /** 配上了、内容没变：旧课次 id → 新内容（级别顺序等照新的更新，但课次内容不动） */
  same: Array<{ id: number; next: NewLesson }>
  removedIds: number[]
}

const keyOf = (level: string, seq: number, nth: number) => `${level}\u0000${seq}\u0000${nth}`

export function planReplace(old: OldLesson[], levels: ParsedLevel[]): ReplacePlan {
  const oldByKey = new Map<string, OldLesson>()
  const seenOld = new Map<string, number>()
  for (const o of old) {
    const b = `${o.levelName}\u0000${o.seq}`
    const n = (seenOld.get(b) ?? 0) + 1
    seenOld.set(b, n)
    oldByKey.set(keyOf(o.levelName, o.seq, n), o)
  }
  const plan: ReplacePlan = { added: [], changed: [], same: [], removedIds: [] }
  const used = new Set<number>()
  const seenNew = new Map<string, number>()
  for (const lv of levels) {
    for (const lesson of lv.lessons) {
      const b = `${lv.name}\u0000${lesson.seq}`
      const n = (seenNew.get(b) ?? 0) + 1
      seenNew.set(b, n)
      const nl: NewLesson = { levelName: lv.name, lesson, hash: lessonHash(lesson) }
      const o = oldByKey.get(keyOf(lv.name, lesson.seq, n))
      if (!o) { plan.added.push(nl); continue }
      used.add(o.id)
      if (o.hash === nl.hash) plan.same.push({ id: o.id, next: nl })
      else plan.changed.push({ id: o.id, next: nl })
    }
  }
  plan.removedIds = old.filter(o => !used.has(o.id)).map(o => o.id)
  return plan
}

export interface ReplaceCounts { added: number; changed: number; removed: number }
export const countsOf = (p: ReplacePlan): ReplaceCounts => ({ added: p.added.length, changed: p.changed.length, removed: p.removedIds.length })
