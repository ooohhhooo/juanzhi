import { ToolRegistry } from '../registry.ts'
import { BUILTIN_TOOLS } from './builtin.ts'
import { DATA_TOOLS } from './data.ts'

/** 默认的工具注册表。后续接运营 / 辅导的数据工具：写好 ToolDef，加进下面的数组，再把名字写进 roles.ts 的 tools */
export function createRegistry(extra: Array<(typeof BUILTIN_TOOLS)[number]> = []): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of [...BUILTIN_TOOLS, ...DATA_TOOLS, ...extra]) r.register(t)
  return r
}
