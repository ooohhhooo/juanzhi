// 教材位置短写法：按版本分组、册短写、单元短写、页码、较粗、超过 4 个折叠
import assert from 'node:assert/strict'
import { formatLocs, formatLoc, shortLevel, shortUnit, groupLocs } from '../../src/shared/tb-loc.ts'

const L = (edition, levelName, label, title, extra = {}) => ({ edition, outlineName: `${edition} 多册`, levelName, label, title, pages: '', coarse: false, ...extra })

assert.equal(shortLevel('三年级上册'), '三上'); assert.equal(shortLevel('四年级下册'), '四下'); assert.equal(shortLevel('六年级全一册'), '六全'); assert.equal(shortLevel('Book 1'), 'Book 1')
assert.equal(shortUnit({ label: '第2单元《Unit 2 Different families》', title: 'Unit 2 Different families' }), 'U2 Different families', '标题自带 Unit 编号，不重复')
assert.equal(shortUnit({ label: '第6模块', title: "Module 6 / Unit 5 We're family" }), "M6 / U5 We're family")
assert.equal(shortUnit({ label: '第3单元《Lesson 4 Cats》', title: 'Lesson 4 Cats' }), 'Lesson 4 Cats', 'Lesson 开头原样')
assert.equal(shortUnit({ label: '第5单元', title: '我的家' }), 'U5 我的家')
assert.equal(shortUnit({ label: '第5单元', title: '' }), 'U5')

const txt = formatLocs([L('人教PEP', '三年级上册', '第2单元', 'Unit 2 Different families'), L('人教PEP', '四年级上册', '第1单元', 'Unit 1 Helping at home'), L('外研版', '三年级上册', '第6模块', "Module 6 / Unit 5 We're family")])
const lines = txt.split('\n')
assert.equal(lines.length, 3)
assert.match(lines[0], /^人教PEP {2}三上 U2 Different families$/)
assert.match(lines[1], /^ +四上 U1 Helping at home$/, '版本名只写一次，后续行缩进')
assert.ok(!lines[1].includes('人教PEP'))
assert.match(lines[2], /^外研版 {2}三上 M6/)
assert.ok(!txt.includes('三年级') && !txt.includes('单元'), '没有长写')

// 页码、较粗
assert.equal(formatLoc({ edition: '', outlineName: '我的教材', levelName: '三年级上册', label: '第2单元', title: 'Plurals', pages: '第 12–18 页', coarse: true }), '我的教材 三上 U2 Plurals p.12–18（较粗）')
// 超过 4 个
const many = [1, 2, 3, 4, 5, 6].map(i => L('冀教版', '三年级上册', `第${i}单元`, `Unit ${i} T${i}`))
const g = groupLocs(many)
assert.deepEqual([g[0].items.length, g[0].more], [4, 2])
const t2 = formatLocs(many)
assert.match(t2, /等 6 处$/); assert.equal(t2.split('\n').length, 5)
// 去重
assert.equal(groupLocs([many[0], many[0]])[0].items.length, 1)
console.log('tb-loc.test.mjs OK')
