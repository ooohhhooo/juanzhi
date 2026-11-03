/**
 * Skill（内部叫 playbook）的保存 / 删除 / 导入 / 导出（纯逻辑，不依赖 electron）：
 * 用户的 Skill 是数据目录 playbooks/ 下的 .md（带 frontmatter）。导入 Claude Code / Codex 风格的 SKILL.md 时只读那一份文字，
 * 文件夹里的脚本等其他文件既不复制也不执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parsePlaybook, ROLE_IDS, type Playbook } from './parse.ts'

export const MAX_BODY_BYTES = 64 * 1024
const ROLE_NAME_BY_ID: Record<string, string> = { ops: '运营', tutor: '辅导老师', research: '教研', teacher: '授课老师' }

export interface SkillInput { name: string; description: string; roles: string[]; when?: string; body: string; origin?: 'imported' }
export interface SkillFile { file: string; playbook: Playbook; origin?: 'imported' }

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 生成带 frontmatter 的 .md 文本（roles 为空 = 所有角色，不写 roles 行） */
export function serializeSkill(i: SkillInput): string {
  const lines = ['---', `name: ${oneLine(i.name)}`, `description: ${oneLine(i.description)}`]
  const roles = [...new Set(i.roles.map(r => ROLE_NAME_BY_ID[ROLE_IDS[r] ?? r] ?? r))]
  if (roles.length) lines.push(`roles: [${roles.join(', ')}]`)
  if (i.when?.trim()) lines.push(`when: ${oneLine(i.when)}`)
  if (i.origin === 'imported') lines.push('source: imported')
  lines.push('---', '', i.body.replace(/\r\n/g, '\n').trim(), '')
  return lines.join('\n')
}

/** 正文里用反引号包着的 snake_case 名字，不在已知工具里的，当作可能写错的工具名 */
export function unknownToolMentions(body: string, known: Iterable<string>): string[] {
  const set = new Set(known)
  const out = new Set<string>()
  for (const m of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) if (!set.has(m[1])) out.add(m[1])
  return [...out]
}

/** 用现有解析器核对一份要保存的 Skill；返回错误（白话）或通过后的文本 */
export function checkSkill(i: SkillInput): { ok: true; text: string; playbook: Playbook } | { ok: false; error: string } {
  if (!i.name.trim()) return { ok: false, error: '请填名称' }
  if (!oneLine(i.description)) return { ok: false, error: '请填一句说明' }
  if (!i.body.trim()) return { ok: false, error: '正文是空的' }
  if (Buffer.byteLength(i.body, 'utf8') > MAX_BODY_BYTES) return { ok: false, error: '正文超过 64KB，请精简' }
  const text = serializeSkill(i)
  const r = parsePlaybook(text)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, text, playbook: r.playbook }
}

/** 读数据目录里的用户 Skill（带文件名）；坏文件跳过 */
export function listUserSkillFiles(dir: string): SkillFile[] {
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort() } catch { return [] }
  const out: SkillFile[] = []
  for (const f of files) {
    try {
      const p = path.join(dir, f)
      if (fs.statSync(p).size > MAX_BODY_BYTES + 4096) continue
      const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
      const r = parsePlaybook(text)
      if (r.ok) out.push({ file: f, playbook: r.playbook, origin: /^source:\s*imported\s*$/m.test(text.split('\n---')[0]) ? 'imported' : undefined })
    } catch { /* 跳过 */ }
  }
  return out
}

function fileNameFor(name: string, taken: Set<string>): string {
  const base = name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'skill'
  let f = `${base}.md`
  for (let n = 2; taken.has(f); n++) f = `${base}-${n}.md`
  return f
}

/** 保存：originalName 有值 = 编辑（改名会改写同一个文件）；没有 = 新建，名称不能和已有的我的 Skill 重复 */
export function saveSkill(dir: string, input: SkillInput, opts: { originalName?: string; knownTools: Iterable<string> }): { name: string; warnings: string[] } {
  const existing = listUserSkillFiles(dir)
  const old = opts.originalName ? existing.find(e => e.playbook.name === opts.originalName) : undefined
  const c = checkSkill({ ...input, origin: input.origin ?? old?.origin })
  if (!c.ok) throw new Error(c.error)
  const name = c.playbook.name
  const clash = existing.find(e => e.playbook.name === name && e !== old)
  if (clash) throw new Error(`已经有一个叫「${name}」的 Skill，换个名字，或先删掉旧的`)
  fs.mkdirSync(dir, { recursive: true })
  const file = old ? old.file : fileNameFor(name, new Set(fs.readdirSync(dir)))
  fs.writeFileSync(path.join(dir, file), c.text, 'utf8')
  const unknown = unknownToolMentions(c.playbook.body, opts.knownTools)
  return { name, warnings: unknown.length ? [`正文里提到的这些工具不存在，助手可能用不了：${unknown.join('、')}`] : [] }
}

export function deleteSkill(dir: string, name: string): boolean {
  const e = listUserSkillFiles(dir).find(x => x.playbook.name === name)
  if (!e) return false
  fs.unlinkSync(path.join(dir, e.file))
  return true
}

/** SKILL.md 的 frontmatter 比我们的宽松（连字符 key、引号、多行）：只取 name / description / roles / when */
function lenientMeta(text: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'))
  if (!m) return null
  const meta: Record<string, string> = {}
  let key = ''
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) { key = kv[1].toLowerCase(); meta[key] = kv[2].trim() } else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim()
  }
  for (const k of Object.keys(meta)) meta[k] = meta[k].replace(/^[>|][-+]?\s*/, '').replace(/^(["'])([\s\S]*)\1$/, '$2').trim()
  return { meta, body: m[2].trim() }
}

/** 名字规整成解析器认的样子：英文小写 + 连字符，或中文名 */
export function normalizeSkillName(raw: string, fallback: string): string {
  const s = raw.trim()
  if (/^[a-z][a-z0-9-]*$/.test(s) || /^[一-鿿][一-鿿a-z0-9-]{0,39}$/.test(s)) return s
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '')
  if (n) return n
  return s === fallback ? 'skill' : normalizeSkillName(fallback, fallback)
}

/** 把一份 .md / SKILL.md 文本转成可保存的 Skill；frontmatter 缺 roles = 适用全部角色 */
export function skillFromText(text: string, fallbackName: string): { ok: true; input: SkillInput } | { ok: false; error: string } {
  const strict = parsePlaybook(text.replace(/^﻿/, ''))
  if (strict.ok) { const p = strict.playbook; return { ok: true, input: { name: p.name, description: p.description, roles: p.roles, when: p.when, body: p.body, origin: 'imported' } } }
  const l = lenientMeta(text)
  if (!l) return { ok: false, error: '缺少 frontmatter（文件开头要有 --- 包起来的 name 和 description）' }
  const description = oneLine(l.meta.description ?? '')
  if (!description) return { ok: false, error: 'frontmatter 里缺少 description' }
  if (!l.body) return { ok: false, error: '正文是空的' }
  const roleList = (l.meta.roles ?? '').replace(/^\[|\]$/g, '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  const roles = [...new Set(roleList.filter(r => r in ROLE_IDS).map(r => ROLE_IDS[r]))]
  return { ok: true, input: { name: normalizeSkillName(l.meta.name ?? fallbackName, fallbackName), description, roles, when: l.meta.when ?? '', body: l.body, origin: 'imported' } }
}

/** 导入单个 .md 文件 */
export function importSkillFile(dir: string, file: string, knownTools: Iterable<string>): { name: string; warnings: string[] } {
  if (fs.statSync(file).size > MAX_BODY_BYTES + 4096) throw new Error('这个文件太大（超过 64KB），不像是 Skill')
  const r = skillFromText(fs.readFileSync(file, 'utf8'), path.basename(file, path.extname(file)))
  if (!r.ok) throw new Error(r.error)
  return saveSkill(dir, r.input, { knownTools })
}

/** 导入一个文件夹：只读里面的 SKILL.md，其他文件（脚本等）不导入、不执行 */
export function importSkillFolder(dir: string, folder: string, knownTools: Iterable<string>): { name: string; warnings: string[]; note: string } {
  const f = path.join(folder, 'SKILL.md')
  if (!fs.existsSync(f)) throw new Error('这个文件夹里没有 SKILL.md')
  if (fs.statSync(f).size > MAX_BODY_BYTES + 4096) throw new Error('SKILL.md 太大（超过 64KB）')
  const r = skillFromText(fs.readFileSync(f, 'utf8'), path.basename(folder))
  if (!r.ok) throw new Error(`SKILL.md：${r.error}`)
  return { ...saveSkill(dir, r.input, { knownTools }), note: '只导入了说明文字，脚本不会执行' }
}

/** 导出：这份 Skill 的 .md 文本（带 frontmatter） */
export function skillText(p: Playbook): string { return serializeSkill({ name: p.name, description: p.description, roles: p.roles, when: p.when, body: p.body }) }
