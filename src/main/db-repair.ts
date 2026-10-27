/**
 * 数据修补（不是迁移：不改表结构、不依赖版本号）。不依赖 electron，单测直接加载。
 */
import { looksLikeCode, UNNAMED_KP } from '../shared/code-guard.ts'

const FLAG = 'kp_names_repaired_v1'
const BACKUP = 'kp_names_orig_v1'

/**
 * 知识点名称就是内部代码的（旧版本里老师采纳 AI 的「待归类：RD.INFER.OPINION」建议时，代码被当成了名称）改成「待命名的考点」，
 * 老师可以在设置 → 知识点里改成真正的中文名。**只跑一次**（settings.kp_names_repaired_v1）；识别规则要求以已知的一级前缀开头
 * （GR. RD. VO. PH. ……），不会误改「A.M」「P.M」这类缩写；改名前把原名记进 settings.kp_names_orig_v1（代码 → 原名），
 * 全部在一个事务里。返回修了几个。
 */
export function repairKpNames(db: any): number {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FLAG)) return 0
  const rows = db.prepare('SELECT code, name FROM kps').all() as Array<{ code: string; name: string }>
  const bad = rows.filter(r => looksLikeCode(r.name ?? ''))
  db.exec('BEGIN')
  try {
    if (bad.length) {
      const up = db.prepare('UPDATE kps SET name = ? WHERE code = ?')
      for (const r of bad) up.run(UNNAMED_KP, r.code)
      db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(BACKUP, JSON.stringify(Object.fromEntries(bad.map(r => [r.code, r.name]))))
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, 'true')").run(FLAG)
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
  return bad.length
}
