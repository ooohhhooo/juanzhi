/**
 * 跨批合并（提示词 §7.3）：
 *  - 题目以 (section, no) 为键；continued_from_prev=true 的记录整条替换上一批的同键记录；
 *  - 材料按 id 追加 text；
 *  - 同一个大题序号在后面的批次里重新出现（听力部分「一」、笔试部分「一」），视为新的大题实例，题目挂到最新实例。
 * 同时生成下一批的 PREV_CONTEXT。
 */
import type { Meta, Section, Material, AnyQuestion } from './schema.ts'

export type Mode = 'text' | 'vision'

export interface MergedSection extends Section { inst: number; batch: number }
export interface MergedMaterial extends Material { batch: number }
export interface MergedQuestion extends AnyQuestion { mode: Mode; batch: number; inst: number }

export interface MergeState {
  meta: Meta
  sections: MergedSection[]
  materials: MergedMaterial[]
  questions: MergedQuestion[]
  notes: string[]
  /** 大题序号 → 最新实例号 */
  latestInst: Record<string, number>
}

export function newMergeState(): MergeState {
  return {
    meta: { title: null, grade: null, semester: null, school_year: null, exam_type: null, textbook: null, total_score: null },
    sections: [], materials: [], questions: [], notes: [], latestInst: {}
  }
}

export interface BatchOutput {
  meta: Meta
  sections: Section[]
  materials: Material[]
  questions: AnyQuestion[]
  notes: string[]
}

export function mergeBatch(state: MergeState, out: BatchOutput, ctx: { batch: number; mode: Mode }): void {
  for (const k of Object.keys(state.meta) as Array<keyof Meta>) {
    if (state.meta[k] === null && out.meta[k] !== null) (state.meta as Record<string, unknown>)[k] = out.meta[k]
  }

  out.sections.forEach((s, si) => {
    const existing = state.latestInst[s.no]
    const last = state.sections[state.sections.length - 1]
    // 模型漏设 continued_from_prev 时的兜底：本批第一个大题与上一批最后一个大题序号、标题都相同，只能是同一个大题的续写
    // （「听力一」与「笔试一」标题不同，不会误判）
    const looksContinued = si === 0 && !!last && last.no === s.no && last.batch !== ctx.batch && last.title.trim() !== '' && sameTitle(last.title, s.title)
    if ((s.continued_from_prev || looksContinued) && existing !== undefined) {
      // 续写的大题：沿用已有实例，只补全缺的信息
      const cur = state.sections.find(x => x.no === s.no && x.inst === existing)
      if (cur) {
        if (!cur.title && s.title) cur.title = s.title
        if (cur.score_each === null && s.score_each !== null) cur.score_each = s.score_each
        if (cur.total_score === null && s.total_score !== null) cur.total_score = s.total_score
      }
      return
    }
    const inst = existing === undefined ? 0 : existing + 1
    state.latestInst[s.no] = inst
    state.sections.push({ ...s, inst, batch: ctx.batch })
  })

  for (const m of out.materials) {
    const cur = state.materials.find(x => x.id === m.id)
    // 上一批的材料标了 continues_next、本批又给了同 id 的材料：不管模型有没有设 continued_from_prev，都是续写
    if (cur && (m.continued_from_prev || (cur.continues_next && cur.batch !== ctx.batch))) {
      cur.text = cur.text ? `${cur.text}\n${m.text}` : m.text
      cur.continues_next = m.continues_next
    } else if (cur) {
      state.notes.push(`材料 ${m.id} 重复出现，已保留先出现的`)
    } else {
      state.materials.push({ ...m, batch: ctx.batch })
    }
  }

  for (const q of out.questions) {
    const inst = state.latestInst[q.section] ?? 0
    const idx = findQuestion(state, q.section, q.no, inst)
    const old = idx >= 0 ? state.questions[idx] : null
    // 上一批末尾标了 continues_next 的题，本批出现同键记录就是它的续写——模型漏设 continued_from_prev 时也一样，
    // 否则会保留残缺的前半、丢弃完整的后半，而且没有任何标记
    const impliedContinuation = !!old && !q.continued_from_prev && old.continues_next && old.batch !== ctx.batch
    if (old && (q.continued_from_prev || impliedContinuation)) {
      // 整条替换：保留原位置，以及上一批给出的页码/anchor（提示词要求模型原样沿用，这里再兜底一次）
      state.questions[idx] = { ...q, mode: old.mode, batch: old.batch, inst, page: old.page, anchor: old.anchor, anchor_ref: old.anchor_ref }
      if (impliedContinuation) state.notes.push(`第 ${q.section || '?'} 大题第 ${q.no} 题跨批，模型没有标注续写，已按续写合并，请核对`)
    } else if (old) {
      state.notes.push(`第 ${q.section || '?'} 大题第 ${q.no} 题重复出现，已保留先出现的`)
    } else {
      state.questions.push({ ...q, mode: ctx.mode, batch: ctx.batch, inst })
    }
  }

  for (const n of out.notes) if (n && !state.notes.includes(n)) state.notes.push(n)
}

const sq = (t: string) => t.replace(/\s+/g, '').toLowerCase()
function sameTitle(a: string, b: string): boolean {
  return sq(a) === sq(b)
}

function findQuestion(state: MergeState, section: string, no: string, inst: number): number {
  for (let i = state.questions.length - 1; i >= 0; i--) {
    const q = state.questions[i]
    if (q.section === section && q.no === no && q.inst === inst) return i
  }
  return -1
}

const q2 = (s: string) => JSON.stringify(s)

/** 下一批的 {{PREV_CONTEXT}}；mode 决定 anchor 的写法（文本版是字符串，视觉版是 [x,y,w,h]） */
export function buildPrevContext(state: MergeState, mode: Mode): string {
  const lastSection = state.sections[state.sections.length - 1]
  if (!lastSection && state.questions.length === 0) return '（无，本批是第一批）'
  const lines: string[] = []
  if (lastSection) {
    lines.push(`- 最后一个大题：no=${lastSection.no}；title=${lastSection.title}；qtype=${lastSection.qtype}；score_each=${lastSection.score_each ?? 'null'}`)
  }
  const lastQ = state.questions[state.questions.length - 1]
  if (lastQ && lastQ.continues_next) {
    const anchor = Array.isArray(lastQ.anchor) ? JSON.stringify(lastQ.anchor) : q2(String(lastQ.anchor ?? ''))
    const parts = [`section=${lastQ.section}`, `no=${lastQ.no}`, `page=${lastQ.page}`, `anchor=${anchor}`]
    if (mode === 'text') parts.push(`anchor_ref=${q2(lastQ.anchor_ref)}`)
    parts.push(`已识别题干=${q2(lastQ.stem)}`, `已识别选项=${JSON.stringify(lastQ.options)}`)
    lines.push(`- 未完成的题：${parts.join('；')}`)
  }
  const lastM = state.materials[state.materials.length - 1]
  if (lastM && lastM.continues_next) {
    lines.push(`- 未完成的材料：id=${lastM.id}；末尾文字=${q2('…' + lastM.text.slice(-30))}`)
  }
  return lines.length ? lines.join('\n') : '（无，本批是第一批）'
}
