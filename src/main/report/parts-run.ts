/**
 * 报告分段的运行：注册表、每一段怎么跑、写库、重新拼装（M9 beta.3）。
 * 纯逻辑（元数据、拼装顺序）在 parts.ts；这里要用数据库和 AI。
 *
 * 接入新的一段（比如以后的「课程对照」）：在启动时调用 registerReportPart({ id, label, placement, order, readers, ai, enabled?, skip?, run, render? })。
 *   - run(ctx) 返回这一段的 Markdown（和可选的模型名、用量、事实核对结果、警告）；抛错 = 这一段失败，主文和其他段不受影响，界面给它单独的「重试这一部分」；
 *   - enabled(ctx) 决定这次生成要不要跑它（读 ctx.options，比如用户勾了「加入课程对照」）；skip(ctx) 返回一句原因 = 这次跳过（界面显示原因，不算失败）；
 *   - render(db, reportId) 可选：拼装时临时生成这一段的 Markdown（变形题的答题卡随老师的勾选变化，所以不能存死）；
 *   - 注册的段会自动参与：分段生成与进度、单段重试、拼装进最终 Markdown（placement 决定位置）、失败占位。
 */
import { getDb } from '../db'
import { AiError } from '../ai/client'
import { friendlyAiError } from '../ai/friendly'
import { promptText, promptVersionFor } from '../ai/prompts'
import { fillTemplate } from '../stats/p2'
import { paperScope } from '../stats/filter'
import { questionsOfKp } from '../stats/core'
import { checkRulesFor, markFindings } from '../../shared/factcheck'
import { asSubject } from '../../shared/subject'
import type { UnverifiedItem } from '../ai/chunk'
import type { ReportReader } from '../../shared/report-post'
import { log } from '../log'
import { CORE_PART_METAS, assembleReport } from './parts'
import type { PartMeta, PartStatus, PartText } from './parts'
import { buildErrorsSection, buildTricksSection, buildVariantsSection } from './teacher-sections'
import type { VariantRow } from './teacher-sections'
import { parseCheckAnswers, sameAnswer, validateVariants } from './variants-check'
import { partChat } from './part-ai'
import type { PreparedReport } from './service'
import type { ReportOptions } from '../../shared/report-options'

export interface PartContext {
  reportId: string
  reader: ReportReader
  /** 生成选项（课程对照、家长版一句话……），存在 reports.options_json */
  options: ReportOptions
  prepared: PreparedReport
  /** 主文（已收尾，含标题）：附加段需要参考时读它 */
  mainMarkdown: string
  signal: AbortSignal
}

export interface PartOutput {
  markdown: string
  model?: string | null
  promptVersion?: string | null
  usage?: unknown
  /** 这一段里讲英语规则、没能对上证据的句子（会并入整份报告的「未核实」清单） */
  unverified?: UnverifiedItem[]
  warnings?: string[]
  /** 写库后（同一事务里）再做的事，如变形题的行 */
  persist?: (db: any, reportId: string) => void
}

export interface ReportPartDef extends PartMeta {
  enabled?: (ctx: Omit<PartContext, 'signal' | 'mainMarkdown'>) => boolean
  /** 这次不跑这一段的原因（如「没有易错点」）；返回非空 = 跳过，界面显示原因 */
  skip?: (ctx: Omit<PartContext, 'signal' | 'mainMarkdown'>) => string | null
  run: (ctx: PartContext) => Promise<PartOutput>
  /** 拼装时临时生成这一段的 Markdown（覆盖库里存的）；返回 null = 用库里存的 */
  render?: (db: any, reportId: string) => string | null
}

const registry = new Map<string, ReportPartDef>()

export function registerReportPart(def: ReportPartDef): void { registry.set(def.id, def) }
export const getPartDef = (id: string): ReportPartDef | undefined => registry.get(id)
export const allPartMetas = (): PartMeta[] => [...registry.values()].map(({ id, label, placement, order, readers, ai, omitWhenEmpty }) => ({ id, label, placement, order, readers, ai, omitWhenEmpty }))

/** 这个读者、这些选项下，这次生成要跑的附加段（按 order） */
export function partsFor(reader: ReportReader, options: ReportOptions, base: Omit<PartContext, 'signal' | 'mainMarkdown' | 'options' | 'reader'>): ReportPartDef[] {
  return [...registry.values()]
    .filter(d => d.readers.includes(reader) && (d.enabled?.({ ...base, reader, options }) ?? true))
    .sort((a, b) => a.order - b.order)
}

// ───────────────────────── 库：读写分段 ─────────────────────────

export interface PartRowDb { report_id: string; part: string; status: PartStatus; markdown: string | null; message: string | null; detail: string | null; model: string | null; prompt_version: string | null; usage_json: string | null; created_at: string }
interface PartMeta2 { usage?: unknown; unverified?: UnverifiedItem[]; warnings?: string[] }

const parseJson = <T,>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb } catch { return fb } }
export const metaOf = (row: Pick<PartRowDb, 'usage_json'>): PartMeta2 => parseJson<PartMeta2>(row.usage_json, {})

export function loadParts(reportId: string): PartRowDb[] {
  return getDb().prepare('SELECT * FROM report_parts WHERE report_id = ?').all(reportId) as PartRowDb[]
}

export function saveMainPart(reportId: string, o: { markdown: string; model: string | null; promptVersion: string | null; usage: unknown; unverified: UnverifiedItem[]; warnings: string[] }): void {
  getDb().prepare(`INSERT OR REPLACE INTO report_parts (report_id, part, status, markdown, message, detail, model, prompt_version, usage_json) VALUES (?, 'main', 'ok', ?, NULL, NULL, ?, ?, ?)`)
    .run(reportId, o.markdown, o.model, o.promptVersion, JSON.stringify({ usage: o.usage, unverified: o.unverified, warnings: o.warnings }))
}

function savePart(reportId: string, part: string, status: PartStatus, o: { markdown?: string; message?: string | null; detail?: string | null; model?: string | null; promptVersion?: string | null; meta?: PartMeta2 } = {}): void {
  getDb().prepare(`INSERT OR REPLACE INTO report_parts (report_id, part, status, markdown, message, detail, model, prompt_version, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reportId, part, status, o.markdown ?? '', o.message ?? null, o.detail ?? null, o.model ?? null, o.promptVersion ?? null, o.meta ? JSON.stringify(o.meta) : null)
}

/** 开始重跑一段：只把状态改成 running，旧的正文和说明先留着（新的一次成功了才替换；失败了就还原） */
function markRunning(reportId: string, part: string): void {
  getDb().prepare(`INSERT INTO report_parts (report_id, part, status) VALUES (?, ?, 'running') ON CONFLICT(report_id, part) DO UPDATE SET status = 'running'`).run(reportId, part)
}
/** 写库失败（比如报告已经被删了）不能当成 AI 失败，也不能让整条链路崩：吞掉并记一条日志 */
function trySave(reportId: string, part: string, status: PartStatus, o: Parameters<typeof savePart>[3] = {}): void {
  try { savePart(reportId, part, status, o) } catch { log.warn('report-part', '保存分段状态失败', { part }) }
}

/** 正在生成附加段的报告（崩溃后留下的 running 行不在这里 = 视为失败，可以重试） */
const running = new Set<string>()
export const isGenerating = (reportId: string): boolean => running.has(reportId)
export const effectiveStatus = (reportId: string, s: PartStatus): PartStatus => (s === 'running' && !running.has(reportId) ? 'failed' : s)

/**
 * 按库里的各段重新拼装整份报告的 Markdown，并把各段的「未核实」清单和警告并回报告。
 * 之后的出口（界面 / 复制 / 导出 / 删句 / 过期判断）仍然只认 reports.markdown。
 */
export function reassemble(reportId: string): string | null {
  const db = getDb()
  const rows = loadParts(reportId)
  const main = rows.find(r => r.part === 'main')
  if (!main) return null
  const metas = allPartMetas()
  const texts: PartText[] = rows.filter(r => r.part !== 'main' && registry.has(r.part)).map(r => {
    const def = registry.get(r.part)!
    const status = effectiveStatus(reportId, r.status)
    const rendered = status === 'ok' ? def.render?.(db, reportId) ?? null : null
    return { id: r.part, status, markdown: rendered ?? r.markdown ?? '' }
  })
  const md = assembleReport(main.markdown ?? '', texts, metas)
  const okRows = rows.filter(r => r.status === 'ok')
  const order = (r: PartRowDb) => (r.part === 'main' ? 0 : registry.get(r.part)?.order ?? 999)
  const sorted = [...okRows].sort((a, b) => order(a) - order(b))
  const unverified = sorted.flatMap(r => metaOf(r).unverified ?? [])
  const warnings = sorted.flatMap(r => metaOf(r).warnings ?? [])
  db.prepare('UPDATE reports SET markdown = ?, verify_json = ?, warnings_json = ? WHERE id = ?').run(md, JSON.stringify(unverified), JSON.stringify(warnings), reportId)
  return md
}

// ───────────────────────── 跑一批附加段 ─────────────────────────

export type PartEvent = { part: string; label: string; state: 'start' | 'ok' | 'failed'; index: number; total: number; message?: string }

/** 把一次失败翻成这一段的白话原因 */
function explain(e: unknown): { message: string; detail: string } {
  if (e instanceof AiError) { const f = friendlyAiError(e); return { message: f.message, detail: f.detail } }
  return { message: (e as Error)?.message || '这一部分没有生成成功', detail: '' }
}

/**
 * 依次跑附加段，每段独立：失败只影响自己。每跑完一段就重新拼装并写回报告（界面实时看到进度）。
 * 取消（signal 被中止）= 当前段记为失败「已取消」，剩下的段记为「没有生成」，之后都可以单独重试。
 */
export async function runParts(o: { reportId: string; defs: ReportPartDef[]; ctx: Omit<PartContext, 'signal' | 'reportId'>; signal: AbortSignal; onEvent: (e: PartEvent) => void; onChange: () => void }): Promise<{ failed: string[]; cancelled: boolean }> {
  const { reportId, defs, signal } = o
  running.add(reportId)
  const failed: string[] = []
  let cancelled = false
  // 重试时旧的一段（status = ok）先记下来：新的一次失败 / 被取消时还原它，不能让重试把原来好好的内容弄丢
  const prev = new Map(loadParts(reportId).map(r => [r.part, r]))
  const restoreOrFail = (id: string, message: string, detail = ''): void => {
    const old = prev.get(id)
    if (old && old.status === 'ok') {
      try { getDb().prepare("UPDATE report_parts SET status = 'ok' WHERE report_id = ? AND part = ?").run(reportId, id) } catch { /* 报告已被删 */ }
    } else trySave(reportId, id, 'failed', { message, detail })
  }
  try {
    for (const d of defs) markRunning(reportId, d.id)
    reassemble(reportId)
    o.onChange()
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]
      const ev = (state: PartEvent['state'], message?: string) => o.onEvent({ part: d.id, label: d.label, state, index: i + 1, total: defs.length, message })
      if (cancelled) {
        restoreOrFail(d.id, '已取消，这一部分没有生成')
        failed.push(d.id)
        continue
      }
      const ctx: PartContext = { ...o.ctx, reportId, signal }
      let why: string | null = null
      try { why = d.skip?.(ctx) ?? null } catch (e) {
        const x = explain(e)
        log.warn('report-part', '附加段判断是否跳过时出错', { part: d.id })
        restoreOrFail(d.id, x.message, x.detail)
        failed.push(d.id)
        continue
      }
      if (why) {
        trySave(reportId, d.id, 'skipped', { message: why })
        ev('ok', why)
        reassemble(reportId)
        continue
      }
      ev('start')
      let out: PartOutput | null = null
      try {
        out = await d.run(ctx)
      } catch (e) {
        const x = explain(e)
        if (e instanceof AiError && e.code === 'aborted') cancelled = true
        // 日志只记哪一段、什么错误码，不记提示词和返回内容
        log.warn('report-part', '附加段失败', { part: d.id, code: e instanceof AiError ? e.code : 'other' })
        restoreOrFail(d.id, x.message, x.detail)
        failed.push(d.id)
        ev('failed', x.message)
      }
      if (out) {
        // 写库单独一步：失败（比如报告已被删除）是本机存储的问题，不能算成 AI 失败；事务回滚，旧内容（含变形题行）原样保留
        const db = getDb()
        try {
          db.exec('BEGIN')
          try {
            savePart(reportId, d.id, 'ok', { markdown: out.markdown, model: out.model ?? null, promptVersion: out.promptVersion ?? null, meta: { usage: out.usage, unverified: out.unverified ?? [], warnings: out.warnings ?? [] } })
            out.persist?.(db, reportId)
            db.exec('COMMIT')
          } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
          ev('ok')
        } catch {
          log.warn('report-part', '保存分段结果失败', { part: d.id })
          restoreOrFail(d.id, '这一部分生成了，但保存到本机时出错（报告可能已被删除）。可以再试一次')
          failed.push(d.id)
          ev('failed', '保存到本机时出错')
        }
      }
      try { reassemble(reportId) } catch { /* 报告已被删 */ }
      o.onChange()
    }
  } finally {
    running.delete(reportId)
    try { reassemble(reportId) } catch { /* 报告已被删 */ }
    o.onChange()
  }
  return { failed, cancelled }
}

// ───────────────────────── 内置的三段（老师版） ─────────────────────────

const kpsOf = (p: PreparedReport) => (p.src.evidence?.kps ?? []).map(k => ({ code: k.code, name: k.name, plain: k.plain, example_en: k.example_en, example_zh: k.example_zh, hint_words: k.hint_words }))
const evidenceOf = (p: PreparedReport): string[] => p.src.evidence?.statements ?? []

/** 对一段 AI 写的文字做事实核对：对不上证据的句子加「未核实」标记，并返回清单 */
function factCheck(md: string, evidence: string[], subject?: unknown): { text: string; unverified: UnverifiedItem[] } {
  const found = checkRulesFor(subject, md, evidence)
  if (!found.length) return { text: md, unverified: [] }
  return { text: markFindings(md, found).text, unverified: found.map(f => ({ sentence: f.sentence, kind: f.kind, reason: f.reason })) }
}

registerReportPart({
  ...CORE_PART_METAS[0],
  // 易错题集 + 易错知识点：程序从数据库拼，不调用 AI
  async run(ctx) {
    const db = getDb()
    const items = ctx.prepared.input.errorItems
    const ids = items.flatMap(i => i.questions.map(q => q.questionId))
    const answers = new Map<string, string>()
    if (ids.length) {
      // 只有老师审核过（status = done）的卷子里的题才给参考答案
      const rows = db.prepare(`SELECT q.id, q.answer FROM questions q JOIN papers p ON p.id = q.paper_id WHERE p.status = 'done' AND q.answer IS NOT NULL AND q.answer <> '' AND q.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; answer: string }>
      for (const r of rows) answers.set(r.id, r.answer)
    }
    return { markdown: buildErrorsSection(items, kpsOf(ctx.prepared), { answerOf: id => answers.get(id) ?? null, subject: ctx.prepared.subject }) }
  }
})

registerReportPart({
  ...CORE_PART_METAS[1],
  skip: ctx => (ctx.prepared.input.errorItems.length === 0 ? '这个范围内没有 AI 估计的易错点，不用写口诀' : null),
  async run(ctx) {
    const p = ctx.prepared
    const user = fillTemplate(promptText('p3_tricks', 'user', p.subject), { ERROR_ITEMS: p.input.placeholders.ERROR_ITEMS, EVIDENCE: p.input.placeholders.EVIDENCE })
    const r = await partChat({ system: promptText('p3_tricks', 'system', p.subject), user, kind: 'p3_tricks', signal: ctx.signal })
    const built = buildTricksSection(r.content, p.input.errorItems, kpsOf(p), p.subject)
    if (built.cards === 0) throw new Error('AI 没有写出可用的口诀（可能是证据里没有对应的规则，或口诀不合要求）。可以点「重试这一部分」')
    const fc = factCheck(built.markdown, evidenceOf(p), p.subject)
    const warnings: string[] = []
    if (built.dropped.length) warnings.push(`有 ${built.dropped.length} 句口诀含价格 / 夸大的说法或太长，已去掉：${built.dropped.slice(0, 3).map(s => `「${s}」`).join('')}`)
    return { markdown: fc.text, model: r.model, promptVersion: promptVersionFor('p3_tricks', p.subject), usage: r.usage, unverified: fc.unverified, warnings }
  }
})

const toRow = (r: any): VariantRow => ({
  id: r.id, seq: r.seq, kp_code: r.kp_code, qtype: r.qtype, stem: r.stem ?? '', options: parseJson<string[]>(r.options_json, []), answer: r.answer ?? '',
  explanation: r.explanation ?? '', changed: r.changed ?? '', status: r.status, teacher_ok: !!r.teacher_ok
})
export const variantRows = (db: any, reportId: string): VariantRow[] => (db.prepare('SELECT * FROM report_variants WHERE report_id = ? ORDER BY seq').all(reportId) as any[]).map(toRow)

registerReportPart({
  ...CORE_PART_METAS[2],
  skip: ctx => (ctx.prepared.input.errorItems.length === 0 ? '这个范围内没有 AI 估计的易错点，不出变形题' : null),
  render: (db, reportId) => {
    const names = new Map((db.prepare('SELECT code, name FROM kps').all() as any[]).map(r => [String(r.code), String(r.name)]))
    return buildVariantsSection(variantRows(db, reportId), c => (c ? names.get(c) ?? '' : ''))
  },
  async run(ctx) {
    const p = ctx.prepared
    const db = getDb()
    const items = p.input.errorItems.slice(0, 3)
    const kps = new Map(kpsOf(p).map(k => [k.code, k]))
    const english = asSubject(p.subject) === 'english'
    // 只把考点、白话释义、例词、例句和题型交给 AI；题干与选项原文不外发
    const kpRows = items.map((it, i) => {
      const k = kps.get(it.code)
      return [i + 1, it.name, k?.plain || '—', k?.hint_words || '—', (english ? (k?.example_en ? `${k.example_en} ${k.example_zh}`.trim() : '') : (k?.example_zh || '')) || '—', it.qtypes.join('、') || '—'].map(x => String(x).replace(/\s+/g, ' ').replace(/\|/g, '／')).join(' | ')
    })
    const user = fillTemplate(promptText('p4_variant_gen', 'user', p.subject), { VARIANT_KPS: kpRows.join('\n'), EVIDENCE: p.input.placeholders.EVIDENCE })
    const gen = await partChat({ system: promptText('p4_variant_gen', 'system', p.subject), user, kind: 'p4_variant_gen', signal: ctx.signal })

    // 本机核对用的材料（题干与选项原文不外发）：这些考点在范围内的原题原文（查抄袭）+ 已出现过的英文词（查超纲）
    const sc = paperScope(p.src.filter)
    const originals: string[] = []
    for (const it of items) for (const q of questionsOfKp(db, sc, it.code, 30)) originals.push(`${q.stem} ${q.options.join(' ')}`)
    const vocab = new Set<string>()
    const addWords = (t: string) => { for (const m of t.toLowerCase().matchAll(/[a-z]+(?:'[a-z]+)?/g)) { vocab.add(m[0]); vocab.add(m[0].replace(/(es|s|ed|ing)$/, '')) } }
    if (english) {   // 词汇范围只对英语查
      originals.forEach(addWords)
      for (const k of kps.values()) addWords(`${k.example_en} ${k.hint_words} ${k.name}`)
    }

    const v = validateVariants(gen.content, { kpCodes: items.map(i => i.code), originals, vocab, max: 3, subject: p.subject })
    if (v.error) throw new Error(`${v.error}。可以点「重试这一部分」`)
    const usable = v.variants.filter(x => x.problems.length === 0)
    if (usable.length === 0) throw new Error(`AI 出的题都没有通过程序校验（${[...new Set(v.variants.flatMap(x => x.problems))].slice(0, 3).join('；') || '格式不对'}）。可以点「重试这一部分」`)

    // 第二次 AI 独立解答：只给题干和选项，不给出题答案
    const qText = usable.map((x, i) => `${i + 1}. ${x.stem}` + (x.qtype === 'choice' ? '\n' + x.options.map((o, k) => `${'ABCD'[k]}. ${o}`).join('\n') : '')).join('\n\n')
    const chk = await partChat({ system: promptText('p4_variant_check', 'system', p.subject), user: fillTemplate(promptText('p4_variant_check', 'user', p.subject), { QUESTIONS: qText }), kind: 'p4_variant_check', signal: ctx.signal })
    const second = parseCheckAnswers(chk.content)
    if (second.size === 0) throw new Error('第二次 AI 解答没有给出可以读取的答案，变形题没法核对。可以点「重试这一部分」')

    const evidence = evidenceOf(p)
    const unverified: UnverifiedItem[] = []
    for (const x of usable) {
      const fc = factCheck(x.explanation, evidence, p.subject)
      if (fc.unverified.length) { x.explanation = fc.text; unverified.push(...fc.unverified) }
    }
    const flagged = usable.filter((x, i) => !sameAnswer(x, second.get(i + 1))).length
    const warnings: string[] = []
    if (flagged) warnings.push(`有 ${flagged} 道变形题的第二次 AI 解答与出题答案不一致，已默认不放进答题卡（可以在题目旁查看，核对后仍可使用）`)
    if (usable.length < 3) warnings.push(`变形题只有 ${usable.length} 道通过了程序校验`)
    const usableIndex = new Map(usable.map((x, i) => [x, i + 1]))
    return {
      markdown: '', model: gen.model, promptVersion: promptVersionFor('p4_variant_gen', p.subject), usage: { gen: gen.usage, check: chk.usage }, unverified, warnings,
      persist: (d, reportId) => {
        d.prepare('DELETE FROM report_variants WHERE report_id = ?').run(reportId)
        const ins = d.prepare(`INSERT INTO report_variants (id, report_id, seq, kp_code, source_question_id, qtype, stem, options_json, answer, explanation, changed, status, teacher_ok, check_json, model, check_model)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        v.variants.forEach((x, i) => {
          const at = usableIndex.get(x)
          const sec = at ? second.get(at) ?? null : null
          const status = x.problems.length ? 'dropped' : sameAnswer(x, sec ?? undefined) ? 'checked' : 'flagged'
          ins.run(`${reportId}-v${i + 1}`, reportId, i + 1, x.kp_code, x.qtype, x.stem, JSON.stringify(x.options), x.answer, x.explanation, x.changed, status,
            JSON.stringify({ problems: x.problems, hints: x.hints, second: sec }), gen.model, chk.model)
        })
      }
    }
  }
})

