// A4：疑似重复 / 部分重复的卷子。夹具取自真实案例的数据形态：运营导入的图片 g4-2025-page1.png 其实是已有「2024-2025 学年第二学期四年级期末卷」的第 1 页（25 题），
// 软件只按文件哈希去重，认不出来，看板变成 3 份卷子。tests/unit/fixtures/g4-papers.json 是那两份真实卷子的题干和选项。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { questionKey, findSimilar, decideFlag, similarText, detectSimilar, scanSimilar, scanSimilarAsync, redetectAfterRemoval, T_ANY } from '../../src/main/parse/similar.ts'
import { newDb, addPaper } from './helpers/db.mjs'
import { paperScope } from '../../src/main/stats/filter.ts'
import { scopeNotes } from '../../src/main/stats/core.ts'

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/g4-papers.json', import.meta.url), 'utf8'))
const y24 = F.y2024, y25 = F.y2025
assert.equal(y24.questions.length, 36); assert.equal(y24.questions.filter(q => q.page === 1).length, 25)

const sim = (p, qs) => ({ id: p.id, title: p.title, grade: p.grade, school_year_start: p.school_year_start ?? p.year, keys: new Set(qs.map(q => questionKey(q.stem, q.options)).filter(Boolean)) })

// ── 题目键：规范化；选项放进题干还是放进选项不影响；太短的不算 ──
assert.equal(questionKey('', ['A. sunny', 'B. windy']), questionKey('A. sunny B. windy', []))
assert.equal(questionKey('Look at the ____ (sheep).', []), questionKey('look at the (SHEEP)', []).replace('sheep', 'sheep') && questionKey('LOOK AT THE ____ ( sheep ) .', []))
assert.equal(questionKey('1. Hi', []), null, '太短的题干不当依据')
assert.equal(questionKey('x', '["A. farm","B. car","C. warm"]'), questionKey('x A. farm B. car C. warm', []), '库里存的是 JSON 字符串')

// ── 真实案例：第 1 页（25 题，带 OCR 噪声）→ 被识别成「像是 2024-2025 卷的一部分」 ──
const page1 = y24.questions.filter(q => q.page === 1).map((q, i) => ({
  stem: [q.stem, ...(i % 3 === 0 ? q.options : [])].join(' ').toUpperCase().replace(/\./g, ' .') + (i === 4 ? ' ~' : ''),   // 大小写、标点、选项换个位置
  options: i % 3 === 0 ? [] : q.options.map(o => o.replace(/ +/g, '  '))
}))
{
  const full = sim({ id: 'full', title: y24.title, grade: '4', year: 2024 }, y24.questions)
  const newPaper = sim({ id: 'new', title: 'g4-2025-page1', grade: '4', year: 2024 }, page1)
  const hit = findSimilar(newPaper, [full, sim({ id: 'other', title: y25.title, grade: '4', year: 2025 }, y25.questions)])
  assert.ok(hit && hit.of.id === 'full', '认出是 2024-2025 卷的一部分')
  assert.ok(hit.ratio >= 0.95, `第 1 页的题几乎全在整卷里：${hit.ratio}`)
  assert.ok(hit.reverse > 0.5 && hit.reverse < 0.8, `整卷里只有约 25/36 的题在这一页里：${hit.reverse}`)
  assert.match(similarText(full.title, hit.ratio, hit.reverse), /^疑似重复：像是《.+》的一部分（\d+% 的题在那份卷子里也有）$/)
  // 同一份卷子两次完整导入（换了文件格式）：基本一样
  const again = sim({ id: 'again', title: 'x', grade: null, year: null }, y24.questions.map(q => ({ stem: q.stem, options: q.options })))
  const h2 = findSimilar(again, [full]); assert.ok(h2 && h2.ratio === 1 && h2.reverse === 1)
  assert.match(similarText('整卷', h2.ratio, h2.reverse), /基本一样/)
}
// ── 不误伤：两年的卷子（同学校同年级、题目不同）不是重复；新卷太少题不比 ──
{
  const a = sim({ id: 'a', title: y24.title, grade: '4', year: 2024 }, y24.questions)
  const b = sim({ id: 'b', title: y25.title, grade: '4', year: 2025 }, y25.questions)
  const overlap = [...b.keys].filter(k => a.keys.has(k)).length / b.keys.size
  assert.ok(overlap < 0.5, `两年的卷子题目重合度应该很低：${overlap}`)
  assert.equal(findSimilar(b, [a]), null, '2025 卷不是 2024 卷的重复')
  assert.equal(findSimilar(sim({ id: 'tiny', title: 't', grade: '4', year: 2024 }, y24.questions.slice(0, 2)), [a]), null, '少于 3 道有效题不比对')
}
// 判定线：0.8 任意；0.5 + 同年级同学年；0.3 + 同标题
{
  const mk = (n, over = {}) => ({ id: over.id ?? 'n', title: over.title ?? '甲', grade: over.grade ?? '4', school_year_start: over.year ?? 2025, keys: new Set(Array.from({ length: n }, (_, i) => `题目内容编号${i}`)) })
  const old = { id: 'o', title: '乙', grade: '4', school_year_start: 2025, keys: new Set(Array.from({ length: 10 }, (_, i) => `题目内容编号${i}`)) }
  assert.equal(T_ANY, 0.8)
  assert.ok(findSimilar(mk(10, { grade: '5', year: 2020 }), [old]), '完全包含：不看元数据')
  const half = { id: 'h', title: '丙', grade: '4', school_year_start: 2025, keys: new Set([...Array.from({ length: 5 }, (_, i) => `题目内容编号${i}`), ...Array.from({ length: 5 }, (_, i) => `别的题目内容${i}`)]) }
  assert.ok(findSimilar(half, [old]), '一半重合 + 同年级同学年 → 疑似')
  assert.equal(findSimilar({ ...half, grade: '5' }, [old]), null, '一半重合但年级不同 → 不标')
  const third = { id: 't', title: '乙', grade: '5', school_year_start: 2020, keys: new Set([...Array.from({ length: 3 }, (_, i) => `题目内容编号${i}`), ...Array.from({ length: 7 }, (_, i) => `又别的题目${i}`)]) }
  assert.ok(findSimilar(third, [old]), '三成重合 + 标题一样 → 疑似')
  assert.equal(findSimilar({ ...third, title: '丁' }, [old]), null)
}

// ── 入库：detectSimilar 标 suspect，统计默认不计入；确认是新卷后计入；示例卷不参与 ──
{
  const { db } = newDb()
  // 题干和选项分开存，和应用里一样
  const put = (p, qs) => { const id = addPaper(db, { ...p, questions: qs.map(() => ({})) }); qs.forEach((q, i) => db.prepare('UPDATE questions SET stem = ?, options = ? WHERE paper_id = ? AND ord = ?').run(q.stem, JSON.stringify(q.options), id, i + 1)); return id }
  const idFull = put({ title: y24.title, grade: '4', year: 2024, status: 'done' }, y24.questions)
  const idNew = put({ title: 'g4-2025-page1', grade: '4', year: 2024, status: 'reviewing' }, page1)
  const r = detectSimilar(db, idNew)
  assert.ok(r && r.self && r.self.of === idFull && /像是《.*》的一部分/.test(r.self.text) && r.flaggedOthers.length === 0)
  const row = db.prepare('SELECT similar_state s, similar_to t, similar_ratio r FROM papers WHERE id = ?').get(idNew)
  assert.deepEqual([row.s, row.t], ['suspect', idFull]); assert.ok(row.r >= 0.9, String(row.r))
  const count = f => { const sc = paperScope({ includeReviewing: true, ...f }); return db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params).c }
  assert.equal(count({}), 1, '疑似重复的卷子默认不计入统计（待审核也算进来的情况下，仍只有整卷这一份）')
  assert.equal(count({ includeDuplicates: true }), 2, '打开「包含重复导入」才一并计入')
  // 疑似重复的计数跟随当前筛选：四年级范围里 1 份，五年级范围里 0 份；打开「包含重复导入」后不再算「没计入」
  assert.equal(scopeNotes(db, { includeReviewing: true }).similarSuspects, 1)
  assert.equal(scopeNotes(db, { includeReviewing: true, grade: '4' }).similarSuspects, 1)
  assert.equal(scopeNotes(db, { includeReviewing: true, grade: '5' }).similarSuspects, 0)
  assert.equal(scopeNotes(db, { includeReviewing: true, includeDuplicates: true }).similarSuspects, 0)
  // 疑似重复和「同一文件导入多份」分开计数：一份疑似重复卷不能同时让 duplicates 也变成 1
  { const n = scopeNotes(db, { includeReviewing: true }); assert.equal(n.duplicates, 0); assert.equal(n.similarSuspects, 1) }
  db.prepare("UPDATE papers SET file_hash = (SELECT file_hash FROM papers WHERE id = ?) WHERE id = ?").run(idFull, idNew)   // 再让两份是同一个文件
  { const n = scopeNotes(db, { includeReviewing: true }); assert.equal(n.duplicates, 0, '被标成疑似重复的那份已经不在统计范围里，不再算「同一文件的多份」'); assert.equal(n.similarSuspects, 1) }
  db.prepare("UPDATE papers SET file_hash = ? WHERE id = ?").run('h-restored', idNew)
  db.prepare("UPDATE papers SET similar_state = 'accepted' WHERE id = ?").run(idNew)   // 老师选「确实是新卷，计入统计」
  assert.equal(count({}), 2)
  assert.equal(detectSimilar(db, idNew), null, '老师确认过的，重新解析后也不再标')
  assert.equal(db.prepare('SELECT similar_state s FROM papers WHERE id = ?').get(idNew).s, 'accepted')
  // 示例数据不参与；修订号：similar_state 变化会推高数据修订号（看板和缓存据此刷新）
  const rev0 = db.prepare('SELECT rev FROM data_rev').get().rev
  db.prepare("UPDATE papers SET similar_state = NULL WHERE id = ?").run(idNew)
  assert.ok(db.prepare('SELECT rev FROM data_rev').get().rev > rev0, 'similar_state 在修订号触发器里')
  db.prepare('UPDATE papers SET is_sample = 1 WHERE id = ?').run(idNew)
  assert.equal(detectSimilar(db, idNew), null)
}
// ── P1-4：判断是对称的——先导入第 1 页、后导入整卷，被排除的是第 1 页；卷头信息读不出来时靠题目内容 ──
{
  for (const meta of [{ grade: '4', year: 2024 }, { grade: null, year: null }]) {
    const { db } = newDb()
    const put = (p, qs) => { const id = addPaper(db, { ...p, questions: qs.map(() => ({})) }); qs.forEach((q, i) => db.prepare('UPDATE questions SET stem = ?, options = ? WHERE paper_id = ? AND ord = ?').run(q.stem, JSON.stringify(q.options), id, i + 1)); return id }
    const idPage = put({ title: 'g4-2025-page1', ...meta, status: 'done' }, page1)
    const idFull = put({ title: y24.title, ...meta, status: 'reviewing' }, y24.questions)
    const r = detectSimilar(db, idFull)
    assert.ok(r && r.self === null && r.flaggedOthers.length === 1 && r.flaggedOthers[0].id === idPage, `整卷后到：被标的是旧的第 1 页（${JSON.stringify(meta)}）`)
    const st = id => db.prepare('SELECT similar_state s, similar_to t FROM papers WHERE id = ?').get(id)
    assert.deepEqual([st(idPage).s, st(idPage).t], ['suspect', idFull], '第 1 页像是整卷的一部分')
    assert.equal(st(idFull).s, null, '整卷不被标')
    const count = f => { const sc = paperScope({ includeReviewing: true, ...f }); return db.prepare(`SELECT COUNT(*) c FROM papers p WHERE ${sc.where}`).get(...sc.params).c }
    assert.equal(count({}), 1, '统计里只有整卷这一份')
    // 老师确认过的（accepted）旧卷不会被改
    db.prepare("UPDATE papers SET similar_state = 'accepted', similar_to = NULL WHERE id = ?").run(idPage)
    assert.equal(detectSimilar(db, idFull), null)
    assert.equal(st(idPage).s, 'accepted')
    // 整库扫描（升级后）：按导入先后处理，结果和一份份导入一样
    db.prepare("UPDATE papers SET similar_state = NULL WHERE id = ?").run(idPage)
    const sc = scanSimilar(db)
    assert.deepEqual([sc.checked, sc.suspects], [2, 1])
    assert.equal(st(idPage).s, 'suspect'); assert.equal(st(idFull).s, null)
    // 删掉整卷后，第 1 页不再有「原卷」：重新判断，恢复计入
    db.prepare('DELETE FROM questions WHERE paper_id = ?').run(idFull); db.prepare('DELETE FROM papers WHERE id = ?').run(idFull)
    redetectAfterRemoval(db, idFull)
    assert.equal(st(idPage).s, null, '原卷没了，第 1 页恢复计入')
  }
  // 完全一样的两份：标后导入的；先后顺序变了，标的也跟着变
  const a = { id: 'a', title: 'x', grade: null, school_year_start: null, keys: new Set(y24.questions.map(q => questionKey(q.stem, q.options)).filter(Boolean)), seq: '2026-01-01|1' }
  const b = { ...a, id: 'b', seq: '2026-01-02|2' }
  assert.equal(decideFlag(a, b).flagged.id, 'b'); assert.equal(decideFlag(b, a).flagged.id, 'b')
  // 方向文字：被标的一份写「像是《X》的一部分」，X 是更完整的那份
  const full = { ...a, id: 'full' }, part = { ...a, id: 'part', keys: new Set([...a.keys].slice(0, 20)), seq: '2026-01-01|0' }
  const d = decideFlag(part, full); assert.equal(d.flagged.id, 'part'); assert.equal(d.hit.of.id, 'full')
}

// ── 整库扫描：和「按导入先后一份份 detectSimilar」结果一致；300 份卷子不卡（内存里比对）；异步版会让出事件循环 ──
{
  const build = () => {
    const { db } = newDb()
    const put = (title, qs, o = {}) => { const id = addPaper(db, { title, grade: '4', year: 2024, status: 'done', ...o, questions: qs.map(() => ({})) }); qs.forEach((q, i) => db.prepare('UPDATE questions SET stem = ?, options = ? WHERE paper_id = ? AND ord = ?').run(q.stem, JSON.stringify(q.options ?? []), id, i + 1)); return id }
    // 12 个「主题」，每份卷子取其中一部分题；有整卷、有局部、有完全重复、有互不相干的
    const topic = (k, n) => Array.from({ length: n }, (_, i) => ({ stem: `Topic ${k} sentence number ${i} with enough words to be a key` }))
    const ids = []
    for (let k = 0; k < 12; k++) ids.push(put(`整卷${k}`, topic(k, 20), { year: 2020 + (k % 5) }))
    for (let k = 0; k < 12; k += 2) ids.push(put(`局部${k}`, topic(k, 8), { year: 2020 + (k % 5) }))
    for (let k = 1; k < 12; k += 4) ids.push(put(`重复${k}`, topic(k, 20), { year: 2020 + (k % 5) }))
    return { db, ids }
  }
  const a = build(), b = build()
  const states = db => db.prepare('SELECT title, similar_state s, ROUND(similar_ratio, 3) r FROM papers ORDER BY title').all().map(x => `${x.title}:${x.s}:${x.r}`)
  const rA = scanSimilar(a.db)
  for (const { id } of b.db.prepare("SELECT id FROM papers ORDER BY created_at, rowid").all()) detectSimilar(b.db, id, { olderOnly: true })
  assert.deepEqual(states(a.db), states(b.db), '整库扫描 = 按导入先后一份份比对')
  assert.equal(rA.checked, 12 + 6 + 3); assert.ok(rA.suspects >= 9, `局部 6 份 + 重复 3 份都应被标：${rA.suspects}`)
  assert.equal(a.db.prepare("SELECT similar_state s FROM papers WHERE title = '整卷0'").get().s, null, '整卷不被标')
  // 再扫一遍：结果不变（幂等）
  const before = states(a.db); scanSimilar(a.db); assert.deepEqual(states(a.db), before)
  // 老师确认过的不会被改
  a.db.prepare("UPDATE papers SET similar_state = 'accepted' WHERE title = '局部0'").run(); scanSimilar(a.db)
  assert.equal(a.db.prepare("SELECT similar_state s FROM papers WHERE title = '局部0'").get().s, 'accepted')
}
{
  // 300 份：不能卡（以前每对卷子都读一遍数据库，300 份约 5.5 秒）
  const { db } = newDb()
  for (let k = 0; k < 300; k++) {
    const id = addPaper(db, { title: `卷${k}`, grade: '4', year: 2020 + (k % 6), status: 'done', questions: Array.from({ length: 40 }, () => ({})) })
    for (let i = 0; i < 40; i++) db.prepare('UPDATE questions SET stem = ? WHERE paper_id = ? AND ord = ?').run(`Paper ${k} question ${i} with plenty of unique words here`, id, i + 1)
  }
  const t0 = Date.now()
  const progress = []
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const r = await scanSimilarAsync(db, p => progress.push(p.done))
  clearInterval(timer)
  const ms = Date.now() - t0
  assert.equal(r.checked, 300); assert.equal(progress.length, 300); assert.equal(progress[299], 300)
  assert.ok(ms < 3000, `300 份卷子整库扫描应远快于 5.5 秒：${ms} ms`)
  assert.ok(ticks > 0 || ms < 50, '异步版让出了事件循环（定时器在扫描期间触发过）')
}

// ── 扫描期间老师点了「确实是新卷」/ 删了卷子：写回前重新读当前状态，不覆盖 ──
{
  const { db } = newDb()
  const put = (title, year) => { const id = addPaper(db, { title, grade: '4', year, status: 'done', questions: Array.from({ length: 20 }, () => ({})) }); for (let i = 0; i < 20; i++) db.prepare('UPDATE questions SET stem = ? WHERE paper_id = ? AND ord = ?').run(`Shared sentence number ${i} with enough words to be a key`, id, i + 1); return id }
  const a = put('原卷', 2020), b = put('重复卷', 2021), c = put('另一份重复', 2022)
  let n = 0
  await scanSimilarAsync(db, () => {
    n++
    if (n === 1) {
      db.prepare("UPDATE papers SET similar_state = 'accepted' WHERE id = ?").run(b)   // 老师点了「确实是新卷」
      db.prepare('DELETE FROM questions WHERE paper_id = ?').run(c); db.prepare('DELETE FROM papers WHERE id = ?').run(c)   // 这份被删了
    }
  })
  assert.equal(db.prepare('SELECT similar_state s FROM papers WHERE id = ?').get(b).s, 'accepted', '老师确认过的不被扫描结果覆盖')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM papers WHERE id = ?').get(c).c, 0)
  assert.ok(a)
}

console.log('similar.test ✓')
