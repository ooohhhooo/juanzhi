/**
 * 术语表接入层：读 `src/shared/glossary.ts`（界面和报告共用的术语白话表，功能代理维护）。
 * 查询走它的 `lookupTerm`，所以别名（aka，如「出现率」→「考了几份卷子」）也查得到。
 */
import { GLOSSARY, lookupTerm } from '../../shared/glossary'

export interface GlossaryItem {
  /** 词头：术语本身，如「考了几份卷子」 */
  term: string
  /** 白话一句 */
  plain: string
  /** 例子一句（可选）。可以用 **加粗** 标出重点 */
  example?: string
}

const toItem = (g: { term: string; plain: string; example: string }): GlossaryItem => ({ term: g.term, plain: g.plain, example: g.example || undefined })

/** 全部术语 */
export const glossaryItems: GlossaryItem[] = GLOSSARY.map(toItem)

/** 按词头或别名查一个术语；查不到返回 undefined */
export function lookup(term: string): GlossaryItem | undefined {
  const g = lookupTerm(term.trim())
  return g ? toItem(g) : undefined
}
