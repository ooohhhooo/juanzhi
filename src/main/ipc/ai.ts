import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../db'
import { PROVIDER_PRESETS, modelProfile } from '../ai/providers'
import { AiConfigSchema, PROMPT_IDS } from '../ai/types'
import { configView, saveConfig, testConnection, testAll, loadConfig } from '../ai/config'
import { parseModelOf } from '../ai/types'
import { judgeModelHint } from '../parse/model-hint'
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

  ipcMain.handle('ai:saveConfig', async (_e, rawCfg: unknown, rawKey?: unknown, rawVisionKey?: unknown) => {
    const cfg = AiConfigSchema.parse(rawCfg)
    const key = rawKey === undefined ? undefined : z.string().max(500).nullable().parse(rawKey)
    const visionKey = rawVisionKey === undefined ? undefined : z.string().max(500).nullable().parse(rawVisionKey)
    const view = saveConfig(cfg, key, visionKey)
    notifyDataChanged('aiConfig', 'queue')
    return view
  })

  ipcMain.handle('ai:test', async (_e, raw: unknown) => {
    const p = z.object({
      kind: z.enum(['text', 'vision']),
      cfg: AiConfigSchema.partial().optional(),
      apiKey: z.string().max(500).optional(),
      visionKey: z.string().max(500).optional()
    }).parse(raw)
    const r = await testConnection(p.kind, { cfg: p.cfg, apiKey: p.apiKey, visionKey: p.visionKey })
    notifyDataChanged('usage')
    return r
  })

  // 「测试全部」：依次测拆题模型、写报告模型、视觉模型（会写 ai_usage，归写入类）。用界面上还没保存的值测
  ipcMain.handle('ai:testAll', async (_e, raw: unknown) => {
    const p = z.object({
      cfg: AiConfigSchema.partial().optional(),
      apiKey: z.string().max(500).optional(),
      visionKey: z.string().max(500).optional()
    }).parse(raw ?? {})
    const r = await testAll({ cfg: p.cfg, apiKey: p.apiKey, visionKey: p.visionKey })
    notifyDataChanged('usage')
    return r
  })

  // 拆题模型反复写不完时的提示（只读；看最近 10 个批次）。只提示、不自动切换
  ipcMain.handle('ai:modelHint', async () => {
    const cfg = loadConfig()
    const model = parseModelOf(cfg)
    const db = getDb()
    const rows = db.prepare("SELECT truncated, escalated, ms FROM parse_batches WHERE model = ? AND mode = 'text' ORDER BY id DESC LIMIT 10").all(model) as Array<{ truncated: number; escalated: number; ms: number | null }>
    const dismissed = !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`parse_hint_off:${model}`)
    const v = judgeModelHint(rows)
    const preset = PROVIDER_PRESETS.find(x => x.id === cfg.provider)
    return { ...v, suggest: v.suggest && !dismissed, model, reasoning: modelProfile(model).reasoning, recommend: preset?.parseModel || null }
  })

  // 「以后不再提示」：记在设置表里，只对这个拆题模型生效
  ipcMain.handle('ai:dismissModelHint', async () => {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(`parse_hint_off:${parseModelOf(loadConfig())}`, 'true')
    return true
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
