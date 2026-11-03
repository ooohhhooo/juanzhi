/**
 * 剧本（Playbook，类似 Skill）：一份 Markdown 文件，开头是 frontmatter（name、description、roles、when），正文写清分析步骤。
 * 内置剧本在 src/main/agent/playbooks/*.md（随应用打包，见 playbooks-builtin.ts）；用户自己的放在数据目录下的 playbooks/。
 * 同名时用户的覆盖内置的。Harness 只把 name + description 列给模型，模型需要时用 load_playbook(name) 读全文。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Playbook {
  name: string
  description: string
  /** 适用的角色 id；空 = 所有角色 */
  roles: string[]
  when: string
  body: string
  source: 'builtin' | 'user'
}

/** 解析 frontmatter（只支持 key: value 和 roles: [a, b]）；格式不对返回 null */
export function parsePlaybook(text: string, source: Playbook['source']): Playbook | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''))
  if (!m) return null
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*[:：]\s*(.*)$/.exec(line.trim())
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  const name = (fm.name ?? '').trim()
  const description = (fm.description ?? '').trim()
  if (!name || !description) return null
  const roles = (fm.roles ?? '').replace(/^\[|\]$/g, '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
  return { name: name.slice(0, 40), description: description.slice(0, 200), roles, when: (fm.when ?? '').slice(0, 200), body: m[2].trim(), source }
}

/** 读用户剧本目录里的 *.md；目录不存在 / 读不了就当没有 */
export function readPlaybookDir(dir: string, source: Playbook['source']): Playbook[] {
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && f.toLowerCase().endsWith('.md')).sort() } catch { return [] }
  const out: Playbook[] = []
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f))
      if (!st.isFile() || st.size > 64 * 1024) continue
      const p = parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'), source)
      if (p) out.push(p)
    } catch { /* 读不了的文件跳过 */ }
  }
  return out
}

/** 合并内置和用户剧本（同名用户覆盖内置） */
export function mergePlaybooks(builtin: Playbook[], user: Playbook[]): Playbook[] {
  const map = new Map<string, Playbook>()
  for (const p of [...builtin, ...user]) map.set(p.name, p)
  return [...map.values()]
}

export const playbooksForRole = (all: Playbook[], roleId: string): Playbook[] => all.filter(p => p.roles.length === 0 || p.roles.includes(roleId))

/** 给模型的剧本目录：只有 name + description（+ when） */
export function playbookCatalog(list: Playbook[]): string {
  if (!list.length) return ''
  return list.map(p => `- ${p.name}：${p.description}${p.when ? `（适用：${p.when}）` : ''}`).join('\n')
}
