/**
 * 运行日志（主进程）：写到 <userData>/logs，5 个文件 × 2 MB 滚动。只记事件元数据（见 log-core.ts），不记密钥、提示词、AI 正文、试卷内容。
 * 同时接管 console.log/warn/error（原样输出照旧，另外脱敏后写一份），并记录未捕获的异常与进程崩溃。
 */
import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { createLogWriter } from './log-core'
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
  log.error('renderer', String(msg ?? '').slice(0, 300))
}

/** 启动时调用一次：写启动记录、接管 console、挂上崩溃记录 */
export function initLogging(): void {
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
      const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : '')).filter(Boolean).join(' ')
      if (!text) return
      const m = /^\[([^\]]{1,20})\]\s*/.exec(text)
      w().write(level === 'log' ? 'info' : level, m ? m[1] : 'console', m ? text.slice(m[0].length) : text)
    }
  }
  process.on('uncaughtException', e => { log.error('crash', `uncaughtException: ${e?.message ?? e}`) })
  process.on('unhandledRejection', e => { log.error('crash', `unhandledRejection: ${(e as Error)?.message ?? e}`) })
  app.on('render-process-gone', (_e, _wc, d) => log.error('crash', `渲染进程退出: ${d.reason}`, { exitCode: d.exitCode }))
  app.on('child-process-gone', (_e, d) => log.error('crash', `子进程退出: ${d.type} ${d.reason}`, { exitCode: d.exitCode }))
  app.on('before-quit', () => log.info('app', '退出'))
}
