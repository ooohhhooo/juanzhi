import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { getDb, getDataDir } from '../db'
import { getOcrStatus } from '../pipeline/ocr'
import { StatsFilterSchema } from '../stats/filter'

// 通用设置接口的白名单（读和写都只认这些键）。AI 配置与密钥不在其中：
// 它们只能通过 ai:* 接口读写，而且密钥没有任何读回的接口。
// （数据目录的位置不在这里：它决定数据库放在哪，不能存在数据库里——见 datadir.ts / ewb-config.json）
// M4：onboarding_done = 首次启动引导是否已关闭；default_textbook = 引导里选的教材版本（AI 没读出教材时作默认值）
const ALLOWED_KEYS = new Set(['ui_theme', 'ui_language', 'ui_stats_filter', 'onboarding_done', 'default_textbook'])

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
    // 有结构的键单独校验（不只是大小）：全局筛选栏的状态必须是合法的筛选对象
    if (key === 'ui_stats_filter') {
      const r = StatsFilterSchema.safeParse(value)
      if (!r.success) throw new Error('筛选条件格式不正确')
    }
    if (key === 'onboarding_done' && typeof value !== 'boolean') throw new Error('设置值必须是布尔值')
    if (key === 'default_textbook' && !(value === null || (typeof value === 'string' && value.length <= 100))) throw new Error('教材版本必须是不超过 100 字的文字')
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
