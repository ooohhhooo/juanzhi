import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { getDb, getDataDir } from '../db'
import { getOcrStatus } from '../pipeline/ocr'

// 通用设置接口的白名单（读和写都只认这些键）。AI 配置与密钥不在其中：
// 它们只能通过 ai:* 接口读写，而且密钥没有任何读回的接口。
const ALLOWED_KEYS = new Set(['data_dir_custom', 'ui_theme', 'ui_language'])

const SettingsKeySchema = z.string().refine(
  k => ALLOWED_KEYS.has(k),
  { message: '不允许修改此设置项' }
)

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async (_event, rawKey: unknown) => {
    const key = SettingsKeySchema.parse(rawKey)
    const db = getDb()
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
    return row ? JSON.parse(row.value_json) : null
  })

  ipcMain.handle('settings:set', async (_event, rawKey: unknown, value: unknown) => {
    const key = SettingsKeySchema.parse(rawKey)
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('设置值必须能序列化为 JSON')
    if (json.length > 100_000) throw new Error('设置值过大')
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, json)
    return true
  })

  ipcMain.handle('ocr:status', async () => getOcrStatus())

  ipcMain.handle('settings:getDataDir', async () => {
    return getDataDir()
  })

  ipcMain.handle('settings:openDataDir', async () => {
    shell.openPath(getDataDir())
    return true
  })
}
