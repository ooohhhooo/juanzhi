/**
 * 卷知窗口正在运行时，人在终端里运行 `juanzhi`（交互界面或命令）看到的面板和「Enter 让窗口退出 / Esc 取消」的按键读取。
 * 不依赖 electron，单测直接加载。真正让窗口退出的是 lock.ts 的 sendLockRequest + index.ts 里的 handleLockRequest（只有窗口完全空闲才答应）。
 */
import { boxLines } from './tui/box.ts'

export const PANEL_TEXT = '卷知窗口正在运行。命令行和窗口不能同时用同一份数据。'
export const PANEL_PROMPT = '按 Enter 让卷知窗口退出并继续，按 Esc 取消'
export const BUSY_MESSAGE = '卷知正在处理任务，请等它结束后再试'
export const MANUAL_QUIT = 'Mac 上按 Cmd+Q 退出（只关窗口不行），Windows 上关闭窗口就是退出'
export const CANCELLED_MESSAGE = `已取消。卷知窗口还在运行；要自己退出它：${MANUAL_QUIT}`
export const UNSUPPORTED_MESSAGE = `这个版本的卷知窗口不能从命令行让它退出，请自己退出：${MANUAL_QUIT}`
export const TIMEOUT_MESSAGE = `卷知窗口还没有退出（等了 20 秒）。请自己退出它：${MANUAL_QUIT}`

export function windowRunningPanel(opts: { columns?: number; color?: boolean } = {}): string {
  const columns = opts.columns ?? process.stdout.columns ?? 80
  const color = opts.color ?? !('NO_COLOR' in process.env || process.env.TERM === 'dumb')
  const lines = boxLines('✦ 卷知', `${PANEL_TEXT}\n\n${PANEL_PROMPT}`, columns)
  const paint = (s: string): string => (color ? `\x1b[38;2;143;148;255m${s}\x1b[0m` : s)
  return '\n' + lines.map(paint).join('\n') + '\n\n'
}

/** 读一个按键：Enter → 'enter'；Esc（单独一个）/ Ctrl+C / Ctrl+D / q → 'esc'。方向键等转义序列忽略 */
export function readEnterOrEsc(stdin: NodeJS.ReadStream): Promise<'enter' | 'esc'> {
  return new Promise(resolve => {
    const wasRaw = !!stdin.isRaw
    try { stdin.setRawMode?.(true) } catch { /* 不是终端 */ }
    stdin.resume()
    const fin = (r: 'enter' | 'esc'): void => {
      stdin.off('data', onData)
      try { stdin.setRawMode?.(wasRaw) } catch { /* 不是终端 */ }
      stdin.pause()
      resolve(r)
    }
    const onData = (d: Buffer | string): void => {
      const s = d.toString()
      if (s === '\r' || s === '\n' || s === '\r\n') fin('enter')
      else if (s === '\x1b' || s === '\x03' || s === '\x04' || s === 'q' || s === 'Q') fin('esc')
    }
    stdin.on('data', onData)
  })
}
