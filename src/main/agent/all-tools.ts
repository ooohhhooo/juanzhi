/**
 * Agent 内核的工具总入口（依赖 electron）：每轮对话开始时调用一次，连接器工具按当前配置重新生成。
 * 配套：createRuntimeToolContext（../analysis/tools-runtime）生成 AgentToolContext；剧本用 ./playbooks 的 listPlaybooks / loadPlaybook。
 */
import { getConnectorTools } from '../connectors/tools'
import { composeTools } from './all-tools-core.ts'
import type { AgentTool } from './tool-types'

export function allTools(): AgentTool[] {
  return composeTools(getConnectorTools())
}
