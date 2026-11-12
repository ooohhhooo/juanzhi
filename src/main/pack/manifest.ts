import { z } from 'zod'

export const PACK_FORMAT = 'ewb-pack'
/**
 * 数据包格式版本：1 = 只有 db.sqlite + files/；2 = 另带 extras/（数据页表格 / 文档、Skill、角色）或 courseware/（机构课件文字）。
 * 没有 extras 的包仍然写 1，旧版本软件照样能导入；带 extras 的包写 2，旧版本软件会拒绝（它不认识 extras/ 里的文件）。
 */
export const PACK_FORMAT_VERSION = 2
export const PACK_BASE_VERSION = 1

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
  platform: z.string().max(20).optional(),
  /** 随包带的课程体系个数 / 导出时有没有勾选「带课程大纲」（旧版本的包没有这两项） */
  courseCount: z.number().int().min(0).max(100000).optional(),
  courseIncluded: z.boolean().optional(),
  /** 导出时选了哪些内容（旧版本的包没有：按「试卷、报告、课程全带」处理） */
  contents: z.object({
    papers: z.boolean(), reports: z.boolean(), course: z.boolean(), datasets: z.boolean(), documents: z.boolean(), assets: z.boolean(), chats: z.boolean()
  }).partial().optional(),
  /** 范围：学科（all = 全部）/ 是否只导了选中的卷子 */
  scope: z.object({ subject: z.string().max(20).optional(), selectedPapers: z.boolean().optional() }).optional(),
  /** 各项数量（界面和导入摘要用） */
  counts: z.object({
    reports: z.number().int().min(0).max(10_000_000), datasets: z.number().int().min(0).max(100000), documents: z.number().int().min(0).max(100000),
    skills: z.number().int().min(0).max(100000), courseware: z.number().int().min(0).max(10_000_000), roles: z.number().int().min(0).max(100000), chats: z.number().int().min(0).max(10_000_000)
  }).partial().optional()
}).passthrough()

export type Manifest = z.infer<typeof ManifestSchema>

/** 被打进包里的 settings 键（白名单）。AI 配置、密钥密文、数据目录、onboarding 状态等都属于这台电脑，不进包 */
export const PACK_SETTING_KEYS = ['ai_prompts', 'ai_prompt_bases', 'ui_theme', 'ui_language', 'default_textbook', 'default_textbook.chinese', 'default_textbook.math'] as const
export const isPackSettingKey = (k: string): boolean => (PACK_SETTING_KEYS as readonly string[]).includes(k)

/** 导出时的选择。默认值：试卷、报告、课程大纲带；数据页表格 / 文档、助手的 Skill / 角色、助手对话记录不带 */
export interface ExportSelection {
  /** 'all' 或某个学科 id */
  subject: string
  /** 只导这些卷子（试卷库里选中的）；有值时 subject 不起作用，报告不带 */
  paperIds?: string[]
  papers: boolean
  reports: boolean
  course: boolean
  datasets: boolean
  documents: boolean
  assets: boolean
  chats: boolean
}
export const DEFAULT_SELECTION: ExportSelection = { subject: 'all', papers: true, reports: true, course: true, datasets: false, documents: false, assets: false, chats: false }
export const isPartialScope = (m: { scope?: { subject?: string; selectedPapers?: boolean }; contents?: { papers?: boolean; reports?: boolean } }): boolean =>
  !!m.scope?.selectedPapers || (!!m.scope?.subject && m.scope.subject !== 'all') || m.contents?.papers === false || m.contents?.reports === false
