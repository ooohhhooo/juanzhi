/**
 * 运行日志（主进程）：写到 <userData>/logs，5 个文件 × 2 MB 滚动。只记事件元数据（见 log-core.ts），不记密钥、提示词、AI 正文、试卷内容。
 * 同时接管 console.log/warn/error（原样输出照旧，另外脱敏后写一份），并记录未捕获的异常与进程崩溃。
 */
import { app, dialog } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { createLogWriter, reduceConsoleMessage, sanitize } from './log-core'
import type { LogWriter } from './log-core'
import { getApiKey } from './ai/secret'

let writer: LogWriter | null = null
let hooked = false

export function logDir(): string { return path.join(app.getPath('userData'), 'logs') }

function w(): LogWriter {
  if (!writer) {
    writer = createLogWriter({
      dir: logDir(),
      secrets: () => { try { const k = getApiKey(); return k ? [k] : [] } catch { return [] } }
    })
  }
  return writer
}

export const log = {
  info: (tag: string, msg: string, fields?: Record<string, unknown>) => w().write('info', tag, msg, fields),
  warn: (tag: string, msg: string, fields?: Record<string, unknown>) => w().write('warn', tag, msg, fields),
  error: (tag: string, msg: string, fields?: Record<string, unknown>) => w().write('error', tag, msg, fields)
}
export function logFiles(): string[] { return w().files() }

/** 试卷在日志里只用 8 位短 id（不记标题和文件名） */
export const shortId = (id: string): string => id.slice(0, 8)

/** 渲染端上报：每分钟最多 30 条 */
let rendererWindow = 0
let rendererCount = 0
export function logRendererError(msg: unknown): void {
  const now = Date.now()
  if (now - rendererWindow > 60_000) { rendererWindow = now; rendererCount = 0 }
  if (++rendererCount > 30) return
  // 页面错误的文字可能带题目内容：只留错误名和一个短指纹（preload 端已经这样处理，这里再收一次）
  log.error('renderer', reduceConsoleMessage(sanitize(String(msg ?? ''))))
}

/** 启动时调用一次：写启动记录、接管 console、挂上崩溃记录 */
export function initLogging(opts: { crashDialog?: boolean } = {}): void {
  if (hooked) return
  hooked = true
  log.info('app', '启动', {
    version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron,
    chrome: process.versions.chrome, node: process.versions.node, os: os.release(), packaged: app.isPackaged
  })
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      // 只取第一个字符串参数；Error 对象只记类型名。冒号 / 竖线之后的原文（可能是 AI 返回、题干、文件名）一律不落盘
      const first = args[0]
      const text = typeof first === 'string' ? first : first instanceof Error ? first.name : ''
      if (!text) return
      const m = /^\[([^\]]{1,20})\]\s*/.exec(text)
      w().write(level === 'log' ? 'info' : level, m ? m[1] : 'console', reduceConsoleMessage(m ? text.slice(m[0].length) : text))
    }
  }
  let crashing = false
  process.on('uncaughtException', e => {
    log.error('crash', `uncaughtException ${(e as Error)?.name ?? 'Error'}`)
    // 不能悄悄带着未知状态继续跑：记下日志、告诉用户、退出（命令行模式有自己的处理）
    if (!opts.crashDialog || crashing) return
    crashing = true
    try { dialog.showErrorBox('卷知遇到意外错误，需要退出', '这个错误已经记进日志。重新打开卷知即可；如果反复出现，请到「设置 → 关于」点「导出诊断信息」再「反馈问题」。') } catch { /* 对话框弹不出来也要退出 */ }
    app.exit(1)
  })
  process.on('unhandledRejection', e => { log.error('crash', `unhandledRejection ${(e as Error)?.name ?? typeof e}`) })
  app.on('render-process-gone', (_e, _wc, d) => log.error('crash', `渲染进程退出: ${d.reason}`, { exitCode: d.exitCode }))
  app.on('child-process-gone', (_e, d) => log.error('crash', `子进程退出: ${d.type} ${d.reason}`, { exitCode: d.exitCode }))
  app.on('before-quit', () => log.info('app', '退出'))
}
