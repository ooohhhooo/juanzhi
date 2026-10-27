// 升级前备份 / 失败回滚（P2-4）：备份是一致的副本、只留最近 3 份、回滚后数据和升级前一模一样；v1–v9 迁移一个字没动（见 m6-data 的逐字比对）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupBeforeUpgrade, dbHasData, restoreBackup } from '../../src/main/db-backup.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-bak-'))
const dbPath = path.join(dir, 'db.sqlite')
let db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode=WAL')
db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'旧数据\'); PRAGMA user_version = 9')
const b1 = backupBeforeUpgrade(db, dbPath, 9)
assert.ok(b1 && fs.existsSync(b1) && path.basename(b1).startsWith('db.sqlite.bak-v9-'), b1)
{ const c = new DatabaseSync(b1); assert.equal(c.prepare('SELECT v FROM t').get().v, '旧数据'); assert.equal(c.prepare('PRAGMA user_version').get().user_version, 9); c.close() }
// 升级中途出错 → 用备份覆盖回去
db.exec("UPDATE t SET v = '被改坏了'; PRAGMA user_version = 10")
db.close()
restoreBackup(dbPath, b1)
db = new DatabaseSync(dbPath)
assert.equal(db.prepare('SELECT v FROM t').get().v, '旧数据'); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9)
// 只留最近 3 份
for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(dir, `db.sqlite.bak-v${i}-20200101-00000${i}`), 'x'); fs.utimesSync(path.join(dir, `db.sqlite.bak-v${i}-20200101-00000${i}`), new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i)) }
backupBeforeUpgrade(db, dbPath, 9)
const left = fs.readdirSync(dir).filter(f => f.startsWith('db.sqlite.bak-v'))
assert.equal(left.length, 3, left.join(','))
// 备份失败（路径不可写）不抛错，返回 null
assert.equal(backupBeforeUpgrade(db, path.join(dir, 'nope', 'db.sqlite'), 9), null)
// ── 「有没有数据」：升级前备份 / 升级后扫描看这个，不看版本号（user_version = 0 的最老的库有数据时也要备份；新建的空库什么都不做）──
{
  const mk = f => new DatabaseSync(f)
  const e = mk(':memory:'); assert.equal(dbHasData(e), false, '全新的空库：没有 papers 表')
  e.exec('CREATE TABLE papers (id TEXT)'); assert.equal(dbHasData(e), false, '有表没有行')
  e.exec("INSERT INTO papers VALUES ('x')"); assert.equal(e.prepare('PRAGMA user_version').get().user_version, 0); assert.equal(dbHasData(e), true, 'user_version = 0 的旧库有数据：要备份')
  assert.equal(dbHasData({ prepare() { throw new Error('坏库') } }), false, '读不了就当没有（不阻止升级）')
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('db-backup.test ✓')
