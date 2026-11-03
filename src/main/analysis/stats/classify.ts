/**
 * 自由文字归类（退费原因、问卷意见、跟进备注……）：先抽样让 AI 提出类别，再分批把全部文字归入类别，最后由程序计数。
 * 纯逻辑：AI 调用和提示词由调用方注入（运行时接线在 classify-runtime.ts），所以单测用假 AI 就能跑。
 * 发给 AI 之前一律先过 scrubPII，手机号、身份证号、邮箱等不会离开本机。
 */

export interface Category { name: string; definition: string; examples?: string[] }
export interface ClassifyAiCall { kind: 'analysis-classify'; system: string; user: string; signal?: AbortSignal; maxTokens?: number }
export type ClassifyAi = (o: ClassifyAiCall) => Promise<{ content: string }>
export interface ClassifyPrompts { proposeSystem: string; proposeUser: string; assignSystem: string; assignUser: string }

export const OTHER = '其他'
export const MAX_SAMPLE = 200
export const MAX_BATCH = 100
export const MAX_CONCURRENCY = 3
const MAX_TEXT_CHARS = 300

export class ClassifyError extends Error {}

// ───────────────────────── 去掉个人信息 ─────────────────────────

const PII_RULES: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '【邮箱】'],
  [/(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g, '【身份证号】'],
  [/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g, '【手机号】'],
  [/(?<!\d)0\d{2,3}[- ]?\d{7,8}(?!\d)/g, '【电话】'],
  [/(?<!\d)\d{16,19}(?!\d)/g, '【长数字】'],
  [/(?:微信号?|微信|薇信|vx|wx|weixin|QQ|qq)\s*[:：]?\s*(?:号\s*)?[A-Za-z0-9_-]{5,}/g, '【联系方式】']
]
/** 去掉手机号、身份证号、邮箱、座机、银行卡号样的长数字、微信 / QQ 号等 */
export function scrubPII(text: string): string {
  let s = String(text ?? '')
  for (const [re, rep] of PII_RULES) s = s.replace(re, rep)
  return s
}

// ───────────────────────── 小工具 ─────────────────────────

const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m))
const clean = (t: unknown): string => scrubPII(String(t ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)

/** 容错地取出回答里的 JSON 对象 */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  let s = String(content ?? '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { const v = JSON.parse(s.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}

/** 校验并洗干净 AI 提出的类别：名字去重、去掉“其他”、限制个数 */
export function normalizeCategories(raw: unknown, max = 10): Category[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Category[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = String(o.name ?? '').trim().slice(0, 20)
    if (!name || name === OTHER || seen.has(name)) continue
    seen.add(name)
    const examples = Array.isArray(o.examples) ? o.examples.map(x => scrubPII(String(x)).slice(0, 40)).filter(Boolean).slice(0, 2) : undefined
    out.push({ name, definition: String(o.definition ?? '').trim().slice(0, 60), ...(examples?.length ? { examples } : {}) })
    if (out.length >= max) break
  }
  return out
}

/** 均匀抽样（不随机，同样的输入同样的样本） */
export function sampleEvenly<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(xs[Math.floor((i * xs.length) / max)])
  return out
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new ClassifyError('已取消')
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

const catLines = (cs: Category[]): string => cs.map(c => `${c.name}：${c.definition || '（无说明）'}`).join('\n')

// ───────────────────────── 第一步：提出类别 ─────────────────────────

export interface ProposeOptions { ai: ClassifyAi; prompts: ClassifyPrompts; fieldName?: string; existing?: Category[]; maxCategories?: number; sampleSize?: number; signal?: AbortSignal }
export async function proposeCategories(texts: string[], o: ProposeOptions): Promise<Category[]> {
  const all = texts.map(clean).filter(Boolean)
  if (!all.length) throw new ClassifyError('没有可以归类的文字（这一列全是空的）')
  const sample = sampleEvenly([...new Set(all)], Math.min(o.sampleSize ?? MAX_SAMPLE, MAX_SAMPLE))
  const user = fill(o.prompts.proposeUser, {
    FIELD_NAME: o.fieldName ?? '文字', TOTAL_COUNT: String(all.length), SAMPLE_COUNT: String(sample.length),
    TEXT_LINES: sample.map((t, i) => `${i + 1}. ${t}`).join('\n'), EXISTING_CATEGORIES: o.existing?.length ? catLines(o.existing) : '（无）'
  })
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await o.ai({ kind: 'analysis-classify', system: o.prompts.proposeSystem, user, signal: o.signal, maxTokens: 4000 })
    const cats = normalizeCategories(parseJsonObject(r.content)?.categories, o.maxCategories ?? 10)
    if (cats.length >= 2) return cats
    last = r.content.slice(0, 80)
  }
  throw new ClassifyError(`AI 没能给出可用的类别（回答不合格：${last || '空'}）。可以换个模型重试，或者自己指定类别`)
}

// ───────────────────────── 第二步：逐条归类 ─────────────────────────

export interface ClassifyOptions {
  ai: ClassifyAi; prompts: ClassifyPrompts
  fieldName?: string
  /** 用户 / Agent 指定的类别；给了就不再让 AI 提类别 */ categories?: Category[]
  /** 想在 AI 提议的基础上调整时传：会作为“已有类别”交给 AI 修改 */ seedCategories?: Category[]
  batchSize?: number; concurrency?: number; maxCategories?: number; sampleSize?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}
export interface ClassifyResult {
  categories: Category[]
  /** 与输入 texts 一一对应：每条的类别（可多个）；空白文字是空数组 */ labels: string[][]
  counts: Array<{ name: string; count: number; rate: number }>
  answered: number; blank: number
  /** AI 没给出可用结果、被记为“其他”的条数 */ fallbackToOther: number
  text: string; notes: string[]
}

export async function classifyTexts(texts: string[], o: ClassifyOptions): Promise<ClassifyResult> {
  const cleaned = texts.map(clean)
  const idx = cleaned.map((t, i) => (t ? i : -1)).filter(i => i >= 0)
  if (!idx.length) throw new ClassifyError('没有可以归类的文字（这一列全是空的）')
  const categories = o.categories?.length
    ? normalizeCategories(o.categories, 30)
    : await proposeCategories(texts, { ai: o.ai, prompts: o.prompts, fieldName: o.fieldName, existing: o.seedCategories, maxCategories: o.maxCategories, sampleSize: o.sampleSize, signal: o.signal })
  if (!categories.length) throw new ClassifyError('类别不能为空')
  const names = new Set(categories.map(c => c.name))
  const size = Math.max(1, Math.min(MAX_BATCH, Math.floor(o.batchSize ?? 80)))
  const batches: number[][] = []
  for (let i = 0; i < idx.length; i += size) batches.push(idx.slice(i, i + size))
  const labels: string[][] = cleaned.map(() => [])
  const failed = new Set<number>()
  let done = 0

  const runBatch = async (b: number[]): Promise<void> => {
    let pending = b
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const user = fill(o.prompts.assignUser, { FIELD_NAME: o.fieldName ?? '文字', CATEGORIES: catLines(categories), TEXT_LINES: pending.map((i, k) => `${k + 1}. ${cleaned[i]}`).join('\n') })
      let parsed: Record<string, unknown> | null = null
      try { parsed = parseJsonObject((await o.ai({ kind: 'analysis-classify', system: o.prompts.assignSystem, user, signal: o.signal, maxTokens: 8000 })).content) } catch (e) {
        if (o.signal?.aborted) throw e
        parsed = null
      }
      const items = Array.isArray(parsed?.items) ? parsed!.items as unknown[] : []
      const got = new Set<number>()
      for (const it of items) {
        if (!it || typeof it !== 'object') continue
        const rec = it as Record<string, unknown>
        const k = Number(rec.id) - 1
        if (!Number.isInteger(k) || k < 0 || k >= pending.length || got.has(k)) continue
        const cs = Array.isArray(rec.categories) ? rec.categories.map(x => String(x).trim()) : typeof rec.category === 'string' ? [rec.category.trim()] : []
        const valid = [...new Set(cs.map(c => (names.has(c) ? c : OTHER)))].slice(0, 3)
        if (!valid.length) continue
        got.add(k)
        const real = valid.filter(v => v !== OTHER)
        labels[pending[k]] = real.length ? real : valid
      }
      pending = pending.filter((_, k) => !got.has(k))
    }
    for (const i of pending) { labels[i] = [OTHER]; failed.add(i) }
    done += b.length
    o.onProgress?.(done, idx.length)
  }
  await pool(batches, Math.min(o.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY), runBatch, o.signal)

  const cnt = new Map<string, number>()
  for (const i of idx) for (const l of labels[i]) cnt.set(l, (cnt.get(l) ?? 0) + 1)
  const order = [...categories.map(c => c.name), OTHER]
  const counts = order.filter(n => cnt.has(n)).map(name => ({ name, count: cnt.get(name)!, rate: Math.round((cnt.get(name)! / idx.length) * 1000) / 10 }))
    .sort((a, b) => (a.name === OTHER ? 1 : b.name === OTHER ? -1 : b.count - a.count))
  const notes = ['一条文字可能属于多个类别，所以各类别占比加起来可能超过 100%']
  if (failed.size) notes.push(`有 ${failed.size} 条 AI 没给出可用结果，先记为“其他”`)
  const blank = texts.length - idx.length
  if (blank) notes.push(`有 ${blank} 条是空白，没有参与归类`)
  const otherRate = (cnt.get(OTHER) ?? 0) / idx.length
  if (otherRate > 0.3) notes.push('“其他”超过三成，说明类别没覆盖好，可以补充或修改类别后重跑')
  notes.push('归类由 AI 完成，可能有个别误判；抽查几条再引用更稳妥')
  const used = !cnt.has(OTHER) ? categories : [...categories, { name: OTHER, definition: '不属于上面任何一类，或没有实际内容' }]
  const text = `共 ${idx.length} 条文字归为 ${counts.length} 类：` + counts.slice(0, 6).map(c => `${c.name} ${c.count} 条（${c.rate}%）`).join('，') + (counts.length > 6 ? '……' : '')
  return { categories: used, labels, counts, answered: idx.length, blank, fallbackToOther: failed.size, text, notes }
}
