/**
 * 命令行各命令的实现（M7）。不另写业务逻辑：按通道名调用主进程已注册的处理函数（invoke），或直接调 service 里的函数；
 * 所以参数校验、事实核对、家长版把关、样本不足提示、内部代码过滤、busy 守卫在命令行里和界面一样生效。
 */
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb, getDataDir, LATEST_SCHEMA } from '../db'
import { isAiReady, loadConfig } from '../ai/config'
import { extractQueueState, registerImports } from '../pipeline/queue'
import { parseQueueState } from '../parse/queue'
import { allowPath } from '../allowedPaths'
import { safeKpName } from '../../shared/code-guard'
import { exportBlock, exportReportTo, PARENT_DRAFT_WARNING } from '../report/export-run'
import { getReport } from '../report/service'
import { assertExportTarget } from './outfile'
import { CliError, exportFormatFromFlags, helpData, levelFromFlags, paperFilterFromFlags, readerFromFlags, statsFilterFromFlags } from './args'
import type { ParsedArgs } from './args'

export type Invoke = (channel: string, ...args: unknown[]) => Promise<any>
/** 和界面一样，流式的处理函数通过 event.sender 发增量；命令行给它一个只写 stderr 日志的假 sender */
export type InvokeWithSender = (sender: unknown, channel: string, ...args: unknown[]) => Promise<any>
export interface CliCtx {
  args: ParsedArgs
  /** 不能写文件的目录（userData、数据目录） */
  forbiddenDirs: string[]
  invoke: Invoke
  invokeWithSender: InvokeWithSender
  /** 进度 / 日志（写 stderr；--quiet 时不写） */
  log: (msg: string) => void
  /** 当前时间（毫秒）：测试里可替换 */
  now?: () => number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const AI_HINT = '还没有配置 AI 服务。命令行不能设置 API Key：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」里填写并保存，再回来使用命令行'

function requireAi(): void {
  if (!isAiReady()) throw new CliError('ai_not_configured', AI_HINT)
}

// ───────────────────────── status ─────────────────────────

async function status(ctx: CliCtx) {
  const rows = getDb().prepare('SELECT status, COUNT(*) c FROM papers WHERE is_sample = 0 GROUP BY status').all() as Array<{ status: string; c: number }>
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const r of rows) { byStatus[r.status] = r.c; total += r.c }
  const cfg = loadConfig()
  const ocr = await ctx.invoke('ocr:status')
  return {
    version: app.getVersion(), platform: process.platform, arch: process.arch, schema: LATEST_SCHEMA,
    dataDir: getDataDir(),
    papers: { total, byStatus },
    // 只说有没有配，不输出密钥、不输出服务地址
    ai: { configured: isAiReady(), model: cfg.model || null },
    ocr: { available: !!ocr.available, detail: String(ocr.detail ?? '') }
  }
}

// ───────────────────────── import ─────────────────────────

const DONE_STATES = new Set(['reviewing', 'done', 'failed'])

interface PaperOut { file: string; paperId?: string; status: string; title?: string; questions?: number; error?: string; duplicateOf?: unknown; stage?: string }

function paperState(id: string): { status: string; title: string; error: string | null; stage: string | null; questions: number } | null {
  const db = getDb()
  const r = db.prepare('SELECT status, title, error, error_stage FROM papers WHERE id = ?').get(id) as any
  if (!r) return null
  const q = (db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(id) as any).c as number
  return { status: r.status, title: r.title, error: r.error ?? null, stage: r.error_stage ?? null, questions: q }
}

async function importCmd(ctx: CliCtx) {
  requireAi()
  const files = ctx.args.positionals.map(p => path.resolve(p))
  for (const f of files) allowPath(f)   // 路径是使用者在命令行里明确给出的：等同于在「导入试卷」对话框里选了它
  ctx.log(`导入 ${files.length} 份文件……`)
  const results = await registerImports(files, { parseAfter: true })
  const out: PaperOut[] = results.map(r => r.paperId
    ? { file: r.path, paperId: r.paperId, status: 'imported' }
    : r.code === 'duplicate'
      ? { file: r.path, status: 'duplicate', error: r.error, duplicateOf: r.duplicateOf }
      : { file: r.path, status: 'rejected', error: r.error })
  // 提取和解析都在本进程里跑：命令必须等它们结束，否则进程一退出，排队中的卷子就丢了（所以不加 --wait 也会等；--wait 保留是为了让 Agent 的写法更明确）
  const ids = out.filter(o => o.paperId).map(o => o.paperId!)
  const deadline = Date.now() + ctx.args.timeoutSec * 1000
  let lastLog = 0
  let timedOut = false
  let idleSince = 0
  const stalled = new Set<string>()
  while (ids.some(id => !DONE_STATES.has(paperState(id)?.status ?? 'failed') && !stalled.has(id))) {
    if (Date.now() > deadline) { timedOut = true; break }
    // 提取队列和解析队列都空了，却还有卷子停在「处理中」状态（比如某种原因没被入队）：不能傻等到超时，3 秒后把它们标成「没被处理」
    const ex = extractQueueState(), ps = parseQueueState()
    const idle = !ex.running && ex.waiting.length === 0 && ps.running.length === 0 && ps.waiting.length === 0
    if (idle) {
      if (!idleSince) idleSince = Date.now()
      else if (Date.now() - idleSince > 3000) for (const id of ids) if (!DONE_STATES.has(paperState(id)?.status ?? 'failed')) stalled.add(id)
    } else idleSince = 0
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now()
      ctx.log(ids.map(id => `${paperState(id)?.status ?? '?'}`).join(' / '))
    }
    await sleep(500)
  }
  for (const o of out) {
    if (!o.paperId) continue
    const st = paperState(o.paperId)
    if (!st) { o.status = 'failed'; continue }
    o.status = st.status; o.title = st.title; o.questions = st.questions
    if (st.status === 'failed') { o.error = st.error ?? '处理失败'; o.stage = st.stage ?? undefined }
    else if (!DONE_STATES.has(st.status)) { o.status = 'failed'; o.error = `没有被处理完（停在「${st.status}」，处理队列已经空了）：请到卷知窗口的处理队列里重试`; o.stage = 'stalled' }
  }
  const failed = out.filter(o => o.status === 'failed' || o.status === 'rejected')
  const data = {
    papers: out,
    summary: { total: out.length, reviewing: out.filter(o => o.status === 'reviewing').length, failed: failed.length, duplicates: out.filter(o => o.status === 'duplicate').length },
    // 解析出来的题目、知识点都是 AI 的结果，没有经过人工审核
    note: '导入的试卷处于「待审核」：AI 解析的题型、分值、知识点可能有错。请在卷知界面里审核后再把统计、报告当作结论；统计默认只计入已确认的试卷，加 --include-reviewing 可以把待审核的也算进去。'
  }
  if (timedOut) throw new CliError('timeout', `等了 ${ctx.args.timeoutSec} 秒还有试卷没处理完（命令行退出后这些任务不会继续）。可以加大 --timeout 再试`, data)
  if (failed.length) throw new CliError('import_failed', `有 ${failed.length} 份没能导入或解析成功：${failed.map(f => `${path.basename(f.file)}（${f.error ?? f.status}）`).join('；')}`, data)
  return data
}

// ───────────────────────── papers ─────────────────────────

function paperRow(p: any) {
  return {
    id: p.id, title: p.title, fileName: p.file_name, status: p.status, grade: p.grade, semester: p.semester, schoolYearStart: p.school_year_start,
    examType: p.exam_type, textbook: p.textbook, region: p.region, pageCount: p.page_count, createdAt: p.created_at,
    similarState: p.similar_state ?? null, error: p.error ?? null
  }
}

async function papersList(ctx: CliCtx) {
  const rows = await ctx.invoke('papers:list', paperFilterFromFlags(ctx.args.flags))
  const counts = new Map((getDb().prepare('SELECT paper_id, COUNT(*) c FROM questions GROUP BY paper_id').all() as any[]).map(r => [r.paper_id as string, r.c as number]))
  return { papers: (rows as any[]).filter(p => !p.is_sample).map(p => ({ ...paperRow(p), questions: counts.get(p.id) ?? 0 })) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function needUuid(id: string, what: string): string {
  if (!UUID.test(id)) throw new CliError('usage', `${what} id 的格式不对（应当是类似 3f2a…的 36 位编号，可以用 ${what === '试卷' ? 'papers list' : 'report list'} 查）`)
  return id
}

async function papersShow(ctx: CliCtx) {
  const id = needUuid(ctx.args.positionals[0], '试卷')
  const p = await ctx.invoke('papers:get', id)
  if (!p) throw new CliError('not_found', `找不到这份试卷：${id}`)
  const q = await ctx.invoke('questions:list', id)
  const names = new Map((getDb().prepare('SELECT code, name FROM kps').all() as any[]).map(k => [k.code as string, safeKpName(k.name)]))
  const questions = (q.questions as any[]).map(x => ({
    id: x.id, no: x.no, section: x.section, qtype: x.qtype, score: x.score, difficulty: x.difficulty, stem: x.stem, options: x.options, answer: x.answer,
    kpMain: x.kp_main ?? null, kpMainName: x.kp_main ? names.get(x.kp_main) ?? null : null,
    kpSecondary: x.kp_secondary ?? [], errorProne: !!x.error_prone, errorReason: x.error_reason ?? null, reviewed: !!x.reviewed
  }))
  return {
    paper: paperRow(p), questions, notes: q.notes ?? [],
    reviewState: p.status === 'done' ? '已确认' : p.status === 'reviewing' ? '待审核：AI 解析的结果还没有经过人工审核' : p.status
  }
}

async function papersConfirm(ctx: CliCtx) {
  const id = needUuid(ctx.args.positionals[0], '试卷')
  if (ctx.args.flags['i-reviewed'] !== true) {
    throw new CliError('confirmation_required',
      '这条命令会跳过人工审核，把整份试卷的所有题目直接标为「已确认」。AI 解析的题型、分值、知识点可能有错，这些错会直接进入统计和报告。应该在卷知界面里逐题审核；如果你（或使用者）确实已经审核过了，再加上 --i-reviewed 参数重新运行')
  }
  const p = await ctx.invoke('papers:get', id)
  if (!p) throw new CliError('not_found', `找不到这份试卷：${id}`)
  if (!['reviewing', 'done'].includes(p.status)) throw new CliError('invalid_state', `这份试卷现在是「${p.status}」状态，还没有解析完成，不能确认`)
  const before = p.status
  await ctx.invoke('questions:confirmPaper', id, true)
  return { id, previousStatus: before, status: 'done', warning: '已跳过人工审核直接确认（--i-reviewed）：请确认你确实审核过这份试卷。' }
}

// ───────────────────────── stats ─────────────────────────

async function statsOverview(ctx: CliCtx) {
  return ctx.invoke('stats:overview', statsFilterFromFlags(ctx.args.flags))
}
async function statsHot(ctx: CliCtx) {
  return ctx.invoke('stats:hot', statsFilterFromFlags(ctx.args.flags), levelFromFlags(ctx.args.flags, 2))
}
async function statsCompare(ctx: CliCtx) {
  const f = ctx.args.flags
  if (f.target === undefined || f.target === true) throw new CliError('usage', 'stats compare 要用 --target 指定目标学年（学年起始年，如 2025 表示 2025-2026 学年）')
  const target = Number(f.target)
  if (!Number.isInteger(target) || target < 2000 || target > 2100) throw new CliError('usage', '--target 要是 2000 到 2100 之间的年份')
  let base: string | number = 'before'
  if (f.base !== undefined) {
    if (f.base === 'before') base = 'before'
    else if (f.base !== true && Number.isInteger(Number(f.base)) && Number(f.base) >= 2000 && Number(f.base) <= 2100) base = Number(f.base)
    else throw new CliError('usage', '--base 要是 before（目标学年之前的全部学年）或一个学年起始年')
  }
  const filter = statsFilterFromFlags(f)
  delete filter.school_year_start   // 同比自己决定学年，筛选里的学年不生效（和界面一致）
  return ctx.invoke('stats:compare', filter, target, base, levelFromFlags(f, 2), f['no-align'] !== true)
}

// ───────────────────────── report ─────────────────────────

function reportOut(r: NonNullable<ReturnType<typeof getReport>>) {
  return {
    id: r.id, title: r.title, reader: r.reader, readerLabel: r.readerLabel, createdAt: r.createdAt, model: r.model, status: r.status,
    markdown: r.markdown, warnings: r.warnings, sampleWarning: r.sampleWarning,
    unverified: r.unverified.map(u => ({ sentence: u.sentence, kind: u.kind, reason: u.reason })),
    confirmedAt: r.confirmedAt,
    // 没有老师在界面里点「我已核对」的都是 AI 草稿；家长版更要紧：不能直接发给家长
    draft: !r.confirmedAt, parentDraft: r.reader === 'parent' && !r.confirmedAt,
    blockReason: r.blockReason,
    refs: r.refs.map(x => ({ token: x.token, paperId: x.paperId, missing: !!x.missing })),
    ...(r.reader === 'parent' && !r.confirmedAt ? { warning: PARENT_DRAFT_WARNING } : {})
  }
}

async function reportGenerate(ctx: CliCtx) {
  const reader = readerFromFlags(ctx.args.flags)
  requireAi()
  const filter = statsFilterFromFlags(ctx.args.flags)
  const requestId = crypto.randomUUID()
  let chars = 0, lastLog = 0
  const sender = {
    isDestroyed: () => false, once: () => undefined, removeListener: () => undefined,
    send: (_ch: string, ev: any) => {
      if (ev?.type === 'delta' && typeof ev.text === 'string') chars += ev.text.length
      if (Date.now() - lastLog > 5000) { lastLog = Date.now(); ctx.log(`报告生成中……已收到 ${chars} 字`) }
    }
  }
  ctx.log('生成报告……')
  const res = await ctx.invokeWithSender(sender, 'report:generate', filter, requestId, reader)
  if (!res.ok) {
    const code = res.code === 'no_data' || res.code === 'bad_prompt' ? 'invalid_state' : res.code === 'no_ai' ? 'ai_not_configured' : res.code === 'busy' ? 'busy' : 'ai_failed'
    throw new CliError(code, res.message ?? '生成报告失败', res.detail ? { detail: res.detail } : undefined)
  }
  const r = getReport(res.reportId)
  if (!r) throw new CliError('internal', '报告生成了但读不回来')
  return reportOut(r)
}

async function reportList(ctx: CliCtx) {
  const items = (await ctx.invoke('report:list')) as any[]
  return { reports: items.map(r => ({ id: r.id, title: r.title, reader: r.reader, readerLabel: r.readerLabel, createdAt: r.createdAt, status: r.status, chars: r.chars, unverifiedCount: r.unverifiedCount, confirmedAt: r.confirmedAt, draft: !r.confirmedAt, blockReason: r.blockReason })) }
}

async function reportShow(ctx: CliCtx) {
  const id = needUuid(ctx.args.positionals[0], '报告')
  const r = getReport(id)
  if (!r) throw new CliError('not_found', `找不到这份报告：${id}`)
  return reportOut(r)
}

async function reportExport(ctx: CliCtx) {
  const id = needUuid(ctx.args.positionals[0], '报告')
  const fmt = exportFormatFromFlags(ctx.args.flags)
  const out = ctx.args.flags.out
  if (typeof out !== 'string' || !out.trim()) throw new CliError('usage', '导出要用 --out 指定文件路径，例如 --out ./报告.docx')
  const r = getReport(id)
  if (!r) throw new CliError('not_found', `找不到这份报告：${id}`)
  const why = exportBlock(r, { allowParentDraft: true })
  if (why) throw new CliError('export_blocked', why)
  // 目标路径：补上扩展名之后检查（不在数据目录里；已经存在的文件不加 --overwrite 不覆盖；符号链接不跟随）
  const withExt = path.resolve(out).toLowerCase().endsWith(`.${fmt}`) ? path.resolve(out) : `${path.resolve(out)}.${fmt}`
  const outPath = assertExportTarget(withExt, ctx.forbiddenDirs, ctx.args.flags.overwrite === true)
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }) } catch { /* 下面写文件时会给出白话错误 */ }
  const o = await exportReportTo(r, fmt, outPath, { allowParentDraft: true })
  // draft = 没有老师在界面里点过「我已核对」（所有版本的导出都是 AI 草稿）；parentDraft = 家长版草稿（文件开头带了「请勿直接发给家长」标记）
  return { id, format: fmt, path: o.path, dir: o.dir ?? null, images: o.images, bytes: o.bytes, draft: !r.confirmedAt, parentDraft: o.draft, ...(o.warning ? { warning: o.warning } : {}), reviewed: !!r.confirmedAt }
}

// ───────────────────────── 分发 ─────────────────────────

const HANDLERS: Record<string, (ctx: CliCtx) => Promise<unknown>> = {
  status, import: importCmd,
  'papers list': papersList, 'papers show': papersShow, 'papers confirm': papersConfirm,
  'stats overview': statsOverview, 'stats hot': statsHot, 'stats compare': statsCompare,
  'report generate': reportGenerate, 'report list': reportList, 'report show': reportShow, 'report export': reportExport
}

export async function runCommand(ctx: CliCtx): Promise<unknown> {
  if (ctx.args.help || !ctx.args.command) return helpData()
  const h = HANDLERS[ctx.args.command]
  if (!h) throw new CliError('usage', `没有「${ctx.args.command}」这个命令`)
  return h(ctx)
}
