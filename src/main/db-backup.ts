/**
 * 升级数据库前的备份 / 回滚（不依赖 electron，单测直接加载）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 升级前把数据库拷一份到数据目录：db.sqlite.bak-v<旧版本>-<时间>；用 VACUUM INTO 得到一致的副本（不依赖 WAL 有没有落盘）。只留最近 3 份。失败返回 null（不阻止升级，但会写日志） */
export function backupBeforeUpgrade(handle: any, dbPath: string, fromVersion: number): string | null {
  try {
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    let out = `${dbPath}.bak-v${fromVersion}-${stamp}`
    for (let n = 2; fs.existsSync(out); n++) out = `${dbPath}.bak-v${fromVersion}-${stamp}-${n}`   // 同一秒内再备份一次：换个名字，不覆盖
    handle.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
    const dir = path.dirname(dbPath), base = path.basename(dbPath)
    const olds = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.bak-v`)).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : 1)).map(x => x.f)
    for (const f of olds.slice(0, Math.max(0, olds.length - 3))) { try { fs.rmSync(path.join(dir, f), { force: true }) } catch { /* 清不掉就留着 */ } }
    console.log(`[db] 升级前已备份：${path.basename(out)}`)
    return out
  } catch (e) {
    console.warn(`[db] 升级前备份失败（继续升级）: ${(e as Error).message}`)
    return null
  }
}

/** 用升级前的备份覆盖当前数据库文件（同时清掉 -wal / -shm） */
export function restoreBackup(dbPath: string, backupPath: string): void {
  for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }) } catch { /* 忽略 */ } }
  fs.copyFileSync(backupPath, dbPath)
}


/** 库里有没有卷子（papers 表不存在 / 没有行 = 没有数据） */
export function dbHasData(handle: any): boolean {
  try {
    if (!handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'papers'").get()) return false
    return !!handle.prepare('SELECT 1 FROM papers LIMIT 1').get()
  } catch {
    return false
  }
}
