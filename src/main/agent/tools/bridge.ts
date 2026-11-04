/**
 * 把「分析模块的统一工具 AgentTool（level: read / draft / write / external，带 preview）」适配成内核的 ToolDef。
 * 纯逻辑，不依赖 electron，可单测；电子相关的接线（createRuntimeToolContext、真名还原）由调用方通过 BridgeOptions 注入。
 *
 * 规则：
 *  - read / draft → 内核 level 'read'（不需要同意）；
 *  - write → 内核 level 'write' + effect 'export'（写用户的文件；「只问对外发送」时免问）；
 *  - external → 内核 level 'write' + effect 'external'（发到外部，永远询问），同意弹窗展示 preview（target / content / privacyWarning）；
 *  - planSafe：只有概况类只读工具在「先出计划」阶段、用户确认计划前可用；run_query 和 stat_* 不行；
 *  - 发往外部服务的内容（企业微信、MCP）在预览和发送前把代号还原成真名；发给 AI 的（text_classify）保持代号，不还原。
 */
import type { ToolDef, ToolCtx, ToolOutput, ToolPreviewInfo } from '../types.ts'
import type { AgentTool, AgentToolContext } from '../tool-types.ts'

/** 计划阶段可用的概况类工具 */
export const PLAN_SAFE_TOOLS = new Set(['list_datasets', 'dataset_profile', 'column_values', 'connectors_list', 'outputs_list', 'board_preview', 'load_playbook', 'session_state', 'stats_overview'])
/** 内容会发给 AI 服务的工具：参数保持代号，不还原真名 */
export const AI_BOUND_TOOLS = new Set(['text_classify'])

export const TOOL_LABELS: Record<string, string> = {
  list_datasets: '看有哪些数据', dataset_profile: '看数据概况', run_query: '查数据', column_values: '看某一列的取值', read_document: '读文档',
  stat_nps: '算推荐分', stat_compare_groups: '分组对比', stat_find_low_groups: '找偏低的分组', stat_period_compare: '两期对比', stat_crosstab: '交叉统计',
  stat_multi_choice: '多选题统计', stat_option_impact: '选项影响分析', stat_distribution: '看分布', stat_ratio: '算占比', stat_middle_segment: '看中间段',
  text_classify: '文字归类', board_start: '新建看板', board_add_finding: '写核心发现', board_add_section: '加看板章节', board_add_block: '加图表或表格',
  board_set_caliber: '写口径说明', board_preview: '看板预览', board_export: '导出看板',
  doc_create: '新建汇报', doc_write_section: '写汇报小节', doc_read: '读汇报', table_save: '保存名单', outputs_list: '看已有产出', output_export: '导出产出',
  card_templates: '看卡片模板', card_make: '做分享卡片', connectors_list: '看已连接的外部', wecom_send: '发到企业微信'
}

export interface BridgeOptions {
  /** 为这一步工具调用生成分析模块的上下文（数据集仓库、AI、保存对话框等） */
  makeCtx: (ctx: ToolCtx) => AgentToolContext
  /** 把代号还原成真名（递归处理字符串）；不给就原样 */
  restore?: (sessionId: string, value: unknown) => unknown
  /** 工具参数里出现的数据集编号，登记为本会话用到的数据集（导出时用它们还原真名） */
  noteArgs?: (sessionId: string, args: unknown) => void
}

/** 工具返回值 → 内核的 ToolOutput；{ ok: false } 当作失败抛出，让模型看到错误 */
export function toOutput(out: unknown): ToolOutput {
  if (typeof out === 'string') return out
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>
    if (o.ok === false || (o.ok === undefined && typeof o.error === 'string' && Object.keys(o).length === 1)) throw new Error(String(o.error ?? o.message ?? '操作没有成功'))
    if (typeof o.text === 'string' && Object.keys(o).length === 1) return { text: o.text, count: 1 }
    const count = Array.isArray(out) ? out.length : Array.isArray(o.rows) ? (o.rows as unknown[]).length : undefined
    if (typeof o.message === 'string' && Object.keys(o).every(k => ['ok', 'message', 'data'].includes(k))) {
      const data = o.data === undefined ? '' : `\n${JSON.stringify(o.data)}`
      return { text: `${o.message}${data}`, ...(count !== undefined ? { count } : {}) }
    }
  }
  return { text: out === undefined ? '完成' : JSON.stringify(out), ...(Array.isArray(out) ? { count: out.length } : out && typeof out === 'object' && Array.isArray((out as any).rows) ? { count: (out as any).rows.length } : {}) }
}

export function adaptAgentTool(t: AgentTool, o: BridgeOptions): ToolDef {
  const bound = AI_BOUND_TOOLS.has(t.name)
  const prep = (ctx: ToolCtx, args: unknown): unknown => {
    o.noteArgs?.(ctx.sessionId, args)
    return t.level === 'external' && !bound && o.restore ? o.restore(ctx.sessionId, args) : args
  }
  const base = {
    name: t.name,
    description: t.description,
    schema: t.params as ToolDef['schema'],
    label: TOOL_LABELS[t.name] ?? t.name,
    ...(PLAN_SAFE_TOOLS.has(t.name) ? { planSafe: true } : {}),
    ...((t as any).inputSchema ? { inputSchema: (t as any).inputSchema as Record<string, unknown> } : {})
  }
  const run = async (args: unknown, ctx: ToolCtx): Promise<ToolOutput> => {
    const a = prep(ctx, args)
    const actx = o.makeCtx(ctx)
    return toOutput(await t.run(a, actx))
  }
  if (t.level === 'read' || t.level === 'draft') return { ...base, level: 'read', run }
  const preview = t.preview
    ? async (args: unknown, ctx: ToolCtx): Promise<ToolPreviewInfo | string> => {
        const r = await t.preview!(prep(ctx, args))
        return r
      }
    : undefined
  return {
    ...base, level: 'write', effect: t.level === 'external' ? 'external' : 'export', run,
    describe: (args: unknown) => (t.level === 'external' ? `把内容发到外部：${base.label}` : `${base.label}（会写文件）`),
    ...(preview ? { preview } : {})
  }
}

export function adaptAgentTools(list: AgentTool[], o: BridgeOptions): ToolDef[] {
  return list.map(t => adaptAgentTool(t, o))
}
