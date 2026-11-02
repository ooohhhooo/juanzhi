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
import { loadConfig, recordUsage, visionCreds } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { parseModelOf } from '../ai/types'
import { decidePage, paperExpectsCjk, namesHaveCjk, ocrQuality, relaxSparse } from '../pipeline/ocr-quality'
import type { PageChoice, PageQuality, Recognizer } from '../pipeline/ocr-quality'
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
  recognizer: string | null
  ocr_lang: string | null
  quality_json: string | null
}

function readRows(p: PageRow): Row[] {
  let lines: RawLine[] = []
  try { lines = JSON.parse(p.lines_json) } catch { /* 当作无坐标 */ }
  if (lines.length > 0) return buildRows(lines)
  return p.text ? rowsFromPlainText(p.text) : []
}

interface Prepared {
  inputs: PageInput[]
  notes: string[]
  /** 每页的识别方式和原因（解析前写进 pages 表，试卷详情和审核页据此说明） */
  choices: Map<number, PageChoice>
}

/** 这页最终用的识别方式（记录用）：读图 = vision-model；否则沿用提取时记下的，旧数据按文字来源和平台推 */
function recognizerOf(p: PageRow, mode: PageInput['mode']): Recognizer | null {
  if (mode === 'vision') return 'vision-model'
  if (p.recognizer) return p.recognizer as Recognizer
  if (p.text_source === 'docx') return 'docx-text'
  if (p.text_source === 'pdf-text') return 'pdf-text'
  if (p.text_source === 'ocr') return process.platform === 'win32' ? 'win-ocr' : 'mac-vision'
  return null
}

/**
 * 决定每页走文本还是视觉。不再相信 Windows 的固定置信度：看文字本身的质量（pipeline/ocr-quality.ts）。
 * 默认（auto）只有本机识别不好的页才交给视觉模型；设置里可改成图片和扫描件一律读图，或从不读图。空白页在没有视觉模型时跳过。
 */
function preparePages(pages: PageRow[], cfg: AiConfig, names: string[]): Prepared {
  const notes: string[] = []
  const inputs: PageInput[] = []
  const choices = new Map<number, PageChoice>()
  const blockers: string[] = []
  const visionReady = !!cfg.vision_model.trim() && !!visionCreds(cfg).key
  const expectsCjk = paperExpectsCjk({
    pageTexts: pages.map(p => {
      const rows = readRows(p)
      return { texts: rows.map(r => r.text), trustedForCjk: p.text_source === 'pdf-text' || p.text_source === 'docx' || (p.text_source === 'ocr' && (!p.ocr_lang || /^zh/i.test(p.ocr_lang))) }
    })
  })
  const nameCjk = namesHaveCjk(names)
  // 每个本机识别出文字的页的质量（提取时记过的用记录，没有就现场算），再按全卷把「太短」的封面 / 答案页放过
  const quals = pages.map((p): PageQuality | null => {
    if (p.text_source !== 'ocr') return null
    try { if (p.quality_json) return JSON.parse(p.quality_json) } catch { /* 损坏的记录：现场重算 */ }
    return ocrQuality(readRows(p).map(r => r.text), { lang: p.ocr_lang, paperExpectsCjk: expectsCjk, nameHasCjk: nameCjk, conf: p.ocr_lang ? null : p.ocr_conf })
  })
  const relaxed = relaxSparse(quals)
  for (const [pi, p] of pages.entries()) {
    const rows = readRows(p)
    const chars = rows.reduce((s, r) => s + r.text.length, 0)
    const hasImage = !!p.image_rel
    const stored: PageQuality | null = relaxed[pi]
    const c = decidePage({
      textSource: p.text_source, hasImage, rowTexts: rows.map(r => r.text), lang: p.ocr_lang,
      // 有引擎语言 = Windows，那个置信度是固定值，不可信
      conf: p.ocr_lang ? null : p.ocr_conf, quality: stored
    }, { policy: cfg.vision_policy, visionReady, expectsCjk, nameHasCjk: nameCjk })
    choices.set(p.idx, c)
    if (c.mode === 'skip') {
      if (c.reason === 'ocr-failed') blockers.push(`第 ${p.idx} 页`)
      else if (p.text_source === 'none' || c.reason === 'no-text') notes.push(`第 ${p.idx} 页没有识别出文字，已跳过（配置视觉模型后重试可让 AI 直接读图）`)
    }
    inputs.push({ idx: p.idx, mode: c.mode, rows, chars, imageRel: p.image_rel })
  }
  if (blockers.length) {
    throw new ParseError('prepare', `${blockers.join('、')}没有可用的文字（本机识别未成功），需要视觉模型来读图。请在「设置 → AI 服务」填写视觉模型后点击重试`)
  }
  if (inputs.every(i => i.mode === 'skip')) throw new ParseError('prepare', '这份试卷没有可解析的文字或图片')
  return { inputs, notes, choices }
}

/** 把每页的识别方式和原因写进 pages 表（解析前写；读图失败改用本机文字时会再更新一次） */
function recordRecognition(paperId: string, pages: PageRow[], prepared: Prepared): void {
  const db = getDb()
  const upd = db.prepare('UPDATE pages SET recognizer = ?, rec_reason = ?, quality_json = COALESCE(?, quality_json) WHERE paper_id = ? AND idx = ?')
  for (const p of pages) {
    const c = prepared.choices.get(p.idx)
    const inp = prepared.inputs.find(i => i.idx === p.idx)
    if (!c || !inp) continue
    upd.run(recognizerOf(p, inp.mode), c.reason, c.quality ? JSON.stringify(c.quality) : null, paperId, p.idx)
  }
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
  paperId: string, runId: number, fileName: string, prepared: Prepared, cfg: AiConfig, tax: TaxonomyContext,
  knownMeta: string, ctx: ParseContext
): Promise<AiStageResult> {
  const key = getApiKey()
  if (!key) throw new ParseError('prepare', '尚未设置 API Key，请先到「设置 → AI 服务」配置')
  const vcreds = visionCreds(cfg)
  const textModel = parseModelOf(cfg)
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

  /** 记一行批次明细（parse_batches）：模型、模式、尝试次数、有没有被长度截断 / 加长重试、耗时、token。只写数字，不写正文 */
  const recordBatch = (seqNo: number, batch: Batch, model: string, row: { attempts: number; truncated: boolean; escalated: boolean; usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number }; ms: number; ok: boolean; errCode?: string }) => {
    try {
      getDb().prepare(`INSERT INTO parse_batches (paper_id, run_id, seq, mode, model, pages, attempts, truncated, escalated, reasoning_tokens, prompt_tokens, completion_tokens, ms, ok, err_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(paperId, runId, seqNo, batch.mode, model, batch.pages.join(','), row.attempts, row.truncated ? 1 : 0, row.escalated ? 1 : 0,
          row.usage?.reasoningTokens ?? null, row.usage?.promptTokens ?? null, row.usage?.completionTokens ?? null, row.ms, row.ok ? 1 : 0, row.errCode ?? null)
    } catch (e) { console.warn(`[parse] 记录批次明细失败: ${(e as Error).message}`) }
  }

  /** 跑一个批次；输出不可用时按约定对半拆小重试，单页还不行就报错 */
  const runBatch = async (batch: Batch, plannedNo: number | null): Promise<void> => {
    checkAbort(ctx)
    const seqNo = ++seq
    const model = batch.mode === 'vision' ? cfg.vision_model : textModel
    const schema = batch.mode === 'vision' ? VisionOutputSchema : TextOutputSchema
    const base = await buildMessages(batch, seqNo, plannedNo)
    let feedback: { raw: string; error: string } | null = null
    let lastProblem = ''
    let lastDetail = ''
    const lim = effectiveMaxTokens(cfg, model)
    const batchT0 = Date.now()
    let attemptsTotal = 0
    let sawTruncated = false
    let sawEscalated = false
    const endpoint = batch.mode === 'vision' ? vcreds : { baseUrl: cfg.base_url, key }
    if (!endpoint.key) throw new ParseError('prepare', '视觉模型没有可用的 API Key：它用了和文本模型不同的服务地址，请到「设置 → AI 服务」给它填上自己的密钥')

    /** 收下一个批次的结果：合并进整卷、记批次明细、更新进度 */
    const accept = (data: any, r: { attempts: number; escalated: boolean; usage: any }): void => {
      const allowed: readonly string[] = batch.mode === 'vision' ? FLAGS_VISION : FLAGS_TEXT
      const questions: AnyQuestion[] = data.questions.map((q: any) => {
        const page = batch.pages.includes(q.page) ? q.page
          : batch.pages.reduce((best, p) => (Math.abs(p - q.page) < Math.abs(best - q.page) ? p : best), batch.pages[0])
        return {
          ...q, page, anchor_ref: 'anchor_ref' in q ? q.anchor_ref : '',
          flags: q.flags.filter((f: string) => allowed.includes(f))
        } as AnyQuestion
      })
      mergeBatch(state, { ...data, questions, materials: data.materials, sections: data.sections }, { batch: seqNo, mode: batch.mode })
      used.push({ mode: batch.mode, pages: batch.pages, attempts: r.attempts })
      recordBatch(seqNo, batch, model, { attempts: Math.max(attemptsTotal, r.attempts), truncated: sawTruncated, escalated: r.escalated || sawEscalated, usage: r.usage, ms: Date.now() - batchT0, ok: true })
      finished++
      curProgress = Math.min(90, 10 + Math.round((finished / Math.max(totalBatches, finished)) * 70))
      ctx.onProgress({
        paperId, stage: 'parse:ai', progress: curProgress,
        message: `AI 解析中：已完成第 ${batch.pages[0]}${batch.pages.length > 1 ? '–' + batch.pages[batch.pages.length - 1] : ''} 页（${finished}/${Math.max(totalBatches, finished)} 批）`
      })
    }
    let held: { data: any; r: any } | null = null

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
          baseUrl: endpoint.baseUrl, apiKey: endpoint.key, model, messages, temperature: 0.1, maxTokens: lim.maxTokens, jsonMode: true,
          // 流式读取：超时按「多久没收到数据」算（思考内容也算数据），而不是一次请求的总时长——
          // 推理模型在 32768 的上限下一次写好几分钟，按总时长计的 180 秒会先到，而「写不完自动加长重试」永远轮不到
          stream: true,
          timeoutMs: cfg.timeout_sec * 1000, signal: ctx.signal, fetchImpl: net.fetch as unknown as typeof fetch,
          // 推理模型先思考再作答：处理队列里要看得到「AI 正在思考」，不然用户只会看着转圈圈干等
          escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback,
          onRetry: () => { retried = true; sawTruncated = true; sawEscalated = true; say(`输出内容较长，AI 正在自动加长篇幅重试一次（不需要操作）· 已用 ${secs()} 秒`) },
          onAttempt: a => { attemptsTotal++; recordUsage({ paperId, kind: 'parse-' + batch.mode, model, usage: a.usage, ok: a.ok, errCode: a.error?.code }) }
        })
      } catch (e) {
        if (e instanceof AiError && (e.code === 'truncated' || e.code === 'empty')) {
          if (held) { accept(held.data, held.r); return }   // 补框那一轮写不完 / 空：用第一轮的结果
          if (e.code === 'truncated') sawTruncated = true
          lastProblem = e.message
          lastDetail = e.detail
          break
        }
        // 读图时这个密钥没有权限 / 找不到模型：本机文字能用就改用本机文字，别让整份卷子失败
        if (e instanceof AiError && batch.mode === 'vision' && (e.code === 'forbidden' || e.code === 'not_found')) {
          recordBatch(seqNo, batch, model, { attempts: attemptsTotal || 1, truncated: sawTruncated, escalated: sawEscalated, ms: Date.now() - batchT0, ok: false, errCode: e.code })
          const usable = batch.pages.every(i => (prepared.inputs.find(p => p.idx === i)?.rows.length ?? 0) > 0)
          if (usable) {
            for (const i of batch.pages) {
              const inp = prepared.inputs.find(p => p.idx === i)!
              inp.mode = 'text'
              const ch = prepared.choices.get(i)
              if (ch) prepared.choices.set(i, { ...ch, mode: 'text', reason: 'vision-forbidden' })
            }
            prepared.notes.push(`第 ${batch.pages.join('、')} 页：AI 读图时${e.code === 'forbidden' ? '这个密钥没有权限使用视觉模型' : '找不到视觉模型'}（${model}），已改用本机识别的文字`)
            await runBatch({ mode: 'text', pages: batch.pages }, null)
            return
          }
          throw new ParseError('ai', e.code === 'forbidden' ? `AI 读图失败：这个密钥没有权限使用视觉模型「${model}」。请到服务商控制台开通，或在「设置 → AI 服务」换一个有权限的视觉模型` : `AI 读图失败：找不到视觉模型「${model}」，请检查「设置 → AI 服务」里的模型名称`, `${e.code}；${e.detail}`)
        }
        recordBatch(seqNo, batch, model, { attempts: attemptsTotal || 1, truncated: sawTruncated, escalated: sawEscalated, ms: Date.now() - batchT0, ok: false, errCode: e instanceof AiError ? e.code : 'other' })
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
      // 读图版必须给每道题的框（anchor）：截图和「出自原卷」全靠它。有题没给框，第一轮只把这些题的题号告诉模型让它补；
      // 第一轮的结果先留着当后备——第二轮失败（写不完、空、格式不对）就用它，不会因此对半拆批、白白重来
      if (batch.mode === 'vision' && round === 0) {
        const noBox = (z.data.questions as Array<{ no: string; anchor: unknown }>).filter(q => !Array.isArray(q.anchor))
        if (noBox.length > 0) {
          held = { data: z.data, r }
          lastProblem = `有 ${noBox.length} 道题没有给出位置框`
          feedback = { raw: r.content, error: `这些题的 anchor 是 null 或缺失：第 ${noBox.slice(0, 12).map(q => q.no).join('、')} 题${noBox.length > 12 ? ' 等' : ''}。请只补上这些题的位置：anchor 是 [x, y, w, h]（框住题号和题干第一行，数值是 0–1 的比例），其余内容照旧；只有这道题确实不在图片上时才写 null。` }
          continue
        }
      }
      accept(z.data, r)
      return
    }
    // 第二轮没成：有第一轮留下的结果（只是有的题没框）就收下它
    if (held) { accept(held.data, held.r); return }

    recordBatch(seqNo, batch, model, { attempts: Math.max(attemptsTotal, 1), truncated: sawTruncated, escalated: sawEscalated, ms: Date.now() - batchT0, ok: false, errCode: sawTruncated ? 'truncated' : 'invalid' })
    const halves = halveBatch(batch)
    if (halves) {
      for (const h of halves) await runBatch(h, null)
      return
    }
    // 给用户看的是白话（已经自动加大上限重试过、也拆小过）；技术原因放进详情
    throw new ParseError('ai', `AI 没能完整读懂第 ${batch.pages[0]} 页（已经自动重试过）；${RETRY_HINT}`, `第 ${batch.pages[0]} 页：${lastProblem || '模型输出不可用'}${lastDetail ? `；${lastDetail}` : ''}`)
  }

  for (let i = 0; i < plan.length; i++) await runBatch(plan[i], i + 1)
  return { state, batches: used, model: textModel, visionModel: used.some(u => u.mode === 'vision') ? cfg.vision_model : null }
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
  const pages = db.prepare('SELECT idx, image_rel, width, height, text_source, lines_json, text, ocr_conf, recognizer, ocr_lang, quality_json FROM pages WHERE paper_id = ? ORDER BY idx').all(paperId) as unknown as PageRow[]
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
  let usedModel = parseModelOf(cfg)
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
    usedModel = last.model || parseModelOf(cfg)
    version = last.prompt_version || ''
    usageNote = last.usage_json || ''
    notes = state.notes
    runId = last.id
    // 不改动被复用的那条运行的状态：重新定位若被取消/失败，题目没变，审核页顶栏仍应显示这条已完成的运行；成功时 saveResults 会更新它
  } else {
    const prepared = preparePages(pages, cfg, [paper.file_name ?? '', paper.title ?? ''])
    const usesVision = prepared.inputs.some(i => i.mode === 'vision')
    const usesText = prepared.inputs.some(i => i.mode === 'text')
    const parts = [usesText ? promptVersionFor('p1_text') : '', usesVision ? promptVersionFor('p1_vision') : ''].filter(Boolean)
    version = [...new Set(parts)].join(' / ')
    let prevAi: string[] = []
    try { prevAi = JSON.parse(paper.ai_meta_json || '[]') } catch { /* 忽略 */ }
    const known = knownMetaText(paper, prevAi)
    db.prepare('UPDATE parse_runs SET status = ? WHERE paper_id = ? AND status = ?').run('superseded', paperId, 'running')
    runId = Number(db.prepare('INSERT INTO parse_runs (paper_id, prompt_version, model, vision_model) VALUES (?, ?, ?, ?)')
      .run(paperId, version, parseModelOf(cfg), usesVision ? cfg.vision_model : null).lastInsertRowid)
    recordRecognition(paperId, pages, prepared)
    stage('ai', 8, '调用 AI 拆题与标注…')
    try {
      const r = await runAiStage(paperId, runId, paper.file_name, prepared, cfg, tax, known, ctx)
      recordRecognition(paperId, pages, prepared)   // 读图失败改用本机文字的页，记录要跟着改
      state = r.state
      usedModel = [r.batches.some(b => b.mode === 'text') ? parseModelOf(cfg) : '', r.visionModel ?? ''].filter(Boolean).join(' + ') || parseModelOf(cfg)
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
