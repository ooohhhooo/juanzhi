/**
 * 总入口的纯逻辑部分（不依赖 electron，可单测）：把分析 / 产出 / 连接器三组工具统一成 AgentTool。
 * electron 部分（读连接器配置）在 ./all-tools.ts。
 *
 * level 词表：read / draft / write / external。
 *  - 产出模块的 'auto'（只写本会话自己的产出目录）映射为 'draft'；
 *  - 连接器的 connectors_list 映射为 'read'，其余连接器工具是 'external'，preview 返回「发到哪里 + 完整内容」。
 */
import type { ZodType } from 'zod'
import type { AgentTool, AgentToolContext, AgentToolLevel } from './tool-types.ts'
import type { AgentTool as ConnectorTool } from '../connectors/types.ts'
import { OUTPUT_TOOLS } from './outputs/tools.ts'
import { registerBoard } from './outputs/store.ts'
import { setTableExporter } from './outputs/export.ts'
import { analysisTools } from '../analysis/tools-adapter.ts'
import { exportTableXlsx } from '../analysis/report/export-xlsx.ts'
import { getBoard } from '../analysis/report/tools.ts'
import fs from 'node:fs'

/** 产出模块的表格 → xlsx 接到看板模块的 exportTableXlsx（幂等） */
export function installTableExporter(): void {
  setTableExporter(async o => {
    const columns = o.columns.map((label, i) => ({ key: `c${i}`, label, format: 'text' as const }))
    const rows = o.rows.map(r => Object.fromEntries(columns.map((c, i) => [c.key, r[i] ?? ''])))
    fs.writeFileSync(o.outPath, await exportTableXlsx(columns, rows, o.name.slice(0, 31) || '名单'))
  })
}

/** 分析工具 + 看板登记：board_start 成功后把看板登记进产出列表（一个会话一个看板，boardId = sessionId） */
function analysisWithBoardRegistration(): AgentTool[] {
  return analysisTools().map(t => {
    if (t.name !== 'board_start') return t
    return {
      ...t,
      async run(args: any, ctx: AgentToolContext) {
        const out: any = await t.run(args, ctx)
        if (out?.ok) {
          const spec = getBoard({ sessionId: ctx.sessionId, dataDir: ctx.dataDir })
          registerBoard({ dataDir: ctx.dataDir, sessionId: ctx.sessionId }, ctx.sessionId, spec?.title ?? args.title)
        }
        return out
      }
    }
  })
}

function outputAgentTools(): AgentTool[] {
  return OUTPUT_TOOLS.map(t => {
    const level: AgentToolLevel = t.level === 'auto' ? 'draft' : 'write'
    return {
      name: t.name, description: t.description, params: t.params as ZodType<any>, level,
      preview: t.name === 'output_export' ? (a: any) => `把产出 ${a.id} 导出成 ${a.format} 文件，放在本次任务的 exports 文件夹里` : undefined,
      run: async (args: any, ctx: AgentToolContext) => t.run(args, { sessionId: ctx.sessionId, dataDir: ctx.dataDir })
    }
  })
}

export function connectorAgentTools(tools: ConnectorTool[]): AgentTool[] {
  return tools.map(t => {
    if (t.name === 'connectors_list') {
      return { name: t.name, description: t.description, params: t.params as ZodType<any>, level: 'read' as const, run: (a: any, ctx: AgentToolContext) => t.run(a, { signal: ctx.signal }) }
    }
    return {
      name: t.name, description: t.description, params: t.params as ZodType<any>, level: 'external' as const,
      preview: typeof t.preview === 'function' ? (a: any) => t.preview(a) : undefined,
      run: (a: any, ctx: AgentToolContext) => t.run(a, { signal: ctx.signal })
    }
  })
}

/** 三组工具合在一起；工具名重复直接报错（内核注册时一眼能看到） */
export function composeTools(connectorTools: ConnectorTool[]): AgentTool[] {
  installTableExporter()
  const all = [...analysisWithBoardRegistration(), ...outputAgentTools(), ...connectorAgentTools(connectorTools)]
  const seen = new Set<string>()
  for (const t of all) {
    if (seen.has(t.name)) throw new Error(`工具名重复：${t.name}`)
    seen.add(t.name)
    if (t.level === 'external' && !t.preview) throw new Error(`external 工具必须有 preview：${t.name}`)
  }
  return all
}
