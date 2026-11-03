/**
 * 剧本（playbook）文件的解析与校验：Markdown 开头是 frontmatter（--- 包起来的 key: value），正文是分析方法。
 * 纯函数，不依赖 electron；Agent 内核读取剧本文本后用它取 name / description / roles / when。
 */
export const PLAYBOOK_ROLES = ['运营', '辅导老师', '教研', '授课老师'] as const
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number]

export interface Playbook { name: string; description: string; roles: PlaybookRole[]; when: string; body: string }

export function parsePlaybook(md: string): { ok: true; playbook: Playbook } | { ok: false; error: string } {
  const text = md.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { ok: false, error: '缺少 frontmatter（文件开头要有 --- 包起来的头部）' }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (!kv) return { ok: false, error: `frontmatter 里这一行格式不对：${line}` }
    meta[kv[1]] = kv[2].trim()
  }
  for (const k of ['name', 'description', 'roles', 'when']) if (!meta[k]) return { ok: false, error: `frontmatter 缺少 ${k}` }
  const list = /^\[(.*)\]$/.exec(meta.roles)
  if (!list) return { ok: false, error: 'roles 要写成 [运营, 辅导老师] 这样的列表' }
  const roles = list[1].split(/[,，]/).map(s => s.trim()).filter(Boolean)
  const bad = roles.filter(r => !(PLAYBOOK_ROLES as readonly string[]).includes(r))
  if (!roles.length || bad.length) return { ok: false, error: `roles 只能从 ${PLAYBOOK_ROLES.join('、')} 里选${bad.length ? `，不认识：${bad.join('、')}` : ''}` }
  if (!/^[a-z][a-z0-9-]*$/.test(meta.name)) return { ok: false, error: 'name 只能用小写英文字母、数字和连字符' }
  const body = m[2].trim()
  if (!body) return { ok: false, error: '正文是空的' }
  return { ok: true, playbook: { name: meta.name, description: meta.description, roles: roles as PlaybookRole[], when: meta.when, body } }
}
