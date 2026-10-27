// M6 数据层：迁移 v10（白话释义、旧默认输出上限、旧框修复、新表新列）、知识点白话 / 例句编辑与内置数据、证据包、Word 导出。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { newDb, addPaper, migrations, migrate } from './helpers/db.mjs'
import { KP_PLAIN } from '../../src/main/seed/kp-plain.ts'
import { KP_SEEDS_V1 } from '../../src/main/seed/taxonomy.ts'
import { saveTaxonomy } from '../../src/main/taxonomy/edit.ts'
import { collectEvidence } from '../../src/main/stats/evidence.ts'
import { paperScope } from '../../src/main/stats/filter.ts'
import { buildDocx } from '../../src/main/report/docx.ts'
import { validateKpRows } from '../../src/main/pack/kp-rules.ts'
import { loadTaxonomyText } from './helpers/taxtext.mjs'
import mammoth from 'mammoth'
import JSZip from 'jszip'

// ── 内置数据：145 个节点一个不少，字段合规 ──
{
  const codes = KP_SEEDS_V1.map(k => k[0])
  assert.equal(codes.length, 145); assert.deepEqual(Object.keys(KP_PLAIN).sort(), [...codes].sort())
  const seen = new Set()
  for (const [c, v] of Object.entries(KP_PLAIN)) {
    assert.ok(v.plain && v.plain.length <= 25, `${c} 白话 ≤ 25 字：${v.plain}`)
    assert.ok(v.hint_words && v.hint_words.length <= 40 && !/[|\n]/.test(v.hint_words + v.plain + v.example_en + v.example_zh), `${c} 例词/字符`)
    assert.equal((v.example_en.match(/\*\*/g) ?? []).length, 2, `${c} 例句里恰好一对 ** 标记：${v.example_en}`)
    assert.ok(!/[A-Za-z]/.test(v.example_zh), `${c} 中文意思里不夹英文`)
    assert.ok(!seen.has(v.example_en), `${c} 例句重复`); seen.add(v.example_en)
    assert.ok(!/time to \+ 名词|time for \+ 动词/.test(v.plain + v.example_en + v.hint_words), `${c} 不写反 time for / time to 的规则`)
  }
  assert.ok(/It's time \*\*for\*\* lunch/.test(KP_PLAIN['GR.PREP.COLLOC'].example_en) || /time for/.test(KP_PLAIN['GR.PREP.COLLOC'].plain))
}

// ── 迁移 v10 ──
{
  const { db, version } = newDb()
  assert.equal(version, 10)
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
  for (const c of ['plain', 'example_en', 'example_zh', 'hint_words']) assert.ok(cols('kps').includes(c), `kps.${c}`)
  for (const c of ['error_detail', 'similar_to', 'similar_ratio', 'similar_state']) assert.ok(cols('papers').includes(c), `papers.${c}`)
  for (const c of ['reader', 'confirmed_at', 'verify_json']) assert.ok(cols('reports').includes(c), `reports.${c}`)
  assert.ok(cols('ai_analyses').includes('verify_json')); assert.deepEqual(cols('ai_drafts'), ['key', 'kind', 'markdown', 'refs_json', 'message', 'detail', 'model', 'created_at'])
  assert.equal(db.prepare("SELECT COUNT(*) c FROM kps WHERE builtin = 1 AND plain IS NOT NULL AND example_en IS NOT NULL AND example_zh IS NOT NULL AND hint_words IS NOT NULL").get().c, 145, '全部内置节点都有白话 / 例句 / 例词')
  assert.equal(db.prepare("SELECT plain p FROM kps WHERE code = 'GR.PRON.POSS'").get()?.p ?? '表示“谁的”', db.prepare("SELECT plain p FROM kps WHERE code = 'GR.PRON.POSS'").get()?.p ?? '表示“谁的”')
  db.prepare("INSERT INTO reports (id, kind, markdown) VALUES ('r1', 'report', 'x')").run()
  assert.equal(db.prepare("SELECT reader r FROM reports WHERE id = 'r1'").get().r, 'full', '旧报告读者默认 full（完整数据版）')
}
// 从 v9 升上来：旧输出上限 8192（等于旧版内置默认）→ 自动；用户手改过的保留；旧框修复；已有报告 / 题目不丢
{
  const ms = migrations()
  const mk = cfg => {
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON')
    for (let i = 0; i < 9; i++) { db.exec('BEGIN'); ms[i](db); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT') }
    if (cfg) db.prepare("INSERT INTO settings (key, value_json) VALUES ('ai_config', ?)").run(JSON.stringify(cfg))
    return db
  }
  const read = db => JSON.parse(db.prepare("SELECT value_json v FROM settings WHERE key = 'ai_config'").get().v)
  let db = mk({ provider: 'deepseek', model: 'deepseek-v4-pro', max_tokens: 8192 })
  migrate(db, 9)
  assert.deepEqual([read(db).max_tokens, read(db).max_tokens_auto], [32768, true], '旧默认 8192 → 自动（推理模型 32768）')
  db = mk({ provider: 'deepseek', model: 'deepseek-v4-pro', max_tokens: 16384 }); migrate(db, 9)
  assert.deepEqual([read(db).max_tokens, read(db).max_tokens_auto], [16384, false], '用户手改过（运营把它调成 16384）的保留，关闭自动')
  db = mk({ provider: 'x', model: 'm' }); migrate(db, 9)
  assert.equal(read(db).max_tokens_auto, true, '没存过输出上限 = 用默认 = 自动')
  db = mk({ max_tokens: 8192, max_tokens_auto: false }); migrate(db, 9)
  assert.equal(read(db).max_tokens_auto, false, '已经有 max_tokens_auto 的不再动')
  db = mk(null); migrate(db, 9); assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'ai_config'").get().c, 0, '没有配置就不凭空造')
  // 旧框修复 + 数据保留
  db = mk(null)
  db.prepare("INSERT INTO papers (id, title, file_name, file_hash, status) VALUES ('p1', 't', 'f', 'h', 'done')").run()
  const iq = db.prepare("INSERT INTO questions (id, paper_id, ord, no_label, bbox_json, bbox_source, page_idx) VALUES (?, 'p1', ?, ?, ?, ?, 1)")
  iq.run('q16', 1, '16', '[0.128,0.677,0.291,0.026]', 'text-anchor'); iq.run('q17', 2, '17', '[0.412,0.677,0.274,0.026]', 'text-anchor'); iq.run('qm', 3, '18', '[0.05,0.677,0.4,0.026]', 'manual'); iq.run('qbad', 4, '19', '不是json', 'text-anchor')
  db.prepare("INSERT INTO reports (id, kind, markdown, title) VALUES ('old', 'report', '旧报告', '全部年级 · 考情分析报告')").run()
  migrate(db, 9)
  const b = id => JSON.parse(db.prepare('SELECT bbox_json b FROM questions WHERE id = ?').get(id).b)
  assert.ok(Math.abs(b('q16')[0] + b('q16')[2] - 0.404) < 0.0011, '第 16 题右边缩回到第 17 题前面'); assert.deepEqual(b('q17'), [0.412, 0.677, 0.274, 0.026]); assert.deepEqual(b('qm'), [0.05, 0.677, 0.4, 0.026], '手工框不动')
  assert.equal(db.prepare("SELECT bbox_json b FROM questions WHERE id = 'qbad'").get().b, '不是json', '坏数据原样保留')
  assert.equal(db.prepare("SELECT markdown m, reader r FROM reports WHERE id = 'old'").get().r, 'full'); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10)
}

// ── 知识点编辑器：白话 / 例句 / 例词可填可清，字符规则同名称和说明 ──
{
  const { db } = newDb()
  const r = saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.PRON', name: '测试代词', plain: '表示“谁的”', example_en: 'This is **my** book.', example_zh: '这是我的书。', hint_words: 'my / your' }])
  const code = r.touched[0]
  const row = () => db.prepare('SELECT plain, example_en, example_zh, hint_words FROM kps WHERE code = ?').get(code)
  assert.equal(row().plain, '表示“谁的”'); assert.equal(row().hint_words, 'my / your')
  saveTaxonomy(db, [{ op: 'update', code, plain: '  改了  ', example_en: '' }])
  assert.equal(row().plain, '改了'); assert.equal(row().example_en, null, '空串 = 清掉'); assert.equal(row().example_zh, '这是我的书。', '没提到的字段不动')
  assert.throws(() => saveTaxonomy(db, [{ op: 'update', code, plain: '含|竖线' }]), /白话释义.*竖线/)
  assert.throws(() => saveTaxonomy(db, [{ op: 'update', code, plain: '两行\n文字' }]), /白话释义/)
  assert.throws(() => saveTaxonomy(db, [{ op: 'update', code, example_en: 'x'.repeat(121) }]), /英文例句不能超过 120/)
  // 内置节点也能改白话（和改名一样）；改了会让修订号推高
  const rev = db.prepare('SELECT rev FROM data_rev').get().rev
  saveTaxonomy(db, [{ op: 'update', code: 'GR.NOUN', plain: '名词的各种变化' }])
  assert.ok(db.prepare('SELECT rev FROM data_rev').get().rev > rev)
  // 数据包校验：新字段同样不许带竖线 / 控制字符
  const base = { code: 'A', parent_code: null, name: '甲', level: 1, intro_grade: 3, note: null }
  validateKpRows([{ ...base, plain: '好的', example_en: 'ok **a**', example_zh: '好', hint_words: 'a / b' }])
  assert.throws(() => validateKpRows([{ ...base, plain: 'a|b' }]), /白话释义/); assert.throws(() => validateKpRows([{ ...base, hint_words: 'x\ny' }]), /例词/)
}

// ── 给 AI 的知识点树带白话 ──
{
  const { db } = newDb()
  const t = loadTaxonomyText(db)
  const line = t.split('\n').find(l => l.startsWith('GR.PREP.COLLOC | '))
  assert.ok(line && line.split(' | ').length === 5 && /固定搭配/.test(line.split(' | ')[4]), line)
  assert.ok(t.split('\n').every(l => l.split(' | ').length === 5), '每行 5 栏：代码 | 路径 | 年级 | 说明 | 白话')
}

// ── 证据包：易错说明 + 知识点白话；只取范围内（已审核）的题 ──
{
  const { db } = newDb()
  addPaper(db, { title: 'A', status: 'done', questions: [
    { no: 1, kp: 'GR.PREP.COLLOC', err: true, reason: 'time for + 名词，time to + 动词', stem: "It's time ____ breakfast." },
    { no: 2, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: 'sheep 单复数同形，易误加 -s' },
    { no: 3, kp: 'GR.NOUN.PLURAL.IRR', err: false, reason: '' }] })
  addPaper(db, { title: 'B待审核', status: 'reviewing', questions: [{ no: 1, kp: 'GR.NOUN.PLURAL.IRR', err: true, reason: '待审核卷里的说明不该进证据' }] })
  const ev = collectEvidence(db, paperScope({}), { level: 2 })
  const colloc = ev.kps.find(k => k.code === 'GR.PREP.COLLOC')
  assert.deepEqual(colloc.reasons, ['time for + 名词，time to + 动词'])
  assert.ok(colloc.plain && colloc.example_en, '带上知识点的白话和例句')
  assert.ok(ev.statements.includes('sheep 单复数同形，易误加 -s') && !ev.statements.some(s => /待审核/.test(s)))
  // 统计范围打开「含待审核」时，未审核卷子里 AI 写的易错说明仍然不进证据
  const evR = collectEvidence(db, paperScope({ includeReviewing: true }), { level: 2 })
  assert.ok(!evR.statements.some(s => /待审核/.test(s)) && !/待审核卷里/.test(evR.text), '证据只取已确认（done）的卷子')
  assert.ok(evR.statements.includes('sheep 单复数同形，易误加 -s'))
  assert.ok(/^介词固定搭配 \| .+ \| .+ \| time for \+ 名词，time to \+ 动词$/m.test(ev.text) || /time for \+ 名词，time to \+ 动词/.test(ev.text), ev.text)
  assert.ok(!/GR\.PREP|PH_/.test(ev.text), '证据表里不放内部代码，免得 AI 照抄')
  assert.equal(collectEvidence(db, paperScope({ grade: '6' }), {}).text, '（无）')
  const only = collectEvidence(db, paperScope({}), { codes: ['GR.PREP.COLLOC'] }); assert.deepEqual(only.kps.map(k => k.code), ['GR.PREP.COLLOC'])
}

// ── Word 导出：能被 Word 类软件读回（mammoth），文字、表格、列表、图片都在 ──
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const md = ['# 标题', '> 说明：AI 草稿〔未核实〕', '## 易错点', '- **名词复数**：tomato 的复数加 -es', '1. 第一条', '| 名称 | 份数 |', '|---|---|', '| 名词复数 | 3/3 |', '引用 [2025卷 · 7] 结束 <script>x</script> & "q"'].join('\n')
  const buf = await buildDocx({ title: '四年级 考情分析报告（老板版）· 2026-10-26', markdown: md, images: new Map([['[2025卷 · 7]', { png, width: 300, height: 60 }]]), footer: 'AI 草稿 · 请老师核对后再使用' })
  const text = (await mammoth.extractRawText({ buffer: buf })).value
  for (const s of ['四年级 考情分析报告（老板版）', '易错点', '名词复数', 'tomato 的复数加 -es', '第一条', '3/3', '[2025卷 · 7]', '<script>x</script>', 'AI 草稿 · 请老师核对']) assert.ok(text.includes(s), `docx 里要有「${s}」：\n${text}`)
  assert.equal((text.match(/四年级 考情分析报告/g) ?? []).length, 1, '文档标题不重复写（正文第一行的一级标题略过）')
  const z = await JSZip.loadAsync(buf)
  assert.ok(z.file('word/media/image1.png') && z.file('word/document.xml') && z.file('[Content_Types].xml'))
  const html = (await mammoth.convertToHtml({ buffer: buf })).value
  assert.ok(/<table>/.test(html) && /<img /.test(html) && /<h2>.*易错点.*<\/h2>/.test(html), html.slice(0, 400))
  const empty = await buildDocx({ title: 't', markdown: '' }); assert.ok(empty.length > 500)
}
// ── 整份确认会清空 papers.ai_meta_json（有意的，见交付说明）：确认之后卷头信息算老师认可的，重新解析不再用新的 AI 猜测覆盖 ──
{
  const { pickPrefill } = await import('../../src/main/parse/validate.ts')
  const paper = { title: 'x', file_name: 'x.pdf', grade: '4', semester: '下', school_year_start: 2025, exam_type: '期末', textbook: null, total_score: 100 }
  const guess = { grade: '5', semester: '上', school_year_start: 2024, textbook: '人教PEP' }
  const afterAi = pickPrefill(paper, guess, ['grade', 'semester'])   // 还是「AI 猜测」的字段：允许被新猜测覆盖
  assert.equal(afterAi.fields.grade, '5'); assert.equal(afterAi.fields.semester, '上')
  const afterConfirm = pickPrefill(paper, guess, [])                  // 整份确认后 ai_meta_json = []：已有的值保留，只补空的
  assert.equal(afterConfirm.fields.grade, undefined); assert.equal(afterConfirm.fields.semester, undefined); assert.equal(afterConfirm.fields.textbook, '人教PEP')
}

console.log('m6-data.test ✓')
