/**
 * 给 Agent 的工具定义。全部是 level 'external'（对外操作）：内核每次执行前要弹窗，
 * 用 preview(args) 的结果展示「发到哪里 + 完整内容」，用户点「发送」才调用 run。
 */
import fs from 'node:fs'
import { z } from 'zod'
import type { AgentTool, ToolPreview } from './types'
import { CONNECTORS, getConnector } from './registry'
import { findByName, listEntries, fullConfig } from './store'
import { checkSendableFile } from './wecom'
import { markdownSegments, textSegments } from './wecom-core'
import { privacyWarning } from './privacy'
import { mcpToolName, uniqueToolName, withMcp } from './mcp-client'

export const connectorsList: AgentTool = {
  name: 'connectors_list',
  description: '列出用户已配置的外部连接（企业微信群、MCP 服务器）的名称和能做什么。不含任何密钥。',
  params: z.object({}),
  level: 'external',
  async preview() { return { target: '卷知', content: '查看已配置的连接器（只读）' } },
  async run() {
    const rows = listEntries().map(e => {
      const c = getConnector(e.type)
      return `- ${e.name}（${c?.name ?? e.type}）${e.type === 'wecom' ? '：可发文字 / Markdown / 文件' : `：可用工具 ${(e.allowed ?? []).join('、') || '无'}`}`
    })
    return { ok: true, message: rows.length ? rows.join('\n') : '还没有配置任何连接' }
  }
}

const WecomSendParams = z.object({
  targetName: z.string().min(1),
  kind: z.enum(['text', 'markdown', 'file']),
  content: z.string().optional(),
  fileRef: z.string().optional()
})
type WecomSendArgs = z.infer<typeof WecomSendParams>

function targetOf(a: WecomSendArgs): { config: any } {
  const t = findByName('wecom', a.targetName)
  if (!t) throw new Error(`没有名为「${a.targetName}」的企业微信群连接`)
  return t
}

export const wecomSend: AgentTool = {
  name: 'wecom_send',
  description: '发消息到用户配置的企业微信群。kind=text / markdown 时用 content；kind=file 时用 fileRef（文件完整路径，不超过 20MB；只能是本次对话导出的文件，或用户刚在文件选择框里选的文件，数据集文件一律不能发）。需要用户确认后才会发出。',
  params: WecomSendParams,
  level: 'external',
  async preview(raw): Promise<ToolPreview> {
    const a = WecomSendParams.parse(raw)
    targetOf(a)
    const target = `企业微信群：${a.targetName}`
    if (a.kind === 'file') {
      if (!a.fileRef) throw new Error('缺少文件路径')
      const chk = checkSendableFile(a.fileRef, {}, { strict: false })
      if (chk.error) throw new Error(chk.error)
      let warn: string | undefined
      if (/\.(md|txt|csv|json)$/i.test(a.fileRef) && chk.size < 1_000_000) warn = privacyWarning(fs.readFileSync(a.fileRef, 'utf8'))
      else if (/\.(docx|xlsx|html?)$/i.test(a.fileRef)) warn = '文件内容无法在这里预览，发送前请确认里面没有不该外发的个人信息'
      return { target, content: `文件：${chk.name}（${(chk.size / 1024).toFixed(0)} KB）\n路径：${a.fileRef}`, privacyWarning: warn }
    }
    if (!a.content?.trim()) throw new Error('缺少内容')
    const segs = a.kind === 'markdown' ? markdownSegments(a.content) : textSegments(a.content)
    return { target, content: segs.join('\n\n———— 下一条 ————\n\n'), privacyWarning: privacyWarning(a.content) }
  },
  async run(raw, ctx) {
    const a = WecomSendParams.parse(raw)
    const t = targetOf(a)
    const act = (n: string) => CONNECTORS.find(c => c.id === 'wecom')!.actions.find(x => x.name === n)!
    if (a.kind === 'file') {
      if (!a.fileRef) return { ok: false, message: '缺少文件路径' }
      return act('send_file').run({ path: a.fileRef }, t.config, ctx ?? {})
    }
    if (!a.content?.trim()) return { ok: false, message: '缺少内容' }
    return act(a.kind === 'markdown' ? 'send_markdown' : 'send_text').run({ content: a.content }, t.config, ctx ?? {})
  }
}

/** 已启用（勾选过）的 MCP 工具，动态转成 Agent 工具 */
export function mcpTools(): AgentTool[] {
  const out: AgentTool[] = []
  const used = new Set<string>()
  for (const e of listEntries()) {
    if (e.type !== 'mcp') continue
    for (const name of e.allowed ?? []) {
      const def = (e.tools ?? []).find(t => t.name === name)
      if (!def) continue
      out.push({
        name: uniqueToolName(mcpToolName(e.name, name, 's' + e.id.slice(0, 4)), e.id, used),
        description: `[MCP · ${e.name}] ${def.description}`.slice(0, 1000),
        params: z.record(z.unknown()),
        inputSchema: def.inputSchema,
        level: 'external',
        async preview(args): Promise<ToolPreview> {
          const text = JSON.stringify(args ?? {}, null, 2)
          return { target: `外部 MCP 服务器：${e.name} · ${name}`, content: text, privacyWarning: privacyWarning(text) }
        },
        async run(args) {
          const f = fullConfig(e.id)
          if (!f) return { ok: false, message: '这个 MCP 连接已被删除' }
          try {
            const r = await withMcp(f.config, c => c.callTool(name, args))
            return { ok: !r.isError, message: r.text.slice(0, 20000) || (r.isError ? '工具返回了错误' : '完成') }
          } catch (err) { return { ok: false, message: (err as Error).message } }
        }
      })
    }
  }
  return out
}

/** 内核取用：全部连接器相关工具（每次调用都按当前配置重新生成） */
export function getConnectorTools(): AgentTool[] { return [connectorsList, wecomSend, ...mcpTools()] }
