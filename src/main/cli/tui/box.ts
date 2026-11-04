/**
 * 交互界面启动前（拿运行锁失败、数据目录不可用等）的报错：画在一个圆角框里，不输出 JSON。
 * 纯函数 + 少量 ANSI，不依赖 Ink，单测直接加载。
 */
import { charWidth, textWidth } from './markdown.ts'

/** 按显示宽度折行（中文每字 2 列） */
export function wrapWidth(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let cur = '', w = 0
    for (const ch of para) {
      const cw = charWidth(ch.codePointAt(0)!)
      if (w + cw > width) { out.push(cur); cur = ''; w = 0 }
      cur += ch; w += cw
    }
    out.push(cur)
  }
  return out
}

export function boxLines(title: string, body: string, columns: number): string[] {
  const inner = Math.max(24, Math.min(columns, 84) - 4)
  const rows = wrapWidth(body, inner)
  const pad = (s: string): string => s + ' '.repeat(Math.max(0, inner - textWidth(s)))
  const top = '╭' + '─'.repeat(inner + 2) + '╮'
  const bottom = '╰' + '─'.repeat(inner + 2) + '╯'
  return [top, `│ ${pad(title)} │`, `│ ${pad('')} │`, ...rows.map(r => `│ ${pad(r)} │`), bottom]
}

export function errorBox(message: string, opts: { columns?: number; color?: boolean } = {}): string {
  const columns = opts.columns ?? process.stdout.columns ?? 80
  const color = opts.color ?? !('NO_COLOR' in process.env || process.env.TERM === 'dumb')
  const lines = boxLines('✦ 卷知', message, columns)
  const paint = (s: string): string => (color ? `\x1b[38;2;143;148;255m${s}\x1b[0m` : s)
  return '\n' + lines.map(paint).join('\n') + '\n\n'
}
