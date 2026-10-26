import { z } from 'zod'

export const PACK_FORMAT = 'ewb-pack'
export const PACK_FORMAT_VERSION = 1

export const ManifestSchema = z.object({
  format: z.literal(PACK_FORMAT),
  formatVersion: z.number().int().min(1).max(1000),
  /** 数据库的 schema 版本（PRAGMA user_version） */
  schemaVersion: z.number().int().min(1).max(10_000),
  appVersion: z.string().max(40),
  exportedAt: z.string().max(40),
  paperCount: z.number().int().min(0).max(10_000_000),
  questionCount: z.number().int().min(0).max(100_000_000),
  pageCount: z.number().int().min(0).max(100_000_000).optional(),
  fileCount: z.number().int().min(0).max(100_000_000).optional(),
  platform: z.string().max(20).optional()
}).passthrough()

export type Manifest = z.infer<typeof ManifestSchema>

/** 被打进包里的 settings 键（白名单）。AI 配置、密钥密文、数据目录、onboarding 状态等都属于这台电脑，不进包 */
export const PACK_SETTING_KEYS = ['ai_prompts', 'ui_theme', 'ui_language', 'default_textbook'] as const
export const isPackSettingKey = (k: string): boolean => (PACK_SETTING_KEYS as readonly string[]).includes(k)
