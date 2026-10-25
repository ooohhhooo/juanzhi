/**
 * API Key 的加密存取。明文只存在于主进程内存；落盘的是 safeStorage（macOS 钥匙串 / Windows DPAPI）加密后的密文。
 * 渲染端只能「写入」和「清除」，没有任何接口能读回明文或密文。
 */
import { safeStorage } from 'electron'
import { getDb } from '../db'

const STORE_KEY = 'ai_key_enc'
let memoryKey: string | null = null

export type KeyStorage = 'encrypted' | 'memory' | 'none'

export function saveApiKey(key: string | null): KeyStorage {
  const db = getDb()
  const clean = key?.trim() || null
  memoryKey = clean
  db.prepare('DELETE FROM settings WHERE key = ?').run(STORE_KEY)
  if (!clean) return 'none'
  if (!safeStorage.isEncryptionAvailable()) return 'memory'
  const enc = safeStorage.encryptString(clean).toString('base64')
  db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(STORE_KEY, JSON.stringify(enc))
  return 'encrypted'
}

/** 仅主进程内部使用 */
export function getApiKey(): string | null {
  if (memoryKey) return memoryKey
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(STORE_KEY) as { value_json: string } | undefined
  if (!row) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const plain = safeStorage.decryptString(Buffer.from(JSON.parse(row.value_json), 'base64'))
    memoryKey = plain
    return plain
  } catch {
    // 换了电脑/用户后密文解不开：当作没有密钥，让用户重新输入
    return null
  }
}

export function keyStorage(): KeyStorage {
  const row = getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(STORE_KEY)
  if (row) return getApiKey() ? 'encrypted' : 'none'
  return memoryKey ? 'memory' : 'none'
}

/**
 * 库里有没有存过密钥（有密文行，或内存里有）——不看当前能不能解开。
 * 「不改发」守卫必须看这个：密文在、但钥匙串暂时不可用时，不能因为 keyStorage() 返回 'none' 就放行；
 * 钥匙串恢复后同一份密文又能解开，旧密钥就会被发往新地址。
 */
export function hasStoredKey(): boolean {
  if (memoryKey) return true
  return !!getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(STORE_KEY)
}
