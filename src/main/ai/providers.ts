/**
 * AI 服务预设（OpenAI 兼容接口）。用户可以改 base_url / 模型名；预设只是省去手填。
 * 模型名会随服务商迭代，这里给的是写代码时的推荐值，设置页提示「以服务商控制台为准」。
 * 注意：DeepSeek 已在 2026-07 下线 deepseek-chat，不能再当默认值。
 */

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  /** 文本解析用的模型 */
  model: string
  /** 能看图的模型；空字符串 = 该服务商没有合适的默认视觉模型，需用户自己填 */
  visionModel: string
  /** 申请密钥的页面，仅作提示文字 */
  keyHint: string
  models: string[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro', visionModel: 'deepseek-flash',
    keyHint: 'platform.deepseek.com', models: ['deepseek-v4-pro', 'deepseek-flash']
  },
  {
    id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus', visionModel: 'qwen3-vl-plus',
    keyHint: 'bailian.console.aliyun.com', models: ['qwen-plus', 'qwen-max', 'qwen3-vl-plus']
  },
  {
    id: 'doubao', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-250615', visionModel: 'doubao-seed-1-6-vision-250815',
    keyHint: 'console.volcengine.com/ark（模型名可填推理接入点 ID：ep-…）', models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-vision-250815']
  },
  {
    id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview', visionModel: 'moonshot-v1-32k-vision-preview',
    keyHint: 'platform.moonshot.cn', models: ['kimi-k2-0905-preview', 'moonshot-v1-32k-vision-preview']
  },
  {
    id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6', visionModel: 'glm-4.6v',
    keyHint: 'open.bigmodel.cn', models: ['glm-4.6', 'glm-4.6v']
  },
  {
    id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '', visionModel: '',
    keyHint: '任何兼容 /chat/completions 的服务，如本地 Ollama、中转服务', models: []
  }
]

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id)
}

/**
 * 模型档案（M6）：推理模型会先「思考」再作答，思考内容（reasoning_content）也占输出额度，所以默认输出上限要大得多。
 *  - reasoning：是推理模型（流里会有 reasoning_content，界面显示「AI 正在思考」）；
 *  - defaultMaxTokens：设置里选「自动」时发给服务商的 max_tokens；
 *  - ceiling：这个模型一次最多能写多长；遇到「写不完」自动翻倍重试时不会超过它（超过服务商上限会被直接拒绝）。
 * 预设里列出的模型按表走；表里没有的（自定义服务商 / 新模型）按名字猜：名字里有 reason / think / r1 / qwq / v4 的当推理模型。
 */
export interface ModelProfile { reasoning: boolean; defaultMaxTokens: number; ceiling: number }

export const REASONING_DEFAULT_MAX_TOKENS = 32768
export const PLAIN_DEFAULT_MAX_TOKENS = 8192
/** 旧版本的默认值：设置里等于它的，视为「用户没改过」，迁移成新默认（见 db.ts v10） */
export const LEGACY_DEFAULT_MAX_TOKENS = 8192

const KNOWN_MODELS: Record<string, ModelProfile> = {
  'deepseek-v4-pro': { reasoning: true, defaultMaxTokens: 32768, ceiling: 65536 },
  'deepseek-flash': { reasoning: true, defaultMaxTokens: 32768, ceiling: 65536 },
  'qwen-plus': { reasoning: false, defaultMaxTokens: 8192, ceiling: 8192 },
  'qwen-max': { reasoning: false, defaultMaxTokens: 8192, ceiling: 8192 },
  'qwen3-vl-plus': { reasoning: true, defaultMaxTokens: 16384, ceiling: 32768 },
  'doubao-seed-1-6-250615': { reasoning: true, defaultMaxTokens: 16384, ceiling: 32768 },
  'doubao-seed-1-6-vision-250815': { reasoning: true, defaultMaxTokens: 16384, ceiling: 32768 },
  'kimi-k2-0905-preview': { reasoning: false, defaultMaxTokens: 8192, ceiling: 16384 },
  'moonshot-v1-32k-vision-preview': { reasoning: false, defaultMaxTokens: 8192, ceiling: 8192 },
  'glm-4.6': { reasoning: true, defaultMaxTokens: 32768, ceiling: 65536 },
  'glm-4.6v': { reasoning: true, defaultMaxTokens: 16384, ceiling: 32768 }
}
const REASONING_NAME_RE = /reason|think|(^|[-_/])r1($|[-_])|qwq|(^|[-_/])o[134]($|[-_])|deepseek-v\d|deepseek-flash/i

export function modelProfile(model: string): ModelProfile {
  const m = model.trim().toLowerCase()
  const known = KNOWN_MODELS[m]
  if (known) return known
  if (REASONING_NAME_RE.test(m)) return { reasoning: true, defaultMaxTokens: REASONING_DEFAULT_MAX_TOKENS, ceiling: 65536 }
  return { reasoning: false, defaultMaxTokens: PLAIN_DEFAULT_MAX_TOKENS, ceiling: PLAIN_DEFAULT_MAX_TOKENS }
}

/**
 * 一次调用实际用的输出上限、天花板和「被拒绝时的安全值」：
 *  - 「自动」（max_tokens_auto，默认开）：取该模型的默认值；写不完时可以翻倍到模型天花板；
 *    名字猜错、首个请求被服务商拒绝（400）时降到 fallback 重试一次；
 *  - 手动：用设置里的数，**永远不翻倍、不降级**（ceiling = 手填值，fallback 为空）——管理员明确要的数，程序不替他改。
 */
export function effectiveMaxTokens(cfg: { max_tokens: number; max_tokens_auto?: boolean }, model: string): { maxTokens: number; ceiling: number; auto: boolean; fallback: number | undefined } {
  const prof = modelProfile(model)
  const auto = cfg.max_tokens_auto !== false
  if (!auto) return { maxTokens: cfg.max_tokens, ceiling: cfg.max_tokens, auto: false, fallback: undefined }
  return { maxTokens: prof.defaultMaxTokens, ceiling: prof.ceiling, auto: true, fallback: prof.defaultMaxTokens > PLAIN_DEFAULT_MAX_TOKENS ? PLAIN_DEFAULT_MAX_TOKENS : undefined }
}
