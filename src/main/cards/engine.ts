/**
 * 版式引擎（纯函数，不依赖 electron）：把 layouts/<kind>.html 里的模板和卡片内容拼成 HTML。
 * 模板语法（刻意很小，设计师改版式时不用碰代码）：
 *   {{字段}}        取值并做 HTML 转义（任何内容都会被转义）；字段可写成 a.b
 *   {{{字段}}}      不转义，只用于程序自己生成并已转义过的片段（如高亮后的口诀）
 *   {{#each 列表}}…{{/each}}   循环；块内 {{字段}} 先取当前项，取不到再往外层找；{{@n}} = 序号（1 起），{{@nn}} = 两位序号 01
 *   {{#if 字段}}…{{/if}}       字段有内容时才输出；{{#if 字段}}…{{else}}…{{/if}}
 */

export const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string; raw: boolean }
  | { t: 'each'; path: string; body: Node[] }
  | { t: 'if'; path: string; body: Node[]; other: Node[] }

const TOKEN = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g

export function parseTemplate(src: string): Node[] {
  const root: Node[] = []
  const stack: Array<{ node: Node; list: Node[]; kind: 'each' | 'if' }> = []
  let cur = root
  let last = 0
  const push = (n: Node) => cur.push(n)
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index ?? 0
    if (i > last) push({ t: 'text', v: src.slice(last, i) })
    last = i + m[0].length
    if (m[1]) { push({ t: 'var', path: m[1], raw: true }); continue }
    const tag = m[2]
    let mm: RegExpExecArray | null
    if ((mm = /^#each\s+(\S+)$/.exec(tag))) {
      const node: Node = { t: 'each', path: mm[1], body: [] }
      push(node); stack.push({ node, list: cur, kind: 'each' }); cur = node.body
    } else if ((mm = /^#if\s+(\S+)$/.exec(tag))) {
      const node: Node = { t: 'if', path: mm[1], body: [], other: [] }
      push(node); stack.push({ node, list: cur, kind: 'if' }); cur = node.body
    } else if (tag === 'else') {
      const top = stack[stack.length - 1]
      if (!top || top.node.t !== 'if') throw new Error('模板里的 {{else}} 没有对应的 {{#if}}')
      cur = top.node.other
    } else if (tag === '/each' || tag === '/if') {
      const top = stack.pop()
      if (!top || top.kind !== tag.slice(1)) throw new Error(`模板里的 {{${tag}}} 没有对应的开头`)
      cur = top.list
    } else push({ t: 'var', path: tag, raw: false })
  }
  if (last < src.length) push({ t: 'text', v: src.slice(last) })
  if (stack.length) throw new Error('模板里有没有闭合的 {{#each}} / {{#if}}')
  return root
}

type Scope = { data: unknown; idx?: number }

function lookup(scopes: Scope[], path: string): unknown {
  if (path === '@n' || path === '@nn') {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].idx !== undefined) return path === '@n' ? scopes[i].idx! + 1 : String(scopes[i].idx! + 1).padStart(2, '0')
    return ''
  }
  const parts = path === 'this' ? [] : path.split('.')
  for (let i = scopes.length - 1; i >= 0; i--) {
    let v: unknown = scopes[i].data
    if (parts.length === 0) return v
    let ok = true
    for (const p of parts) {
      if (v && typeof v === 'object' && p in (v as Record<string, unknown>)) v = (v as Record<string, unknown>)[p]
      else { ok = false; break }
    }
    if (ok) return v
  }
  return undefined
}
const truthy = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '' && v !== false

function run(nodes: Node[], scopes: Scope[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') out += n.v
    else if (n.t === 'var') { const v = lookup(scopes, n.path); out += n.raw ? String(v ?? '') : escapeHtml(v) }
    else if (n.t === 'if') out += run(truthy(lookup(scopes, n.path)) ? n.body : n.other, scopes)
    else {
      const list = lookup(scopes, n.path)
      if (Array.isArray(list)) list.forEach((item, idx) => { out += run(n.body, [...scopes, { data: item, idx }]) })
    }
  }
  return out
}

export function renderTemplate(src: string | Node[], data: unknown): string {
  const nodes = typeof src === 'string' ? parseTemplate(src) : src
  return run(nodes, [{ data }])
}
