/**
 * 剧本的辅助函数（解析 / 读目录 / 合并 / 按角色筛选 / 给模型的目录）。
 * 剧本只有一套：内置的在 playbooks/*.md（playbooks/index.ts 用 ?raw 编进主进程），用户的在 <数据目录>/playbooks/；解析与加载都在 playbooks/parse.ts 和 playbooks/store.ts。
 * 这里是内核（service / prompt）用的薄封装。
 */
import { parsePlaybook as parseOne } from './playbooks/parse.ts'
import { readPlaybookFiles } from './playbooks/store.ts'

export interface Playbook {
  name: string
  description: string
  /** 适用的角色 id；空 = 所有角色 */
  roles: string[]
  when: string
  body: string
  source: 'builtin' | 'user'
}

/** 解析一份剧本；格式不对返回 null */
export function parsePlaybook(text: string, source: Playbook['source']): Playbook | null {
  const r = parseOne(text.replace(/^﻿/, ''))
  return r.ok ? { ...r.playbook, source } : null
}

/** 读目录里的 *.md；目录不存在 / 读不了就当没有 */
export function readPlaybookDir(dir: string, source: Playbook['source']): Playbook[] { return readPlaybookFiles(dir, source).items }

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
