// 主进程数据链路按学科分开：统计 / 筛选候选值、判重（数学保留运算符、跨学科不比对）、知识点编辑的学科、
// 助手会话与数据工具、报告历史保留条数、命令行 --subject。
import assert from 'node:assert/strict'
import { newDb, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { paperScope } from '../../src/main/stats/filter.ts'
import { describeFilter } from '../../src/main/stats/p2.ts'
import { questionKey, detectSimilar, scanSimilar } from '../../src/main/parse/similar.ts'
import { saveTaxonomy, TaxonomyError } from '../../src/main/taxonomy/edit.ts'
import { createSession, listSessions, sessionSubject, getSession } from '../../src/main/agent/store.ts'
import { statsOverview, papersList, reportsList, kpQuestions, resolveKp } from '../../src/main/agent/tools/data.ts'
import { historySearch } from '../../src/main/agent/tools/builtin.ts'
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts'
import { getRole } from '../../src/main/agent/roles.ts'
import { pruneReportHistory } from '../../src/main/report/history-prune.ts'
import { parseArgs, statsFilterFromFlags, paperFilterFromFlags, subjectFromFlags, CliError, COMMANDS } from '../../src/main/cli/args.ts'

const { db } = newDb()
const setSubject = (id, s) => db.prepare('UPDATE papers SET subject = ? WHERE id = ?').run(s, id)
const Q = (kp, extra = {}) => ({ kp, score: 2, difficulty: 3, ...extra })

// ───── 造数据：英语 2 份、数学 1 份、语文 1 份 ─────
const en1 = addPaper(db, { title: '英语卷1', textbook: '人教PEP', region: '北京', questions: [Q('GR.TENSE.PAST.REG')] })
const en2 = addPaper(db, { title: '英语卷2', textbook: '外研版', questions: [Q('FN.SHOP')] })
const ma1 = addPaper(db, { title: '数学卷1', textbook: '人教版', region: '上海', year: 2024, questions: [Q('MA.NUM.INT.COUNT', { qtype: 'MA_ORAL' })] })
const cn1 = addPaper(db, { title: '语文卷1', textbook: '统编版', questions: [Q('CN.PY.TONE', { qtype: 'CN_OTHER' })] })
setSubject(ma1, 'math'); setSubject(cn1, 'chinese')
void en2

// ───── 统计：按学科隔开 ─────
{
  assert.equal(S.scopeCounts(db, paperScope({})).papers, 2, '不写学科 = 英语')
  assert.equal(S.scopeCounts(db, paperScope({ subject: 'math' })).papers, 1)
  assert.equal(S.scopeCounts(db, paperScope({ subject: 'chinese' })).papers, 1)
  // 筛选候选值
  const fe = S.filterOptions(db, {}), fm = S.filterOptions(db, { subject: 'math' }), fc = S.filterOptions(db)
  assert.deepEqual(fe.textbooks, ['人教PEP', '外研版']); assert.deepEqual(fm.textbooks, ['人教版']); assert.deepEqual(fc.textbooks, fe.textbooks, '不传筛选 = 英语')
  assert.deepEqual(fm.regions, ['上海']); assert.deepEqual(fm.years, [2024])
  // 选中范围的份数：别的学科的卷子 id 不算
  assert.equal(S.selectedCount(db, { paperIds: [en1, ma1] }), 1)
  assert.equal(S.selectedCount(db, { paperIds: [en1, ma1], subject: 'math' }), 1)
  // 描述里写学科名（英语保持原样）
  assert.ok(describeFilter({ subject: 'math' }, 0).startsWith('数学'))
  assert.ok(!/英语/.test(describeFilter({}, 0)))
  // 题型分组兜底不再是英语的 written
  const d = S.distribution(db, { subject: 'chinese' })
  assert.ok(d.qtypes.every(q => q.group !== 'written'))
}

// ───── 判重：数学保留运算符；跨学科不比对 ─────
{
  assert.notEqual(questionKey('计算 3+5=8 这道题', [], 'math'), questionKey('计算 3×5=8 这道题', [], 'math'), '数学「+」和「×」不能被当成同一题')
  assert.equal(questionKey('计算 3+5=8 这道题', [], 'english'), questionKey('计算 3×5=8 这道题', [], 'english'), '其他学科保持原来的归一化')
  assert.notEqual(questionKey('比较大小 12 > 7 填符号', [], 'math'), questionKey('比较大小 12 < 7 填符号', [], 'math'))

  const { db: d2 } = newDb()
  const mk = (title, subj, stems) => {
    const id = addPaper(d2, { title, status: 'done', questions: stems.map(s => ({ stem: s, kp: subj === 'math' ? 'MA.CALC' : 'GR.TENSE' })) })
    d2.prepare('UPDATE papers SET subject = ? WHERE id = ?').run(subj, id); return id
  }
  const stems = ['What did you do last weekend yesterday', 'She goes to school by bus every single day', 'They played football in the park after school', 'He has lived in Beijing for five years now']
  mk('A卷', 'english', stems)
  const b = mk('B卷', 'math', stems)   // 题干一样但学科不同：不算重复
  assert.equal(detectSimilar(d2, b), null, '跨学科不比对')
  const c = mk('C卷', 'english', stems)
  assert.ok(detectSimilar(d2, c), '同学科同题干判为疑似重复')
  scanSimilar(d2)
  assert.equal(d2.prepare('SELECT similar_state s FROM papers WHERE id = ?').get(b).s, null, '整库扫描也不跨学科')
  // 数学：只差运算符的两份卷子不是重复
  mk('数1', 'math', ['计算 12+35=47 竖式', '计算 56-23=33 竖式', '计算 7×8=56 口算', '计算 72÷9=8 口算'])
  const m2 = mk('数2', 'math', ['计算 12-35=47 竖式', '计算 56+23=33 竖式', '计算 7÷8=56 口算', '计算 72×9=8 口算'])
  assert.equal(detectSimilar(d2, m2), null, '只差运算符的数学卷不判重复')
}

// ───── 知识点编辑：学科 ─────
{
  saveTaxonomy(db, [{ op: 'add', parent_code: null, name: '数学自建一级', subject: 'math' }])
  const root = db.prepare("SELECT code, subject FROM kps WHERE name = '数学自建一级'").get()
  assert.deepEqual([root.code, root.subject], ['MA.U.U1', 'math'], '根节点代码用学科前缀')
  saveTaxonomy(db, [{ op: 'add', parent_code: null, name: '语文自建一级', subject: 'chinese' }])
  assert.equal(db.prepare("SELECT code FROM kps WHERE name = '语文自建一级'").get().code, 'CN.U.U1')
  saveTaxonomy(db, [{ op: 'add', parent_code: null, name: '英语自建一级' }])
  assert.equal(db.prepare("SELECT code FROM kps WHERE name = '英语自建一级'").get().code, 'U.U1', '英语沿用 U')
  saveTaxonomy(db, [{ op: 'add', parent_code: 'MA.NUM', name: '数的认识子项' }])
  assert.equal(db.prepare('SELECT subject s FROM kps WHERE code = ?').get('MA.NUM.U1').s, 'math', '子节点随父节点')
  assert.throws(() => saveTaxonomy(db, [{ op: 'add', parent_code: 'MA.NUM', name: '串学科', subject: 'chinese' }]), e => e instanceof TaxonomyError && /不能在/.test(e.message))
  assert.throws(() => saveTaxonomy(db, [{ op: 'move', code: 'MA.NUM.U1', parent_code: 'GR.TENSE' }]), e => e instanceof TaxonomyError && /别的学科/.test(e.message))
  assert.throws(() => saveTaxonomy(db, [{ op: 'merge', code: 'MA.NUM.U1', into: 'GR.TENSE' }]), e => e instanceof TaxonomyError && /别的学科/.test(e.message))
}

// ───── 助手：会话学科、数据工具强制本学科 ─────
{
  createSession(db, { id: 'se', role: 'ops', scene: 'org', title: '英语对话' })
  createSession(db, { id: 'sm', role: 'ops', scene: 'org', title: '数学对话', subject: 'math' })
  createSession(db, { id: 'sm2', role: 'ops', scene: 'org', title: '数学另一个', subject: 'math' })
  assert.equal(sessionSubject(db, 'se'), 'english'); assert.equal(sessionSubject(db, 'sm'), 'math'); assert.equal(sessionSubject(db, '不存在'), 'english')
  assert.equal(getSession(db, 'sm').session.subject, 'math')
  assert.deepEqual(listSessions(db, 60, 'math').map(s => s.id).sort(), ['sm', 'sm2'])
  assert.deepEqual(listSessions(db, 60, 'english').map(s => s.id), ['se'])
  assert.equal(listSessions(db).length, 3, '不指定学科 = 全部')

  const ctxOf = sid => ({ db, scene: 'org', roleId: 'ops', sessionId: sid, signal: new AbortController().signal, setPlan() {}, ask: async () => '', playbook: () => null, playbookNames: () => [] })
  const run = async (tool, args, sid) => { const o = await tool.run(tool.schema.parse(args), ctxOf(sid)); return typeof o === 'string' ? o : o.text }
  const tm = await run(papersList, {}, 'sm')
  assert.ok(tm.includes('数学卷1') && !tm.includes('英语卷1') && !tm.includes('语文卷1'), '数学会话只看到数学卷')
  const te = await run(papersList, {}, 'se')
  assert.ok(te.includes('英语卷1') && !te.includes('数学卷1'))
  assert.ok((await run(statsOverview, {}, 'sm')).includes('卷子 1 份'))
  assert.ok((await run(statsOverview, {}, 'se')).includes('卷子 2 份'))
  // 知识点名字只在本学科里找
  assert.equal(resolveKp(db, 'MA.NUM', 'english').length, 0); assert.equal(resolveKp(db, 'MA.NUM', 'math').length, 1)
  assert.ok((await run(kpQuestions, { kp: 'GR.TENSE.PAST.REG' }, 'sm')).includes('没有找到'), '数学会话查不到英语知识点')
  // 报告列表按学科
  const ins = (id, subj) => db.prepare("INSERT INTO reports (id, kind, filter_json, markdown, subject) VALUES (?, 'report', '{}', 'x', ?)").run(id, subj)
  ins('r-en', 'english'); ins('r-ma', 'math')
  const rm = await run(reportsList, {}, 'sm')
  assert.ok(rm.includes('r-ma') && !rm.includes('r-en'))
  // 以前的对话也只翻本学科的
  const hs = await run(historySearch, { query: '' }, 'sm')
  assert.ok(hs.includes('sm2') && !hs.includes('对话 se'))
  // 系统提示写学科名
  const role = getRole('ops') ?? getRole('teacher')
  const p = buildSystemPrompt({ subject: 'math', role, scene: 'org', playbooks: [], today: '今天' })
  assert.ok(p.includes('数学试卷数据') && !p.includes('英语试卷数据'))
  assert.ok(buildSystemPrompt({ role, scene: 'org', playbooks: [], today: '今天' }).includes('英语试卷数据'))
}

// ───── 报告历史：每个学科各留 N 条 ─────
{
  const { db: d3 } = newDb()
  const ins = d3.prepare("INSERT INTO reports (id, kind, filter_json, markdown, subject, created_at) VALUES (?, 'report', '{}', 'x', ?, ?)")
  for (let i = 0; i < 5; i++) ins.run(`e${i}`, 'english', `2026-01-0${i + 1} 10:00:00`)
  for (let i = 0; i < 4; i++) ins.run(`m${i}`, 'math', `2026-02-0${i + 1} 10:00:00`)
  pruneReportHistory(d3, 'report', 'math', 3)
  const ids = s => d3.prepare('SELECT id FROM reports WHERE subject = ? ORDER BY id').all(s).map(r => r.id)
  assert.deepEqual(ids('math'), ['m1', 'm2', 'm3'], '数学留最近 3 条')
  assert.equal(ids('english').length, 5, '英语的不受影响')
  pruneReportHistory(d3, 'report', 'english', 3)
  assert.deepEqual(ids('english'), ['e2', 'e3', 'e4'])
  assert.equal(ids('math').length, 3)
}

// ───── 命令行 --subject ─────
{
  assert.equal(subjectFromFlags(parseArgs(['papers', 'list', '--subject', 'math']).flags), 'math')
  assert.equal(subjectFromFlags(parseArgs(['status']).flags), undefined)
  assert.throws(() => subjectFromFlags(parseArgs(['papers', 'list', '--subject', 'physics']).flags), e => e instanceof CliError && e.code === 'usage')
  for (const c of ['status', 'import', 'papers list', 'stats overview', 'stats hot', 'stats compare', 'report generate', 'report list']) assert.ok(COMMANDS[c].flags.includes('subject'), `${c} 接受 --subject`)
  const f = parseArgs(['stats', 'overview', '--subject', 'chinese', '--grade', '4']).flags
  assert.deepEqual(statsFilterFromFlags(f), { subject: 'chinese', grade: '4' })
  assert.deepEqual(statsFilterFromFlags({}, 'math'), { subject: 'math' }, '没写 --subject 用兜底学科（设置里当前学科）')
  assert.deepEqual(statsFilterFromFlags({ subject: 'english' }, 'math'), { subject: 'english' }, '明确写了就以明确的为准')
  assert.deepEqual(paperFilterFromFlags({ subject: 'math' }), { subject: 'math' })
  assert.deepEqual(paperFilterFromFlags({}), {}, '都没写：不带学科（papers:list 当英语）')
}

console.log('subject-data: ok')
