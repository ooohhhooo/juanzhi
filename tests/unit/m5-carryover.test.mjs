// M5 从 M4 三审转入的项：
//  P2-A 导出失败：等写出流真正 close 再删 .part，读句柄显式销毁
//  P2-B 知识点代码 / 名称 / 说明的字符限制（控制字符、换行、竖线；代码字符集）
//  P2-C 启动提示：区分「文件没动的崩溃」「提交后仅清理失败」「真的恢复失败」；.invalid-* journal 只留最近几份
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { makeEnv, paperWithFiles, openDb, root, LATEST, newDb, addPaper, migrate } from './helpers/packenv.mjs'
import { extractPack } from '../../src/main/pack/reader.ts'
import { prepareStagedDb } from '../../src/main/pack/stage-db.ts'
import { applyMerge } from '../../src/main/pack/apply.ts'
import { buildPack } from '../../src/main/pack/exporter.ts'
import { PackError } from '../../src/main/pack/errors.ts'
import { kpTextProblem, flatKpText, stripInvisible, cleanSuggestedName, validateKpRows, KP_CODE_RE } from '../../src/main/pack/kp-rules.ts'
import { saveTaxonomy, TaxonomyError } from '../../src/main/taxonomy/edit.ts'
import {
  writeJournal, recoverImportJournal, recoverImportJournalDetailed, startupNoticeOf, pruneInvalidJournals, KEEP_INVALID_JOURNALS, MARKER_KEY, JOURNAL_FILE
} from '../../src/main/pack/journal.ts'

const Q = (code, score = 2) => ({ kp: code, qtype: 'MC', score, difficulty: 3 })

// ─────────── P2-A：导出失败时，rejected 之前写出流和所有读句柄都已经 close ───────────
{
  const E = makeEnv('p2a')
  // 文件要足够大，让读句柄在出错时还「在途」（被背压卡住）
  const big = paperWithFiles(E, { title: '大卷', year: 2025, grade: '4', hash: 'h-big', questions: [Q('GR.NOUN.PLURAL.REG')] }, 3)
  fs.writeFileSync(path.join(E.filesDir, big, 'page-1.png'), Buffer.alloc(3_000_000, 1))
  fs.writeFileSync(path.join(E.filesDir, big, 'page-2.png'), Buffer.alloc(3_000_000, 2))
  fs.writeFileSync(path.join(E.filesDir, big, 'page-3.png'), Buffer.alloc(3_000_000, 3))

  const realCreateRead = fs.createReadStream, realCreateWrite = fs.createWriteStream
  // 两种失败来源：'write' = 写出流报 ENOSPC（读句柄在途）；'read' = 某个源文件读失败（写出流还开着）
  for (const source of ['write', 'read']) {
    const reads = [], writes = []
    let uncaught = 0
    const onU = () => { uncaught++ }
    process.on('uncaughtException', onU)
    try {
      fs.createReadStream = (p, ...r) => {
        const s = realCreateRead.call(fs, p, ...r)
        reads.push({ p: String(p), s })
        if (source === 'read' && String(p).endsWith('page-2.png')) setTimeout(() => { const e = new Error('EIO: simulated'); e.code = 'EIO'; s.emit('error', e) }, 30)
        return s
      }
      // 写出流：句柄「慢慢」才放掉（模拟 Windows 上杀毒软件占着）：destroy 之后 120ms 才真正 close
      fs.createWriteStream = (p, ...r) => {
        const real = realCreateWrite.call(fs, p, ...r)
        if (!String(p).endsWith('.part')) return real
        let n = 0
        const w = new Writable({
          highWaterMark: 16 * 1024,
          write(chunk, enc, cb) {
            n += chunk.length
            if (source === 'write' && n > 1_000_000) { const e = new Error('ENOSPC: simulated'); e.code = 'ENOSPC'; cb(e); return }
            real.write(chunk, enc, cb)
          },
          destroy(err, cb) { setTimeout(() => real.destroy(), 120); real.once('close', () => cb(err)) }
        })
        writes.push(w)
        return w
      }
      const out = path.join(E.dir, `fail-${source}.ewb.zip`)
      const err = await buildPack({ db: E.db, openDb, filesDir: E.filesDir, outPath: out, tmpDir: path.join(E.dir, 'tmp-' + source), appVersion: 't' }).then(() => null, e => e)
      assert.ok(err instanceof PackError, `${source}：应 reject PackError：${err}`)
      if (source === 'write') assert.match(err.message, /磁盘空间不足/)
      // reject 的这一刻：写出流已经 close（而不是还在异步关闭），所有读句柄也都 close
      assert.equal(writes.length, 1)
      assert.equal(writes[0].closed, true, `${source}：reject 时写出流必须已经 close（否则紧接着删 .part，Windows 上会 EBUSY）`)
      const open = reads.filter(r => !r.s.closed).map(r => path.basename(r.p))
      assert.deepEqual(open, [], `${source}：reject 时所有读句柄都应已关闭，还开着：${open}`)
      assert.ok(reads.length >= 2, '前提：确实开过读句柄')
      assert.ok(!fs.existsSync(`${out}.part`) && !fs.existsSync(out), `${source}：.part 已删，也没留下数据包`)
      assert.equal(uncaught, 0)
    } finally { fs.createReadStream = realCreateRead; fs.createWriteStream = realCreateWrite; process.off('uncaughtException', onU) }
  }
  // 失败之后同一个库再导出一次成功
  const ok = await buildPack({ db: E.db, openDb, filesDir: E.filesDir, outPath: path.join(E.dir, 'ok.ewb.zip'), tmpDir: path.join(E.dir, 'tmp2'), appVersion: 't' })
  assert.equal(ok.entries, 2 + ok.manifest.fileCount)
}

// ─────────── P2-B：字符限制 ───────────
{
  // 纯函数
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a b', 'a​b', 'a﻿b', 'a‮b']) assert.ok(kpTextProblem(bad), JSON.stringify(bad) + ' 应被拒绝')
  assert.match(kpTextProblem('甲|乙'), /竖线/)
  for (const good of ['一般现在时', 'be动词 (am/is/are)', 'Let\'s + 动词原形', '例：last week, yesterday', '“引号”、顿号，逗号。']) assert.equal(kpTextProblem(good), null, good)
  assert.equal(flatKpText('a\nb | c\t d'), 'a b c d', '压成一行')
  for (const c of ['GR.TENSE', 'GR.TENSE.U1', 'VO.TOPIC.FOOD', 'U.U1', 'A_B.C2']) assert.ok(KP_CODE_RE.test(c), c)
  for (const c of ['gr.tense', 'GR TENSE', 'GR.TENSE\n', 'GR|X', '1A', 'GR..X', '.GR', 'GR.', 'GR.T"x', '中文.X']) assert.ok(!KP_CODE_RE.test(c), JSON.stringify(c) + ' 应被拒绝')

  // 手工编辑：新增 / 改名 / 改说明
  const { db } = newDb()
  const fails = (ops, re) => assert.throws(() => saveTaxonomy(db, ops), e => e instanceof TaxonomyError && re.test(e.message), String(re))
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: '第一行\n第二行' }], /名称.*换行/)
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: '甲|乙' }], /名称.*竖线/)
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: 'x\u0000y' }], /名称.*控制字符/)
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: '好', note: '第一行\n| 假记录 | 名称' }], /说明.*换行/)
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: '好', note: 'a|b' }], /说明.*竖线/)
  fails([{ op: 'add', parent_code: 'GR.TENSE', name: '好', note: 'x'.repeat(501) }], /说明不能超过 500/)   // 不再悄悄截断
  fails([{ op: 'update', code: 'GR.TENSE.PAST.REG', name: '改\n名' }], /名称.*换行/)
  fails([{ op: 'update', code: 'GR.TENSE.PAST.REG', note: '说明\r\n换行' }], /说明.*换行/)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM kps WHERE name LIKE '%第一行%' OR name LIKE '%|%'").get().c, 0, '被拒绝的什么都没写进库')
  // 合规的照常
  saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE', name: '时态小测（自建）', note: '例：last week, yesterday' }])
  assert.equal(db.prepare("SELECT note FROM kps WHERE code = 'GR.TENSE.U1'").get().note, '例：last week, yesterday')

  // 数据包导入：名称 / 说明 / 代码含控制字符、换行、竖线的整包拒绝
  const row = (code, name, extra = {}) => ({ code, parent_code: null, name, level: 1, intro_grade: null, note: null, ...extra })
  const badp = (rows, re) => assert.throws(() => validateKpRows(rows), e => e instanceof PackError && e.code === 'bad_content' && re.test(e.message), String(re))
  validateKpRows([row('AA', '正常'), row('AA.BB', '子', { parent_code: 'AA', level: 2 })])
  badp([row('AA', '第一行\n第二行')], /名称.*换行/)
  badp([row('AA', '甲|乙')], /名称.*竖线/)
  badp([row('AA', '好', { note: '一行\n另一行' })], /说明.*换行/)
  badp([row('AA', '好', { note: 'a | b | c' })], /说明.*竖线/)
  badp([row('aa b', '好')], /代码.*不允许的字符/)
  badp([row('AA\nBB', '好')], /代码.*不允许的字符/)
  badp([row('AA|BB', '好')], /代码.*不允许的字符/)
  badp([row('中文', '好')], /代码.*不允许的字符/)
}

// ─────────── P2-C：启动提示按实际情况区分 ───────────
{
  const mk = (tag) => {
    const E = makeEnv(tag)
    paperWithFiles(E, { title: '本机', year: 2025, grade: '4', hash: 'h-' + tag, questions: [Q('VO.TOPIC.FOOD')] }, 1)
    const bk = path.join(E.dataDir, 'backups', 'pre-import-20261026-140000-abcd'); fs.mkdirSync(bk, { recursive: true })
    const j = { id: 'id-' + tag, filesDir: E.filesDir, backupFilesDir: path.join(bk, 'files'), startedAt: 'x' }
    return { E, j, bk }
  }
  // ① 文件没动（journal 写好了、files 还没改名）：数据完整，不能说「可能对不上」
  {
    const { E, j } = mk('c1')
    writeJournal(E.dataDir, j)
    const o = recoverImportJournalDetailed(E.db, E.dataDir)
    assert.equal(o.kind, 'untouched')
    const n = startupNoticeOf(o)
    assert.equal(n.kind, 'recovered')
    assert.match(n.message, /还没有开始改动你的文件/)
    assert.doesNotMatch(n.message, /对不上|没有成功|失败/)
  }
  // ② 提交之后只是清 journal 失败：不抛错、不说恢复失败，说「已经完成」
  {
    const { E, j } = mk('c2')
    writeJournal(E.dataDir, j)
    E.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify(j.id))
    const realRm = fs.rmSync
    fs.rmSync = (p, o) => { if (String(p).endsWith(JOURNAL_FILE)) { const e = new Error('EBUSY: simulated'); e.code = 'EBUSY'; throw e } return realRm.call(fs, p, o) }
    let o
    try { o = recoverImportJournalDetailed(E.db, E.dataDir) } finally { fs.rmSync = realRm }
    assert.equal(o.kind, 'committed_cleanup_failed')
    const n = startupNoticeOf(o)
    assert.equal(n.kind, 'completed')
    assert.match(n.message, /已经成功完成/)
    assert.match(n.message, /不需要做任何事/)
    assert.doesNotMatch(n.message, /对不上|没有成功|没有完成/)
    assert.ok(fs.existsSync(path.join(E.dataDir, JOURNAL_FILE)), 'journal 还在（无害），下次启动再清')
    // 下次启动清理成功 → 不再有提示
    assert.equal(startupNoticeOf(recoverImportJournalDetailed(E.db, E.dataDir)), null)
  }
  // ③ 已提交且清理成功：没有提示
  {
    const { E, j } = mk('c3')
    writeJournal(E.dataDir, j)
    E.db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(MARKER_KEY, JSON.stringify(j.id))
    assert.equal(startupNoticeOf(recoverImportJournalDetailed(E.db, E.dataDir)), null)
  }
  // ④ 目录已换、没提交：换回来，提示「没有完成……保持在导入之前」
  {
    const { E, j } = mk('c4')
    writeJournal(E.dataDir, j)
    fs.renameSync(E.filesDir, j.backupFilesDir); fs.mkdirSync(E.filesDir)
    const n = startupNoticeOf(recoverImportJournalDetailed(E.db, E.dataDir))
    assert.equal(n.kind, 'recovered'); assert.match(n.message, /换回导入之前/)
  }
  // ⑤ files 和备份都找不到：这才是「可能对不上」
  {
    const { E, j } = mk('c5')
    writeJournal(E.dataDir, j)
    fs.rmSync(E.filesDir, { recursive: true })
    const o = recoverImportJournalDetailed(E.db, E.dataDir)
    assert.equal(o.kind, 'missing')
    const n = startupNoticeOf(o)
    assert.equal(n.kind, 'failed'); assert.match(n.message, /可能对不上/)
  }
  // ⑥ 恢复自己抛错
  {
    const n = startupNoticeOf(null, new Error('EBUSY: x'))
    assert.equal(n.kind, 'failed'); assert.match(n.message, /自动恢复没有成功：EBUSY/)
  }
  // 旧接口（字符串）仍可用
  { const { E, j } = mk('c6'); writeJournal(E.dataDir, j); assert.match(recoverImportJournal(E.db, E.dataDir), /没有完成.*保持现状/) }
}

// ─────────── .invalid-* journal 只留最近几份 ───────────
{
  const E = makeEnv('inv')
  const names = [1000, 2000, 3000, 4000, 5000, 6000].map(t => `${JOURNAL_FILE}.invalid-${t}`)
  for (const n of names) fs.writeFileSync(path.join(E.dataDir, n), 'x')
  fs.writeFileSync(path.join(E.dataDir, 'db-other.txt'), 'keep')
  const removed = pruneInvalidJournals(E.dataDir)
  assert.equal(removed, 6 - KEEP_INVALID_JOURNALS)
  const left = fs.readdirSync(E.dataDir).filter(n => n.startsWith(`${JOURNAL_FILE}.invalid-`)).sort()
  assert.deepEqual(left, names.slice(6 - KEEP_INVALID_JOURNALS), '留下的是时间戳最新的几份，不是最先出现的')
  assert.ok(fs.existsSync(path.join(E.dataDir, 'db-other.txt')), '别的文件不动')
  // 又来一个不认的 journal：改名后自动清理，总数仍不超过上限，而且新的这份在
  fs.writeFileSync(path.join(E.dataDir, JOURNAL_FILE), '{bad json')
  assert.throws(() => recoverImportJournal(E.db, E.dataDir), /无法识别/)
  const after = fs.readdirSync(E.dataDir).filter(n => n.startsWith(`${JOURNAL_FILE}.invalid-`))
  assert.equal(after.length, KEEP_INVALID_JOURNALS)
  assert.ok(after.some(n => Number(n.split('invalid-')[1]) > 1e12), '刚改名留下的新的一份还在')
  assert.ok(!after.includes(names[3 - 3]) && !after.includes(names[0]), '最老的被清掉了')
}

// ─────────── M5 审核 P2-1：旧数据 / 采纳建议 / 粘贴的零宽字符，不能让用户自己的数据包导不回去 ───────────
{
  // 纯函数
  assert.equal(stripInvisible('a\u200bb\ufeffc\u202ed'), 'abcd', '零宽 / BOM / 双向控制字符直接去掉（不变成空格，不把一个词拆开）')
  assert.equal(flatKpText('旧\n名|称\u200b'), '旧 名 称')
  assert.equal(flatKpText('\n|\t'), '', '全是分隔符 → 折完是空（调用方用代码顶上 / 拒绝）')
  // 采纳 AI 建议（taxonomy:approveSuggestion）用同一套规则：折成一行；折完为空 / 超长则拒绝
  assert.equal(cleanSuggestedName('购物：\n尺码|询问\u200b'), '购物： 尺码 询问')
  assert.throws(() => cleanSuggestedName('\n | \u200b'), /名称不能为空/)
  assert.throws(() => cleanSuggestedName('长'.repeat(31)), /不能超过 30/)
  assert.match(fs.readFileSync('src/main/ipc/questions.ts', 'utf8'), /cleanSuggestedName\(parsed\.name\)/, 'approveSuggestion 确实调用了它')
  // 手工编辑：粘贴带来的零宽字符静默剔除，不报「看不见的字符」
  const { db } = newDb()
  saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE', name: '从微\u200b信粘\ufeff贴', note: '例\u200b：last week' }])
  const n = db.prepare("SELECT name, note FROM kps WHERE code = 'GR.TENSE.U1'").get()
  assert.deepEqual([n.name, n.note], ['从微信粘贴', '例：last week'])
  saveTaxonomy(db, [{ op: 'update', code: 'GR.TENSE.U1', name: '改\u200b名' }])
  assert.equal(db.prepare("SELECT name FROM kps WHERE code = 'GR.TENSE.U1'").get().name, '改名')
  assert.throws(() => saveTaxonomy(db, [{ op: 'update', code: 'GR.TENSE.U1', name: '\u200b\u200b' }]), /名称不能为空/, '只有看不见的字符 = 空名称')
  assert.throws(() => saveTaxonomy(db, [{ op: 'update', code: 'GR.TENSE.U1', name: '带|竖线' }]), /竖线/, '可见的竖线仍然报错')

  // 用户自己导出自己的旧数据包再导入不被拒：旧版本库里已有含换行 / 竖线 / 零宽字符的自建节点
  const A = makeEnv('legacykp')
  paperWithFiles(A, { title: '旧卷', year: 2025, grade: '4', hash: 'h-legacy', questions: [Q('GR.NOUN.PLURAL.REG')] }, 1)
  const ins = A.db.prepare("INSERT INTO kps (code, parent_code, name, level, sort, builtin, note) VALUES (?, 'GR.TENSE', ?, 2, ?, 0, ?)")
  ins.run('GR.TENSE.U1', '旧\n名|称\u200b', 999, '第一行\n第二行 | 说明')
  ins.run('GR.TENSE.U2', '\n|', 1000, null)
  const out = path.join(A.dir, 'legacy.ewb.zip')
  await buildPack({ db: A.db, openDb, filesDir: A.filesDir, outPath: out, tmpDir: path.join(A.dir, 'tmp'), appVersion: 't' })
  const prep = p => prepareStagedDb(p, { openDb, migrate: (d, from) => migrate(d, from), latest: LATEST })
  const ex = await extractPack(out, path.join(A.dir, 'stage1'))
  {
    const d = openDb(ex.dbPath, { readOnly: true })
    const rows = Object.fromEntries(d.prepare("SELECT code, name, note FROM kps WHERE code LIKE 'GR.TENSE.U%'").all().map(r => [r.code, r]))
    d.close()
    assert.deepEqual([rows['GR.TENSE.U1'].name, rows['GR.TENSE.U1'].note], ['旧 名 称', '第一行 第二行 说明'], '导出端把名称 / 说明折成一行：导出的包永远合规')
    assert.equal(rows['GR.TENSE.U2'].name, 'GR.TENSE.U2', '名称折完是空 → 用代码顶上')
    assert.equal(prep(ex.dbPath).kpTextFolded, 0, '新导出的包导入端什么都不用整理')
  }
  // 旧版本导出的、没折平的包（M5 之前的导出）：导入端宽容归一化，而不是整包拒绝；并告知整理了几个
  const ex2 = await extractPack(out, path.join(A.dir, 'stage2'))
  {
    const d = openDb(ex2.dbPath)
    d.prepare("UPDATE kps SET name = ?, note = ? WHERE code = 'GR.TENSE.U1'").run('旧\n名|称\u200b', '第一行\n第二行 | 说明')
    d.prepare("UPDATE kps SET name = ? WHERE code = 'GR.TENSE.U2'").run('另一个|\u200b名')
    d.close()
    const info = prep(ex2.dbPath)
    assert.equal(info.kpTextFolded, 2, '两个节点被整理')
    const B = makeEnv('legacyimport')
    applyMerge(B.deps, { dbPath: ex2.dbPath, filesDir: ex2.filesDir })
    assert.deepEqual({ ...B.db.prepare("SELECT name, note FROM kps WHERE code = 'GR.TENSE.U1'").get() }, { name: '旧 名 称', note: '第一行 第二行 说明' }, '合并进来的是整理后的文字')
    assert.equal(B.db.prepare("SELECT name FROM kps WHERE code = 'GR.TENSE.U2'").get().name, '另一个 名')
  }
  // 宽容只限这类字符：别的问题照样整包拒绝
  const ex3 = await extractPack(out, path.join(A.dir, 'stage3'))
  { const d = openDb(ex3.dbPath); d.prepare("UPDATE kps SET name = ? WHERE code = 'GR.TENSE.U1'").run('长'.repeat(31)); d.close()
    assert.throws(() => prep(ex3.dbPath), e => e instanceof PackError && e.code === 'bad_content' && /名称超过 30/.test(e.message)) }
}

fs.rmSync(root, { recursive: true, force: true })
console.log('m5-carryover.test ✓')
