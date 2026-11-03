/**
 * 剧本仓库（纯逻辑，不依赖 electron / vite）：内置剧本由调用方传入原文，用户剧本读数据目录下的 playbooks/*.md。
 * 同名时用户剧本优先；坏文件（格式不对）跳过并记在 problems 里；macOS 的 ._ 开头文件忽略。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parsePlaybook, type Playbook } from './parse.ts'

export interface PlaybookInfo { name: string; description: string; roles: string[]; when: string; source: 'builtin' | 'user' }
export interface LoadedPlaybook extends Playbook { source: 'builtin' | 'user' }

export function userPlaybookDir(dataDir: string): string { return path.join(dataDir, 'playbooks') }

/** 读一个目录里的 *.md（坏文件跳过并记在 problems；._ 开头的和超过 64KB 的忽略） */
export function readPlaybookFiles(dir: string, source: 'builtin' | 'user'): { items: LoadedPlaybook[]; problems: string[] } {
  const items: LoadedPlaybook[] = []
  const problems: string[] = []
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort() } catch { return { items, problems } }
  for (const f of files) {
    try {
      if (fs.statSync(path.join(dir, f)).size > 64 * 1024) { problems.push(`${f}：文件太大`); continue }
      const r = parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (r.ok) items.push({ ...r.playbook, source })
      else problems.push(`${f}：${r.error}`)
    } catch { problems.push(`${f}：读取失败`) }
  }
  return { items, problems }
}

function readUser(dataDir: string | undefined): { items: LoadedPlaybook[]; problems: string[] } {
  return dataDir ? readPlaybookFiles(userPlaybookDir(dataDir), 'user') : { items: [], problems: [] }
}

/** builtin：{ 文件路径或名字 → 原文 }，路径里 ._ 开头的会被过滤 */
export function createPlaybooks(builtin: Record<string, string>) {
  const builtinItems: LoadedPlaybook[] = []
  for (const [file, raw] of Object.entries(builtin)) {
    const base = file.split('/').pop() ?? file
    if (base.startsWith('.')) continue
    const r = parsePlaybook(raw)
    if (r.ok) builtinItems.push({ ...r.playbook, source: 'builtin' })
  }

  function all(dataDir?: string): { items: LoadedPlaybook[]; problems: string[] } {
    const u = readUser(dataDir)
    const map = new Map<string, LoadedPlaybook>()
    for (const p of builtinItems) map.set(p.name, p)
    for (const p of u.items) map.set(p.name, p)
    return { items: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)), problems: u.problems }
  }
  return {
    /** 全文列表（内置 + 用户，同名用户优先） */
    allPlaybooks(dataDir?: string): LoadedPlaybook[] { return all(dataDir).items },
    listPlaybooks(dataDir?: string): PlaybookInfo[] {
      return all(dataDir).items.map(p => ({ name: p.name, description: p.description, roles: p.roles, when: p.when, source: p.source }))
    },
    /** 用户剧本里有格式问题的文件（白话原因），给设置页 / 日志提示用 */
    playbookProblems(dataDir?: string): string[] { return all(dataDir).problems },
    loadPlaybook(name: string, dataDir?: string): LoadedPlaybook | null {
      return all(dataDir).items.find(p => p.name === name) ?? null
    }
  }
}
