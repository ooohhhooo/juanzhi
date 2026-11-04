/**
 * 文档资料：数据页导入的图片、PDF、Word、文本。只存读出来的文字（<数据目录>/documents/<id>.txt）和一份目录（catalog.json），
 * 原文件不复制。助手用 list_datasets 看到它们，用 read_document 分段读；发给 AI 前去掉手机号、身份证号等。
 * 不依赖 electron（读文字在 IPC 层做，见 agent/attachments.ts），单测可以直接加载。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { scrubPII } from './scrub.ts'
import type { ToolDef } from './types.ts'

export type DocKind = 'image' | 'pdf' | 'docx' | 'text'
export interface DocEntry { id: string; name: string; kind: DocKind; chars: number; importedAt: string; note: string }

/** 一份文档最多存多少字；read_document 一次最多返回多少字 */
export const DOC_MAX_CHARS = 500_000
export const DOC_READ_MAX = 12_000

export class DocumentStore {
  readonly dir: string
  constructor(dataDir: string) { this.dir = path.join(dataDir, 'documents') }
  private catalogFile() { return path.join(this.dir, 'catalog.json') }
  private textFile(id: string) { return path.join(this.dir, `${id}.txt`) }
  list(): DocEntry[] {
    try { const j = JSON.parse(fs.readFileSync(this.catalogFile(), 'utf8')); return Array.isArray(j.items) ? j.items : [] } catch { return [] }
  }
  private save(items: DocEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.catalogFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2))
    fs.renameSync(tmp, this.catalogFile())
  }
  add(name: string, kind: DocKind, text: string): DocEntry {
    const body = text.slice(0, DOC_MAX_CHARS)
    const e: DocEntry = { id: 'doc-' + crypto.randomUUID().slice(0, 12), name: name.slice(0, 160), kind, chars: body.length, importedAt: new Date().toISOString(), note: text.length > DOC_MAX_CHARS ? `文字太长，只保存了前 ${DOC_MAX_CHARS / 10000} 万字` : '' }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.textFile(e.id), body)
    this.save([...this.list(), e])
    return e
  }
  get(id: string): DocEntry | undefined { return this.list().find(d => d.id === id) }
  text(id: string): string {
    if (!/^doc-[0-9a-f-]{1,40}$/.test(id) || !this.get(id)) throw new Error('找不到这份文档')
    return fs.readFileSync(this.textFile(id), 'utf8')
  }
  remove(id: string): boolean {
    const items = this.list()
    if (!items.some(d => d.id === id)) return false
    this.save(items.filter(d => d.id !== id))
    fs.rmSync(this.textFile(id), { force: true })
    return true
  }
  rename(id: string, name: string): void {
    const n = name.trim().slice(0, 160)
    if (!n) throw new Error('名称不能为空')
    this.save(this.list().map(d => (d.id === id ? { ...d, name: n } : d)))
  }
}

let provider: (() => string) | null = null
let current: { dir: string; store: DocumentStore } | null = null
export function setDocumentsDirProvider(fn: () => string): void { provider = fn; current = null }
export function getDocumentStore(): DocumentStore {
  if (!provider) throw new Error('文档模块还没有初始化数据目录')
  const dir = provider()
  if (!current || current.dir !== dir) current = { dir, store: new DocumentStore(dir) }
  return current.store
}
const storeOf = (ctx?: { documents?: unknown }): DocumentStore => (ctx?.documents as DocumentStore | undefined) ?? getDocumentStore()

/** list_datasets 里附带的文档清单（名称过一遍去个人信息） */
export function documentsForModel(ctx?: { documents?: unknown }): Array<{ id: string; name: string; kind: DocKind; chars: number; importedAt: string }> {
  try { return storeOf(ctx).list().map(d => ({ id: d.id, name: scrubPII(d.name), kind: d.kind, chars: d.chars, importedAt: d.importedAt })) } catch { return [] }
}

const KIND_LABEL: Record<DocKind, string> = { image: '图片（识别出的文字）', pdf: 'PDF', docx: 'Word', text: '文本' }

export const readDocument: ToolDef<{ documentId: string; from?: number; maxChars?: number }> = {
  name: 'read_document',
  description: `读一份用户导入的文档资料（图片识别出的文字、PDF、Word、文本）的文字内容。documentId 来自 list_datasets 返回的 documents。长文档分段读：from 是起始字位置（默认 0），一次最多 ${DOC_READ_MAX} 字；返回里 nextFrom 不为空说明后面还有。手机号、身份证号等已去掉。`,
  params: z.object({ documentId: z.string().describe('文档 id（来自 list_datasets 的 documents）'), from: z.number().int().min(0).optional(), maxChars: z.number().int().min(500).max(DOC_READ_MAX).optional() }),
  level: 'read',
  async run(args, ctx) {
    try {
      const s = storeOf(ctx as { documents?: unknown })
      const d = s.get(args.documentId)
      if (!d) return { error: '找不到这份文档，请先用 list_datasets 看有哪些' }
      const all = s.text(d.id)
      const from = Math.min(args.from ?? 0, all.length)
      const end = Math.min(all.length, from + (args.maxChars ?? DOC_READ_MAX))
      return { id: d.id, name: scrubPII(d.name), kind: KIND_LABEL[d.kind], totalChars: all.length, from, to: end, nextFrom: end < all.length ? end : null, text: scrubPII(all.slice(from, end)) }
    } catch (e) { return { error: (e as Error).message } }
  }
}
