// v13（语文、数学）：学科列、新学科种子、学科注册表、统计筛选按学科隔开。
import assert from 'node:assert/strict'
import { newDb, migrations } from './helpers/db.mjs'

const subject = await import('../../src/shared/subject.ts')
const guard = await import('../../src/shared/code-guard.ts')
const filter = await import('../../src/main/stats/filter.ts')
const p2 = await import('../../src/main/stats/p2.ts')
const ma = await import('../../src/main/seed/taxonomy-math.ts')
const cn = await import('../../src/main/seed/taxonomy-chinese.ts')
const en = await import('../../src/main/seed/taxonomy.ts')

// ───── 种子本身 ─────
{
  const all = [...en.KP_SEEDS_V1, ...ma.MA_KP_SEEDS_V1, ...cn.CN_KP_SEEDS_V1].map(s => s[0])
  assert.equal(new Set(all).size, all.length, '三个学科的知识点代码全局唯一')
  const qt = [...en.QTYPE_SEEDS_V1, ...ma.MA_QTYPE_SEEDS_V1, ...cn.CN_QTYPE_SEEDS_V1].map(s => s[0])
  assert.equal(new Set(qt).size, qt.length, '三个学科的题型代码全局唯一')
  for (const [seeds, sid] of [[ma.MA_KP_SEEDS_V1, 'math'], [cn.CN_KP_SEEDS_V1, 'chinese']]) {
    const rows = en.buildKpRows(seeds)
    assert.ok(rows.every(r => r.level >= 1 && r.level <= 3), `${sid} 不超过三层`)
    assert.ok(rows.every(r => subject.subjectOfCode(r.code) === sid), `${sid} 代码都能认出学科`)
    assert.ok(rows.every(r => subject.categoryOf(sid, r.code)), `${sid} 每个节点都有大类`)
  }
  for (const s of subject.SUBJECT_LIST) {
    const qts = s.id === 'english' ? en.QTYPE_SEEDS_V1 : s.id === 'math' ? ma.MA_QTYPE_SEEDS_V1 : cn.CN_QTYPE_SEEDS_V1
    assert.ok(qts.some(q => q[0] === s.otherQtype), `${s.name}的「其他」题型在种子里`)
    const groups = new Set(s.qtypeGroups.map(g => g.id))
    assert.ok(qts.every(q => groups.has(q[2])), `${s.name}的题型分组都在注册表里`)
  }
  assert.ok(Object.keys(ma.MA_KP_PLAIN).length === ma.MA_KP_SEEDS_V1.length && Object.values(ma.MA_KP_PLAIN).every(v => v.plain), '数学每个节点都有白话')
  assert.ok(Object.keys(cn.CN_KP_PLAIN).length === cn.CN_KP_SEEDS_V1.length && Object.values(cn.CN_KP_PLAIN).every(v => v.plain), '语文每个节点都有白话')
}

// ───── 新装：直接建到 v14 ─────
{
  const { db, version } = newDb()
  assert.equal(version, 15)
  const c = (sql, ...a) => db.prepare(sql).get(...a).c
  assert.equal(c("SELECT COUNT(*) c FROM kps WHERE subject = 'math'"), ma.MA_KP_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM kps WHERE subject = 'chinese'"), cn.CN_KP_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM kps WHERE subject = 'english'"), en.KP_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM qtypes WHERE subject = 'math'"), ma.MA_QTYPE_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM qtypes WHERE subject = 'chinese'"), cn.CN_QTYPE_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM kps WHERE subject = 'math' AND builtin = 1 AND plain IS NOT NULL"), ma.MA_KP_SEEDS_V1.length)
  assert.equal(c("SELECT COUNT(*) c FROM kps WHERE subject <> 'english' AND sort < 100000"), 0, '新学科 sort 不和英语穿插')
  for (const t of ['papers', 'reports', 'course_outlines', 'agent_sessions', 'ai_analyses', 'course_advice', 'kps', 'qtypes']) {
    assert.ok(db.prepare(`PRAGMA table_info(${t})`).all().some(col => col.name === 'subject'), `${t}.subject`)
  }
}

// ───── 从 v12 升上来：旧数据全部归英语，修订号触发器认 subject ─────
{
  const ms = migrations()
  const { db } = newDb(':memory:', 12)
  db.prepare("INSERT INTO papers (id, title, file_name, file_hash, status) VALUES ('p1', '旧卷', 'a.pdf', 'h1', 'done')").run()
  db.prepare("INSERT INTO reports (id, kind, markdown) VALUES ('r1', 'report', 'x')").run()
  db.exec('BEGIN'); ms[12](db); db.exec('PRAGMA user_version = 13'); db.exec('COMMIT')
  assert.equal(db.prepare("SELECT subject s FROM papers WHERE id = 'p1'").get().s, 'english')
  assert.equal(db.prepare("SELECT subject s FROM reports WHERE id = 'r1'").get().s, 'english')
  const rev = () => db.prepare('SELECT rev FROM data_rev WHERE id = 1').get().rev
  const before = rev()
  db.prepare("UPDATE papers SET subject = 'math' WHERE id = 'p1'").run()
  assert.equal(rev(), before + 1, '改了已确认卷子的学科，修订号 +1')
  ms[12](db)   // 重复执行无害
  assert.equal(db.prepare("SELECT COUNT(*) c FROM kps WHERE subject = 'math'").get().c, ma.MA_KP_SEEDS_V1.length)
}

// ───── 统计按学科隔开；英语是缺省，不进缓存键 ─────
{
  const { db } = newDb()
  const ins = db.prepare("INSERT INTO papers (id, title, file_name, file_hash, status, subject) VALUES (?, ?, ?, ?, 'done', ?)")
  ins.run('a', '英语卷', 'a.pdf', 'ha', 'english')
  ins.run('b', '数学卷', 'b.pdf', 'hb', 'math')
  ins.run('c', '数学卷2', 'c.pdf', 'hb', 'math')   // 同文件两份：只算一份
  const ids = f => { const s = filter.paperScope(filter.StatsFilterSchema.parse(f)); return db.prepare(`SELECT p.id FROM papers p WHERE ${s.where} ORDER BY p.id`).all(...s.params).map(r => r.id) }
  assert.deepEqual(ids({}), ['a'], '不写学科 = 英语')
  assert.deepEqual(ids({ subject: 'math' }), ['b'])
  assert.deepEqual(ids({ subject: 'chinese' }), [])
  assert.throws(() => filter.StatsFilterSchema.parse({ subject: 'physics' }))
  assert.deepEqual(p2.normalizeFilter({ subject: 'english', grade: '3' }), { grade: '3' }, '英语不写进归一化的筛选')
  assert.deepEqual(p2.normalizeFilter({ subject: 'math' }), { subject: 'math' })
}

// ───── 注册表与去代码 ─────
{
  assert.equal(subject.asSubject('nope'), 'english')
  assert.equal(subject.subjectOfCode('MA.NUM.FRAC'), 'math')
  assert.equal(subject.subjectOfCode('CN_PY_WRITE'), 'chinese')
  assert.equal(subject.subjectOfCode('GR.NOUN.PLURAL'), 'english')
  assert.equal(subject.categoryOf('math', 'MA.NUM.FRAC.COMPARE')?.key, 'ma-num')
  assert.equal(subject.categoryOf('chinese', 'CN.CHAR.STROKE')?.key, 'cn-pinyin')
  assert.equal(guard.stripCodes('分数比大小（MA.NUM.FRAC.COMPARE）要多练'), '分数比大小要多练')
  assert.equal(guard.stripCodes('看拼音写词语 CN_PY_WRITE 错得多'), '看拼音写词语 错得多')
  assert.equal(guard.safeKpName('CN.WORD.SYN'), guard.UNNAMED_KP)
  assert.equal(guard.stripCodes('Mr.Wang 和 P.E 课'), 'Mr.Wang 和 P.E 课', '正常缩写不当代码')
}

console.log('migration-v13 ok')
