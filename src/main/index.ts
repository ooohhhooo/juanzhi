import { app, BrowserWindow, dialog, protocol, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { initDatabase, closeDatabase } from './db'
import { registerProtocol } from './protocol'
import { registerPaperIpc } from './ipc/papers'
import { registerSettingsIpc } from './ipc/settings'
import { registerAiIpc } from './ipc/ai'
import { registerParseIpc } from './ipc/parse'
import { registerQuestionIpc } from './ipc/questions'
import { registerStatsIpc } from './ipc/stats'
import { destroyPdfRenderer } from './pipeline/pdf-renderer'
import { recoverInterruptedPapers } from './pipeline/queue'
import { getMainWindow, setMainWindow } from './window'

// 数据目录固定为 <appData>/english-exam-workbench，与启动方式、productName 无关。
// EWB_USER_DATA_DIR 仅供自动化测试隔离数据，正常使用不要设置。
const userDataDir = process.env.EWB_USER_DATA_DIR
  || path.join(app.getPath('appData'), 'english-exam-workbench')
app.setName('english-exam-workbench')
app.setPath('userData', userDataDir)

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
    title: '小学英语校考知识点分析工作台',
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

if (!app.requestSingleInstanceLock()) {
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
    registerProtocol()

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

    registerPaperIpc()
    registerSettingsIpc()
    registerAiIpc()
    registerParseIpc()
    registerQuestionIpc()
    registerStatsIpc()
    createWindow()

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
  })
}
