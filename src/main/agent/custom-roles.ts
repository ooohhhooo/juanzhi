/**
 * 自定义角色：内置角色之外，用户可以自己建（名称、说明、可用工具、推荐问题、默认剧本、额外说明）。
 * 存在数据目录的 agent-roles/*.json，一个角色一个文件；可以导出成文件发给别人、再导入（开源用户互相分享）。纯函数 + fs，目录由调用方传入，单测用临时目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { BASE_TOOLS } from './roles.ts'
import type { RoleDef } from './roles.ts'

export const ROLE_FILE_FORMAT = 'juanzhi-agent-role-v1'
export const MAX_NOTES = 1500

export const CustomRoleSchema = z.object({
  id: z.string().regex(/^c-[a-z0-9]{3,24}$/),
  name: z.string().trim().min(1).max(20),
  /** 怎么说话、关注什么 */
  description: z.string().trim().max(400).default(''),
  /** 在基础工具（计划 / 提问 / 剧本 / 取回进度）之外勾选的工具 */
  tools: z.array(z.string().min(1).max(64)).max(40).default([]),
  suggestions: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  defaultPlaybook: z.string().trim().max(60).optional(),
  /** 只给这个角色的额外说明（会放进规矩里） */
  notes: z.string().max(MAX_NOTES).default('')
})
export type CustomRole = z.infer<typeof CustomRoleSchema>

export function toRoleDef(c: CustomRole): RoleDef {
  return {
    id: c.id as RoleDef['id'], names: { org: c.name, school: c.name },
    persona: c.description || `你在帮「${c.name}」处理工作，回答简短、直接。`,
    tools: [...new Set([...BASE_TOOLS, ...c.tools])], suggestions: c.suggestions, rules: c.notes.trim() ? [c.notes.trim()] : [],
    enabled: true, custom: true, ...(c.defaultPlaybook ? { defaultPlaybook: c.defaultPlaybook } : {})
  }
}

const fileOf = (dir: string, id: string) => path.join(dir, `${id}.json`)

export function readCustomRoles(dir: string): CustomRole[] {
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && f.endsWith('.json')).sort() } catch { return [] }
  const out: CustomRole[] = []
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const r = CustomRoleSchema.safeParse(raw?.role ?? raw)
      if (r.success && `${r.data.id}.json` === f) out.push(r.data)
    } catch { /* 坏文件跳过 */ }
  }
  return out
}

export function saveCustomRole(dir: string, role: CustomRole): CustomRole {
  const r = CustomRoleSchema.parse(role)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileOf(dir, r.id), JSON.stringify({ format: ROLE_FILE_FORMAT, role: r }, null, 2), 'utf8')
  return r
}

export function deleteCustomRole(dir: string, id: string): boolean {
  if (!/^c-[a-z0-9]{3,24}$/.test(id)) return false
  try { fs.unlinkSync(fileOf(dir, id)); return true } catch { return false }
}

export const newRoleId = (taken: Set<string>): string => {
  for (;;) {
    const id = `c-${Math.random().toString(36).slice(2, 8)}`
    if (id.length >= 5 && !taken.has(id)) return id
  }
}

/** 导出文件的内容 */
export const exportRoleText = (role: CustomRole): string => JSON.stringify({ format: ROLE_FILE_FORMAT, role }, null, 2)

/**
 * 导入：认得出格式、字段合法才收；id 一律重新生成（不会覆盖已有角色）；不认识的工具名去掉并告诉用户去掉了几个。
 */
export function parseRoleFile(text: string, knownTools: Set<string>, takenIds: Set<string>): { ok: true; role: CustomRole; droppedTools: number } | { ok: false; error: string } {
  let raw: any
  try { raw = JSON.parse(text) } catch { return { ok: false, error: '这个文件不是角色文件（不是有效的 JSON）。' } }
  const body = raw?.role ?? raw
  if (!body || typeof body !== 'object') return { ok: false, error: '这个文件不是角色文件。' }
  const wanted: string[] = Array.isArray(body.tools) ? body.tools.filter((t: unknown) => typeof t === 'string') : []
  const tools = wanted.filter(t => knownTools.has(t) && !BASE_TOOLS.includes(t))
  const r = CustomRoleSchema.safeParse({ ...body, id: newRoleId(takenIds), tools })
  if (!r.success) return { ok: false, error: `角色文件的内容不完整或不合法：${r.error.issues.map(i => i.path.join('.')).join('、')}` }
  return { ok: true, role: r.data, droppedTools: wanted.filter(t => !tools.includes(t) && !BASE_TOOLS.includes(t)).length }
}
