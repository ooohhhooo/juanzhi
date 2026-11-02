import { ipcMain } from 'electron'
import { z } from 'zod'
import { cancelDownload, checkForUpdate, downloadUpdate, getUpdateState, installBusy, installUpdate, openReleasePage, skipVersion } from '../update/service'
import { parseVersion } from '../update/core'

const CheckSchema = z.object({ silent: z.boolean().optional() }).strict().optional()
const InstallSchema = z.object({ force: z.boolean().optional() }).strict().optional()
const VersionSchema = z.string().max(40).refine(v => !!parseVersion(v), { message: '版本号格式不对' })

/** 应用内更新（见 update/service.ts）。这些通道只写临时目录和用户数据目录之外的一个小状态文件，不动卷知的数据，所以归只读类（重启待定时也能用） */
export function registerUpdateIpc(): void {
  ipcMain.handle('update:state', async () => getUpdateState())
  ipcMain.handle('update:check', async (_e, raw: unknown) => checkForUpdate({ silent: !!CheckSchema.parse(raw)?.silent }))
  ipcMain.handle('update:download', async () => downloadUpdate())
  ipcMain.handle('update:cancel', async () => { cancelDownload(); return true })
  /** 有解析 / 提取 / 报告在跑时返回 { ok:false, busy:'原因' }，由界面让老师等或放弃这些任务（force:true）后再装 */
  ipcMain.handle('update:install', async (_e, raw: unknown) => {
    const force = !!InstallSchema.parse(raw)?.force
    const busy = installBusy()
    // hard = 正在导出 / 导入数据包：不给「放弃」，force 也不行
    if (busy && (busy.hard || !force)) return { ok: false, busy: busy.reason, hard: busy.hard }
    return installUpdate()
  })
  ipcMain.handle('update:skip', async (_e, v: unknown) => { skipVersion(VersionSchema.parse(v)); return true })
  ipcMain.handle('update:openReleasePage', async () => { await openReleasePage(); return true })
}
