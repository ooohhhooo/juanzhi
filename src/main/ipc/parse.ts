import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { isAiReady } from '../ai/config'
import { loadConfig } from '../ai/config'
import { enqueueParse, cancelParse, parseQueueState, isParseActive } from '../parse/queue'
import { reprocessPaper, extractQueueState } from '../pipeline/queue'
import { isQueuePaused, setQueuePaused } from '../pipeline/control'
import { notifyDataChanged } from '../events'

const UuidSchema = z.string().uuid()
// extract：连提取一起重做；ai：重新调用模型；locate：沿用上次 AI 结果，只重新定位
const StageSchema = z.enum(['extract', 'ai', 'locate'])

export function registerParseIpc(): void {
  ipcMain.handle('parse:start', async (_e, rawId: unknown, rawStage?: unknown) => {
    const id = UuidSchema.parse(rawId)
    const stage = rawStage === undefined || rawStage === null ? 'ai' : StageSchema.parse(rawStage)
    const db = getDb()
    const paper = db.prepare('SELECT status FROM papers WHERE id = ?').get(id) as { status: string } | undefined
    if (!paper) throw new Error('试卷不存在')
    if (['imported', 'extracting', 'parsing'].includes(paper.status) || isParseActive(id)) throw new Error('这份试卷正在处理中')
    // 「从头重试」先做的是提取，没配 AI 也能用（提取后是否接着解析由 maybeAutoParse 判断）；只有真要调模型的阶段才检查
    if (stage === 'ai' && !isAiReady()) throw new Error('尚未配置 AI 服务：请先到「设置 → AI 服务」填写 Base URL、模型和 API Key')

    if (stage === 'extract') { reprocessPaper(id, true); return true }
    const pageCount = (db.prepare('SELECT COUNT(*) c FROM pages WHERE paper_id = ?').get(id) as { c: number }).c
    if (pageCount === 0) throw new Error('这份试卷还没有提取出页面，请选择「从头重试（重新提取）」')
    enqueueParse(id, stage === 'locate' ? 'locate' : undefined)
    notifyDataChanged('papers', 'queue')
    return true
  })

  ipcMain.handle('parse:cancel', async (_e, rawId: unknown) => cancelParse(UuidSchema.parse(rawId)))

  ipcMain.handle('queue:state', async () => ({
    paused: isQueuePaused(),
    concurrency: loadConfig().concurrency,
    aiReady: isAiReady(),
    extract: extractQueueState(),
    parse: parseQueueState()
  }))

  ipcMain.handle('queue:pause', async () => { setQueuePaused(true); notifyDataChanged('queue'); return true })
  ipcMain.handle('queue:resume', async () => { setQueuePaused(false); notifyDataChanged('queue'); return true })
}
