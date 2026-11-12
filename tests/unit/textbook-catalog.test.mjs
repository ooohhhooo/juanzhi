// 内置学校教材目录：每个目录文件的格式、教材版本、知识点代码、年级学期都要合法；注册表里列出的文件和目录里的文件一一对应。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEdition, bookKey, bookLabel, catalogInfo, builtinId, parseBuiltinId, pickBooks, builtinName } from '../../src/main/course/textbook-builtin.ts'
import { CATALOG } from '../../src/main/course/catalog.ts'
import { CATALOG_RAW } from '../../src/main/seed/textbook-catalog/index.ts'
import { KP_SEEDS_V1 } from '../../src/main/seed/taxonomy.ts'
import { MA_KP_SEEDS_V1 } from '../../src/main/seed/taxonomy-math.ts'
import { CN_KP_SEEDS_V1 } from '../../src/main/seed/taxonomy-chinese.ts'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main/seed/textbook-catalog')
const known = new Set([...KP_SEEDS_V1, ...MA_KP_SEEDS_V1, ...CN_KP_SEEDS_V1].map(s => s[0]))

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort()
assert.ok(files.length >= 6, '至少 6 个版本的目录文件')
const raws = new Map(CATALOG_RAW.map(e => [e.id, e]))
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  assert.equal(`${raw.id}.json`, f, `${f}：文件名要和 id 一致`)
  assert.deepEqual(validateEdition(raw, known), [], `${f} 校验通过`)
  assert.ok(raws.has(raw.id), `${f} 已登记在 textbook-catalog/index.ts`)
}
assert.equal(raws.size, files.length, 'index.ts 里登记的和目录里的文件数一致')
assert.equal(CATALOG.length, files.length, '运行时目录没有丢掉任何一个版本')
// 用户拍板的第一批 6 个版本
for (const id of ['math-renjiao', 'math-bsd', 'chinese-tongbian', 'english-pep', 'english-wy', 'english-yilin']) assert.ok(raws.has(id), `内置了 ${id}`)
// 英语第一批扩充的 12 个版本（docs/学科调研/教材目录/english-第一批-调研说明.md）
for (const id of ['english-pepxqd', 'english-pepjt', 'english-wyyiqi', 'english-bsdsanqi', 'english-bsdyiqi', 'english-jjsanqi', 'english-jjyiqi', 'english-xiangshao', 'english-xianglu', 'english-minjiao', 'english-shanlv', 'english-chongda']) assert.ok(raws.has(id), `内置了 ${id}`)
// 英语第三批（docs/学科调研/教材目录/english-第三批-调研说明.md）
for (const id of ['english-yuejiao', 'english-datong', 'english-xinjiaoji', 'english-hjyiqi']) assert.ok(raws.has(id), `内置了 ${id}`)

// 校验函数本身能报出问题
const good = JSON.parse(fs.readFileSync(path.join(dir, 'math-renjiao.json'), 'utf8'))
const bad = (patch) => validateEdition(patch(structuredClone(good)), known)
assert.ok(bad(e => { e.textbookValue = '某某版'; return e }).some(m => /textbookValue/.test(m)))
assert.ok(bad(e => { e.books[0].units[0].kps.push('MA.NOPE'); return e }).some(m => /不存在/.test(m)))
assert.ok(bad(e => { e.books[0].semester = '中'; return e }).some(m => /学期/.test(m)))
assert.ok(bad(e => { e.books[0].grade = 0; return e }).some(m => /年级/.test(m)))
assert.ok(bad(e => { e.books.push(structuredClone(e.books[0])); return e }).some(m => /重复/.test(m)))
assert.ok(bad(e => { e.books[0].units[2].no = e.books[0].units[1].no; return e }).some(m => /序号/.test(m)))
assert.ok(bad(e => { e.checkedAt = '昨天'; return e }).some(m => /checkedAt/.test(m)))
assert.ok(bad(e => { e.sources = []; return e }).some(m => /sources/.test(m)))
assert.ok(bad(e => { e.subject = 'english'; return e }).length > 0, '学科和 id、教材版本对不上')

// no 可以是 null（准备课、综合实践等）：校验通过，入库后用 label / 标题显示
assert.ok(good.books.some(b => b.units.some(u => u.no === null)), '真实目录里有无序号的单元')
assert.deepEqual(bad(e => { e.books[0].units[0].no = null; e.books[0].units[0].label = '准备课'; return e }), [])

// 辅助函数
const ed = CATALOG.find(e => e.id === 'math-renjiao')
assert.equal(bookKey(ed.books[0]), '1上')
assert.equal(bookLabel(ed.books[0]), '一年级上册')
const info = catalogInfo(CATALOG, 'math')
assert.deepEqual(info.map(i => i.id).sort(), ['math-beijing', 'math-bsd', 'math-hujiao', 'math-jijiao', 'math-qingdao', 'math-qingdaowusi', 'math-renjiao', 'math-sujiao', 'math-xishi'])
assert.ok(info[0].books.every(b => b.key && b.label && b.units > 0))
assert.equal(catalogInfo(CATALOG, 'chinese').length, 1)
assert.equal(pickBooks(ed, ['2上', '1上']).map(bookKey).join(','), '1上,2上', '按年级学期排序')
assert.equal(builtinId(ed, pickBooks(ed, ['2上', '1上'])), 'math-renjiao:1上,2上')
assert.deepEqual(parseBuiltinId('math-renjiao:1上,2上'), { editionId: 'math-renjiao', keys: ['1上', '2上'] })
assert.equal(parseBuiltinId('乱写'), null)
assert.equal(builtinName(ed, pickBooks(ed, ['1上'])), '人教版 一年级上册')
console.log('textbook-catalog ok')
