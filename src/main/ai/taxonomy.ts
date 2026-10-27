import { safeKpName } from '../../shared/code-guard'
import { getDb } from '../db'
import { flatKpText } from '../pack/kp-rules.ts'

export interface KpRecord {
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
  /** 白话释义（一句话说清考什么）、例句（英文 / 中文，英文里用 ** 标出关键词）、例词；内置节点有，自建节点可在知识点编辑器里填 */
  plain: string | null
  example_en: string | null
  example_zh: string | null
  hint_words: string | null
}

export interface QtypeRecord {
  code: string
  name: string
  group: string
  note: string | null
  sort: number
}

export function listKps(includeDeprecated = false): KpRecord[] {
  return getDb().prepare(
    `SELECT code, parent_code, name, level, intro_grade, sort, deprecated, merged_into, note, builtin, plain, example_en, example_zh, hint_words FROM kps ${includeDeprecated ? '' : 'WHERE deprecated = 0'} ORDER BY sort, code`
  ).all().map((k: any) => ({ ...k, name: safeKpName(k.name) })) as unknown as KpRecord[]
}

export function listQtypes(): QtypeRecord[] {
  return getDb().prepare(`SELECT code, name, "group", note, sort FROM qtypes ORDER BY sort, code`).all() as unknown as QtypeRecord[]
}

export interface TaxonomyContext {
  kps: Set<string>
  qtypes: Set<string>
  /** {{KNOWLEDGE_TREE}}：代码 | 路径名称 | 常见引入年级 | 说明 | 白话 */
  treeText: string
  /** {{QUESTION_TYPES}}：代码 | 名称 | 说明 */
  qtypeText: string
}

/** 运行时把当前的知识点树与题型表（含用户改过的）渲染成提示词里的文本；顺序固定，利于前缀缓存 */
export function loadTaxonomy(): TaxonomyContext {
  const kps = listKps()
  const byCode = new Map(kps.map(k => [k.code, k]))
  // 一行一个节点：名称 / 说明里的换行、竖线（旧版本允许输入、或来自旧数据）折成空格，不能把一行拆成几行
  const flat = flatKpText
  const pathName = (k: KpRecord): string => {
    const names: string[] = [flat(k.name)]
    let p = k.parent_code ? byCode.get(k.parent_code) : undefined
    while (p) { names.unshift(flat(p.name)); p = p.parent_code ? byCode.get(p.parent_code) : undefined }
    return names.join('/')
  }
  const treeText = kps.map(k => `${k.code} | ${pathName(k)} | ${k.intro_grade ?? '-'} | ${flat(k.note ?? '')} | ${flat(k.plain ?? '') || '—'}`).join('\n')
  const qts = listQtypes()
  const qtypeText = qts.map(q => `${q.code} | ${q.name} | ${q.note ?? ''}`).join('\n')
  return { kps: new Set(kps.map(k => k.code)), qtypes: new Set(qts.map(q => q.code)), treeText, qtypeText }
}
