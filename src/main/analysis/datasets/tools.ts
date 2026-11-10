/**
 * 给 Agent 内核注册的数据集工具（全部只读）。形状：{ name, description, params(zod), level: 'read', run(args, ctx) }。
 * 返回值都是可 JSON 序列化的对象；所有可能含个人信息的内容都已过 toModel（敏感列换成代号）。
 */
import { z } from 'zod'
import type { ToolContext, ToolDef } from '../types.ts'
import { storeOf } from './index.ts'
import { DatasetError } from './store.ts'
import { documentsForModel, readDocument } from '../documents.ts'
import { visibleInSubject } from '../../../shared/classify.ts'

const plain = (e: unknown) => (e instanceof DatasetError ? e.message : e instanceof Error ? e.message : String(e))

/** 用户写的名称 / 备注也可能带人名：同样过一遍代号化 */
function mask(ctx: ToolContext | undefined, id: string, text: string): string {
  if (!text) return text
  return storeOf(ctx).safeText([id], text)
}

export const listDatasets: ToolDef<Record<string, never>> = {
  name: 'list_datasets',
  description: '数据目录：列出用户已导入的所有数据集（id、名称、来源文件、备注、每张表的表名和行数、列数）和文档资料（documents：图片识别文字、PDF、Word、文本，用 read_document 读）。开始分析前先调用它，拿到 datasetId / documentId。试卷库、课程大纲、报告不在这里，用 papers_list、course_coverage、reports_list。',
  params: z.object({}),
  level: 'read',
  async run(_args, ctx) {
    const s = storeOf(ctx)
    return {
      // 只给「会话学科 + 通用」的数据集和文档；表里若有「科目 / 学科」列，由助手按列区分
      datasets: s.list().filter(d => visibleInSubject(d.subject, ctx?.subject)).map(d => ({
        id: d.id, subject: d.subject ?? 'general', name: mask(ctx, d.id, d.name), sourceFile: mask(ctx, d.id, d.sourceFile), importedAt: d.importedAt, note: mask(ctx, d.id, d.note),
        tables: d.tables.map(t => ({ name: mask(ctx, d.id, t.name), sheet: mask(ctx, d.id, t.sheet), rows: t.rows, columns: t.columns.length, multiSelectViews: t.views.map(v => mask(ctx, d.id, v.view)) }))
      })),
      documents: documentsForModel(ctx as { documents?: unknown; subject?: string })
    }
  }
}

export const datasetProfile: ToolDef<{ datasetId: string; table?: string }> = {
  name: 'dataset_profile',
  description: '查看某个数据集（或其中一张表）的概况：每列一行，含内部列名、原列名、类型、空值率、取值数、数值的范围 / 均值 / 四分位、常见取值及占比、日期范围、可能的用途（像 ID、像评分、像分组维度、像自由文本……）。敏感列的取值已换成代号（如「人员A017」），分析和回答里直接用代号即可，系统会在界面上还原。写 SQL 前先看这个。',
  params: z.object({ datasetId: z.string().describe('数据集 id（来自 list_datasets）'), table: z.string().optional().describe('表名；省略则返回全部表') }),
  level: 'read',
  async run(args, ctx) {
    try { return { text: storeOf(ctx).profileText(args.datasetId, args.table) } } catch (e) { return { error: plain(e) } }
  }
}

export const runQuery: ToolDef<{ sql: string; datasets: string[] }> = {
  name: 'run_query',
  description: '对数据集执行一条只读 SQL（SQLite 语法），只允许单条 SELECT / WITH 查询，不能写入、不能 PRAGMA / ATTACH。datasets 填要用的数据集 id，依次对应别名 d1、d2……，表名要写成 d1."表名"，表名和列名都用双引号括起来，列名用内部列名（如 "c03_年级"，见 dataset_profile）。每张表有行号列 _row；多选列有拆成「一个选项一行」的视图（见概况里的视图名），用 _row 关联原表。最多返回 500 行（超出会注明总行数），10 秒超时；大结果请先 GROUP BY 汇总。敏感列在结果里是代号，SQL 里写代号会自动还原成原值。出错时返回白话原因（message）和一小段处理过的错误细节（detail），请据此改写后重试。',
  params: z.object({ sql: z.string().min(1).max(20000), datasets: z.array(z.string()).min(1).max(5).describe('数据集 id 列表，依次是 d1、d2……') }),
  level: 'read',
  async run(args, ctx) {
    try {
      const s = storeOf(ctx)
      const r = await s.runQuery(args.sql, args.datasets, { signal: ctx?.signal })
      const { rawError: _drop, ...safe } = r as typeof r & { rawError?: string }   // 原始错误不给模型
      return { ...safe, aliases: Object.fromEntries(args.datasets.map((id, i) => [`d${i + 1}`, id])) }
    } catch (e) { return { ok: false, message: plain(e) } }
  }
}

export const columnValues: ToolDef<{ datasetId: string; table: string; column: string; limit?: number }> = {
  name: 'column_values',
  description: '查看某一列的取值分布（取值 + 出现次数，按次数从多到少）。多选列按选项统计。用来了解有哪些选项、写筛选条件、做文字归类前看看有哪些说法。敏感列返回代号。column 可填内部列名或原列名。',
  params: z.object({ datasetId: z.string(), table: z.string(), column: z.string(), limit: z.number().int().min(1).max(200).optional().describe('最多返回多少个取值，默认 30') }),
  level: 'read',
  async run(args, ctx) {
    try { return storeOf(ctx).columnValues(args.datasetId, args.table, args.column, args.limit ?? 30) } catch (e) { return { error: plain(e) } }
  }
}

export const DATASET_TOOLS: ToolDef[] = [listDatasets, datasetProfile, runQuery, columnValues, readDocument]
