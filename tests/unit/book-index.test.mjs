// 教材书库：清洗、词形归一、题干去干扰、认单元（目录三种版式 + 按正文标题）、书后词表、全文索引（FTS5 与退化路径）、搜索排序、去重、扫描页走识别。
// 全部是虚构的小段文字，不含真实教材内容。
import assert from 'node:assert/strict'
import { cleanPage, looksLikeMappedPinyin, normForSearch } from '../../src/main/bookindex/text.ts'
import { lemmaKey, englishLemmas, cleanQuestion, indexTokens, cjkGrams } from '../../src/main/bookindex/tokens.ts'
import { analyzeStructure, resolveUncertain, detectOffset } from '../../src/main/bookindex/structure.ts'
import { splitWordEntry } from '../../src/main/bookindex/appendix.ts'
import { buildBook, needsOcr } from '../../src/main/bookindex/build.ts'
import { newDb } from './helpers/db.mjs'
import { saveBook, hasBook, listBooks, removeBook, ensureFts, forceNoFts, cacheClear, bookUnits, unitWordList } from '../../src/main/bookindex/store.ts'
import { searchBooks, searchQuestion } from '../../src/main/bookindex/search.ts'

// ───── 文字清洗 ─────
assert.equal(cleanPage(['Who’s your teacher?']).text, "Who's your teacher?")
{
  // 统编语文式拼音：单独成行或夹在汉字间的乱码字母要去掉；英文页不动
  const c = cleanPage(['早晨，从山坡上，从坪坝', 'bS', '里，走来了许多小学生，有汉', 'hSn', '族的'])
  assert.equal(c.text, '早晨，从山坡上，从坪坝里，走来了许多小学生，有汉族的')
  assert.equal(c.pinyinRemoved, 2)
  assert.equal(cleanPage(['I can sing', 'Hello'], true).text, 'I can sing Hello', '英文页不受影响')
  assert.equal(cleanPage(['我愿意', 'ABC', '好'], false).text, '我愿意 ABC 好', '关掉清洗就原样保留')
  assert.equal(looksLikeMappedPinyin([['huQng', 'bS']]), false, '很少几个不算拼音字体')
  assert.equal(looksLikeMappedPinyin([Array.from({ length: 40 }, () => 'huQng')]), true)
}
assert.equal(cleanPage(['ruler  () 尺子']).text, 'ruler () 尺子', '音标字体的私有区符号去掉')
assert.equal(normForSearch("Who’s your  Art-Teacher?"), "who's your art-teacher")

// ───── 词形归一（保守） ─────
assert.equal(lemmaKey('is'), lemmaKey('are')); assert.equal(lemmaKey('am'), 'be')
assert.equal(lemmaKey('plates'), lemmaKey('plate')); assert.equal(lemmaKey('boxes'), lemmaKey('box')); assert.equal(lemmaKey('babies'), lemmaKey('baby'))
assert.equal(lemmaKey('liked'), lemmaKey('like')); assert.equal(lemmaKey('making'), lemmaKey('make')); assert.equal(lemmaKey('running'), lemmaKey('run'))
assert.equal(lemmaKey('children'), 'child')
for (const w of ['bus', 'this', 'class', 'sing', 'red', 'need', 'thing', 'news', 'yes']) assert.equal(lemmaKey(w), w, `${w} 不该被改`)
assert.notEqual(lemmaKey('bed'), lemmaKey('bee'))
assert.deepEqual(englishLemmas("Who's your art teacher?"), ['who', 'be', 'your', 'art', 'teacher'])
assert.deepEqual(englishLemmas("I can't swim. They're here."), ['i', 'can', 'not', 'swim', 'they', 'be', 'here'])
assert.deepEqual(cjkGrams('分数的').bi, ['分数', '数的'])
assert.ok(indexTokens('Plates 分数').includes('plate') && indexTokens('Plates 分数').includes('分数'))

// ───── 题干去干扰 ─────
assert.equal(cleanQuestion('3. ____ is your art teacher?\nA. Who B. What C. Where'), 'is your art teacher?')
assert.equal(cleanQuestion('（5）下面哪个词语有新鲜感？（ ）\nA. 新鲜  B. 老旧'), '下面哪个词语有新鲜感？')
assert.equal(cleanQuestion('No.12 I have ______ eraser.'), 'I have eraser.')

// ───── 虚构的英文书：目录标题一栏页码一栏（读出顺序乱）、单元号在页尾、附录词表 ─────
const pg = (...lines) => lines
const enRaw = [
  pg('Cover'),
  pg('Appendix 1: Words in each unit', 'CONTENTS', 'Unit 1 Hello!', 'Unit 2 Colours', '1', '6', '11'),
  pg('Hi, I’m Zoom.', 'Unit One', '1'),
  pg('Who’s your art teacher?', 'I have an eraser.', 'A pencil box and rulers.', '2'),
  pg('Let’s learn', 'ruler pencil eraser', '3'),
  pg('Look at the plates.', '4'),
  pg('Story time', '5'),
  pg('Good morning.', 'Unit Two', '6'),
  pg('I see red. Colour it blue!', '7'),
  pg('What colour is it? It is green.', '8'),
  pg('Sing a song', '9'),
  pg('Fill in the blanks.', '10'),
  pg('Appendix 1', 'Words in each unit', '单元词汇表', 'Unit 1', 'ruler   尺子 p.2', 'eraser () 橡皮 p.2', 'pencil box 铅笔盒', '(文具) p.2', 'Unit 2', 'red红色 p.7', 'blue 蓝色 p.7', '11'),
  pg('')
]
const fake = (raw, extra = {}) => buildBook({ hash: 'h' + Math.abs(raw.length * 7919), name: '虚构英语三上', textLayer: async () => raw, ...extra })
const en = await fake(enRaw)
assert.equal(en.structure.via, 'toc')
assert.equal(en.structure.offset, 2)
assert.deepEqual(en.structure.units.map(u => [u.key, u.pageStart, u.pageEnd]), [['unit:1', 3, 7], ['unit:2', 8, 12]])
assert.deepEqual(en.pages.slice(2, 12).map(p => p.printed), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '印的页码按偏移补齐')
assert.equal(en.pages[1].kind, 'toc'); assert.equal(en.pages[12].kind, 'appendix'); assert.equal(en.pages[3].unitSeq, 1); assert.equal(en.pages[9].unitSeq, 2)
{
  const words = en.appendix.filter(a => a.kind === 'word')
  assert.deepEqual(words.map(w => [w.text, w.unitKey, w.printedRef, w.pdfRef]), [['ruler', 'unit:1', 2, 4], ['eraser', 'unit:1', 2, 4], ['pencil box', 'unit:1', 2, 4], ['red', 'unit:2', 7, 9], ['blue', 'unit:2', 7, 9]])
  assert.equal(words[2].gloss.includes('铅笔盒'), true, '换行的释义连在一起')
}
assert.match(en.summary.line, /2 个单元，5 个单词/)
assert.match(en.summary.line, /共 14 页/)
assert.deepEqual(splitWordEntry('clever /()/聪明的；聪颖的 p.8'), { text: 'clever', gloss: '聪明的；聪颖的' })
assert.equal(splitWordEntry('p.8'), null)

// ───── 没有目录：按正文里的 Unit 标题切；完全认不出：按页均分 ─────
{
  const noToc = enRaw.filter((_, i) => i !== 1)
  const r = analyzeStructure(noToc.map((l, i) => { const c = cleanPage(l); return { page: i + 1, text: c.text, lines: c.lines, empty: !c.text } }))
  assert.equal(r.via, 'heading'); assert.equal(r.units.length, 2)
  const flat = Array.from({ length: 25 }, (_, i) => pg(`Some text on page ${i}`)).map((l, i) => { const c = cleanPage(l); return { page: i + 1, text: c.text, lines: c.lines, empty: false } })
  const b = analyzeStructure(flat)
  assert.equal(b.via, 'blocks'); assert.ok(b.units.length >= 2 && b.notes.length)
}

// ───── 虚构的语文书：点线目录 + 课文号 + 识字表 / 写字表 / 词语表；拼音乱码 ─────
const pinyin = Array.from({ length: 40 }, () => 'huQng')
const cnRaw = [
  pg('封面'),
  pg('目 录', '第一单元......................................1', '1. 小蝌蚪找妈妈....................2', '.2. 秋天的雨...............................5', '第二单元.....................................9', '3. 古诗二首..............................10', '识字表........................................14', '写字表........................................15', '词语表........................................16'),
  pg('第一单元', '1'),
  pg('小蝌蚪游啊游，找到了妈妈。', 'bS', '关注有新鲜感的词语。', pinyin[0], '2'),
  pg('秋天的雨', '这是一场秋天的雨。', '3'),
  pg('阅读时，关注有新鲜感的词语和句子。', '4'),
  pg('秋天的雨下啊下。', '5'),
  pg('语文园地', '6'),
  pg('交流平台', '7'),
  pg('习作', '8'),
  pg('第二单元', '9'),
  pg('古诗二首', '白日依山尽，黄河入海流。', '10'),
  pg('练习', '11'),
  pg('练习', '12'),
  pg('练习', '13'),
  pg('识 字 表', '.1. 蝌', 'kE', '蚪', 'dGu', '.3. 诗', '14'),
  pg('写 字 表', '..1 . .蝌 蚪 游', '..3 . .诗 歌', '15'),
  pg('词 语 表', '. 1. 小蝌蚪. 妈妈. 游泳', '. 3. 白日. 黄河', '16'),
  pg('后记', ''),
  pg('')
]
// 拼音乱码要够多才判定为拼音字体：补一页
cnRaw[11] = pg('练习练习练习练习练习练习练习练习', ...pinyin, '11')
const cn = await buildBook({ hash: 'cn1', name: '虚构语文三上', textLayer: async () => cnRaw })
assert.equal(cn.structure.units.length, 2)
assert.deepEqual(cn.structure.units.map(u => [u.title, u.pageStart]), [['第一单元', 3], ['第二单元', 11]])
assert.ok(cn.pages[3].text.includes('小蝌蚪游啊游，找到了妈妈。关注有新鲜感的词语。'), cn.pages[3].text)
assert.ok(!/bS|huQng/.test(cn.pages[3].text), '拼音乱码不进正文')
assert.ok(cn.pages[3].pinyinRemoved >= 1)
assert.equal(cn.structure.units[0].sections.find(s => s.lessonNo === 2).page, 7, '课文挂在单元下，页码按偏移换算')
{
  const by = k => cn.appendix.filter(a => a.kind === k)
  assert.deepEqual(by('char-read').map(a => [a.text, a.lessonNo, a.unitKey]), [['蝌', 1, 'unit:1'], ['蚪', 1, 'unit:1'], ['诗', 3, 'unit:2']])
  assert.deepEqual(by('char-write').map(a => a.text).join(''), '蝌蚪游诗歌')
  assert.deepEqual(by('phrase').map(a => [a.text, a.unitKey]), [['小蝌蚪', 'unit:1'], ['妈妈', 'unit:1'], ['游泳', 'unit:1'], ['白日', 'unit:2'], ['黄河', 'unit:2']])
}

// ───── 扫描页：文字层是空的，走注入的文字识别；识别不到的页记为“没有文字” ─────
{
  const scanned = enRaw.map((l, i) => (i === 3 ? [] : l))
  let calls = []
  const b = await fake(scanned, { ocr: async p => { calls.push(p); return p === 4 ? ['Who’s your art teacher?', 'I have an eraser.', '2'] : [] } })
  assert.ok(calls.includes(4))
  assert.equal(b.pages[3].via, 'ocr'); assert.ok(b.pages[3].text.includes('art teacher')); assert.equal(b.summary.ocrPages, 1)
  const noOcr = await fake(scanned)
  assert.equal(noOcr.pages[3].via, 'none'); assert.ok(noOcr.summary.emptyPages.includes(4)); assert.match(noOcr.summary.line, /第 4.*没有文字/)
  assert.equal(needsOcr(['x']), true); assert.equal(needsOcr(['This page has enough readable text on it.']), false)
}

// ───── AI 只能从已认出的单元里选 ─────
{
  const pages = enRaw.map((l, i) => { const c = cleanPage(l); return { page: i + 1, text: c.text, lines: c.lines, empty: !c.text } })
  const st = analyzeStructure(pages)
  st.uncertain = [5, 6]
  const asked = []
  const n = await resolveUncertain(st, pages, async (ps, units) => { asked.push(ps.map(p => p.page)); assert.ok(units.every(u => u.key.startsWith('unit:'))); return { 5: 'unit:2', 6: 'unit:99' } })
  assert.deepEqual(asked, [[5, 6]]); assert.equal(n, 1)
  assert.equal(st.pageUnit[4], 2); assert.equal(st.pageUnit[5], 1, '不在列表里的回答被丢掉')
  assert.equal(await resolveUncertain(st, pages, async () => { throw new Error('boom') }), 0, 'AI 出错不影响结果')
  assert.equal(detectOffset(pages).offset, 2)
}

// ───── 存库 + 搜索（FTS5 与退化路径结果一致）；同一文件只存一份 ─────
const mk = () => newDb().db   // 真实迁移建出来的库（含 v16 的 book_* 表）
for (const useFts of [true, false]) {
  const db = mk()
  cacheClear()
  if (!useFts) forceNoFts(db)
  assert.equal(ensureFts(db), useFts)
  saveBook(db, en, { subject: 'english' }); saveBook(db, cn, { subject: 'chinese' })
  saveBook(db, en, { subject: 'english' })   // 同一个文件再存一次：只有一份
  assert.equal(listBooks(db).length, 2); assert.ok(hasBook(db, en.hash))
  assert.equal(db.prepare('SELECT COUNT(*) c FROM book_pages WHERE book_id = ?').get(en.hash).c, en.pages.length)
  if (useFts) assert.equal(db.prepare('SELECT COUNT(*) c FROM book_fts WHERE book_id = ?').get(en.hash).c, en.pages.filter(p => p.text).length, '全文索引也没有重复')

  // 整句 > 多词 > 单词
  const r = searchBooks(db, "Who's your art teacher?")
  assert.equal(r.hits[0].page, 4); assert.equal(r.hits[0].level, 'sentence'); assert.equal(r.hits[0].unitKey, 'unit:1'); assert.equal(r.hits[0].printedPage, 2)
  assert.match(r.hits[0].snippet, /art teacher/)
  const multi = searchBooks(db, 'teacher art eraser')
  assert.equal(multi.hits[0].page, 4); assert.equal(multi.hits[0].level, 'multi')
  // 单词：词表命中最靠前，指向印的页码；词形不同也能找到（plates ← plate）
  const w = searchBooks(db, 'eraser')
  assert.equal(w.hits[0].page, 4); assert.ok(w.hits[0].sources.includes('word-list')); assert.equal(w.hits[0].listed.gloss, '橡皮'); assert.equal(w.hits[0].printedPage, 2)
  assert.equal(searchBooks(db, 'plate').hits[0].page, 6)
  assert.equal(searchBooks(db, 'Is it green').hits[0].page, 10, 'is/are/be 归一')
  assert.ok(searchBooks(db, 'pencil box').hits[0].sources.includes('word-list'))
  // 目录页 / 附录页降权：目录里的 “Hello” 不会排在正文前面
  const hello = searchBooks(db, 'Hello')
  assert.ok(hello.hits.every(h => h.page !== 2))
  // 中文
  const z = searchBooks(db, '有新鲜感的词语和句子')
  assert.equal(z.hits[0].page, 6); assert.equal(z.hits[0].level, 'sentence'); assert.equal(z.hits[0].unitKey, 'unit:1')
  const z2 = searchBooks(db, '蝌蚪')
  assert.ok(z2.hits.some(h => h.page === 4 && h.unitKey === 'unit:1'))
  assert.equal(searchBooks(db, '黄河', { subject: 'chinese' }).hits[0].unitKey, 'unit:2')
  assert.equal(searchBooks(db, 'eraser', { subject: 'chinese' }).hits.length, 0, '按学科过滤')
  assert.equal(searchBooks(db, 'eraser', { bookIds: ['nope'] }).hits.length, 0)
  assert.equal(searchBooks(db, '   ').hits.length, 0)
  // 题干：去掉题号、选项、下划线
  const q = searchQuestion(db, "4. ______ your art teacher?\nA. Who's B. What's")
  assert.equal(q.cleaned, 'your art teacher?')
  assert.equal(q.hits[0].page, 4)
  // 单元词表
  assert.deepEqual(unitWordList(db, en.hash, 'unit:2').map(i => i.text), ['red', 'blue'])
  assert.equal(bookUnits(db, cn.hash)[0].sections.length >= 2, true)
  removeBook(db, en.hash)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM book_pages WHERE book_id = ?').get(en.hash).c, 0, '删书连带删页')
  assert.equal(searchBooks(db, 'eraser').hits.length, 0)
}

// ───── 迁移建出 4 张表 ─────
{ const { db: d, version } = newDb(); assert.equal(version >= 16, true); assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'book_%' AND type = 'table'").get().c, 4); assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0) }

console.log('book-index.test ✓')
