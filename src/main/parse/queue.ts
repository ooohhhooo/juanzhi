/**
 * AI 解析队列：同时解析的试卷数 = 配置里的 concurrency（默认 2）；可全局暂停、单份取消；
 * 失败写 status='failed' + error_stage='parse'，页面数据保留，可从「AI 解析 / 重新定位」重试而不必重新提取。
 */
import { getDb } from '../db'
import { notifyDataChanged, sendProgress } from '../events'
import { loadConfig, isAiReady } from '../ai/config'
import { AiError } from '../ai/client'
import { friendlyAiError } from '../ai/friendly'
import { isQueuePaused, onResume } from '../pipeline/control'
import { parsePaper, ParseError } from './run'
import type { FromStage } from './run'
import type { JobProgress } from '../types'

interface Job {
  paperId: string
  fromStage?: FromStage
  ctl: AbortController
}

export interface ParseQueueState {
  waiting: Array<{ paperId: string; fromStage: FromStage | null }>
  running: Array<{ paperId: string; fromStage: FromStage | null; stage: string; progress: number; message: string }>
}

const waiting: Job[] = []
const running = new Map<string, Job>()
const lastProgress = new Map<string, JobProgress>()

export function isParseActive(paperId: string): boolean {
  return running.has(paperId) || waiting.some(j => j.paperId === paperId)
}

export function parseQueueState(): ParseQueueState {
  return {
    waiting: waiting.map(j => ({ paperId: j.paperId, fromStage: j.fromStage ?? null })),
    running: [...running.values()].map(j => {
      const p = lastProgress.get(j.paperId)
      return { paperId: j.paperId, fromStage: j.fromStage ?? null, stage: p?.stage ?? 'parse:prepare', progress: p?.progress ?? 0, message: p?.message ?? '' }
    })
  }
}

/** 加入解析队列；调用方负责检查 AI 已配置、试卷状态合适 */
export function enqueueParse(paperId: string, fromStage?: FromStage): void {
  if (isParseActive(paperId)) return
  waiting.push({ paperId, fromStage, ctl: new AbortController() })
  notifyDataChanged('queue')
  pump()
}

export function cancelParse(paperId: string): boolean {
  const wi = waiting.findIndex(j => j.paperId === paperId)
  if (wi >= 0) { waiting.splice(wi, 1); notifyDataChanged('queue'); return true }
  const job = running.get(paperId)
  if (job) { job.ctl.abort(); return true }
  return false
}

/** 给用户看的白话原因 + 技术详情（详情收在界面的「查看详情」里，不出现在主文案里） */
function userMessage(e: unknown): { message: string; detail: string } {
  if (e instanceof ParseError) return { message: e.message, detail: e.detail }
  if (e instanceof AiError) return friendlyAiError(e)
  return { message: '解析时出了点问题，可以点「重试」，多次失败请联系管理员', detail: (e as Error).message }
}

async function runJob(job: Job): Promise<void> {
  const db = getDb()
  const before = db.prepare('SELECT status, error, error_stage FROM papers WHERE id = ?').get(job.paperId) as any
  if (!before) return
  try {
    await parsePaper(job.paperId, job.fromStage, {
      signal: job.ctl.signal,
      onProgress: p => { lastProgress.set(p.paperId, p); sendProgress(p) }
    })
  } catch (e) {
    if (job.ctl.signal.aborted || (e instanceof AiError && e.code === 'aborted')) {
      // 用户取消：回到开始前的状态，不算失败
      db.prepare('UPDATE papers SET status = ?, error = ?, error_stage = ?, parse_stage = NULL WHERE id = ?')
        .run(before.status === 'parsing' ? 'extracted' : before.status, before.error, before.error_stage, job.paperId)
      db.prepare("UPDATE parse_runs SET status = 'cancelled', finished_at = datetime('now','localtime') WHERE paper_id = ? AND status IN ('running','ai_done')").run(job.paperId)
      sendProgress({ paperId: job.paperId, stage: 'cancelled', progress: 0, message: '已取消' })
    } else {
      const { message: msg, detail } = userMessage(e)
      console.warn(`[parse] 失败 ${job.paperId}: ${(e as Error).message}${detail ? ` | ${detail}` : ''}`)
      const stage = e instanceof ParseError ? e.stage : 'ai'
      db.prepare("UPDATE papers SET status = 'failed', error = ?, error_detail = ?, error_stage = 'parse', parse_stage = ? WHERE id = ?").run(msg, detail.slice(0, 1000) || null, stage, job.paperId)
      // 定位/入库阶段的失败也要把这次运行记为 failed（AI 阶段的失败 run.ts 里已经记过）
      db.prepare("UPDATE parse_runs SET status = 'failed', error = ?, finished_at = datetime('now','localtime') WHERE paper_id = ? AND status IN ('running','ai_done')")
        .run(`${msg}${detail ? ` | ${detail}` : ''}`.slice(0, 500), job.paperId)
      sendProgress({ paperId: job.paperId, stage: 'failed', progress: 0, message: msg })
    }
  } finally {
    running.delete(job.paperId)
    lastProgress.delete(job.paperId)
    notifyDataChanged('papers', 'questions', 'materials', 'queue', 'usage')
    pump()
  }
}

function pump(): void {
  if (isQueuePaused()) return
  const limit = loadConfig().concurrency
  while (running.size < limit && waiting.length > 0) {
    const job = waiting.shift()!
    running.set(job.paperId, job)
    notifyDataChanged('queue')
    void runJob(job)
  }
}

onResume(() => { pump(); notifyDataChanged('queue') })

/** 提取完成后的自动解析：已配置且打开了自动解析（或这份是用户要求「从头重试」的） */
export function maybeAutoParse(paperId: string, force: boolean): void {
  if (!isAiReady()) return
  if (!force && !loadConfig().auto_parse) return
  const row = getDb().prepare('SELECT status FROM papers WHERE id = ?').get(paperId) as { status: string } | undefined
  if (row?.status === 'extracted') enqueueParse(paperId)
}

/** 启动时：被中断的解析退回；有旧题目的回到待审核，否则回到已提取 */
export function recoverInterruptedParsing(): void {
  const db = getDb()
  const r = db.prepare(`
    UPDATE papers SET status = CASE WHEN EXISTS (SELECT 1 FROM questions q WHERE q.paper_id = papers.id) THEN 'reviewing' ELSE 'extracted' END,
      parse_stage = NULL WHERE status = 'parsing'
  `).run()
  db.prepare("UPDATE parse_runs SET status = 'interrupted', finished_at = datetime('now','localtime') WHERE status IN ('running','ai_done')").run()
  if (r.changes > 0) console.log(`[parse] 已把 ${r.changes} 份中断的解析退回`)
}
