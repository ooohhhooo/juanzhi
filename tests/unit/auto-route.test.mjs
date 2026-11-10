// 导入自动分流 + 自动认学科：v14 迁移、分流规则、提取后核对学科、改学科、文档 / 数据集学科、助手工具按学科过滤
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb, addPaper, migrations } from './helpers/db.mjs'
import { planRoute, needsPeek } from '../../src/main/pipeline/auto-route.ts'
import { checkSubjectAfterExtract, hasSubjectHint, resolvePaperSubject, changePaperSubject, paperText } from '../../src/main/parse/subject-check.ts'
import { pickGroupSubject, foreignSubjectNotes } from '../../src/main/agent/paper-subject.ts'
import { DocumentStore, readDocument, documentsForModel } from '../../src/main/analysis/documents.ts'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { listDatasets } from '../../src/main/analysis/datasets/tools.ts'

const MATH_PAGE = `三年级数学期末测试卷
一、直接写得数。（每题 1 分，共 8 分）
25+36=（  ） 72-18=（  ） 6×7=（  ） 48÷6=（  ）
二、应用题。（每题 5 分）
1. 小明买 3 本练习本，每本 4 元 5 角，一共用了多少元？
2. 一个长方形长 8 厘米，宽 5 厘米，它的周长和面积各是多少？计算过程写在下面。`
const EN_PAGE = `PEP 小学英语五年级期末测试
Ⅰ. Listen and choose. 听录音，选出你所听到的单词。
1. A. apple B. banana C. orange
Ⅱ. Choose the correct answer. What time is it? It's seven o'clock. I get up (  ) the morning.
Ⅲ. Read and answer. Mike is a student. He goes to school by bus every day. Fill in the blanks.`

// ── v14 迁移：只加列，重复执行无害，旧数据不动 ──
{
  const ms = migrations()
  assert.equal(ms.length, 14)
  const { db } = newDb(':memory:', 13)
  assert.ok(!db.prepare('PRAGMA table_info(papers)').all().some(c => c.name === 'subject_hint'))
  db.prepare("INSERT INTO papers (id, title, file_name, file_hash, status, subject) VALUES ('p1', '旧卷', 'a.pdf', 'h1', 'done', 'math')").run()
  db.exec('BEGIN'); ms[13](db); db.exec('PRAGMA user_version = 14'); db.exec('COMMIT')
  assert.ok(db.prepare('PRAGMA table_info(papers)').all().some(c => c.name === 'subject_hint'))
  const row = db.prepare("SELECT subject, subject_hint FROM papers WHERE id = 'p1'").get()
  assert.equal(row.subject, 'math'); assert.equal(row.subject_hint, null)
  ms[13](db)   // 重复执行无害
  assert.equal(newDb().version, 14)
}

// ── 分流规则 ──
{
  assert.equal(planRoute('/x/学员表.xlsx', null).route, 'table')
  assert.equal(planRoute('/x/a.csv', null).route, 'table')
  assert.match(planRoute('/x/一年级课程大纲.xlsx', null).note, /课程/)
  assert.equal(planRoute('/x/普通表.xlsx', null).note, undefined)
  assert.equal(planRoute('/x/a.jpg', null).route, 'paper', '图片一律当试卷')
  assert.equal(planRoute('/x/a.PNG', null).route, 'paper')
  assert.equal(needsPeek('/x/a.pdf'), true); assert.equal(needsPeek('/x/a.jpg'), false); assert.equal(needsPeek('/x/a.xlsx'), false)
  assert.equal(planRoute('/x/a.pdf', null).route, 'paper', '扫描件拿不到文字：当试卷')
  assert.equal(planRoute('/x/a.pdf', '   ').route, 'paper')
  assert.equal(planRoute('/x/期末.pdf', MATH_PAGE).route, 'paper')
  const plan = planRoute('/x/三年级英语教案.docx', '一、教学目标\n学会单词 friend, tall。\n二、教学过程\n热身、导入、操练。\n三、教学反思\n学生参与度较高，课堂气氛不错。')
  assert.deepEqual([plan.route, plan.subject], ['document', 'english'])
  const memo = planRoute('/x/会议纪要.docx', '本周教研组开会讨论了下学期课程安排，各位老师汇报了教学进度，下周继续跟进，请大家按时完成各自的任务。')
  assert.deepEqual([memo.route, memo.subject], ['document', 'general'])
  assert.equal(planRoute('/x/a.zip', null).route, 'unsupported')
}

// ── 提取后核对学科 ──
{
  const { db } = newDb()
  const addPages = (id, text) => db.prepare("INSERT INTO pages (paper_id, idx, image_rel, text) VALUES (?, 1, 'p.png', ?)").run(id, text)
  // 当前英语，卷面明说数学 → 写 hint，不解析
  const a = addPaper(db, { title: '卷A', status: 'extracted' }); addPages(a, MATH_PAGE)
  const r = checkSubjectAfterExtract(db, a)
  assert.deepEqual([r.action, r.hint], ['hint', 'math'])
  assert.equal(db.prepare('SELECT subject_hint h FROM papers WHERE id = ?').get(a).h, 'math')
  assert.equal(hasSubjectHint(db, a), true)
  // 一致 → 照常解析
  const b = addPaper(db, { title: '卷B', status: 'extracted' }); addPages(b, EN_PAGE)
  assert.equal(checkSubjectAfterExtract(db, b).action, 'parse')
  assert.equal(hasSubjectHint(db, b), false)
  // 把握不大（文字很少）→ 用当前学科，不打扰
  const c = addPaper(db, { title: '卷C', status: 'extracted' }); addPages(c, '第一题 25+36=')
  assert.equal(checkSubjectAfterExtract(db, c).action, 'parse')
  // 只有 lines_json、没有 text 也能取到文字
  const d = addPaper(db, { title: '卷D', status: 'extracted' })
  db.prepare("INSERT INTO pages (paper_id, idx, image_rel, lines_json) VALUES (?, 1, 'p.png', ?)").run(d, JSON.stringify(MATH_PAGE.split('\n').map(text => ({ text }))))
  assert.match(paperText(db, d), /应用题/)
  assert.equal(checkSubjectAfterExtract(db, d).hint, 'math')
  // 用户选「放到数学」：设学科、清 hint
  assert.equal(resolvePaperSubject(db, a, 'math'), true)
  const ra = db.prepare('SELECT subject, subject_hint h FROM papers WHERE id = ?').get(a)
  assert.deepEqual([ra.subject, ra.h], ['math', null])
  // 「保持英语」：学科不变，只清 hint
  assert.equal(resolvePaperSubject(db, d, 'english'), false)
  assert.equal(hasSubjectHint(db, d), false)
  assert.throws(() => resolvePaperSubject(db, 'nope', 'math'))
  assert.throws(() => resolvePaperSubject(db, a, 'physics'))
}

// ── 改学科 ──
{
  const { db } = newDb()
  const pid = addPaper(db, { title: '卷', status: 'reviewing', questions: [{ qtype: 'MC' }, { qtype: 'MC' }] })
  db.prepare("INSERT INTO pages (paper_id, idx, image_rel, text) VALUES (?, 1, 'p.png', 'x')").run(pid)
  // 没审核过：直接改，删题目，退回已提取，建议重新解析
  const r1 = changePaperSubject(db, pid, 'math')
  assert.deepEqual(r1, { ok: true, changed: true, reparse: true })
  const row = db.prepare('SELECT subject, status FROM papers WHERE id = ?').get(pid)
  assert.deepEqual([row.subject, row.status], ['math', 'extracted'])
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(pid).c, 0)
  // 改成同一个学科：什么都不做
  assert.deepEqual(changePaperSubject(db, pid, 'math'), { ok: true, changed: false, reparse: false })

  // 已审核（整份确认过）：先要二次确认，不改
  const done = addPaper(db, { title: '审过', status: 'done', questions: [{ qtype: 'MC' }, { qtype: 'MC' }, { qtype: 'MC' }] })
  db.prepare("INSERT INTO pages (paper_id, idx, image_rel, text) VALUES (?, 1, 'p.png', 'x')").run(done)
  const n = changePaperSubject(db, done, 'chinese')
  assert.deepEqual(n, { ok: false, needConfirm: true, reviewed: 3 })
  assert.equal(db.prepare('SELECT subject FROM papers WHERE id = ?').get(done).subject, 'english')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(done).c, 3)
  assert.equal(changePaperSubject(db, done, 'chinese', { confirmLoseReview: true }).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ?').get(done).c, 0)

  // 逐题标过「已审核」也要确认
  const some = addPaper(db, { title: '部分审', status: 'reviewing', questions: [{ qtype: 'MC' }, { qtype: 'MC' }] })
  db.prepare("UPDATE questions SET reviewed = 1 WHERE paper_id = ? AND ord = 1").run(some)
  assert.equal(changePaperSubject(db, some, 'math').reviewed, 1)

  // 处理中不允许改
  const busy = addPaper(db, { title: '解析中', status: 'parsing' })
  assert.throws(() => changePaperSubject(db, busy, 'math'), /处理中/)
  const queued = addPaper(db, { title: '排队', status: 'extracted' })
  assert.throws(() => changePaperSubject(db, queued, 'math', { busy: true }), /处理中/)
  // 没有页面的失败卷：只改学科，不重新解析
  const nopage = addPaper(db, { title: '无页', status: 'failed' })
  assert.deepEqual(changePaperSubject(db, nopage, 'math'), { ok: true, changed: true, reparse: false })
}

// ── 文档、数据集：学科缺省通用，且能改 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-auto-'))
  const docs = new DocumentStore(dir)
  const g = docs.add('通用资料.txt', 'text', '一份没有学科的资料，内容是家长沟通记录。')
  const m = docs.add('数学教案.txt', 'text', '数学教案：分数的初步认识，教学目标……', 'math')
  assert.equal(g.subject, 'general'); assert.equal(m.subject, 'math')
  // 旧条目没有 subject 字段：读出来是通用
  const cat = path.join(dir, 'documents', 'catalog.json')
  const raw = JSON.parse(fs.readFileSync(cat, 'utf8'))
  delete raw.items[0].subject
  fs.writeFileSync(cat, JSON.stringify(raw))
  assert.equal(new DocumentStore(dir).get(g.id).subject, 'general')
  docs.setSubject(g.id, 'english'); assert.equal(docs.get(g.id).subject, 'english')
  docs.setSubject(g.id, 'general'); assert.equal(docs.get(g.id).subject, 'general')
  assert.throws(() => docs.setSubject('doc-nope', 'math'))

  // CSV 数据集：缺省通用；有「科目」列时说明里写清楚；可以改学科
  const store = new DatasetStore(dir)
  const csv = (rows) => Buffer.from(rows.map(r => r.join(',')).join('\n'), 'utf8')
  const f1 = path.join(dir, '成绩.csv'); fs.writeFileSync(f1, csv([['姓名', '科目', '分数'], ['甲', '数学', '90'], ['乙', '英语', '80'], ['丙', '语文', '70']]))
  const ds = await store.importFile(f1)
  assert.equal(ds.subject, 'general')
  assert.match(ds.note, /「科目」列/)
  const f2 = path.join(dir, '出勤.csv'); fs.writeFileSync(f2, csv([['姓名', '次数'], ['甲', '3'], ['乙', '4']]))
  const ds2 = await store.importFile(f2)
  assert.equal(ds2.note, '')
  store.setSubject(ds2.id, 'math'); assert.equal(store.get(ds2.id).subject, 'math')
  assert.equal(new DatasetStore(dir).get(ds2.id).subject, 'math', '落盘')
  // 旧目录里没有 subject 字段：当通用
  const dcat = path.join(dir, 'datasets', 'catalog.json')
  const dj = JSON.parse(fs.readFileSync(dcat, 'utf8')); dj.datasets.forEach(d => { delete d.subject }); fs.writeFileSync(dcat, JSON.stringify(dj))
  assert.equal(new DatasetStore(dir).get(ds2.id).subject, 'general')
  store.setSubject(ds2.id, 'math')

  // ── 助手工具：只给「会话学科 + 通用」──
  const e1 = docs.add('英语资料.txt', 'text', 'English materials 单词表', 'english')
  const names = async (subject) => {
    const r = await listDatasets.run({}, { store, documents: docs, subject })
    return { ds: r.datasets.map(d => d.id), docs: r.documents.map(d => d.id) }
  }
  const onMath = await names('math')
  assert.deepEqual(onMath.docs.sort(), [g.id, m.id].sort(), '数学对话：数学 + 通用的文档，没有英语的')
  assert.deepEqual(onMath.ds.sort(), [ds.id, ds2.id].sort())
  const onEn = await names('english')
  assert.deepEqual(onEn.docs.sort(), [g.id, e1.id].sort())
  assert.deepEqual(onEn.ds, [ds.id], '英语对话：看不到数学专属的数据集')
  assert.equal((await names(undefined)).docs.length, 3, '没指定会话学科 = 不过滤')
  assert.equal(documentsForModel({ documents: docs, subject: 'chinese' }).length, 1, '语文对话只有通用的')
  // read_document 同样限制
  assert.ok((await readDocument.run({ documentId: m.id }, { documents: docs, subject: 'english' })).error, '英语对话读不了数学文档')
  assert.ok((await readDocument.run({ documentId: m.id }, { documents: docs, subject: 'math' })).text)
  assert.ok((await readDocument.run({ documentId: g.id }, { documents: docs, subject: 'math' })).text, '通用文档谁都能读')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 助手导入试卷：每组各判各的学科 ──
{
  assert.deepEqual(pickGroupSubject([MATH_PAGE], '卷', undefined, 'english'), { subject: 'math', how: 'detected' })
  assert.deepEqual(pickGroupSubject([EN_PAGE], undefined, undefined, 'english'), { subject: 'english', how: 'detected' })
  assert.deepEqual(pickGroupSubject([MATH_PAGE], '卷', 'chinese', 'english'), { subject: 'chinese', how: 'explicit' }, '参数里写了就以它为准')
  assert.deepEqual(pickGroupSubject(['第一题 25+36='], '图', undefined, 'math'), { subject: 'math', how: 'session' }, '拿不准用会话学科')
  assert.deepEqual(pickGroupSubject([], undefined, undefined, 'chinese'), { subject: 'chinese', how: 'session' })
  assert.deepEqual(foreignSubjectNotes([{ fileName: 'a.pdf', subject: 'english' }], 'english'), [])
  const notes = foreignSubjectNotes([{ fileName: 'a.pdf', subject: 'english' }, { fileName: 'b.pdf', subject: 'math' }, { fileName: 'c.pdf', subject: 'math' }], 'english')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /2 份.*数学卷.*数学学科.*「b.pdf」、「c.pdf」.*切换到数学/)
}

console.log('auto-route.test ✓')
