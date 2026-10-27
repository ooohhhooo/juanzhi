/**
 * 命令行模式的入口（M7）：打包后的程序收到 `cli` 子命令时走这里，不创建窗口、不显示 Dock 图标、不弹对话框。
 * 流程：解析参数 → 拿运行锁（窗口 / 别的命令行在跑就报错）→ 初始化数据库 → 把允许的 IPC 处理函数注册进内存表 → 执行命令 →
 * 关数据库 → stdout 打一行 JSON、写结果文件 → 释放锁、退出。设计见 docs/M7-命令行接口设计.md。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { closeDatabase, configuredDir, defaultDir, getDataDir, getStartupNotice, initDatabase, takeUpgradeScan } from '../db'
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
import { CliError, failFromError, helpData, okResult, parseArgs, scanOutputFlags, serializeResult } from './args'
import type { CliFail, CliOk, ParsedArgs } from './args'
import { assertResultFileWritable, writeFileAtomic } from './outfile'
import { runCommand } from './commands'
import type { CliCtx } from './commands'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** 命令行只会调用这些通道；其余通道虽然注册了（处理函数是现成的）但调用会被拒绝——靠写死的白名单，而不是靠「命令里碰巧没写」 */
export const CLI_ALLOWED_CHANNELS = new Set([
  'ocr:status', 'papers:list', 'papers:get', 'questions:list', 'questions:confirmPaper',
  'stats:overview', 'stats:hot', 'stats:compare', 'report:generate', 'report:list'
])

/** 命令行模式下把 console.* 都改写到 stderr：stdout 只能有那一行 JSON（主进程里已有的 console.log 很多）。用 util.format：Error 对象不会变成 {} */
function redirectConsole(): void {
  const w = (...a: unknown[]) => { try { process.stderr.write(util.format(...a) + '\n') } catch { /* stderr 不可用就算了 */ } }
  console.log = w; console.info = w; console.debug = w; console.warn = w
}

/** 流式处理函数（报告生成）用 event.sender 发增量：命令行给一个只记日志的 sender */
const NULL_SENDER = { isDestroyed: () => false, send: () => undefined, once: () => undefined, removeListener: () => undefined }

const debug = (msg: string): void => { if (process.env.EWB_CLI_DEBUG === '1') { try { process.stderr.write(`[juanzhi][debug] ${msg}\n`) } catch { /* 忽略 */ } } }

export function startCliMode(rawArgs: string[]): void {
  redirectConsole()
  // 不显示 Dock 图标 / 菜单栏；不要因为「没有窗口」就退出
  try { app.dock?.hide() } catch { /* 不是 macOS */ }
  try { (app as any).setActivationPolicy?.('accessory') } catch { /* 旧版本没有 */ }
  app.on('window-all-closed', () => { /* 命令行模式：PDF 渲染用的隐藏窗口关了也不能退出，由 finish() 统一退出 */ })

  let parsed: ParsedArgs | null = null
  let release: (() => void) | null = null
  let done = false
  let exiting = false
  const out = scanOutputFlags(rawArgs)
  let forbidden: string[] = []   // 结果文件不能落在这些目录里（userData、数据目录）

  /** 写结果文件（--result-file、--out 的副本、环境变量 JUANZHI_RESULT_FILE）：每个都过安全检查，写不了只报 stderr，不影响命令结果 */
  const writeFiles = (line: string, exit: number): void => {
    const files = new Map<string, boolean>()   // 路径 → 是不是环境变量指定的（环境变量的再写一个 .exit 文件，Windows 包装脚本读它拿退出码）
    for (const f of [parsed?.resultFile ?? out.resultFile, parsed?.jsonOut ?? out.jsonOut]) if (f) files.set(f, false)
    if (process.env.JUANZHI_RESULT_FILE) files.set(process.env.JUANZHI_RESULT_FILE, true)
    for (const [f, isEnv] of files) {
      try {
        const abs = assertResultFileWritable(f, forbidden)
        writeFileAtomic(abs, line + '\n')
        if (isEnv) writeFileAtomic(abs + '.exit', String(exit) + '\n')
      } catch (e) { process.stderr.write(`[juanzhi] 没有写结果文件（${f}）：${(e as Error).message}\n`) }
    }
  }

  const finish = (r: CliOk | CliFail): void => {
    if (done) return
    done = true
    debug(`finish ok=${r.ok}`)
    const line = serializeResult(r)
    const code = r.ok ? 0 : r.exit
    // 测试用：确认命令行运行期间没有任何可见窗口（PDF 渲染用的离屏窗口不算）
    if (process.env.EWB_CLI_DEBUG === '1') {
      try { process.stderr.write(`[juanzhi][debug] visibleWindows=${BrowserWindow.getAllWindows().filter(w => w.isVisible()).length} totalWindows=${BrowserWindow.getAllWindows().length} dock=${process.platform === 'darwin' ? app.dock?.isVisible() : 'n/a'}\n`) } catch { /* 调试信息而已 */ }
    }
    try { destroyPdfRenderer() } catch { /* 没开过 */ }
    try { closeDatabase() } catch { /* 没打开 */ }
    // 先关库再写结果文件：数据库文件在禁区里，结果文件本来就不允许指向它，这里的顺序再保一道
    writeFiles(line, code)
    try { release?.() } catch { /* 锁已经没了 */ }
    // 只退出一次（评审 / CI：Windows 上多次调用 app.exit 的重入会以访问违规崩溃）；stdout 在 Windows 的 GUI 程序里可能是无效句柄，写失败不影响结果文件和退出码
    const exit = (): void => {
      if (exiting) return
      exiting = true
      debug(`exit(${code})`)
      setTimeout(() => app.exit(code), 30)
    }
    try { process.stdout.on('error', () => exit()); process.stdout.write(line + '\n', () => exit()) } catch { exit() }
    setTimeout(exit, 3000).unref?.()   // stdout 回调一直不来（管道被占住）时也要退出
  }

  const onSignal = (): void => { finish({ ok: false, code: 'internal', message: '命令被中断', exit: 1 }) }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  process.on('uncaughtException', e => finish(failFromError(e)))
  // 队列里有不少 `void drain()` 之类的后台 Promise：多出一个未处理的 rejection 只记日志，不能让整个命令（比如导入途中）变成 internal
  process.on('unhandledRejection', e => { try { process.stderr.write(`[juanzhi] 未处理的 Promise 错误：${util.format(e)}\n`) } catch { /* 忽略 */ } })

  void app.whenReady().then(async () => {
    try {
      debug('ready')
      parsed = parseArgs(rawArgs)
      if (parsed.help || !parsed.command) return finish(okResult(helpData()))
      const log = (m: string): void => { if (!parsed!.quiet) process.stderr.write(`[juanzhi] ${m}\n`) }
      forbidden = [app.getPath('userData')]

      // 运行锁：窗口 / 别的命令行在跑（锁是「持有者活着才持有」，崩溃后自动释放）
      const got = await acquireRunLock(app.getPath('userData'), 'cli')
      if (!got.ok) {
        if (got.holder?.mode === 'gui') throw new CliError('app_running', '卷知窗口正在运行，请先退出卷知再用命令行（Mac 上要按 Cmd+Q 退出，只关闭窗口不行；Windows 上关闭窗口就是退出）')
        if (!got.holder) throw new CliError('cli_busy', '卷知（窗口或另一个命令行任务）正在使用数据，请等它结束后再试；如果一直这样，请退出卷知窗口后再试')
        throw new CliError('cli_busy', `另一个卷知命令行任务（进程 ${got.holder.pid}）正在使用数据，请等它结束后再试`)
      }
      release = got.release
      debug('lock acquired')

      // 指定的数据目录不可用（比如在没插上的移动硬盘上）：图形界面会弹窗让老师选，命令行只能报错
      const custom = configuredDir()
      if (custom && !fs.existsSync(path.join(custom, 'db.sqlite'))) {
        throw new CliError('data_unavailable', `找不到之前设置的数据目录：${custom}。如果它在移动硬盘或网络位置上，请先连接好；或打开卷知窗口改用默认位置`)
      }
      forbidden = [app.getPath('userData'), custom ?? defaultDir()]
      // 结果文件的路径先检查（不在数据目录里、不覆盖别人的文件）：不行就直接报错，命令不执行
      for (const f of [parsed.resultFile, parsed.jsonOut, process.env.JUANZHI_RESULT_FILE]) if (f) assertResultFileWritable(f, forbidden)
      try { await initDatabase() } catch (e) { throw new CliError('data_unavailable', `数据库打不开：${(e as Error).message}。请检查磁盘空间和数据目录权限`) }
      forbidden = [app.getPath('userData'), getDataDir()]
      debug('db ready')
      // 启动时恢复的提示（比如上次覆盖导入中断后已经自动恢复）：命令行不弹窗，写到 stderr
      const notice = getStartupNotice()
      if (notice) log(`提示：${JSON.stringify(notice)}`)
      recoverInterruptedPapers()
      registerProtocol()
      if (takeUpgradeScan()) { log('数据库刚升级，检查重复试卷……'); await startSimilarScan() }

      // 把现有的 IPC 处理函数注册进内存表（命令实现按通道名调用它们，参数校验原样生效）；调用只允许白名单里的通道
      const handlers = new Map<string, Handler>()
      const real = { handle: ipcMain.handle.bind(ipcMain), on: ipcMain.on.bind(ipcMain) }
      ;(ipcMain as any).handle = (ch: string, fn: Handler) => { handlers.set(ch, fn) }
      ;(ipcMain as any).on = () => ipcMain
      registerPaperIpc(); registerSettingsIpc(); registerParseIpc(); registerQuestionIpc(); registerStatsIpc(); registerReportIpc()
      ;(ipcMain as any).handle = real.handle; (ipcMain as any).on = real.on
      const call = async (sender: unknown, channel: string, args: unknown[]) => {
        if (!CLI_ALLOWED_CHANNELS.has(channel)) throw new CliError('internal', `内部错误：命令行不允许调用 ${channel}`)
        const h = handlers.get(channel)
        if (!h) throw new CliError('internal', `内部错误：命令行没有注册 ${channel}`)
        return h({ sender }, ...args)
      }
      const ctx: CliCtx = {
        args: parsed, log, forbiddenDirs: forbidden,
        invoke: (ch, ...a) => call(NULL_SENDER, ch, a),
        invokeWithSender: (sender, ch, ...a) => call(sender, ch, a)
      }
      debug('run command')
      const data = await runCommand(ctx)
      finish(okResult(data))
    } catch (e) {
      finish(failFromError(e))
    }
  })
}
