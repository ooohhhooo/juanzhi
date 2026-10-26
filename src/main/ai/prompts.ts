/**
 * 提示词管理：内置默认值来自 docs/prompts/v1-sonnet改写.md（scripts/extract-prompts.cjs 抽成 prompts/*.txt 资源文件），
 * 用户可在设置里改写；改写后的文本存在 settings.ai_prompts（id.part → 文本）。每次解析都记录用的是哪个版本。
 */
import crypto from 'node:crypto'
import { getDb } from '../db'
import { unknownPlaceholders } from '../parse/batch'
import { promptProblem, sanitizeOverrides } from './prompt-rules'
import type { PromptId, PromptPart, PromptView } from './types'
import { PROMPT_IDS } from './types'
import p1TextSystem from './prompts/p1_text.system.txt?raw'
import p1TextUser from './prompts/p1_text.user.txt?raw'
import p1VisionSystem from './prompts/p1_vision.system.txt?raw'
import p1VisionUser from './prompts/p1_vision.user.txt?raw'
import p2System from './prompts/p2_yoy.system.txt?raw'
import p2User from './prompts/p2_yoy.user.txt?raw'
import p3System from './prompts/p3_report.system.txt?raw'
import p3User from './prompts/p3_report.user.txt?raw'

/** 内置提示词的版本号；改了资源文件就要同步提升，并在交付说明里记一笔 */
export const PROMPT_DEFAULT_VERSION = 'v1.1'
const SETTINGS_KEY = 'ai_prompts'

// 资源文件末尾有换行（便于编辑器查看），发给模型前去掉，保证与 docs 里的提示词正文逐字一致
// （含 \r：Windows 上若被 git 转成 CRLF，也不能让 \r 进到发给模型的文本里）
const trimEnd = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '')
const DEFAULTS: Record<string, string> = {
  'p1_text.system': trimEnd(p1TextSystem), 'p1_text.user': trimEnd(p1TextUser),
  'p1_vision.system': trimEnd(p1VisionSystem), 'p1_vision.user': trimEnd(p1VisionUser),
  'p2_yoy.system': trimEnd(p2System), 'p2_yoy.user': trimEnd(p2User),
  'p3_report.system': trimEnd(p3System), 'p3_report.user': trimEnd(p3User)
}

const TITLES: Record<PromptId, string> = {
  p1_text: 'P1 解析（文本版）：OCR 文本 → 题目清单',
  p1_vision: 'P1 解析（视觉版）：页面图片 → 题目清单',
  p2_yoy: 'P2 年度变化分析',
  p3_report: 'P3 考情分析报告'
}

const P1_COMMON = ['KNOWLEDGE_TREE', 'QUESTION_TYPES', 'FILE_NAME', 'KNOWN_META', 'BATCH_INFO', 'BATCH_PREFIX', 'PREV_CONTEXT']
export const PLACEHOLDERS: Record<PromptId, string[]> = {
  p1_text: [...P1_COMMON, 'OCR_TEXT'],
  p1_vision: [...P1_COMMON, 'PAGE_LIST'],
  p2_yoy: ['FILTER_DESC', 'TARGET_YEAR', 'TARGET_PAPERS', 'BASE_YEARS', 'BASE_PAPERS', 'TARGET_TEXTBOOKS', 'BASE_TEXTBOOKS', 'SAMPLE_WARNING', 'ADDED', 'REMOVED', 'CHANGED', 'HOT'],
  p3_report: ['FILTER_DESC', 'PAPER_COUNT', 'QUESTION_COUNT', 'YEARS', 'SAMPLE_WARNING', 'KP_DIST', 'QTYPE_DIST', 'DIFF_DIST', 'ERROR_PRONE', 'YEAR_DIFF']
}
function overrides(): Record<string, string> {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
  if (!row) return {}
  // 读到的可能是坏数据（手工改库、被破坏的数据包）：不是纯对象 / 值不是文本的一律当没有，回退内置默认，不让提示词读写报错
  try { return sanitizeOverrides(JSON.parse(row.value_json)) } catch { return {} }
}

function writeOverrides(o: Record<string, string>): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(o))
}

export function promptText(id: PromptId, part: PromptPart): string {
  const k = `${id}.${part}`
  return overrides()[k] ?? DEFAULTS[k]
}

export function promptViews(): PromptView[] {
  const o = overrides()
  const views: PromptView[] = []
  for (const id of PROMPT_IDS) {
    for (const part of ['system', 'user'] as PromptPart[]) {
      const k = `${id}.${part}`
      const text = o[k] ?? DEFAULTS[k]
      views.push({
        id, part, title: TITLES[id], text, defaultText: DEFAULTS[k], isCustom: o[k] !== undefined && o[k] !== DEFAULTS[k],
        unknownPlaceholders: unknownPlaceholders(text, PLACEHOLDERS[id]), usedInM2: true   // 字段名沿用旧的；含义是「当前版本会被用到」：P1 两版（M2）、P2（M3）、P3（M4）现在都用
      })
    }
  }
  return views
}

export function savePrompt(id: PromptId, part: PromptPart, text: string): void {
  const k = `${id}.${part}`
  const bad = promptProblem(k, text)
  if (bad) throw new Error(bad === '提示词不能为空' ? '提示词不能为空；想恢复内置版本请点「恢复默认」' : bad.startsWith('P1 的 system') ? 'P1 的 system 提示词里必须出现「JSON」字样（服务商的 JSON 模式要求提示词里提到 json），请保留原有的输出格式说明' : bad)
  const o = overrides()
  if (text === DEFAULTS[k]) delete o[k]
  else o[k] = text
  writeOverrides(o)
}

export function resetPrompt(id: PromptId, part: PromptPart): void {
  const o = overrides()
  delete o[`${id}.${part}`]
  writeOverrides(o)
}

/** 本次解析使用的提示词版本：全是内置 → "v1"；有改写 → "v1+自定义·<哈希前 6 位>"，同一份改写得到同一个标识 */
export function promptVersionFor(id: PromptId): string {
  const o = overrides()
  const custom = (['system', 'user'] as PromptPart[]).map(p => o[`${id}.${p}`]).filter((t, i) => {
    const k = `${id}.${(['system', 'user'] as PromptPart[])[i]}`
    return t !== undefined && t !== DEFAULTS[k]
  })
  if (custom.length === 0) return PROMPT_DEFAULT_VERSION
  const h = crypto.createHash('sha256').update((['system', 'user'] as PromptPart[]).map(p => promptText(id, p)).join('\u0000')).digest('hex').slice(0, 6)
  return `${PROMPT_DEFAULT_VERSION}+自定义·${h}`
}
