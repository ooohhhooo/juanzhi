import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { notifyDataChanged } from '../events'
import { saveTaxonomy, TaxonomyError } from '../taxonomy/edit'

const Code = z.string().regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/).max(80)
const Name = z.string().max(60)
// 白话释义 / 例句 / 例词：可选，空串或 null = 清掉（字符规则在 taxonomy/edit.ts 里统一检查）
const Plain = {
  plain: z.string().max(80).nullable().optional(), example_en: z.string().max(240).nullable().optional(),
  example_zh: z.string().max(160).nullable().optional(), hint_words: z.string().max(120).nullable().optional()
}
const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), parent_code: Code.nullable(), name: Name, note: z.string().max(500).optional(), intro_grade: z.number().int().min(1).max(6).nullable().optional(), ...Plain }).strict(),
  z.object({ op: z.literal('update'), code: Code, name: Name.optional(), note: z.string().max(500).nullable().optional(), intro_grade: z.number().int().min(1).max(6).nullable().optional(), ...Plain }).strict(),
  z.object({ op: z.literal('move'), code: Code, parent_code: Code.nullable() }).strict(),
  z.object({ op: z.literal('merge'), code: Code, into: Code }).strict(),
  z.object({ op: z.literal('deprecate'), code: Code, deprecated: z.boolean() }).strict(),
  z.object({ op: z.literal('delete'), code: Code }).strict()
])

export function registerTaxonomyIpc(): void {
  /** 知识点树编辑：一批操作一个事务（任何一步不合规整批回滚）。节点 ID 不变；编辑会推高数据修订号，看板和 AI 缓存随之失效 */
  ipcMain.handle('taxonomy:save', async (_e, rawOps: unknown) => {
    const ops = z.array(Op).min(1).max(50).parse(rawOps)
    try {
      const r = saveTaxonomy(getDb(), ops)
      notifyDataChanged('taxonomy', 'questions')
      return r
    } catch (e) {
      if (e instanceof TaxonomyError) throw new Error(e.message)
      throw e
    }
  })
}
