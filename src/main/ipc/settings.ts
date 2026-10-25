import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { getDb, getDataDir } from '../db'

const ALLOWED_KEYS = new Set([
  'ai_provider', 'ai_api_key', 'ai_model', 'ai_base_url',
  'data_dir_custom', 'ui_theme', 'ui_language'
])

const SettingsKeySchema = z.string().refine(
  k => ALLOWED_KEYS.has(k),
  { message: '不允许修改此设置项' }
)

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async (_event, rawKey: unknown) => {
    const key = z.string().min(1).parse(rawKey)
    const db = getDb()
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
    return row ? JSON.parse(row.value_json) : null
  })

  ipcMain.handle('settings:set', async (_event, rawKey: unknown, value: unknown) => {
    const key = SettingsKeySchema.parse(rawKey)
    const db = getDb()
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)'
    ).run(key, JSON.stringify(value))
    return true
  })

  ipcMain.handle('settings:getDataDir', async () => {
    return getDataDir()
  })

  ipcMain.handle('settings:openDataDir', async () => {
    shell.openPath(getDataDir())
    return true
  })
}
