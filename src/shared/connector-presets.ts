/**
 * 连接目录：常见 MCP 服务器的预设 + 自定义 MCP 的配置生成与校验。纯函数，不依赖 electron，主进程、界面和单元测试共用。
 * 预设只列出确认存在的包 / 地址；拿不准的标「需要自行确认」。不内置任何 MCP 程序，只帮用户填好启动方式。
 */

export type PresetFieldTarget =
  | 'env'        // 环境变量（加密保存）
  | 'header'     // 请求头（加密保存），可带前缀如 Bearer
  | 'arg'        // 命令参数（明文，如文件夹路径）；有 flag 时先放 flag
  | 'secretArg'  // 命令参数（加密保存，如应用密钥）；有 flag 时先放 flag
  | 'url'        // 整个网址（加密保存，网址里常带密钥）

export interface PresetField {
  key: string
  label: string
  target: PresetFieldTarget
  /** env 变量名 / header 名 */
  name?: string
  /** header 值前缀，例如 'Bearer ' */
  prefix?: string
  /** arg / secretArg 前面的参数名，例如 '-a' */
  flag?: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  kind?: 'text' | 'folder' | 'url'
}

export interface McpPreset {
  id: string
  name: string
  desc: string
  /** lucide-react 图标名 */
  icon: string
  group: 'office' | 'dev' | 'tool'
  transport: { kind: 'stdio'; command: string; args: string[] } | { kind: 'http'; url?: string }
  fields: PresetField[]
  docs: string
  /** 'confirm'：来源只有第三方资料或没法长期保证，界面标「需要自行确认」 */
  confidence: 'official' | 'confirm'
  /** 补充说明（一句话） */
  note?: string
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'feishu', name: '飞书', desc: '读写飞书的消息、文档、多维表格、日历。', icon: 'MessagesSquare', group: 'office',
    transport: { kind: 'stdio', command: 'npx', args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp'] },
    fields: [
      { key: 'appId', label: 'App ID', target: 'arg', flag: '-a', required: true, placeholder: 'cli_xxxxxxxx' },
      { key: 'appSecret', label: 'App Secret', target: 'secretArg', flag: '-s', secret: true, required: true }
    ],
    docs: 'https://github.com/larksuite/lark-openapi-mcp', confidence: 'official',
    note: '需要先在飞书开放平台建一个企业自建应用，并开通所需权限。电脑上要装有 Node.js。'
  },
  {
    id: 'lark', name: 'Lark（国际版）', desc: '飞书国际版：消息、文档、多维表格、日历。', icon: 'Globe', group: 'office',
    transport: { kind: 'stdio', command: 'npx', args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '--domain', 'https://open.larksuite.com'] },
    fields: [
      { key: 'appId', label: 'App ID', target: 'arg', flag: '-a', required: true, placeholder: 'cli_xxxxxxxx' },
      { key: 'appSecret', label: 'App Secret', target: 'secretArg', flag: '-s', secret: true, required: true }
    ],
    docs: 'https://github.com/larksuite/lark-openapi-mcp', confidence: 'official',
    note: '应用要在 Lark 国际版平台创建，和飞书的应用不通用。'
  },
  {
    id: 'dingtalk', name: '钉钉', desc: '钉钉官方 MCP：日历、待办、AI 表格、文档等。', icon: 'BellRing', group: 'office',
    transport: { kind: 'http' },
    fields: [
      { key: 'url', label: 'MCP 地址', target: 'url', secret: true, required: true, kind: 'url', placeholder: '在钉钉 AI Hub 复制的 MCP 地址' }
    ],
    docs: 'https://aihub.dingtalk.com', confidence: 'confirm',
    note: '地址要在钉钉 AI Hub 里选服务后复制，地址里带密钥；服务范围以钉钉当前提供的为准。'
  },
  {
    id: 'notion', name: 'Notion', desc: '读取和编辑 Notion 页面与数据库。', icon: 'NotebookText', group: 'office',
    transport: { kind: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    fields: [
      { key: 'token', label: 'Integration Token', target: 'env', name: 'NOTION_TOKEN', secret: true, required: true, placeholder: 'ntn_…' }
    ],
    docs: 'https://github.com/makenotion/notion-mcp-server', confidence: 'official',
    note: '这是本地版。Notion 官方推荐的在线版要走网页授权登录，卷知暂不支持。页面要先在 Notion 里分享给这个集成。'
  },
  {
    id: 'github', name: 'GitHub', desc: '查看仓库、议题和代码，需要时创建议题。', icon: 'GitBranch', group: 'dev',
    transport: { kind: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    fields: [
      { key: 'token', label: 'Personal Access Token', target: 'header', name: 'Authorization', prefix: 'Bearer ', secret: true, required: true, placeholder: 'github_pat_…' }
    ],
    docs: 'https://github.com/github/github-mcp-server', confidence: 'official',
    note: '令牌只给需要的权限；用「只用读取类工具」可以避免助手改动仓库。'
  },
  {
    id: 'filesystem', name: '本机文件夹', desc: '让助手读取你指定的文件夹里的文件。', icon: 'FolderOpen', group: 'tool',
    transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    fields: [
      { key: 'folder', label: '允许访问的文件夹', target: 'arg', required: true, kind: 'folder', placeholder: '/Users/你/Documents/试卷' }
    ],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', confidence: 'official',
    note: '只有这个文件夹里的内容能被访问。含学生信息的文件夹请谨慎选择。'
  },
  {
    id: 'fetch', name: '网页抓取', desc: '读取一个网址的网页内容。', icon: 'Link', group: 'tool',
    transport: { kind: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    fields: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch', confidence: 'official',
    note: '需要先安装 uv（提供 uvx 命令）。'
  }
]

export const PRESET_GROUPS: Array<{ id: McpPreset['group']; label: string }> = [
  { id: 'office', label: '办公协作' },
  { id: 'dev', label: '开发' },
  { id: 'tool', label: '通用工具' }
]

export const getPreset = (id: string): McpPreset | undefined => MCP_PRESETS.find(p => p.id === id)

// ───────────────────────── 配置结构（和 main/connectors/mcp.ts 的 McpConfigSchema 对应） ─────────────────────────

export interface McpConfigInput {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  secretArgs?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  preset?: string
}

export type Validation = { ok: true } | { ok: false; error: string; field?: string }

const bad = (error: string, field?: string): Validation => ({ ok: false, error, field })

export function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}

const looksAbsolute = (p: string): boolean => /^(\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(p)

/** 校验预设的填写项 */
export function validatePresetValues(preset: McpPreset, values: Record<string, string>): Validation {
  for (const f of preset.fields) {
    const v = (values[f.key] ?? '').trim()
    if (!v) { if (f.required) return bad(`请填写「${f.label}」`, f.key); continue }
    if (/[\r\n]/.test(v)) return bad(`「${f.label}」不能换行`, f.key)
    if (f.kind === 'url' && !isHttpUrl(v)) return bad(`「${f.label}」要以 http:// 或 https:// 开头`, f.key)
    if (f.kind === 'folder' && !looksAbsolute(v)) return bad(`「${f.label}」要填完整路径`, f.key)
    if ((f.target === 'arg' || f.target === 'secretArg') && !f.flag && v.startsWith('-')) return bad(`「${f.label}」不能以 - 开头`, f.key)
  }
  return { ok: true }
}

/** 预设 + 填写项 → 连接配置（先调用 validatePresetValues） */
export function buildPresetConfig(preset: McpPreset, values: Record<string, string>): McpConfigInput {
  const val = (f: PresetField): string => (values[f.key] ?? '').trim()
  const filled = preset.fields.filter(f => val(f))
  if (preset.transport.kind === 'http') {
    const headers: Record<string, string> = {}
    let url = preset.transport.url ?? ''
    for (const f of filled) {
      if (f.target === 'header' && f.name) headers[f.name] = (f.prefix ?? '') + val(f)
      if (f.target === 'url') url = val(f)
    }
    return { transport: 'http', url, headers, preset: preset.id }
  }
  const args = [...preset.transport.args]
  const secretArgs: string[] = []
  const env: Record<string, string> = {}
  for (const f of filled) {
    if (f.target === 'env' && f.name) env[f.name] = val(f)
    else if (f.target === 'arg') args.push(...(f.flag ? [f.flag] : []), val(f))
    else if (f.target === 'secretArg') secretArgs.push(...(f.flag ? [f.flag] : []), val(f))
  }
  return { transport: 'stdio', command: preset.transport.command, args, secretArgs, env, preset: preset.id }
}

// ───────────────────────── 自定义 MCP ─────────────────────────

/** 每行 `名称=值`（环境变量）或 `名称: 值`（请求头）→ 对象；无效行忽略 */
export function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0 && line.trim()) {
      const k = line.slice(0, i).trim()
      if (k) out[k] = line.slice(i + 1).trim()
    }
  }
  return out
}

export interface CustomInput { mode: 'stdio' | 'http'; command: string; argsText: string; envText: string; url: string; headersText: string }

export function validateCustom(i: CustomInput): Validation {
  if (i.mode === 'stdio') return i.command.trim() ? { ok: true } : bad('请填写命令', 'command')
  if (!i.url.trim()) return bad('请填写网址', 'url')
  if (!isHttpUrl(i.url.trim())) return bad('网址要以 http:// 或 https:// 开头', 'url')
  for (const line of i.headersText.split('\n')) {
    if (line.trim() && line.indexOf(':') <= 0) return bad('请求头每行写成「名称: 值」', 'headers')
  }
  return { ok: true }
}

export function buildCustomConfig(i: CustomInput): McpConfigInput {
  if (i.mode === 'http') return { transport: 'http', url: i.url.trim(), headers: parsePairs(i.headersText, ':') }
  return { transport: 'stdio', command: i.command.trim(), args: i.argsText.split('\n').map(s => s.trim()).filter(Boolean), env: parsePairs(i.envText, '=') }
}
