import { ipcMain, app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import { installCliShim, shimPath } from '../cli/shim'
import type { InstallResult } from '../cli/shim'

/** 命令行要调用的程序：安装版 = 当前可执行文件；免安装版（portable）= 它本身的位置（运行时的可执行文件在临时解压目录，用不得） */
function target(): { exePath: string; portable: boolean } {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  return portableFile ? { exePath: portableFile, portable: true } : { exePath: process.execPath, portable: false }
}

export function registerCliIpc(): void {
  /** 命令行工具装没装、装在哪（设置页显示用） */
  ipcMain.handle('cli:status', async () => {
    const env = { platform: process.platform, home: os.homedir(), localAppData: process.env.LOCALAPPDATA }
    const sp = shimPath(env)
    const t = target()
    return { supported: process.platform === 'darwin' || process.platform === 'win32', packaged: app.isPackaged, portable: t.portable, installed: fs.existsSync(sp.file), path: sp.file, dir: sp.dir, exePath: t.exePath }
  })

  /** 「安装命令行工具」：Mac 写 ~/.local/bin/juanzhi；Windows 写 juanzhi.cmd 并把目录加进用户级 PATH（不需要管理员权限） */
  ipcMain.handle('cli:install', async (): Promise<InstallResult> => {
    if (!app.isPackaged && process.env.EWB_CLI_INSTALL_DEV !== '1') throw new Error('开发版不能安装命令行工具（程序路径不是安装后的路径）')
    const t = target()
    return installCliShim({ platform: process.platform, home: os.homedir(), localAppData: process.env.LOCALAPPDATA, exePath: t.exePath, portable: t.portable, allowVolumes: process.env.EWB_CLI_INSTALL_DEV === '1' })
  })
}
