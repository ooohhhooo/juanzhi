/**
 * 工具注册表：注册、按名字取、生成发给模型的工具清单、校验参数。
 * 想给助手加新工具（运营数据、辅导跟进清单……）：写一个 ToolDef，register 进来，再把名字加进某个角色的 tools 名单就行。
 */
import type { ToolSpec } from '../ai/client.ts'
import { toJsonSchema } from './schema.ts'
import type { ToolDef } from './types.ts'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register<A>(t: ToolDef<A>): this {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`工具名不合法：${t.name}`)
    if (this.tools.has(t.name)) throw new Error(`工具重名：${t.name}`)
    this.tools.set(t.name, t as ToolDef)
    return this
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name) }
  names(): string[] { return [...this.tools.keys()] }

  /** 给模型看的工具清单；names 不给 = 全部，给了就只要名单里存在的 */
  specs(names?: string[]): ToolSpec[] {
    const list = names ? names.map(n => this.tools.get(n)).filter((t): t is ToolDef => !!t) : [...this.tools.values()]
    return list.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsonSchema(t.schema) } }))
  }

  /** 解析模型给的参数字符串并用 zod 校验；失败返回给模型看的白话错误，让它改 */
  parseArgs(name: string, raw: string): { ok: true; args: unknown } | { ok: false; error: string } {
    const t = this.tools.get(name)
    if (!t) return { ok: false, error: `没有叫「${name}」的工具。可用的工具：${this.names().join('、')}` }
    let obj: unknown = {}
    if (raw.trim()) {
      try { obj = JSON.parse(raw) } catch { return { ok: false, error: `参数不是合法的 JSON，请重新给出：${raw.slice(0, 120)}` } }
    }
    const r = t.schema.safeParse(obj)
    if (!r.success) {
      const msg = r.error.issues.map(i => `${i.path.join('.') || '（整体）'}：${i.message}`).join('；')
      return { ok: false, error: `参数不符合要求：${msg}。请按工具说明改正后重新调用。` }
    }
    return { ok: true, args: r.data }
  }
}
