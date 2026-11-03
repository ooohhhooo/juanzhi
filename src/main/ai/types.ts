import { z } from 'zod'

/** 设置页保存的 AI 配置（不含密钥；密钥单独加密存放，渲染端读不回） */
export const AiConfigSchema = z.object({
  provider: z.string().min(1).max(40),
  base_url: z.string().max(300),
  /** 写报告 / 做分析用的模型（1.2.1 的「文本模型」，名字沿用 model 以便旧配置、命令行和数据包照旧） */
  model: z.string().max(120),
  /** 拆题用的模型；空 = 与上面的 model 相同（旧配置没有这一项，读取时就是空，行为和 1.2.1 完全一致） */
  parse_model: z.string().max(120).default(''),
  vision_model: z.string().max(120),
  /** 视觉模型自己的服务地址；空 = 与文本模型相同（密钥另存一个加密槽，空 = 同一把） */
  vision_base_url: z.string().max(300).default(''),
  /**
   * 什么时候让 AI 读图：auto（默认）= 本机识别不好的页才读图；images_always = 图片和扫描件一律读图（页面图会发给服务商）；never = 从不读图
   */
  vision_policy: z.enum(['auto', 'images_always', 'never']).default('auto'),
  /** 同时解析几份试卷（1–16；遇到服务商限流时队列会自动放慢，见 parse/queue.ts） */
  concurrency: z.number().int().min(1).max(16),
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

/** 拆题实际用的模型：没单独设置就用「写报告用的模型」 */
export function parseModelOf(cfg: Pick<AiConfig, 'model' | 'parse_model'>): string {
  return cfg.parse_model.trim() || cfg.model
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  parse_model: '',
  vision_model: 'deepseek-flash',
  vision_base_url: '',
  vision_policy: 'auto',
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
  /** 视觉模型是否单独存了密钥（没有 = 沿用文本模型的密钥） */
  hasVisionKey: boolean
}

/** p3_report 是「完整数据版」（沿用 id，旧的自定义提示词和历史报告照旧）；p3_boss / p3_parent / p3_teacher 是另外三个读者的版本 */
export const PROMPT_IDS = ['p1_text', 'p1_vision', 'p2_yoy', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p2_kp', 'p3_tricks', 'p4_variant_gen', 'p4_variant_check', 'p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint', 'p5_course_extract', 'p6_classify_propose', 'p6_classify_assign'] as const
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
  /** 内置默认版的版本号（升过版的提示词各自标注，如老师版 v3.0） */
  version: string
  /** 用户自定义过、而内置默认版之后又升级了：提示词页标「默认版已更新，可对比」；他自己的版本保持不变 */
  defaultUpdated: boolean
  /** 本提示词当前会被使用（P2/P3 要到后续里程碑才用） */
  usedInM2: boolean
}
