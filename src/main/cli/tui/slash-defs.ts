/**
 * 斜杠命令的名单与匹配（纯函数，单测直接加载）。命令怎么执行在 actions.ts。
 */

export interface SlashDef { name: string; args?: string; desc: string }

export const SLASH_COMMANDS: SlashDef[] = [
  { name: 'help', desc: '查看命令和快捷键' },
  { name: 'status', desc: '版本、数据目录、AI 和识别组件状态' },
  { name: 'import', args: '<路径…>', desc: '导入试卷（PDF、图片、Word），解析完成后待审核' },
  { name: 'papers', desc: '试卷列表' },
  { name: 'report', desc: '生成报告（选读者）' },
  { name: 'datasets', desc: '已导入的数据集' },
  { name: 'role', desc: '切换助手角色' },
  { name: 'mode', desc: '切换回答方式：直接回答 / 先出计划 / 自动完成' },
  { name: 'model', desc: '切换模型' },
  { name: 'new', desc: '开始新对话' },
  { name: 'history', desc: '回到以前的对话' },
  { name: 'clear', desc: '清屏' },
  { name: 'exit', desc: '退出' }
]

/** 输入框里的内容是不是正在敲斜杠命令名（以 / 开头、还没有空格）：返回匹配的命令，按「前缀优先、其次包含」排序 */
export function matchSlash(input: string, defs: SlashDef[] = SLASH_COMMANDS): SlashDef[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const q = input.slice(1).toLowerCase()
  if (!q) return defs
  const starts = defs.filter(d => d.name.startsWith(q))
  const has = defs.filter(d => !d.name.startsWith(q) && (d.name.includes(q) || d.desc.includes(q)))
  return [...starts, ...has]
}

/** 拆出 /命令 和后面的参数；不是斜杠命令返回 null。/quit 当 /exit */
export function parseSlash(input: string): { name: string; arg: string } | null {
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(input.trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  return { name: name === 'quit' || name === 'q' ? 'exit' : name, arg: m[2].trim() }
}

/**
 * 把拖进终端的路径拆开：支持 'a b.pdf'、"a b.pdf"、a\ b.pdf、file:// 前缀、~/ 开头。
 * 只做拆分和去转义，是不是真有这个文件由调用方检查。
 */
export function splitPaths(s: string, home: string): string[] {
  const out: string[] = []
  let cur = '', quote = '', has = false
  const push = (): void => { if (has) out.push(cur); cur = ''; has = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
    } else if (c === "'" || c === '"') { quote = c; has = true }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true }
    else if (/\s/.test(c)) push()
    else { cur += c; has = true }
  }
  push()
  return out.map(p => {
    let x = p
    if (x.startsWith('file://')) { try { x = decodeURIComponent(x.slice(7)) } catch { x = x.slice(7) } }
    if (x === '~') return home
    if (x.startsWith('~/')) return home + x.slice(1)
    return x
  })
}
