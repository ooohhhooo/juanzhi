/**
 * 单份试卷的 AI 解析：准备输入 → 分批调用模型（文本版/视觉版）→ 校验与跨批合并 → 定位 bbox → 入库。
 * 阶段：prepare → ai → locate → save。fromStage='locate' 时复用上次保存的 AI 结果，不再调用模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { net, nativeImage } from 'electron'
import { getDb, getFilesDir } from '../db'
import { chat, AiError } from '../ai/client'
import { effectiveMaxTokens, modelProfile } from '../ai/providers'
import { RETRY_HINT, friendlyAiError } from '../ai/friendly'
import type { ChatMessage } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { promptText, promptVersionFor } from '../ai/prompts'
import { loadTaxonomy } from '../ai/taxonomy'
import type { TaxonomyContext } from '../ai/taxonomy'
import type { AiConfig } from '../ai/types'
import { buildRows, rowsFromPlainText } from './lines'
import type { Row, RawLine } from './lines'
import { planBatches, halveBatch, ocrTextFor, batchInfoText, pageListText, fillTemplate, DEFAULT_LIMITS } from './batch'
import type { Batch, PageInput } from './batch'
import { TextOutputSchema, VisionOutputSchema, formatZodError, extractJson, FLAGS_TEXT, FLAGS_VISION } from './schema'
import type { AnyQuestion } from './schema'
import { mergeBatch, newMergeState, buildPrevContext } from './merge'
import type { MergeState, MergedQuestion, Mode } from './merge'
import { locateAll } from './locate'
import type { PageGeom, LocateResult } from './locate'
import { detectSimilar } from './similar'
import { refinePaperBoxes } from './refine-run'
import { normalizeKps, normalizeQtype, scoreConfidence, metaToPaperFields, pickPrefill, knownMetaText } from './validate'
import type { JobProgress } from '../types'

export type ParseStage = 'prepare' | 'ai' | 'locate' | 'save'
export type FromStage = 'ai' | 'locate'

/** 面向用户的解析错误：message 直接展示；stage 记到 papers.error_stage 之外的 parse_stage */
export class ParseError extends Error {
  stage: ParseStage
  /** 技术详情（给管理员看，界面收在「查看详情」里） */
  detail: string
  constructor(stage: ParseStage, message: string, detail = '') {
    super(message)
    this.stage = stage
    this.detail = detail
  }
}

export interface ParseContext {
  signal: AbortSignal
  onProgress: (p: JobProgress) => void
}

interface PageRow {
  idx: number
  image_rel: string
  width: number
  height: number
  text_source: string
  lines_json: string
  text: string | null
  ocr_conf: number | null
}

const LOW_OCR_CONF = 0.55

function readRows(p: PageRow): Row[] {
  let lines: RawLine[] = []
  try { lines = JSON.parse(p.lines_json) } catch { /* 当作无坐标 */ }
  if (lines.length > 0) return buildRows(lines)
  return p.text ? rowsFromPlainText(p.text) : []
}

interface Prepared {
  inputs: PageInput[]
  notes: string[]
}

/** 决定每页走文本还是视觉：没文字/OCR 没跑成/置信度低 → 视觉；空白页在没有视觉模型时跳过 */
function preparePages(pages: PageRow[], cfg: AiConfig): Prepared {
  const notes: string[] = []
  const inputs: PageInput[] = []
  const blockers: string[] = []
  for (const p of pages) {
    const rows = readRows(p)
    const chars = rows.reduce((s, r) => s + r.text.length, 0)
    const hasImage = !!p.image_rel
    let mode: PageInput['mode']
    if (p.text_source === 'docx') mode = rows.length ? 'text' : 'skip'
    else if (p.text_source === 'none') {
      mode = cfg.vision_model && hasImage ? 'vision' : 'skip'
      if (mode === 'skip') notes.push(`第 ${p.idx} 页没有识别出文字，已跳过（配置视觉模型后重试可让 AI 直接读图）`)
    } else if (p.text_source === 'ocr_failed' || p.text_source === 'needs_ocr') {
      if (cfg.vision_model && hasImage) mode = 'vision'
      else { mode = 'skip'; blockers.push(`第 ${p.idx} 页`) }
    } else if (rows.length === 0) {
      mode = cfg.vision_model && hasImage ? 'vision' : 'skip'
    } else if (p.text_source === 'ocr' && (p.ocr_conf ?? 1) < LOW_OCR_CONF && cfg.vision_model && hasImage) {
      mode = 'vision'
    } else {
      mode = 'text'
    }
    inputs.push({ idx: p.idx, mode, rows, chars, imageRel: p.image_rel })
  }
  if (blockers.length) {
    throw new ParseError('prepare', `${blockers.join('、')}没有可用的文字（OCR 未成功），需要视觉模型来读图。请在「设置 → AI 服务」填写视觉模型后点击重试`)
  }
  if (inputs.every(i => i.mode === 'skip')) throw new ParseError('prepare', '这份试卷没有可解析的文字或图片')
  return { inputs, notes }
}

/**
 * 调试用：设了 EWB_AI_DUMP_DIR 才写，供 test:real-ai 留存原始请求/响应。
 * 只写 messages 与模型输出；永远不要把请求头、apiKey 或完整请求配置写进来。
 */
function dumpCall(paperId: string, seq: number, messages: ChatMessage[], content: string | null, extra: object): void {
  const dir = process.env.EWB_AI_DUMP_DIR
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const light = messages.map(m => typeof m.content === 'string' ? m : { ...m, content: m.content.map(c => c.type === 'image_url' ? { type: 'image_url', image_url: '(省略 base64)' } : c) })
    fs.writeFileSync(path.join(dir, `${paperId.slice(0, 8)}-${Date.now()}-${seq}.json`), JSON.stringify({ messages: light, content, ...extra }, null, 2))
  } catch { /* 调试输出失败不影响解析 */ }
}

interface AiStageResult {
  state: MergeState
  /** 每批实际用了什么 */
  batches: Array<{ mode: Mode; pages: number[]; attempts: number }>
  model: string
  visionModel: string | null
}

function checkAbort(ctx: ParseContext): void {
  if (ctx.signal.aborted) throw new AiError('aborted', '已取消')
}

/** 发给视觉模型的图片长边上限（像素）。整页扫描图原样 base64 可能数 MB，不少服务商有单请求大小上限 */
export const MAX_IMAGE_SIDE = 1600

/** 页面图转 data URL：长边不超过上限的原样发 PNG；超过的等比缩小并转 JPEG（文字仍清晰，体积小很多） */
async function readImageDataUrl(paperId: string, rel: string): Promise<string> {
  const file = path.join(getFilesDir(), paperId, rel)
  const img = nativeImage.createFromPath(file)
  const { width, height } = img.getSize()
  if (width > 0 && Math.max(width, height) > MAX_IMAGE_SIDE) {
    const k = MAX_IMAGE_SIDE / Math.max(width, height)
    const small = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' })
    return `data:image/jpeg;base64,${small.toJPEG(88).toString('base64')}`
  }
  const buf = await fs.promises.readFile(file)
  return `data:image/png;base64,${buf.toString('base64')}`
}

async function runAiStage(
  paperId: string, fileName: string, prepared: Prepared, cfg: AiConfig, tax: TaxonomyContext,
  knownMeta: string, ctx: ParseContext
): Promise<AiStageResult> {
  const key = getApiKey()
  if (!key) throw new ParseError('prepare', '尚未设置 API Key，请先到「设置 → AI 服务」配置')
  const pageCount = prepared.inputs.length
  const state = newMergeState()
  const used: AiStageResult['batches'] = []
  let seq = 0
  let finished = 0

  const plan = planBatches(prepared.inputs, { ...DEFAULT_LIMITS, maxPages: cfg.batch_pages, maxVisionPages: Math.min(cfg.batch_pages, 3) })
  const totalBatches = plan.length
  let curProgress = 8
  const say = (message: string) => ctx.onProgress({ paperId, stage: 'parse:ai', progress: curProgress, message })

  const sysText = promptText('p1_text', 'system')
  const sysVision = promptText('p1_vision', 'system')
  const userText = promptText('p1_text', 'user')
  const userVision = promptText('p1_vision', 'user')

  const buildMessages = async (batch: Batch, seqNo: number, plannedNo: number | null): Promise<ChatMessage[]> => {
    const vars: Record<string, string> = {
      KNOWLEDGE_TREE: tax.treeText,
      QUESTION_TYPES: tax.qtypeText,
      FILE_NAME: fileName,
      KNOWN_META: knownMeta,
      BATCH_INFO: batchInfoText({ seq: plannedNo ?? seqNo, total: plannedNo ? totalBatches : null, pages: batch.pages, pageCount }),
      BATCH_PREFIX: `b${seqNo}`,
      PREV_CONTEXT: buildPrevContext(state, batch.mode)
    }
    if (batch.mode === 'text') {
      vars.OCR_TEXT = ocrTextFor(prepared.inputs, batch.pages)
      return [{ role: 'system', content: sysText }, { role: 'user', content: fillTemplate(userText, vars) }]
    }
    vars.PAGE_LIST = pageListText(batch.pages)
    const images = await Promise.all(batch.pages.map(async i => {
      const rel = prepared.inputs.find(p => p.idx === i)!.imageRel
      return { type: 'image_url' as const, image_url: { url: await readImageDataUrl(paperId, rel) } }
    }))
    return [{ role: 'system', content: sysVision }, { role: 'user', content: [{ type: 'text', text: fillTemplate(userVision, vars) }, ...images] }]
  }

  /** 跑一个批次；输出不可用时按约定对半拆小重试，单页还不行就报错 */
  const runBatch = async (batch: Batch, plannedNo: number | null): Promise<void> => {
    checkAbort(ctx)
    const seqNo = ++seq
    const model = batch.mode === 'vision' ? cfg.vision_model : cfg.model
    const schema = batch.mode === 'vision' ? VisionOutputSchema : TextOutputSchema
    const base = await buildMessages(batch, seqNo, plannedNo)
    let feedback: { raw: string; error: string } | null = null
    let lastProblem = ''
    let lastDetail = ''
    const lim = effectiveMaxTokens(cfg, model)

    for (let round = 0; round < 2; round++) {
      checkAbort(ctx)
      const messages: ChatMessage[] = feedback
        ? [...base,
          { role: 'assistant', content: feedback.raw },
          { role: 'user', content: `你上一次的输出不符合要求：\n${feedback.error}\n请严格按 system 中的 Schema 重新输出完整的 JSON 对象（只输出 JSON，不要解释）。` }]
        : base
      let r
      // 等 AI 的时候，处理队列里每秒更新一次「AI 正在思考 · 已用 N 秒」，不报时间用户只会看着转圈圈干等
      const t0 = Date.now()
      let retried = false
      const word = modelProfile(model).reasoning ? '思考' : '处理'
      const secs = () => Math.round((Date.now() - t0) / 1000)
      say(`AI 正在${word} · 已用 0 秒（通常 2–3 分钟）`)
      const tick = setInterval(() => say(retried ? `输出内容较长，AI 正在自动加长篇幅重试一次（不需要操作）· 已用 ${secs()} 秒` : `AI 正在${word} · 已用 ${secs()} 秒（通常 2–3 分钟）`), 1000)
      try {
        r = await chat({
          baseUrl: cfg.base_url, apiKey: key, model, messages, temperature: 0.1, maxTokens: lim.maxTokens, jsonMode: true,
          // 流式读取：超时按「多久没收到数据」算（思考内容也算数据），而不是一次请求的总时长——
          // 推理模型在 32768 的上限下一次写好几分钟，按总时长计的 180 秒会先到，而「写不完自动加长重试」永远轮不到
          stream: true,
          timeoutMs: cfg.timeout_sec * 1000, signal: ctx.signal, fetchImpl: net.fetch as unknown as typeof fetch,
          // 推理模型先思考再作答：处理队列里要看得到「AI 正在思考」，不然用户只会看着转圈圈干等
          escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback,
          onRetry: () => { retried = true; say(`输出内容较长，AI 正在自动加长篇幅重试一次（不需要操作）· 已用 ${secs()} 秒`) },
          onAttempt: a => { recordUsage({ paperId, kind: 'parse-' + batch.mode, model, usage: a.usage, ok: a.ok }) }
        })
      } catch (e) {
        if (e instanceof AiError && (e.code === 'truncated' || e.code === 'empty')) {
          lastProblem = e.message
          lastDetail = e.detail
          break
        }
        throw e
      } finally {
        clearInterval(tick)
      }
      dumpCall(paperId, seqNo, messages, r.content, { model, attempts: r.attempts, usage: r.usage, finish: r.finishReason })

      const j = extractJson(r.content)
      if (!j.ok) {
        // 英文的 JSON 解析错误只进日志，给用户和模型的是中文说明
        console.warn(`[parse] 非法 JSON：${j.error}`)
        lastProblem = '输出不是合法的 JSON（可能被截断或带了多余内容）'
        feedback = { raw: r.content, error: `${lastProblem}。解析器报告：${j.error}` }
        continue
      }
      const z = schema.safeParse(j.value)
      if (!z.success) {
        lastProblem = `输出的结构不符合要求：\n${formatZodError(z.error)}`
        feedback = { raw: r.content, error: lastProblem }
        continue
      }

      const allowed: readonly string[] = batch.mode === 'vision' ? FLAGS_VISION : FLAGS_TEXT
      const questions: AnyQuestion[] = z.data.questions.map((q) => {
        const page = batch.pages.includes(q.page) ? q.page
          : batch.pages.reduce((best, p) => (Math.abs(p - q.page) < Math.abs(best - q.page) ? p : best), batch.pages[0])
        return {
          ...q, page, anchor_ref: 'anchor_ref' in q ? q.anchor_ref : '',
          flags: q.flags.filter(f => allowed.includes(f))
        } as AnyQuestion
      })
      mergeBatch(state, { ...z.data, questions, materials: z.data.materials, sections: z.data.sections }, { batch: seqNo, mode: batch.mode })
      used.push({ mode: batch.mode, pages: batch.pages, attempts: r.attempts })
      finished++
      curProgress = Math.min(90, 10 + Math.round((finished / Math.max(totalBatches, finished)) * 70))
      ctx.onProgress({
        paperId, stage: 'parse:ai', progress: curProgress,
        message: `AI 解析中：已完成第 ${batch.pages[0]}${batch.pages.length > 1 ? '–' + batch.pages[batch.pages.length - 1] : ''} 页（${finished}/${Math.max(totalBatches, finished)} 批）`
      })
      return
    }

    const halves = halveBatch(batch)
    if (halves) {
      for (const h of halves) await runBatch(h, null)
      return
    }
    // 给用户看的是白话（已经自动加大上限重试过、也拆小过）；技术原因放进详情
    throw new ParseError('ai', `AI 没能完整读懂第 ${batch.pages[0]} 页（已经自动重试过）；${RETRY_HINT}`, `第 ${batch.pages[0]} 页：${lastProblem || '模型输出不可用'}${lastDetail ? `；${lastDetail}` : ''}`)
  }

  for (let i = 0; i < plan.length; i++) await runBatch(plan[i], i + 1)
  return { state, batches: used, model: cfg.model, visionModel: used.some(u => u.mode === 'vision') ? cfg.vision_model : null }
}

// ───────── 定位 + 入库 ─────────

interface FinalQuestion {
  q: MergedQuestion
  qtype: string
  kp_main: string
  kp_secondary: string[]
  kp_suggestion: string
  flags: string[]
  loc: LocateResult
  confidence: number
  score: number | null
}

function finalize(state: MergeState, geoms: Map<number, PageGeom>, tax: TaxonomyContext): FinalQuestion[] {
  const locs = locateAll(state.questions, state.sections, geoms)
  return state.questions.map((q, i) => {
    const loc = locs[i]
    const sec = state.sections.find(s => s.no === q.section && s.inst === q.inst)
    let { qtype, invalid } = normalizeQtype(q.qtype, tax.qtypes)
    if (invalid && sec && tax.qtypes.has(sec.qtype) && sec.qtype !== 'OTHER') { qtype = sec.qtype; invalid = false }
    const k = normalizeKps(q, tax.kps)
    const flags = new Set([...k.flags, ...loc.flags])
    if (invalid) flags.add('qtype_invalid')
    // 没有被后一批续上的残缺题（不只是最后一题）都要标出来，别让老师在审核页里看不出来
    if (q.continues_next) flags.add('stem_incomplete')
    if (!q.section) flags.add('no_section')
    // docx 页面本来就没有坐标，没有 bbox 不算定位失败
    const noCoordsPage = !geoms.get(loc.page)?.rows.some(r => r.hasCoords)
    const confidence = scoreConfidence([...flags], { hasBbox: !!loc.bbox || noCoordsPage, hasStem: !!(q.stem.trim() || q.options.length) })
    return {
      q, qtype, kp_main: k.kp_main, kp_secondary: k.kp_secondary, kp_suggestion: k.kp_suggestion,
      flags: [...flags], loc, confidence, score: q.score ?? sec?.score_each ?? null
    }
  })
}

function loadGeoms(pages: PageRow[]): Map<number, PageGeom> {
  const m = new Map<number, PageGeom>()
  for (const p of pages) m.set(p.idx, { idx: p.idx, rows: readRows(p) })
  return m
}

function saveResults(
  paperId: string, runId: number, state: MergeState, finals: FinalQuestion[], meta: { model: string; promptVersion: string; usageNote: string },
  notes: string[]
): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM questions WHERE paper_id = ?').run(paperId)   // question_kps 级联
    db.prepare('DELETE FROM materials WHERE paper_id = ?').run(paperId)
    const insM = db.prepare('INSERT INTO materials (paper_id, mid, section, kind, text, page_idx) VALUES (?, ?, ?, ?, ?, ?)')
    for (const m of state.materials) insM.run(paperId, m.id, m.section, m.kind, m.text, m.page)
    const insQ = db.prepare(`
      INSERT INTO questions (id, paper_id, ord, no, no_label, section, section_title, qtype, material_id, stem, options, answer, score,
        difficulty, error_prone, error_reason, page_idx, bbox_json, bbox_source, anchor, anchor_ref, confidence, reviewed,
        kp_suggestion, kp_suggestion_status, flags_json, edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
    `)
    const insK = db.prepare('INSERT OR IGNORE INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
    finals.forEach((f, i) => {
      const q = f.q
      const id = crypto.randomUUID()
      const sec = state.sections.find(s => s.no === q.section && s.inst === q.inst)
      insQ.run(id, paperId, i + 1, /^\d+$/.test(q.no) ? Number(q.no) : null, q.no, q.section, sec?.title ?? '', f.qtype, q.material_id,
        q.stem, JSON.stringify(q.options), q.answer, f.score, q.difficulty, q.error_prone ? 1 : 0, q.error_reason,
        f.loc.page, f.loc.bbox ? JSON.stringify(f.loc.bbox) : null, f.loc.source,
        typeof q.anchor === 'string' ? q.anchor : q.anchor ? JSON.stringify(q.anchor) : '', q.anchor_ref, f.confidence,
        f.kp_suggestion, f.kp_suggestion ? 'pending' : null, JSON.stringify(f.flags))
      if (f.kp_main) insK.run(id, f.kp_main, 1)
      for (const k of f.kp_secondary) insK.run(id, k, 0)
    })

    const paper = db.prepare('SELECT title, file_name, grade, semester, school_year_start, exam_type, textbook, total_score, ai_meta_json FROM papers WHERE id = ?').get(paperId) as any
    let prevAi: string[] = []
    try { prevAi = JSON.parse(paper.ai_meta_json || '[]') } catch { /* 忽略 */ }
    const guess = metaToPaperFields(state.meta)
    const { fields, aiFields } = pickPrefill(paper, guess, prevAi)
    // 首次启动引导里选的教材版本（M4）：AI 没从卷头读出教材、老师也没填时，用它作默认值；AI 读到了就以 AI 为准（仍标「AI 猜测」）
    if (fields.textbook === undefined && !paper.textbook) {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'default_textbook'").get() as { value_json: string } | undefined
      try { const t = row ? JSON.parse(row.value_json) : null; if (typeof t === 'string' && t.trim()) fields.textbook = t.trim().slice(0, 100) } catch { /* 忽略损坏的设置 */ }
    }
    const sets = Object.keys(fields).map(k => `${k} = ?`)
    db.prepare(`
      UPDATE papers SET status = 'reviewing', error = NULL, error_detail = NULL, error_stage = NULL, parse_stage = 'done', ai_model = ?, prompt_version = ?,
        parsed_at = datetime('now','localtime'), ai_meta_json = ?${sets.length ? ', ' + sets.join(', ') : ''}
      WHERE id = ?
    `).run(meta.model, meta.promptVersion, JSON.stringify(aiFields), ...Object.values(fields), paperId)
    db.prepare(`UPDATE parse_runs SET status = 'done', finished_at = datetime('now','localtime'), usage_json = ?, result_json = ? WHERE id = ?`)
      .run(meta.usageNote, JSON.stringify({ ...stateToJson(state), notes }), runId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function stateToJson(state: MergeState) {
  return { meta: state.meta, sections: state.sections, materials: state.materials, questions: state.questions, notes: state.notes, latestInst: state.latestInst }
}

/** 解析一份试卷。成功后状态为 reviewing；失败抛出 ParseError / AiError，由队列写 failed */
export async function parsePaper(paperId: string, fromStage: FromStage | undefined, ctx: ParseContext): Promise<void> {
  const db = getDb()
  const cfg = loadConfig()
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId) as any
  if (!paper) throw new ParseError('prepare', '试卷不存在')
  const pages = db.prepare('SELECT idx, image_rel, width, height, text_source, lines_json, text, ocr_conf FROM pages WHERE paper_id = ? ORDER BY idx').all(paperId) as unknown as PageRow[]
  if (pages.length === 0) throw new ParseError('prepare', '这份试卷还没有提取出页面，请先重新提取')
  const tax = loadTaxonomy()

  const stage = (s: ParseStage, progress: number, message: string) => {
    db.prepare('UPDATE papers SET parse_stage = ? WHERE id = ?').run(s, paperId)
    ctx.onProgress({ paperId, stage: `parse:${s}`, progress, message })
  }

  db.prepare("UPDATE papers SET status = 'parsing', error = NULL, error_detail = NULL, error_stage = NULL WHERE id = ?").run(paperId)
  stage('prepare', 2, '准备输入…')

  let state: MergeState
  let runId: number
  let usedModel = cfg.model
  let notes: string[] = []
  let version = ''
  let usageNote = ''

  if (fromStage === 'locate') {
    const last = db.prepare("SELECT id, result_json, usage_json, model, vision_model, prompt_version FROM parse_runs WHERE paper_id = ? AND result_json IS NOT NULL ORDER BY id DESC LIMIT 1").get(paperId) as any
    if (!last) throw new ParseError('locate', '没有可复用的 AI 结果，请选择「重新 AI 解析」')
    let saved: any
    try { saved = JSON.parse(last.result_json) } catch { saved = null }   // 数据包里带来的 / 被破坏的库里，这一列可能是垃圾
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Array.isArray(saved.questions)) throw new ParseError('locate', '上次的 AI 结果已损坏，无法复用，请选择「重新 AI 解析」')
    state = { ...newMergeState(), ...saved }
    usedModel = last.model || cfg.model
    version = last.prompt_version || ''
    usageNote = last.usage_json || ''
    notes = state.notes
    runId = last.id
    // 不改动被复用的那条运行的状态：重新定位若被取消/失败，题目没变，审核页顶栏仍应显示这条已完成的运行；成功时 saveResults 会更新它
  } else {
    const prepared = preparePages(pages, cfg)
    const usesVision = prepared.inputs.some(i => i.mode === 'vision')
    const usesText = prepared.inputs.some(i => i.mode === 'text')
    const parts = [usesText ? promptVersionFor('p1_text') : '', usesVision ? promptVersionFor('p1_vision') : ''].filter(Boolean)
    version = [...new Set(parts)].join(' / ')
    let prevAi: string[] = []
    try { prevAi = JSON.parse(paper.ai_meta_json || '[]') } catch { /* 忽略 */ }
    const known = knownMetaText(paper, prevAi)
    db.prepare('UPDATE parse_runs SET status = ? WHERE paper_id = ? AND status = ?').run('superseded', paperId, 'running')
    runId = Number(db.prepare('INSERT INTO parse_runs (paper_id, prompt_version, model, vision_model) VALUES (?, ?, ?, ?)')
      .run(paperId, version, cfg.model, usesVision ? cfg.vision_model : null).lastInsertRowid)
    stage('ai', 8, '调用 AI 拆题与标注…')
    try {
      const r = await runAiStage(paperId, paper.file_name, prepared, cfg, tax, known, ctx)
      state = r.state
      usedModel = [r.batches.some(b => b.mode === 'text') ? cfg.model : '', r.visionModel ?? ''].filter(Boolean).join(' + ') || cfg.model
      notes = [...prepared.notes, ...state.notes]
      state.notes = notes
      usageNote = JSON.stringify({ batches: r.batches })
      db.prepare("UPDATE parse_runs SET status = 'ai_done', result_json = ?, usage_json = ?, model = ? WHERE id = ?")
        .run(JSON.stringify(stateToJson(state)), usageNote, usedModel, runId)
    } catch (e) {
      const cancelled = ctx.signal.aborted || (e instanceof AiError && e.code === 'aborted')
      db.prepare("UPDATE parse_runs SET status = ?, error = ?, finished_at = datetime('now','localtime') WHERE id = ?")
        .run(cancelled ? 'cancelled' : 'failed', cancelled ? null : (e as Error).message.slice(0, 500), runId)
      throw e
    }
  }

  checkAbort(ctx)
  stage('locate', 92, '定位每道题在原卷上的位置…')
  const finals = finalize(state, loadGeoms(pages), tax)
  checkAbort(ctx)
  stage('save', 97, '保存到数据库…')
  saveResults(paperId, runId, state, finals, { model: usedModel, promptVersion: version, usageNote }, notes)
  // 题目截图的框用页面墨迹修准（带出邻题题号、残字、上下一行的字脚）；失败不影响解析结果
  try { refinePaperBoxes(paperId) } catch (e) { console.warn(`[parse] 修正截图框失败: ${(e as Error).message}`) }
  // 疑似重复 / 部分重复：和已有卷子比题目文字（失败不影响解析结果）
  try { detectSimilar(db, paperId) } catch (e) { console.warn(`[parse] 相似卷比对失败: ${(e as Error).message}`) }
  ctx.onProgress({ paperId, stage: 'reviewing', progress: 100, message: `已拆出 ${finals.length} 道题，等待审核` })
}
