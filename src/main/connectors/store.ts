/**
 * 连接器配置的存取。公开部分（名称、命令、勾选）存 settings 表；密钥部分（Webhook 地址、环境变量）
 * 用 safeStorage 加密后另存一行，和 AI 密钥同一做法：渲染端只拿到掩码，读不回明文。
 */
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { getDb } from '../db'
import { getConnector } from './registry'
import type { McpTool } from './mcp-client'

const LIST_KEY = 'connectors_v1'
const SECRET_KEY = 'connectors_secret_enc'

export interface StoredEntry {
  id: string
  type: string
  name: string
  pub: Record<string, unknown>
  tools?: McpTool[]
  allowed?: string[]
}
export interface EntryView {
  id: string; type: string; name: string; summary: string; secretSet: boolean
  tools?: McpTool[]; allowed?: string[]
}

let memorySecrets: Record<string, Record<string, unknown>> | null = null

function getRow(key: string): string | null {
  const r = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
  return r ? r.value_json : null
}
function setRow(key: string, v: string): void { getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, v) }

export function listEntries(): StoredEntry[] {
  const raw = getRow(LIST_KEY)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}
function saveEntries(list: StoredEntry[]): void { setRow(LIST_KEY, JSON.stringify(list)) }

function loadSecrets(): Record<string, Record<string, unknown>> {
  if (memorySecrets) return memorySecrets
  const raw = getRow(SECRET_KEY)
  let out: Record<string, Record<string, unknown>> = {}
  if (raw) {
    try {
      if (safeStorage.isEncryptionAvailable()) out = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(raw), 'base64')))
    } catch { out = {} }
  }
  memorySecrets = out
  return out
}
function saveSecrets(s: Record<string, Record<string, unknown>>): void {
  memorySecrets = s
  if (safeStorage.isEncryptionAvailable()) setRow(SECRET_KEY, JSON.stringify(safeStorage.encryptString(JSON.stringify(s)).toString('base64')))
  else getDb().prepare('DELETE FROM settings WHERE key = ?').run(SECRET_KEY)   // 没有系统加密：只留在内存，不明文落盘
}

/** 仅主进程内部：拿完整配置（含密钥） */
export function fullConfig(id: string): { entry: StoredEntry; config: any } | null {
  const entry = listEntries().find(e => e.id === id)
  if (!entry) return null
  return { entry, config: { ...entry.pub, ...(loadSecrets()[id] ?? {}) } }
}
export function findByName(type: string, name: string): { entry: StoredEntry; config: any } | null {
  const e = listEntries().find(x => x.type === type && x.name === name.trim())
  return e ? fullConfig(e.id) : null
}

export function viewOf(e: StoredEntry): EntryView {
  const c = getConnector(e.type)
  const secrets = loadSecrets()[e.id] ?? {}
  const full = { ...e.pub, ...secrets }
  let summary = ''
  try { summary = c?.mask?.(full) ?? '' } catch { summary = '' }
  if (e.type === 'mcp') {
    const keys = Object.keys((secrets.env as Record<string, string>) ?? {})
    if (keys.length) summary += `（环境变量：${keys.join('、')}，值已隐藏）`
  }
  return { id: e.id, type: e.type, name: e.name, summary, secretSet: c ? c.secretFields.every(f => secrets[f] !== undefined) : false, tools: e.tools, allowed: e.allowed }
}
export const listViews = (): EntryView[] => listEntries().map(viewOf)

/** 新增或修改。修改时没提供的密钥字段沿用旧值 */
export function saveEntry(input: { id?: string; type: string; name: string; config: Record<string, unknown> }): EntryView {
  const c = getConnector(input.type)
  if (!c) throw new Error('不支持的连接器类型')
  const name = input.name.trim()
  if (!name || name.length > 30) throw new Error('名称要在 1–30 个字之间')
  const list = listEntries()
  if (list.some(e => e.name === name && e.id !== input.id)) throw new Error('已有同名的连接，换一个名字')
  const old = input.id ? fullConfig(input.id) : null
  if (input.id && !old) throw new Error('找不到这个连接')
  const merged: Record<string, unknown> = { ...(old?.config ?? {}) }
  for (const [k, v] of Object.entries(input.config)) {
    if (c.secretFields.includes(k) && (v === '' || v == null)) continue
    merged[k] = v
  }
  const parsed = c.configSchema.safeParse(merged)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '配置不正确')
  const cfg = parsed.data as Record<string, unknown>
  const pub: Record<string, unknown> = {}
  const sec: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) (c.secretFields.includes(k) ? sec : pub)[k] = v
  const id = input.id ?? randomUUID()
  const entry: StoredEntry = { id, type: input.type, name, pub, tools: old?.entry.tools, allowed: old?.entry.allowed }
  if (old && input.type === 'mcp' && JSON.stringify(old.entry.pub) !== JSON.stringify(pub)) { entry.tools = undefined; entry.allowed = [] }
  saveEntries(old ? list.map(e => (e.id === id ? entry : e)) : [...list, entry])
  saveSecrets({ ...loadSecrets(), [id]: sec })
  return viewOf(entry)
}

export function removeEntry(id: string): void {
  saveEntries(listEntries().filter(e => e.id !== id))
  const s = { ...loadSecrets() }
  delete s[id]
  saveSecrets(s)
}

export function setTools(id: string, tools: McpTool[]): EntryView {
  const list = listEntries()
  const e = list.find(x => x.id === id)
  if (!e) throw new Error('找不到这个连接')
  e.tools = tools
  e.allowed = (e.allowed ?? []).filter(n => tools.some(t => t.name === n))
  saveEntries(list)
  return viewOf(e)
}
export function setAllowed(id: string, allowed: string[]): EntryView {
  const list = listEntries()
  const e = list.find(x => x.id === id)
  if (!e) throw new Error('找不到这个连接')
  e.allowed = allowed.filter(n => (e.tools ?? []).some(t => t.name === n))
  saveEntries(list)
  return viewOf(e)
}
