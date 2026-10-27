import { app, BrowserWindow, dialog, Menu, protocol, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { initDatabase, closeDatabase, configuredDir, defaultDir, setDataDir, takeUpgradeScan } from './db'
import { startSimilarScan } from './similar-runner'
import { refineAllOnce } from './parse/refine-run'
import { writeConfig } from './datadir'
import { registerProtocol } from './protocol'
import { registerPaperIpc } from './ipc/papers'
import { registerSettingsIpc } from './ipc/settings'
import { registerAiIpc } from './ipc/ai'
import { registerParseIpc } from './ipc/parse'
import { registerQuestionIpc } from './ipc/questions'
import { registerStatsIpc } from './ipc/stats'
import { registerReportIpc } from './ipc/report'
import { registerDataIpc } from './ipc/data'
import { installIpcGuards } from './restart'
import { registerTaxonomyIpc } from './ipc/taxonomy'
import { registerCliIpc } from './ipc/cli'
import { destroyPdfRenderer } from './pipeline/pdf-renderer'
import { recoverInterruptedPapers } from './pipeline/queue'
import { getMainWindow, setMainWindow } from './window'
import { APP_ID, PRODUCT_NAME, WINDOW_TITLE } from './brand'
import { buildMacMenuTemplate } from './menu-template'
import { cliArgvOf } from './cli/args'
import { startCliMode } from './cli/run'
import { acquireRunLock, clearLockFile, inspectRunLock, processLooksLikeJuanzhi } from './cli/lock'

// 数据目录固定为 <appData>/english-exam-workbench，与启动方式、productName 无关。
// EWB_USER_DATA_DIR 仅供自动化测试隔离数据，正常使用不要设置。
const userDataDir = process.env.EWB_USER_DATA_DIR
  || path.join(app.getPath('appData'), 'english-exam-workbench')
app.setName('english-exam-workbench')
app.setPath('userData', userDataDir)
// Windows：任务栏分组标识要和安装器写进快捷方式里的 appId 一致，否则「固定到任务栏」后再启动会出现两个图标
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
// 老师看到的名字用 PRODUCT_NAME（app.name 是内部名 english-exam-workbench，只用来固定数据目录）
if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion() })

// 自动化测试用：只打印解析出的数据目录就退出，不初始化数据库、不占单实例锁
if (process.env.EWB_PRINT_USERDATA === '1') {
  process.stdout.write(`EWB_USERDATA=${app.getPath('userData')}\n`)
  app.exit(0)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ewb',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

const devServerUrl = process.env.ELECTRON_RENDERER_URL
const entryUrl = devServerUrl ?? pathToFileURL(path.join(__dirname, '../renderer/index.html')).href

/** 只有应用自己的入口页（忽略 hash/query）才允许被导航到；其余一律拦截，包括任意 file:// */
function isOwnEntry(target: string): boolean {
  try {
    const t = new URL(target)
    const e = new URL(entryUrl)
    if (t.origin !== e.origin) return false
    const norm = (u: URL) => (u.pathname === '/' ? '/index.html' : u.pathname)
    return devServerUrl ? norm(t) === norm(e) : t.pathname === e.pathname
  } catch {
    return false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: WINDOW_TITLE,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  setMainWindow(win)

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnEntry(url)) event.preventDefault()
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    setMainWindow(null)
    // 隐藏的 PDF 渲染窗口会让 Windows/Linux 的 window-all-closed 永远不触发，主窗口关闭时必须一起销毁
    destroyPdfRenderer()
  })
}

// 命令行模式（`<程序> cli <命令>`）：不创建窗口、不占 Electron 单实例锁（以免打扰正在运行的窗口），见 cli/run.ts
const cliArgs = cliArgvOf(process.argv, app.isPackaged)
let releaseRunLock: (() => void) | null = null

if (cliArgs) {
  startCliMode(cliArgs)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // 运行锁：命令行正在使用数据时，窗口不能同时打开（两边同时写同一份数据会损坏）。锁是「持有者活着才持有」，不会有陈旧锁挡住窗口
    // 锁子系统本身出故障（目录只读、抢锁超时……）不能让窗口打不开：写日志后照常打开
    try {
      const userDataDir = app.getPath('userData')
      let lock = await acquireRunLock(userDataDir, 'gui')
      if (!lock.ok) {
        const h = lock.holder
        const who = h?.pid ? `进程 ${h.pid}${h.startedAt ? `，开始于 ${h.startedAt}` : ''}` : '进程未知'
        const msg = !h ? '卷知（窗口或命令行）正在使用数据，请等它结束后再打开窗口' : h.mode === 'cli' ? '卷知命令行正在使用数据，请等它结束后再打开窗口' : '卷知已经在运行（锁被另一个窗口进程持有）'
        if (process.env.EWB_NO_DIALOG === '1') { process.stderr.write(`[卷知] ${msg}（${who}）\n`); app.exit(3); return }
        const canKill = !!h?.pid && h.mode === 'cli'
        const labels = canKill ? ['好', '结束命令行任务并打开', '仍要打开（有风险）'] : ['好', '仍要打开（有风险）']
        const pick = labels[dialog.showMessageBoxSync({
          type: 'warning', title: PRODUCT_NAME, message: msg,
          detail: `${who}。命令行任务（比如导入试卷、生成报告）做完后会自动释放，稍等片刻再打开卷知即可。\n\n`
            + (canKill ? `如果它卡住了（比如在等钥匙串授权），可以点「结束命令行任务并打开」，或在任务管理器 / 活动监视器里结束进程${h?.pid ? ` ${h.pid}` : ''}。\n\n` : '')
            + '如果你确定现在没有命令行在运行（比如上一次异常退出留下了记录），可以点「仍要打开」。风险：要是命令行其实还在写数据，同时打开窗口可能损坏数据。',
          buttons: labels, defaultId: 0, cancelId: 0
        })]
        if (pick === '仍要打开（有风险）') {
          // 用户确认没有命令行在运行：清掉可能陈旧的锁文件再抢一次；还是抢不到（持有者真的活着）就不带锁打开，命令行互斥暂时不可用
          clearLockFile(userDataDir)
          lock = await acquireRunLock(userDataDir, 'gui')
          if (!lock.ok) console.warn('[lock] 用户选择「仍要打开」：运行锁仍被占用，窗口不带锁打开（命令行互斥暂时不可用）')
          else releaseRunLock = lock.release
        } else if (pick === '结束命令行任务并打开' && canKill) {
          // 弹框期间那个进程可能已经结束、pid 被别的程序复用：杀之前重新确认持有者还是同一个（pid + 启动时间一致），并且进程名确实是卷知
          const now = await inspectRunLock(userDataDir)
          const same = !!now && now.pid === h!.pid && now.startedAt === h!.startedAt
          if (!now) { /* 命令行已经结束：下面直接再抢一次锁 */ }
          else if (!same || !processLooksLikeJuanzhi(h!.pid)) {
            dialog.showMessageBoxSync({ type: 'info', title: PRODUCT_NAME, message: '没有结束任何进程', detail: `持有者已经变了，或者进程 ${h!.pid} 看起来不是卷知的命令行。为了不误伤别的程序，卷知没有结束它。请稍后再试，或手动处理。`, buttons: ['好'] })
            app.exit(3); return
          } else {
            for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
              try { process.kill(h!.pid, sig) } catch { /* 已经结束了 */ }
              for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 200)); lock = await acquireRunLock(userDataDir, 'gui'); if (lock.ok) break }
              if (lock.ok) break
            }
          }
          if (!lock.ok) lock = await acquireRunLock(userDataDir, 'gui')
        }
        if (!lock.ok && pick !== '仍要打开（有风险）') { app.exit(3); return }
      }
      if (lock.ok) releaseRunLock = lock.release
    } catch (e) {
      console.warn(`[lock] 运行锁出错，照常打开窗口（命令行互斥暂时不可用）：${(e as Error).message}`)
    }
    // macOS：中文应用菜单（关于 / 隐藏 / 退出 都用产品名）；Windows / Linux 沿用默认菜单
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacMenuTemplate({ dev: !app.isPackaged }) as Electron.MenuItemConstructorOptions[]))
    registerProtocol()

    // 指定的数据目录不可用（比如放在移动硬盘上、没插）：不能悄悄用默认位置建一个空库——让老师选
    const custom = configuredDir()
    if (custom && !fs.existsSync(path.join(custom, 'db.sqlite'))) {
      for (;;) {
        const r = dialog.showMessageBoxSync({
          type: 'warning', title: '找不到数据目录', buttons: ['重试', '改用默认位置', '退出'], defaultId: 0, cancelId: 2,
          message: '找不到之前设置的数据目录',
          detail: `${custom}\n\n如果它在移动硬盘或网络位置上，请先连接好再点「重试」。\n选「改用默认位置」会改用应用自己的默认目录（${defaultDir()}）——那里可能是一个空的库；原来目录里的数据不会被删除。`
        })
        if (r === 2) { app.quit(); return }
        if (r === 1) { writeConfig(app.getPath('userData'), {}); setDataDir(defaultDir()); break }
        if (fs.existsSync(path.join(custom, 'db.sqlite'))) break
      }
    }

    try {
      await initDatabase()
    } catch (err) {
      dialog.showErrorBox(
        '数据库初始化失败',
        `无法启动应用：${(err as Error).message}\n\n请检查磁盘空间和数据目录权限。`
      )
      app.quit()
      return
    }

    recoverInterruptedPapers()

    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

    installIpcGuards()   // 必须在注册任何 IPC 之前：写入类请求在「需要重启」/「导出中」时由主进程直接拒绝
    registerPaperIpc()
    registerSettingsIpc()
    registerAiIpc()
    registerParseIpc()
    registerQuestionIpc()
    registerStatsIpc()
    registerReportIpc()
    registerDataIpc()
    registerTaxonomyIpc()
    registerCliIpc()
    createWindow()
    // 升级后给库里已有的卷子补扫一遍重复卷：后台分片跑，不挡窗口（失败只写日志）
    if (takeUpgradeScan()) startSimilarScan().then(r => console.log(`[db] 升级后扫描重复试卷：检查 ${r.checked} 份，疑似重复 ${r.suspects} 份`), e => console.warn(`[db] 升级后扫描重复试卷失败: ${(e as Error).message}`))

    // 旧数据里的题目截图框用页面墨迹修一遍（只做一次，后台分片，失败只写日志）
    refineAllOnce().then(n => { if (n) console.log(`[crop] 已修正 ${n} 道题的截图框`) }, e => console.warn(`[crop] 修正截图框失败: ${(e as Error).message}`))

    app.on('activate', () => {
      if (!getMainWindow()) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    destroyPdfRenderer()
    closeDatabase()
    releaseRunLock?.()
  })
  process.on('exit', () => releaseRunLock?.())
}
