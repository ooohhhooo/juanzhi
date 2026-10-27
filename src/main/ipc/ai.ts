import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { PROVIDER_PRESETS, modelProfile } from '../ai/providers'
import { AiConfigSchema, PROMPT_IDS } from '../ai/types'
import { configView, saveConfig, testConnection } from '../ai/config'
import { promptViews, savePrompt, resetPrompt, PROMPT_DEFAULT_VERSION } from '../ai/prompts'
import { notifyDataChanged } from '../events'

const PromptIdSchema = z.enum(PROMPT_IDS)
const PartSchema = z.enum(['system', 'user'])

export function registerAiIpc(): void {
  // 每个预设带上各模型的档案（是不是推理模型、默认输出上限、天花板），设置页「自动」模式据此说明
  ipcMain.handle('ai:presets', async () => PROVIDER_PRESETS.map(p => ({ ...p, profiles: Object.fromEntries([...new Set([p.model, p.visionModel, ...p.models].filter(Boolean))].map(m => [m, modelProfile(m)])) })))
  ipcMain.handle('ai:modelProfile', async (_e, raw: unknown) => modelProfile(z.string().max(120).parse(raw)))

  // 渲染端只能拿到 hasKey，拿不到密钥本身
  ipcMain.handle('ai:getConfig', async () => configView())

  ipcMain.handle('ai:saveConfig', async (_e, rawCfg: unknown, rawKey?: unknown) => {
    const cfg = AiConfigSchema.parse(rawCfg)
    const key = rawKey === undefined ? undefined : z.string().max(500).nullable().parse(rawKey)
    const view = saveConfig(cfg, key)
    notifyDataChanged('aiConfig', 'queue')
    return view
  })

  ipcMain.handle('ai:test', async (_e, raw: unknown) => {
    const p = z.object({
      kind: z.enum(['text', 'vision']),
      cfg: AiConfigSchema.partial().optional(),
      apiKey: z.string().max(500).optional()
    }).parse(raw)
    const r = await testConnection(p.kind, { cfg: p.cfg, apiKey: p.apiKey })
    notifyDataChanged('usage')
    return r
  })

  ipcMain.handle('ai:prompts', async () => ({ defaultVersion: PROMPT_DEFAULT_VERSION, items: promptViews() }))

  ipcMain.handle('ai:savePrompt', async (_e, id: unknown, part: unknown, text: unknown) => {
    savePrompt(PromptIdSchema.parse(id), PartSchema.parse(part), z.string().parse(text))
    notifyDataChanged('prompts')
    return true
  })

  ipcMain.handle('ai:resetPrompt', async (_e, id: unknown, part: unknown) => {
    resetPrompt(PromptIdSchema.parse(id), PartSchema.parse(part))
    notifyDataChanged('prompts')
    return true
  })

  /** token 用量：按模型汇总，另给出每份试卷的合计 */
  ipcMain.handle('ai:usage', async (_e, rawPaperId?: unknown) => {
    const db = getDb()
    if (rawPaperId !== undefined) {
      const id = z.string().uuid().parse(rawPaperId)
      return db.prepare(`SELECT model, COUNT(*) calls, SUM(prompt_tokens) prompt, SUM(completion_tokens) completion, SUM(cached_tokens) cached
        FROM ai_usage WHERE paper_id = ? GROUP BY model`).all(id)
    }
    return db.prepare(`SELECT model, COUNT(*) calls, SUM(prompt_tokens) prompt, SUM(completion_tokens) completion, SUM(cached_tokens) cached,
      SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed FROM ai_usage GROUP BY model ORDER BY calls DESC`).all()
  })
}
