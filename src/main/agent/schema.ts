/**
 * zod → JSON Schema（只支持助手工具参数用到的那一小部分），不加新依赖。
 * 工具参数写成 zod，一份定义同时用来校验模型给的参数、生成发给模型的参数说明。
 */
import type { z } from 'zod'

type Json = Record<string, unknown>

function unwrap(t: any): { inner: any; optional: boolean; nullable: boolean; def?: unknown; hasDefault: boolean; description?: string } {
  let optional = false, nullable = false, hasDefault = false
  let def: unknown
  let description: string | undefined = t?._def?.description
  let cur = t
  for (let i = 0; i < 10; i++) {
    const n = cur?._def?.typeName
    if (n === 'ZodOptional') { optional = true; cur = cur._def.innerType }
    else if (n === 'ZodNullable') { nullable = true; cur = cur._def.innerType }
    else if (n === 'ZodDefault') { hasDefault = true; def = cur._def.defaultValue(); cur = cur._def.innerType }
    else if (n === 'ZodEffects') cur = cur._def.schema
    else break
    description = description ?? cur?._def?.description
  }
  return { inner: cur, optional, nullable, def, hasDefault, description: description ?? cur?._def?.description }
}

export function toJsonSchema(t: z.ZodTypeAny): Json {
  const u = unwrap(t)
  const d = u.inner._def
  let out: Json
  switch (d.typeName) {
    case 'ZodString': {
      out = { type: 'string' }
      for (const c of d.checks ?? []) {
        if (c.kind === 'min') out.minLength = c.value
        else if (c.kind === 'max') out.maxLength = c.value
      }
      break
    }
    case 'ZodNumber': {
      out = { type: 'number' }
      for (const c of d.checks ?? []) {
        if (c.kind === 'int') out.type = 'integer'
        else if (c.kind === 'min') out.minimum = c.value
        else if (c.kind === 'max') out.maximum = c.value
      }
      break
    }
    case 'ZodBoolean': out = { type: 'boolean' }; break
    case 'ZodEnum': out = { type: 'string', enum: [...d.values] }; break
    case 'ZodLiteral': out = { const: d.value }; break
    case 'ZodArray': {
      out = { type: 'array', items: toJsonSchema(d.type) }
      if (d.minLength) out.minItems = d.minLength.value
      if (d.maxLength) out.maxItems = d.maxLength.value
      break
    }
    case 'ZodUnion': out = { anyOf: (d.options as z.ZodTypeAny[]).map(toJsonSchema) }; break
    case 'ZodObject': {
      const props: Json = {}
      const required: string[] = []
      const shape = d.shape()
      for (const [k, v] of Object.entries(shape)) {
        props[k] = toJsonSchema(v as z.ZodTypeAny)
        const uu = unwrap(v)
        if (!uu.optional && !uu.hasDefault) required.push(k)
      }
      out = { type: 'object', properties: props, ...(required.length ? { required } : {}), additionalProperties: false }
      break
    }
    default: out = {}
  }
  if (u.nullable && typeof out.type === 'string') out.type = [out.type, 'null']
  if (u.hasDefault && u.def !== undefined) out.default = u.def
  if (u.description) out.description = u.description
  return out
}
