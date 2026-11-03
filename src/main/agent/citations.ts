/**
 * 出处校验（纯函数）：模型在回答里用 [[q:题目ID]]、[[lesson:课次ID]]、[[stu:学员编号]] 引用数据；
 * 渲染前程序核对这些 ID 是否真的存在，对不上的去掉，并在末尾注明。
 */
import { CITE_PATTERN } from '../../shared/agent-cite.ts'
import type { CiteKind } from '../../shared/agent-cite.ts'
export type { CiteKind }
export const CITE_RE = new RegExp(CITE_PATTERN, 'g')

export interface CiteChecker {
  q: (id: string) => boolean
  lesson: (id: string) => boolean
  stu: (id: string) => boolean
}

export interface CiteRef { kind: CiteKind; id: string }

export function findCitations(text: string): CiteRef[] {
  return [...text.matchAll(CITE_RE)].map(m => ({ kind: m[1] as CiteKind, id: m[2] }))
}

export function validateCitations(text: string, check: CiteChecker): { text: string; removed: number; kept: CiteRef[] } {
  let removed = 0
  const kept: CiteRef[] = []
  const out = text.replace(CITE_RE, (all, kind: CiteKind, id: string) => {
    let ok = false
    try { ok = check[kind](id) } catch { ok = false }
    if (ok) { kept.push({ kind, id }); return all }
    removed++
    return ''
  })
  const tidy = out.replace(/[ \t]+([，。；、,.;])/g, '$1')
  return { text: removed > 0 ? `${tidy.trimEnd()}\n\n（有 ${removed} 处引用对不上，已去掉）` : tidy, removed, kept }
}
