/**
 * 「需要重启」与「导出中」的主进程状态，以及据此拦截写入类 IPC。
 *
 * 更改数据目录后，配置文件已指向新目录，但本次运行的主进程里（数据库连接、队列、文件路径）仍是旧目录。
 * 这个状态必须放在主进程：渲染端的弹窗只是内存状态，macOS 上关窗再点 Dock 图标（新建窗口）或重载页面都会让它消失（M4 审核 P1-5）。
 * 所以：①渲染端启动时向主进程查询（app:info.restartPending）并重新显示拦截；②主进程自己拒绝写入类请求（导入、解析、审核、知识点编辑、
 * 报告生成、示例数据……），即使页面被绕过也不会写进旧目录。
 */
import { ipcMain } from 'electron'
import { WRITE_CHANNELS, EXPORT_BLOCKED } from './ipc-channels.ts'

export { WRITE_CHANNELS, EXPORT_BLOCKED }

let restart: { target: string; oldDir: string } | null = null
let exporting = false

export const setRestartPending = (info: { target: string; oldDir: string }): void => { restart = info }
export const getRestartPending = (): { target: string; oldDir: string } | null => restart
export const setExporting = (v: boolean): void => { exporting = v }

export function blockReason(channel: string): string | null {
  if (restart && WRITE_CHANNELS.has(channel)) return '数据目录已经更改，需要先重启应用才能继续操作（重启之前的改动会写进旧目录，重启后就看不到了）'
  if (exporting && EXPORT_BLOCKED.has(channel)) return '正在导出数据包，请等导出结束再操作（避免试卷文件在导出过程中被改写）'
  return null
}

/** 在注册任何 IPC 之前调用一次：包装 ipcMain.handle，写入类请求先过 blockReason */
export function installIpcGuards(): void {
  const orig = ipcMain.handle.bind(ipcMain)
  ;(ipcMain as any).handle = (channel: string, listener: (...a: any[]) => any) =>
    orig(channel, (e: any, ...args: any[]) => {
      const why = blockReason(channel)
      if (why) throw new Error(why)
      return listener(e, ...args)
    })
}
