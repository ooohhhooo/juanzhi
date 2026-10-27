/**
 * 命令行模式的入口（M7）：打包后的程序收到 `cli` 子命令时走这里，不创建窗口、不显示 Dock 图标、不弹对话框。
 * 流程：解析参数 → 拿运行锁（窗口在运行 / 别的命令行在跑就报错）→ 初始化数据库 → 把现有的 IPC 处理函数注册进内存表 → 执行命令 →
 * stdout 打一行 JSON、写结果文件 → 释放锁、退出。设计见 docs/M7-命令行接口设计.md。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { closeDatabase, configuredDir, initDatabase, takeUpgradeScan } from '../db'
import { registerProtocol } from '../protocol'
import { registerPaperIpc } from '../ipc/papers'
import { registerSettingsIpc } from '../ipc/settings'
import { registerParseIpc } from '../ipc/parse'
import { registerQuestionIpc } from '../ipc/questions'
import { registerStatsIpc } from '../ipc/stats'
import { registerReportIpc } from '../ipc/report'
import { destroyPdfRenderer } from '../pipeline/pdf-renderer'
import { recoverInterruptedPapers } from '../pipeline/queue'
import { startSimilarScan } from '../similar-runner'
import { acquireRunLock } from './lock'
import { CliError, failFromError, helpData, okResult, parseArgs, serializeResult } from './args'
import type { CliFail, CliOk, ParsedArgs } from './args'
import { runCommand } from './commands'
import type { CliCtx } from './commands'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** 命令行模式下把 console.* 都改写到 stderr：stdout 只能有那一行 JSON（主进程里已有的 console.log 很多） */
function redirectConsole(): void {
  const w = (...a: unknown[]) => { try { process.stderr.write(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n') } catch { /* stderr 不可用就算了 */ } }
  console.log = w; console.info = w; console.debug = w; console.warn = w
}

/** 流式处理函数（报告生成）用 event.sender 发增量：命令行给一个只记日志的 sender */
const NULL_SENDER = { isDestroyed: () => false, send: () => undefined, once: () => undefined, removeListener: () => undefined }

export function startCliMode(rawArgs: string[]): void {
  redirectConsole()
  // 不显示 Dock 图标 / 菜单栏；不要因为「没有窗口」就退出
  try { app.dock?.hide() } catch { /* 不是 macOS */ }
  try { (app as any).setActivationPolicy?.('accessory') } catch { /* 旧版本没有 */ }
  app.on('window-all-closed', () => { /* 命令行模式：PDF 渲染用的隐藏窗口关了也不能退出，由 finish() 统一退出 */ })

  let parsed: ParsedArgs | null = null
  let release: (() => void) | null = null
  let done = false

  const writeFiles = (line: string): void => {
    const files = new Set<string>()
    if (parsed?.resultFile) files.add(parsed.resultFile)
    if (parsed?.jsonOut) files.add(parsed.jsonOut)
    if (process.env.JUANZHI_RESULT_FILE) files.add(process.env.JUANZHI_RESULT_FILE)
    for (const f of files) {
      try { fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(path.resolve(f), line + '\n', 'utf8') } catch (e) { process.stderr.write(`[juanzhi] 写结果文件失败（${f}）：${(e as Error).message}\n`) }
    }
  }

  const finish = (r: CliOk | CliFail): void => {
    if (done) return
    done = true
    const line = serializeResult(r)
    writeFiles(line)
    // 测试用：确认命令行运行期间没有任何可见窗口（PDF 渲染用的离屏窗口不算）
    if (process.env.EWB_CLI_DEBUG === '1') {
      try { process.stderr.write(`[juanzhi][debug] visibleWindows=${BrowserWindow.getAllWindows().filter(w => w.isVisible()).length} totalWindows=${BrowserWindow.getAllWindows().length} dock=${process.platform === 'darwin' ? app.dock?.isVisible() : 'n/a'}\n`) } catch { /* 调试信息而已 */ }
    }
    try { destroyPdfRenderer() } catch { /* 没开过 */ }
    try { closeDatabase() } catch { /* 没打开 */ }
    try { release?.() } catch { /* 锁已经没了 */ }
    const code = r.ok ? 0 : r.exit
    // stdout 在 Windows 的 GUI 程序里可能是无效句柄（直接运行 exe 时）：写失败不影响退出码和结果文件
    const exit = () => app.exit(code)
    try { process.stdout.on('error', () => exit()); process.stdout.write(line + '\n', exit) } catch { exit() }
    setTimeout(exit, 3000).unref?.()   // stdout 回调一直不来（管道被占住）时也要退出
  }

  const onSignal = (): void => { finish({ ok: false, code: 'internal', message: '命令被中断', exit: 1 }) }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  process.on('uncaughtException', e => finish(failFromError(e)))
  process.on('unhandledRejection', e => finish(failFromError(e)))

  void app.whenReady().then(async () => {
    try {
      parsed = parseArgs(rawArgs)
      if (parsed.help || !parsed.command) return finish(okResult(helpData()))
      const log = (m: string): void => { if (!parsed!.quiet) process.stderr.write(`[juanzhi] ${m}\n`) }

      // 运行锁：窗口在运行 / 别的命令行在跑
      const got = acquireRunLock(app.getPath('userData'), 'cli')
      if (!got.ok) {
        if (got.holder.mode === 'gui') throw new CliError('app_running', '卷知窗口正在运行，请先关闭卷知窗口再用命令行')
        throw new CliError('cli_busy', '另一个卷知命令行任务正在使用数据，请等它结束后再试')
      }
      release = got.release

      // 指定的数据目录不可用（比如在没插上的移动硬盘上）：图形界面会弹窗让老师选，命令行只能报错
      const custom = configuredDir()
      if (custom && !fs.existsSync(path.join(custom, 'db.sqlite'))) {
        throw new CliError('data_unavailable', `找不到之前设置的数据目录：${custom}。如果它在移动硬盘或网络位置上，请先连接好；或打开卷知窗口改用默认位置`)
      }
      try { await initDatabase() } catch (e) { throw new CliError('data_unavailable', `数据库打不开：${(e as Error).message}。请检查磁盘空间和数据目录权限`) }
      recoverInterruptedPapers()
      registerProtocol()
      if (takeUpgradeScan()) { log('数据库刚升级，检查重复试卷……'); await startSimilarScan() }

      // 把现有的 IPC 处理函数注册进内存表（命令实现按通道名调用它们，参数校验和各种守卫原样生效）
      const handlers = new Map<string, Handler>()
      const real = { handle: ipcMain.handle.bind(ipcMain), on: ipcMain.on.bind(ipcMain) }
      ;(ipcMain as any).handle = (ch: string, fn: Handler) => { handlers.set(ch, fn) }
      ;(ipcMain as any).on = () => ipcMain
      registerPaperIpc(); registerSettingsIpc(); registerParseIpc(); registerQuestionIpc(); registerStatsIpc(); registerReportIpc()
      ;(ipcMain as any).handle = real.handle; (ipcMain as any).on = real.on
      const call = async (sender: unknown, channel: string, args: unknown[]) => {
        const h = handlers.get(channel)
        if (!h) throw new CliError('internal', `内部错误：命令行没有注册 ${channel}`)
        return h({ sender }, ...args)
      }
      const ctx: CliCtx = {
        args: parsed, log,
        invoke: (ch, ...a) => call(NULL_SENDER, ch, a),
        invokeWithSender: (sender, ch, ...a) => call(sender, ch, a)
      }
      const data = await runCommand(ctx)
      finish(okResult(data))
    } catch (e) {
      finish(failFromError(e))
    }
  })
}
