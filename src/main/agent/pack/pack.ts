/**
 * 定制包（配置包）：把一个机构调好的角色、Skill、提示词改写、外部连接的「配置」打成一个文件，发给同事导入。
 * 纯逻辑，不依赖 electron：导出时去掉所有密钥，导入时先出预览（新增 / 替换 / 相同），用户勾选后才写入；文件里不含代码，导入时什么都不会运行。
 * 不包含试卷、学员数据、对话记录。
 */
import { z } from 'zod'
import { promptProblem, sanitizeOverrides } from '../../ai/prompt-rules.ts'
import { CustomRoleSchema } from '../custom-roles.ts'
import type { CustomRole } from '../custom-roles.ts'

export const PACK_FORMAT = 'juanzhi-config-pack-v1'
export const PACK_EXT = '.juanzhi-pack.json'
export const MAX_PACK_BYTES = 2 * 1024 * 1024

export interface PackRole { name: string; description: string; tools: string[]; suggestions: string[]; defaultPlaybook?: string; notes: string }
export interface PackSkill { name: string; description: string; roles: string[]; when: string; body: string; version: number; sampleCount: number }
export interface PackConnector {
  type: string
  name: string
  /** 只有不含密钥的配置（命令、不保密的参数、来源预设） */
  pub: { transport?: 'stdio' | 'http'; command?: string; args?: string[]; preset?: string }
  /** 需要对方自己填的：环境变量名、请求头名、保密参数个数、网址 */
  needs: { env: string[]; headers: string[]; secretArgs: number; url: boolean; other: string[] }
}
export interface Pack { format: typeof PACK_FORMAT; createdAt: string; roles: PackRole[]; skills: PackSkill[]; prompts: Record<string, string>; connectors: PackConnector[] }

// ───────── 去密钥 ─────────
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|webhook)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i,
  /[?&](?:key|token|secret|access_token|api_key|apikey)=[^&\s"']{8,}/i,
  /https?:\/\/[^\s"']*(?:webhook|hook)[^\s"']*[?&]key=/i,
  /\b[A-Fa-f0-9]{32,}\b/
]
/** 长长一串字母数字混在一起（既有数字又有字母、没有 / 和 @ 这类路径符号）也当密钥 */
const LONG_TOKEN = /(?<![A-Za-z0-9+/_@.-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9+/_@.-])/g
const longToken = (s: string): boolean => (s.match(LONG_TOKEN) ?? []).some(t => /\d/.test(t) && /[A-Za-z]/.test(t))
export const looksSecret = (s: string): boolean => SECRET_PATTERNS.some(re => re.test(s)) || longToken(s)
export const PLACEHOLDER = '〈请填写〉'

/** 一个参数里如果像密钥，换成占位符（--token=abc → --token=〈请填写〉；整个像密钥的就整个换掉） */
export function redactArg(a: string): string {
  const kv = /^(--?[A-Za-z0-9_-]+)([=:])(.+)$/.exec(a)
  if (kv && (looksSecret(a) || /token|key|secret|pass|auth/i.test(kv[1]))) return `${kv[1]}${kv[2]}${PLACEHOLDER}`
  if (looksSecret(a)) return PLACEHOLDER
  return a
}

export interface ConnectorSource {
  type: string; name: string
  pub: Record<string, unknown>
  envKeys: string[]; headerKeys: string[]; secretArgsCount: number; hasSecretUrl: boolean
  /** 其他类型（企业微信等）里属于密钥的字段名 */
  secretFieldNames?: string[]
}

export interface BuildInput { roles: CustomRole[]; skills: PackSkill[]; prompts: Record<string, string>; connectors: ConnectorSource[]; now?: Date }

/** 组装定制包；connectors 里只会出现配置，不会出现任何值。返回 warnings：看起来像密钥的文字出现在哪里 */
export function buildPack(i: BuildInput): { pack: Pack; warnings: string[] } {
  const warnings: string[] = []
  const roles: PackRole[] = i.roles.map(r => ({ name: r.name, description: r.description, tools: [...r.tools], suggestions: [...r.suggestions], ...(r.defaultPlaybook ? { defaultPlaybook: r.defaultPlaybook } : {}), notes: r.notes }))
  for (const r of roles) if (looksSecret(`${r.description}\n${r.notes}`)) warnings.push(`角色「${r.name}」的说明里有像密钥的内容，请检查`)
  for (const s of i.skills) if (looksSecret(s.body)) warnings.push(`Skill「${s.name}」的正文里有像密钥的内容，请检查`)
  const prompts = sanitizeOverrides(i.prompts)
  for (const [k, v] of Object.entries(prompts)) if (looksSecret(v)) warnings.push(`提示词「${k}」里有像密钥的内容，请检查`)
  const connectors: PackConnector[] = i.connectors.map(c => {
    const p = c.pub as Record<string, unknown>
    const pub: PackConnector['pub'] = {}
    if (p.transport === 'stdio' || p.transport === 'http') pub.transport = p.transport
    if (typeof p.command === 'string') pub.command = looksSecret(p.command) ? PLACEHOLDER : p.command.slice(0, 500)
    if (Array.isArray(p.args)) pub.args = p.args.filter((a): a is string => typeof a === 'string').slice(0, 50).map(a => redactArg(a).slice(0, 2000))
    if (typeof p.preset === 'string') pub.preset = p.preset.slice(0, 40)
    return { type: c.type, name: c.name, pub, needs: { env: [...c.envKeys], headers: [...c.headerKeys], secretArgs: c.secretArgsCount, url: c.hasSecretUrl, other: c.secretFieldNames ?? [] } }
  })
  const pack: Pack = {
    format: PACK_FORMAT, createdAt: (i.now ?? new Date()).toISOString(), roles,
    skills: i.skills.map(s => ({ ...s })), prompts, connectors
  }
  return { pack, warnings }
}

export const serializePack = (p: Pack): string => JSON.stringify(p, null, 2)

// ───────── 读取 ─────────
const RoleZ = z.object({
  name: z.string().trim().min(1).max(20), description: z.string().max(400).default(''),
  tools: z.array(z.string().max(64)).max(40).default([]), suggestions: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  defaultPlaybook: z.string().trim().max(60).optional(), notes: z.string().max(1500).default('')
})
const SkillZ = z.object({
  name: z.string().trim().min(1).max(60), description: z.string().max(300), roles: z.array(z.string().max(20)).max(4).default([]),
  when: z.string().max(300).default(''), body: z.string().min(1).max(64 * 1024), version: z.number().int().min(1).max(9999).default(1), sampleCount: z.number().int().min(0).max(999).default(0)
})
const ConnZ = z.object({
  type: z.string().min(1).max(20), name: z.string().trim().min(1).max(30),
  pub: z.object({ transport: z.enum(['stdio', 'http']).optional(), command: z.string().max(500).optional(), args: z.array(z.string().max(2000)).max(50).optional(), preset: z.string().max(40).optional() }).default({}),
  needs: z.object({ env: z.array(z.string().max(100)).max(30).default([]), headers: z.array(z.string().max(100)).max(30).default([]), secretArgs: z.number().int().min(0).max(20).default(0), url: z.boolean().default(false), other: z.array(z.string().max(40)).max(10).default([]) }).default({})
})
const PackZ = z.object({
  format: z.literal(PACK_FORMAT), createdAt: z.string().max(40).default(''),
  roles: z.array(RoleZ).max(50).default([]), skills: z.array(SkillZ).max(100).default([]),
  prompts: z.record(z.string()).default({}), connectors: z.array(ConnZ).max(30).default([])
})

export function parsePack(text: string): { ok: true; pack: Pack; dropped: string[] } | { ok: false; error: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) return { ok: false, error: '这个文件太大，不像是配置包。' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: '这个文件不是配置包（不是有效的 JSON）。' } }
  if (!raw || typeof raw !== 'object' || (raw as any).format !== PACK_FORMAT) return { ok: false, error: '这个文件不是「卷知」的配置包，或者版本太新，请先升级软件。' }
  const r = PackZ.safeParse(raw)
  if (!r.success) return { ok: false, error: `配置包的内容不完整或不合法：${r.error.issues.slice(0, 3).map(i => i.path.join('.')).join('、')}` }
  const dropped: string[] = []
  const cleanPrompts = sanitizeOverrides(r.data.prompts)
  for (const k of Object.keys(r.data.prompts)) {
    if (!(k in cleanPrompts)) dropped.push(`提示词「${k}」不是已知的提示词，已忽略`)
    else { const bad = promptProblem(k, cleanPrompts[k]); if (bad) { delete cleanPrompts[k]; dropped.push(`提示词「${k}」${bad}，已忽略`) } }
  }
  // 配置包里不应该有密钥：万一有（手改过），导入时当成没有
  const connectors = r.data.connectors.map(c => ({ ...c, pub: { ...c.pub, ...(c.pub.command && looksSecret(c.pub.command) ? { command: PLACEHOLDER } : {}), ...(c.pub.args ? { args: c.pub.args.map(redactArg) } : {}) } }))
  return { ok: true, pack: { ...r.data, prompts: cleanPrompts, connectors }, dropped }
}

// ───────── 预览 ─────────
export type ItemStatus = 'add' | 'replace' | 'same'
export interface PreviewItem {
  kind: 'role' | 'skill' | 'prompt' | 'connector'
  key: string
  title: string
  status: ItemStatus
  /** 白话说明：会发生什么、要注意什么 */
  note: string
  /** 默认是否勾选：新增和相同的默认勾（相同的不会有变化），要替换的默认不勾，让用户自己决定 */
  selected: boolean
  /** 连接：要运行的命令，让用户看清楚 */
  detail?: string
}
export interface CurrentState {
  roles: CustomRole[]
  /** 我的 Skill（用户自己的）：名字 → 正文 + 版本 */
  userSkills: Array<{ name: string; description: string; when: string; body: string; version: number }>
  builtinSkillNames: Set<string>
  prompts: Record<string, string>
  connectors: Array<{ type: string; name: string }>
  knownTools: Set<string>
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function previewPack(pack: Pack, cur: CurrentState): PreviewItem[] {
  const out: PreviewItem[] = []
  for (const r of pack.roles) {
    const ex = cur.roles.find(x => x.name === r.name)
    const missing = r.tools.filter(t => !cur.knownTools.has(t)).length
    const warn = missing ? `；有 ${missing} 个功能这台电脑上没有，会去掉` : ''
    if (!ex) out.push({ kind: 'role', key: r.name, title: `角色「${r.name}」`, status: 'add', note: `新增${warn}`, selected: true })
    else {
      const same = norm(ex.description) === norm(r.description) && norm(ex.notes) === norm(r.notes) && [...ex.tools].sort().join() === [...r.tools].sort().join() && ex.suggestions.join('|') === r.suggestions.join('|')
      out.push({ kind: 'role', key: r.name, title: `角色「${r.name}」`, status: same ? 'same' : 'replace', note: same ? '和你现有的一样' : `你已经有同名角色，导入会替换它的内容${warn}`, selected: same })
    }
  }
  for (const s of pack.skills) {
    const ex = cur.userSkills.find(x => x.name === s.name)
    const over = cur.builtinSkillNames.has(s.name)
    if (!ex) out.push({ kind: 'skill', key: s.name, title: `Skill「${s.name}」`, status: 'add', note: over ? `新增（和内置的同名，导入后会优先用这一份）· 版本 ${s.version}` : `新增 · 版本 ${s.version}`, selected: true })
    else {
      const same = norm(ex.body) === norm(s.body) && norm(ex.description) === norm(s.description)
      out.push({ kind: 'skill', key: s.name, title: `Skill「${s.name}」`, status: same ? 'same' : 'replace', note: same ? '和你现有的一样' : `你已经有同名 Skill（版本 ${ex.version}），导入的是版本 ${s.version}；替换后旧的会留在历史里，可以恢复`, selected: same })
    }
  }
  for (const [k, v] of Object.entries(pack.prompts)) {
    const ex = cur.prompts[k]
    out.push({ kind: 'prompt', key: k, title: `提示词「${k}」`, status: ex === undefined ? 'add' : ex === v ? 'same' : 'replace', note: ex === undefined ? '新增一份改写' : ex === v ? '和你现有的一样' : '你已经改写过这条提示词，导入会替换', selected: ex === undefined || ex === v })
  }
  for (const c of pack.connectors) {
    const ex = cur.connectors.find(x => x.type === c.type && x.name === c.name)
    const needs: string[] = []
    if (c.needs.url) needs.push('网址')
    if (c.needs.env.length) needs.push(`环境变量 ${c.needs.env.join('、')}`)
    if (c.needs.headers.length) needs.push(`请求头 ${c.needs.headers.join('、')}`)
    if (c.needs.secretArgs) needs.push(`${c.needs.secretArgs} 个保密参数`)
    if (c.needs.other.length) needs.push(c.needs.other.join('、'))
    const detail = c.pub.command ? `${c.pub.command} ${(c.pub.args ?? []).join(' ')}`.trim() : undefined
    out.push({
      kind: 'connector', key: `${c.type}:${c.name}`, title: `外部连接「${c.name}」`, status: ex ? 'replace' : 'add',
      note: `${ex ? '你已经有同名连接，导入会替换它的设置（你已填的密钥保留）' : '新增'}；只保存设置，不会立刻运行${needs.length ? `；导入后需要你自己填：${needs.join('；')}` : ''}`,
      selected: !ex, detail
    })
  }
  return out
}

// ───────── 应用 ─────────
export interface ApplyDeps {
  saveRole: (r: PackRole, existingId: string | null) => void
  saveSkill: (s: PackSkill, existedName: string | null) => { warnings: string[] }
  savePrompt: (key: string, text: string) => void
  saveConnector: (c: PackConnector, exists: boolean) => { ok: boolean; note: string }
}
export interface ApplyResult { added: number; replaced: number; skipped: number; notes: string[]; needSecrets: string[] }

/** 只处理用户勾选的项目（selectedKeys 里是 `${kind}:${key}`）；单个失败不影响其他 */
export function applyPack(pack: Pack, cur: CurrentState, selectedKeys: Set<string>, deps: ApplyDeps): ApplyResult {
  const res: ApplyResult = { added: 0, replaced: 0, skipped: 0, notes: [], needSecrets: [] }
  const preview = previewPack(pack, cur)
  const tick = (it: PreviewItem) => { if (it.status === 'add') res.added++; else if (it.status === 'replace') res.replaced++ }
  for (const it of preview) {
    const id = `${it.kind}:${it.key}`
    if (!selectedKeys.has(id)) { res.skipped++; continue }
    if (it.status === 'same') continue
    try {
      if (it.kind === 'role') { const r = pack.roles.find(x => x.name === it.key)!; deps.saveRole({ ...r, tools: r.tools.filter(t => cur.knownTools.has(t)) }, cur.roles.find(x => x.name === it.key)?.id ?? null); tick(it) }
      else if (it.kind === 'skill') { const s = pack.skills.find(x => x.name === it.key)!; const r = deps.saveSkill(s, cur.userSkills.find(x => x.name === it.key) ? it.key : null); res.notes.push(...r.warnings); tick(it) }
      else if (it.kind === 'prompt') { deps.savePrompt(it.key, pack.prompts[it.key]); tick(it) }
      else {
        const c = pack.connectors.find(x => `${x.type}:${x.name}` === it.key)!
        const r = deps.saveConnector(c, it.status === 'replace')
        if (r.ok) { tick(it); if (c.needs.url || c.needs.env.length || c.needs.headers.length || c.needs.secretArgs || c.needs.other.length) res.needSecrets.push(c.name) } else { res.skipped++; res.notes.push(`「${c.name}」没有导入：${r.note}`) }
      }
    } catch (e) { res.skipped++; res.notes.push(`${it.title}没有导入：${(e as Error).message}`) }
  }
  return res
}
