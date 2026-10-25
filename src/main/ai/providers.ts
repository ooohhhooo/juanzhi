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
