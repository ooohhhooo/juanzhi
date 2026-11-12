/**
 * 剧本（playbook）文件的解析与校验：Markdown 开头是 frontmatter（--- 包起来的 key: value），正文是分析方法。
 * 纯函数，不依赖 electron；Agent 内核读取剧本文本后用它取 name / description / roles / when。
 */
export const PLAYBOOK_ROLES = ['运营', '辅导老师', '教研', '主讲老师', '授课老师'] as const
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number]
/** 角色可以写中文名，也可以写内核里的角色编号；解析后统一成编号（内核按编号给角色筛选剧本） */
export const ROLE_IDS: Record<string, string> = { 运营: 'ops', 辅导老师: 'tutor', 教研: 'research', 主讲老师: 'teacher', 授课老师: 'teacher', ops: 'ops', tutor: 'tutor', research: 'research', teacher: 'teacher' }

/** roles 是角色编号（ops / tutor / research / teacher） */
export interface Playbook { name: string; description: string; roles: string[]; when: string; body: string }

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
  for (const k of ['name', 'description']) if (!meta[k]) return { ok: false, error: `frontmatter 缺少 ${k}` }
  // roles 可以不写（= 所有角色）；写了就要是 [运营, 辅导老师] 这样的列表
  const list = meta.roles === undefined ? ['', ''] : /^\[(.*)\]$/.exec(meta.roles)
  if (!list) return { ok: false, error: 'roles 要写成 [运营, 辅导老师] 这样的列表' }
  const roles = list[1].split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  const bad = roles.filter(r => !(r in ROLE_IDS))
  if ((meta.roles !== undefined && !roles.length) || bad.length) return { ok: false, error: `roles 只能从 ${PLAYBOOK_ROLES.join('、')} 里选${bad.length ? `，不认识：${bad.join('、')}` : ''}` }
  if (!/^[a-z][a-z0-9-]*$/.test(meta.name) && !/^[\u4e00-\u9fff][\u4e00-\u9fffa-z0-9-]{0,39}$/.test(meta.name)) return { ok: false, error: 'name 只能用小写英文字母、数字和连字符，或者中文名' }
  const body = m[2].trim()
  if (!body) return { ok: false, error: '正文是空的' }
  return { ok: true, playbook: { name: meta.name, description: meta.description, roles: [...new Set(roles.map(r => ROLE_IDS[r]))], when: meta.when ?? '', body } }
}
