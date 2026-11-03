/**
 * 分析工具的运行时接线（依赖 electron：默认数据集仓库、AI 配置、保存对话框）。单测不加载它。
 * Agent 内核每次对话调用 createRuntimeToolContext({ sessionId, dataDir, signal, onProgress })，把结果当 AgentToolContext 用。
 */
import type { AgentToolContext } from '../agent/tool-types'
import { exportBoardWithDialog } from './report/export-run'
import { runtimeClassifyAi, runtimeClassifyPrompts } from './stats/classify-runtime'
import { createAnalysisContext } from './tools-adapter'

export function createRuntimeToolContext(o: { sessionId: string; dataDir: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): AgentToolContext {
  return createAnalysisContext({
    ...o,
    classifyAi: runtimeClassifyAi,
    classifyPrompts: runtimeClassifyPrompts(),
    exportBoard: async (spec, format) => {
      const r = await exportBoardWithDialog(spec, format)
      return { saved: r.saved, path: r.path }
    }
  })
}
