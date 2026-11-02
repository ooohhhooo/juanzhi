import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { isAiReady } from '../ai/config'
import { loadConfig } from '../ai/config'
import { enqueueParse, cancelParse, parseQueueState, isParseActive, throttleState } from '../parse/queue'
import { isPowerBlocking } from '../power'
import { reprocessPaper, extractQueueState } from '../pipeline/queue'
import { isQueuePaused, setQueuePaused } from '../pipeline/control'
import { notifyDataChanged } from '../events'
import { BatchIdsSchema } from '../types'
import type { BatchItemResult } from '../types'

const UuidSchema = z.string().uuid()
// extract：连提取一起重做；ai：重新调用模型；locate：沿用上次 AI 结果，只重新定位
const StageSchema = z.enum(['extract', 'ai', 'locate'])

/** 把一份试卷加入解析 / 提取队列；不合适就抛带白话原因的错（单份和批量共用） */
function startOne(id: string, stage: z.infer<typeof StageSchema>, batch = false): void {
  const db = getDb()
  const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(id) as { status: string } | undefined
  if (!paper) throw new Error('试卷不存在')
  if (['imported', 'extracting', 'parsing'].includes(paper.status) || isParseActive(id)) throw new Error('这份试卷正在处理中')
  // 「从头重试」先做的是提取，没配 AI 也能用（提取后是否接着解析由 maybeAutoParse 判断）；只有真要调模型的阶段才检查
  if (stage === 'ai' && !isAiReady()) throw new Error('尚未配置 AI 服务：请先到「设置 → AI 服务」填写 Base URL、模型和 API Key')

  if (stage === 'extract') { reprocessPaper(id, true); return }
  const pageCount = (db.prepare('SELECT COUNT(*) c FROM pages WHERE paper_id = ?').get(id) as { c: number }).c
  if (pageCount === 0) throw new Error(batch ? '这份还没提取出页面，请单独打开它重试' : '这份试卷还没有提取出页面，请选择「从头重试（重新提取）」')
  enqueueParse(id, stage === 'locate' ? 'locate' : undefined)
  notifyDataChanged('papers', 'queue')
}

export function registerParseIpc(): void {
  ipcMain.handle('parse:start', async (_e, rawId: unknown, rawStage?: unknown) => {
    const id = UuidSchema.parse(rawId)
    const stage = rawStage === undefined || rawStage === null ? 'ai' : StageSchema.parse(rawStage)
    startOne(id, stage)
    return true
  })

  /**
   * 批量重新解析：逐份走和单份同一条路径（startOne），每份一个结果。
   * 没配 AI 整批直接拒绝（和单份一样）；正在处理的、还没提取出页面的试卷跳过并写明原因。
   * 同时解析几份由队列按设置里的并发数控制，这里只负责排队。
   */
  ipcMain.handle('parse:batchStart', async (_e, rawIds: unknown) => {
    const ids = BatchIdsSchema.parse(rawIds)
    if (!isAiReady()) throw new Error('尚未配置 AI 服务：请先到「设置 → AI 服务」填写 Base URL、模型和 API Key')
    const out: BatchItemResult[] = []
    for (let i = 0; i < ids.length; i++) {
      try { startOne(ids[i], 'ai', true); out.push({ id: ids[i], ok: true }) } catch (e) { out.push({ id: ids[i], ok: false, reason: (e as Error).message }) }
      if (i % 100 === 99) await new Promise<void>(r => setImmediate(r))   // 大批量时让出主进程
    }
    return out
  })

  ipcMain.handle('parse:cancel', async (_e, rawId: unknown) => cancelParse(UuidSchema.parse(rawId)))

  ipcMain.handle('queue:state', async () => ({
    paused: isQueuePaused(),
    concurrency: loadConfig().concurrency,
    throttle: throttleState(),
    power: isPowerBlocking(),
    aiReady: isAiReady(),
    extract: extractQueueState(),
    parse: parseQueueState()
  }))

  ipcMain.handle('queue:pause', async () => { setQueuePaused(true); notifyDataChanged('queue'); return true })
  ipcMain.handle('queue:resume', async () => { setQueuePaused(false); notifyDataChanged('queue'); return true })
}
