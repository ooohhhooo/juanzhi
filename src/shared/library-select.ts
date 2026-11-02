/**
 * 试卷库的搜索、多选与批量操作用到的纯函数（不依赖 electron / React，单测直接跑）。
 */

export interface LibPaper {
  id: string
  title: string
  file_name: string
  school: string | null
  status: string
  is_sample?: number
}

/** 搜索词归一：去首尾空白、转小写（中文不受影响，英文不分大小写） */
export const normQuery = (q: string): string => q.trim().toLowerCase()

/** 试卷标题（标题为空时界面显示文件名，所以文件名也算标题）或学校名里含搜索词（不分大小写的子串）。空搜索词 = 全部匹配 */
export function paperMatches(p: Pick<LibPaper, 'title' | 'file_name' | 'school'>, query: string): boolean {
  const q = normQuery(query)
  if (!q) return true
  return (p.title || p.file_name || '').toLowerCase().includes(q) || (p.school ?? '').toLowerCase().includes(q)
}

export function filterPapers<T extends Pick<LibPaper, 'title' | 'file_name' | 'school'>>(papers: T[], query: string): T[] {
  return normQuery(query) ? papers.filter(p => paperMatches(p, query)) : papers
}

/** 正在提取 / 解析的试卷不能删（和主进程 papers:remove 的判断一致；排队中的由主进程再判断一次） */
export const isBusyStatus = (status: string): boolean => status === 'extracting' || status === 'parsing'

/** 确认框里列出的标题：最多 max 条，其余写「……等共 N 份」 */
export function titleList(titles: string[], max = 8): { shown: string[]; more: number } {
  return { shown: titles.slice(0, max), more: Math.max(0, titles.length - max) }
}

// ── 批量改信息 ──

export type BatchField = 'school' | 'grade' | 'semester' | 'school_year_start' | 'exam_type' | 'textbook' | 'region'
export const BATCH_FIELDS: Array<{ key: BatchField; label: string }> = [
  { key: 'school', label: '学校' }, { key: 'grade', label: '年级' }, { key: 'semester', label: '学期' },
  { key: 'school_year_start', label: '学年起始' }, { key: 'exam_type', label: '考试类型' }, { key: 'textbook', label: '教材' }, { key: 'region', label: '地区' }
]

/**
 * 只把打了勾的字段放进改动里；打了勾但留空 = 清空这一项（传 null，经 IPC 才不会丢）。
 * 没打勾的字段不出现在结果里，主进程就不会碰它。
 */
export function buildBatchMeta(ticked: Partial<Record<BatchField, boolean>>, values: Partial<Record<BatchField, unknown>>): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const { key } of BATCH_FIELDS) {
    if (!ticked[key]) continue
    const v = values[key]
    meta[key] = v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : typeof v === 'string' ? v.trim() : v
  }
  return meta
}

// ── 批量结果 ──

export interface BatchResult { id: string; ok: boolean; reason?: string }
/** 把每份的结果汇总成：成功几份、跳过几份、按原因分组（原因 → 份数） */
export function summarizeBatch(results: BatchResult[]): { ok: number; skipped: number; reasons: Array<{ reason: string; count: number }> } {
  const map = new Map<string, number>()
  let ok = 0
  for (const r of results) {
    if (r.ok) ok++
    else map.set(r.reason || '没有处理', (map.get(r.reason || '没有处理') ?? 0) + 1)
  }
  return { ok, skipped: results.length - ok, reasons: [...map].map(([reason, count]) => ({ reason, count })) }
}

// ── 只统计选中的卷子 ──

/**
 * 选中的卷子 → 统计范围：示例卷和真实卷不混着统计（示例数据永远不混进真实数据的统计）。
 * 只有示例卷 → 看示例数据；有真实卷 → 只取真实卷，示例卷记进 dropped。
 */
export function scopeFromSelection(papers: Array<Pick<LibPaper, 'id' | 'is_sample'>>): { paperIds: string[]; sample: boolean; dropped: number } {
  const real = papers.filter(p => !p.is_sample)
  if (real.length === 0) return { paperIds: papers.map(p => p.id), sample: papers.length > 0, dropped: 0 }
  return { paperIds: real.map(p => p.id), sample: false, dropped: papers.length - real.length }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 读回来的 id 列表不可信：只留合法的、去重、最多 1000 个；空 = 没有 */
export function sanitizePaperIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))].slice(0, 1000)
  return ids.length ? ids : undefined
}

/** 一次最多统计这么多份（统计范围 paperIds 的上限） */
export const MAX_SCOPE_PAPERS = 1000

/** 数组切成每段 n 个（批量操作分批发给主进程） */
export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 给用户看的错误：去掉 IPC 的前缀；校验库（zod）抛出来的 JSON / 英文技术信息不给用户看，换成一句白话。
 * 主进程自己写的中文提示（不是 JSON、不含英文校验字样）原样保留。
 */
export function plainError(err: unknown, fallback = '操作没有成功，请稍后再试'): string {
  const raw = String((err as { message?: unknown } | null)?.message ?? err ?? '')
  const msg = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()
  if (!msg || /^[\[{]/.test(msg) || /ZodError|invalid_type|too_big|too_small|invalid_string|"code"\s*:|"path"\s*:/.test(msg) || /^[\x00-\x7f]+$/.test(msg) && msg.length > 60) return fallback
  return msg
}
