/**
 * 「让助手帮我生成角色」的纯逻辑：把用户的选择拼成提示词输入，把 AI 回答洗成合格的角色草稿。
 * AI 只能从给定清单里选工具和 Skill，程序再过滤一遍；不依赖 electron，可单测。
 */
import { parseJsonObject } from '../analysis/stats/classify.ts'
import { BASE_TOOLS } from './roles.ts'
import type { Scene } from './types.ts'

export interface RoleDraftAnswers {
  job: string
  tasks: string[]
  reportTo: string
  style: string
  extra: string
}
export interface RoleDraft { name: string; description: string; tools: string[]; suggestions: string[]; defaultPlaybook?: string; notes: string }

const cut = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 给提示词模板填的值（用户的文字只截长度，当作普通描述） */
export function draftVars(a: RoleDraftAnswers, scene: Scene, tools: Array<{ name: string; label: string }>, skills: Array<{ name: string; description: string }>): Record<string, string> {
  return {
    SCENE: scene === 'school' ? '学校' : '培训机构',
    JOB: cut(a.job, 40) || '（没写）',
    TASKS: a.tasks.map(t => cut(t, 20)).filter(Boolean).slice(0, 10).join('、') || '（没选）',
    REPORT_TO: cut(a.reportTo, 20) || '（没选）',
    STYLE: cut(a.style, 20) || '（没选）',
    EXTRA: cut(a.extra, 300) || '（没有）',
    TOOL_LIST: tools.filter(t => !BASE_TOOLS.includes(t.name)).map(t => `${t.name}：${cut(t.label, 40)}`).join('\n'),
    SKILL_LIST: skills.map(s => `${s.name}：${cut(s.description, 60)}`).join('\n') || '（没有）'
  }
}

export const fillTemplate = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m))

/** 把 AI 的回答洗成草稿：工具、Skill 只留清单里有的，推荐问题最多 4 个，字段按角色文件的长度限制截断。回答不是 JSON 或没有名称返回 null */
export function normalizeRoleDraft(content: string, knownTools: Set<string>, knownSkills: Set<string>): RoleDraft | null {
  const o = parseJsonObject(content)
  if (!o) return null
  const name = cut(o.name, 20)
  if (!name) return null
  const toolsRaw = Array.isArray(o.tools) ? o.tools : []
  const tools = [...new Set(toolsRaw.map(t => String(t).trim()).filter(t => knownTools.has(t) && !BASE_TOOLS.includes(t)))].slice(0, 40)
  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : []).map(s => cut(s, 80)).filter(Boolean).slice(0, 4)
  const pb = String(o.defaultPlaybook ?? '').trim()
  return {
    name, description: cut(o.description, 400), tools, suggestions,
    ...(pb && knownSkills.has(pb) ? { defaultPlaybook: pb } : {}),
    notes: String(o.notes ?? '').trim().slice(0, 1500)
  }
}
