/**
 * 一个角色最终能用哪些工具（纯函数，单测直接加载），以及「其他身份能做什么」的提示。
 * 发给模型的工具清单只含这里算出来的名单（harness 再按名单过滤一次，名单外的调用一律拒绝）。
 */
import { CONNECTOR_ROLES } from './roles.ts'
import type { RoleDef } from './roles.ts'
import type { Scene } from './types.ts'

/**
 * 老版本留下的自建 / 导入角色文件里没有后来才加的工具：只对自建角色补上，免得老角色突然少功能。
 * 内置角色的名单是明确写出来的，不再偷偷补。
 */
function legacyExtras(role: RoleDef): string[] {
  if (!role.custom) return []
  const t = role.tools
  return [
    'history_search', 'history_read', 'delegate_tasks',
    ...(t.includes('list_datasets') ? ['read_document'] : []),
    ...(t.some(x => x === 'doc_create' || x === 'list_datasets' || x === 'stats_overview') ? ['card_templates', 'card_make'] : []),
    ...(t.includes('stats_overview') ? ['papers_list', 'course_coverage', 'reports_list', 'report_read', 'report_generate', 'paper_import'] : [])
  ]
}

/** service 里「动态工具」名单除了外部（MCP）工具，还夹着这两个固定工具；它们按角色名单给，不跟着外部工具走 */
const NOT_EXTERNAL = new Set(['report_generate', 'paper_import'])
const externalOnly = (names: string[]): string[] => names.filter(n => !NOT_EXTERNAL.has(n))

/** @param connectorTools 动态工具名（用户配置的外部 MCP 工具等）；只有运营 / 辅导老师能用其中的外部工具 */
export function roleToolNames(role: RoleDef, connectorTools: string[] = []): string[] {
  return [...new Set([...role.tools, ...legacyExtras(role), ...(CONNECTOR_ROLES.includes(role.id) ? externalOnly(connectorTools) : [])])]
}

/** 工具 → 一小段白话能力（给「其他身份能做什么」用）；没列的工具不进提示 */
const CAPABILITY: Array<{ tools: string[]; text: string }> = [
  { tools: ['wecom_send'], text: '发到企业微信' },
  { tools: ['list_datasets', 'run_query'], text: '分析导入的数据表' },
  { tools: ['board_start'], text: '做分析看板' },
  { tools: ['stat_nps'], text: '满意度 / 统计分析' },
  { tools: ['text_classify'], text: '文字归类' },
  { tools: ['research_table', 'textbook_locate'], text: '教研对照表、教材定位' },
  { tools: ['courseware_read'], text: '读课件' },
  { tools: ['lesson_kps'], text: '备课（查某一节的知识点和例题）' },
  { tools: ['card_make'], text: '做分享卡片' },
  { tools: ['report_generate'], text: '生成考情报告' },
  { tools: ['paper_import'], text: '导入试卷' },
  { tools: ['doc_create'], text: '写文档、存表格' },
  { tools: ['output_export'], text: '导出文件' }
]

export function roleCapabilities(role: RoleDef, connectorTools: string[] = []): string[] {
  const names = new Set(roleToolNames(role, connectorTools))
  const out = CAPABILITY.filter(c => c.tools.some(t => names.has(t))).map(c => c.text)
  if (CONNECTOR_ROLES.includes(role.id) && externalOnly(connectorTools).length) out.push('用已连接的外部工具')
  return out
}

/** 给模型的一段话：你没有的能力，在哪个身份下有。没有别的身份可推荐时返回空串 */
export function otherRolesHint(current: RoleDef, all: RoleDef[], scene: Scene, connectorTools: string[] = []): string {
  const mine = new Set(roleCapabilities(current, connectorTools))
  const lines: string[] = []
  for (const r of all) {
    if (r.id === current.id || !r.enabled) continue
    const extra = roleCapabilities(r, connectorTools).filter(c => !mine.has(c))
    if (extra.length) lines.push(`- ${r.names[scene]}：${extra.slice(0, 5).join('、')}`)
  }
  if (!lines.length) return ''
  return '# 其他身份能做、你现在做不了的事\n用户要的事如果需要你清单里没有的工具，不要硬做，也不要沉默或只说「做不了」：直接告诉他「这个要切到『某某』身份来做」。其他身份各自擅长：\n' + lines.slice(0, 8).join('\n')
}
