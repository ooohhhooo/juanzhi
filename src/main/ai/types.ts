import { z } from 'zod'

/** 设置页保存的 AI 配置（不含密钥；密钥单独加密存放，渲染端读不回） */
export const AiConfigSchema = z.object({
  provider: z.string().min(1).max(40),
  base_url: z.string().max(300),
  model: z.string().max(120),
  vision_model: z.string().max(120),
  /** 同时解析几份试卷（1–4） */
  concurrency: z.number().int().min(1).max(4),
  /** 提取完成后是否自动开始 AI 解析（需已配置） */
  auto_parse: z.boolean(),
  /** 高级：单批最多几页 / 单次请求超时秒数 / 输出上限 */
  batch_pages: z.number().int().min(1).max(10),
  timeout_sec: z.number().int().min(2).max(600),
  max_tokens: z.number().int().min(1000).max(131072),
  /** 输出上限「自动」（默认）：按所选模型取默认值（推理模型更大），换模型自动跟着变；关掉后才用上面手填的 max_tokens */
  max_tokens_auto: z.boolean().default(true)
})

export type AiConfig = z.infer<typeof AiConfigSchema>

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  vision_model: 'deepseek-flash',
  concurrency: 2,
  auto_parse: true,
  batch_pages: 3,
  timeout_sec: 180,
  max_tokens: 32768,
  max_tokens_auto: true
}

/** 渲染端能拿到的配置视图：只有「是否已保存密钥」，没有密钥本身 */
export interface AiConfigView extends AiConfig {
  hasKey: boolean
  /** encrypted：已用系统钥匙串加密落盘；memory：系统不支持加密，仅本次运行有效；none：未设置 */
  keyStorage: 'encrypted' | 'memory' | 'none'
}

/** p3_report 是「完整数据版」（沿用 id，旧的自定义提示词和历史报告照旧）；p3_boss / p3_parent / p3_teacher 是另外三个读者的版本 */
export const PROMPT_IDS = ['p1_text', 'p1_vision', 'p2_yoy', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p2_kp'] as const
export type PromptId = (typeof PROMPT_IDS)[number]
export type PromptPart = 'system' | 'user'

export interface PromptView {
  id: PromptId
  part: PromptPart
  title: string
  text: string
  defaultText: string
  isCustom: boolean
  /** 提示词里出现了程序不认识的 {{占位符}}（拼错名字） */
  unknownPlaceholders: string[]
  /** 本提示词当前会被使用（P2/P3 要到后续里程碑才用） */
  usedInM2: boolean
}
