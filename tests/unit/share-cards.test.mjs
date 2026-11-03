// 分享卡片：schema 长度限制、HTML 转义、手机号 / 排名 / 多个孩子被拒、孩子称呼、模板资源齐全、默认模板设置、出图流程（假渲染）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCardContent, applyNamePolicy, givenName, checkRaw, checkFinal, hasPhone, ALL_KINDS, audienceOf } from '../../src/main/cards/schema.ts'
import { renderTemplate, escapeHtml } from '../../src/main/cards/engine.ts'
import { loadManifest, listTemplates, loadLayout, templateImagePath, buildCardPage, prepareData, readCardSettings, writeCardSettings, setCardRoot } from '../../src/main/cards/templates.ts'
import { makeCard, setCardRenderer } from '../../src/main/cards/make.ts'
import { CARD_TOOLS, cardMake, cardTemplates } from '../../src/main/cards/tools.ts'
import { checkSendAllowed } from '../../src/main/connectors/send-guard.ts'
import * as S from '../../src/main/agent/outputs/store.ts'

setCardRoot(path.resolve('resources', 'card-templates'))

// ── manifest：20 套，文件都在，区域合法，体积合理，每种版式都有 ──
const mf = loadManifest()
assert.equal(mf.templates.length, 20)
assert.equal(listTemplates('student').length, 10)
assert.equal(listTemplates('parent').length, 10)
for (const t of mf.templates) {
  const p = templateImagePath(t)
  assert.ok(fs.existsSync(p), `${t.id} 底图存在`)
  assert.match(t.file, /\.jpg$/)
  assert.ok(fs.statSync(p).size < 450 * 1024, `${t.id} 体积 ${fs.statSync(p).size}`)
  assert.equal(fs.readFileSync(p).subarray(0, 2).toString('hex'), 'ffd8', `${t.id} 是 JPEG`)
  for (const z of [t.panel, t.title, t.foot]) { assert.equal(z.length, 4); assert.ok(z[0] >= 0 && z[2] <= 1 && z[1] >= 0 && z[3] <= 1 && z[0] < z[2] && z[1] < z[3]) }
  assert.match(t.style.accent, /^#[0-9a-fA-F]{6}$/)
}
assert.equal(new Set(mf.templates.map(t => t.id)).size, 20)
for (const k of ALL_KINDS) { const l = loadLayout(k); assert.ok(l.zones.title && l.zones.panel && l.zones.foot, `${k} 版式有三个区域`) }
assert.ok(fs.existsSync(path.resolve('resources/card-templates/layouts/base.css')))

// ── schema：长度上限截断并提示；数量不够报错 ──
const longKnowledge = { title: '一二三四五六七八九十一二三四五六七八九十', hook: '引导', items: [{ left: 'go', right: 'went' }, { left: 'see', right: 'saw' }], example: { en: 'I went.', zh: '我去了。' } }
let r = parseCardContent('knowledge', longKnowledge)
assert.ok(r.ok); assert.equal([...r.data.title].length, 14); assert.ok(r.data.title.endsWith('…')); assert.ok(r.notices.some(n => n.includes('标题')))
r = parseCardContent('knowledge', { ...longKnowledge, title: '过去式', items: Array.from({ length: 9 }, (_, i) => ({ left: 'a' + i, right: 'b' + i })) })
assert.ok(r.ok); assert.equal(r.data.items.length, 6); assert.ok(r.notices.some(n => n.includes('要点')))
r = parseCardContent('knowledge', { ...longKnowledge, items: [{ left: 'a', right: 'b' }] })
assert.ok(!r.ok); assert.match(r.error, /至少要 2 项/)
r = parseCardContent('weekly', { metrics: [{ value: '1', label: 'x' }], learned: 'a', good: 'b', improve: 'c', tips: 'd' })
assert.ok(!r.ok)
assert.ok(!parseCardContent('nope', {}).ok)
assert.equal(audienceOf('weekly'), 'parent'); assert.equal(audienceOf('mnemonic'), 'student')

// ── HTML 转义：内容里的标签 / 引号 / 脚本一律转义，高亮只加 <em>，** 只加 <b> ──
assert.equal(escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;')
assert.equal(renderTemplate('{{x}}|{{{y}}}|{{#if z}}Z{{else}}N{{/if}}|{{#each l}}[{{@n}}{{v}}]{{/each}}', { x: '<script>', y: '<i>', l: [{ v: '&' }, { v: 2 }] }), '&lt;script&gt;|<i>|N|[1&amp;][22]')
const evil = '<img src=x onerror=alert(1)>"\''
const kn = parseCardContent('knowledge', { ...longKnowledge, title: evil, hook: evil, items: [{ left: evil, right: '<b>' }, { left: 'a', right: 'b' }], example: { en: `${evil} **<u>hit</u>**`, zh: evil }, warning: evil })
assert.ok(kn.ok)
const t0 = listTemplates('student')[0]
const html = buildCardPage(t0, 'knowledge', prepareData('knowledge', kn.data), 1)
assert.ok(!html.includes('<img src=x'), '标题里的标签被转义')
assert.ok(!html.includes('onerror=alert(1)>') || html.includes('&lt;img src=x onerror=alert(1)&gt;'))
assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
assert.ok(html.includes('<b>&lt;u&gt;hit&lt;/u&gt;</b>'), '强调词在 <b> 里，里面的标签也被转义')
assert.equal((html.match(/<img /g) ?? []).length, 1, '页面里只有底图一个 img')
assert.match(html, /Content-Security-Policy/)
const mn = parseCardContent('mnemonic', { title: 't', lines: [{ text: '<i>先</i>左后右', highlight: '先' }, { text: 'b' }], examples: [{ label: 'a', text: 'b' }, { label: 'c', text: 'd' }] })
assert.ok(mn.ok)
const mh = buildCardPage(t0, 'mnemonic', prepareData('mnemonic', mn.data), 1)
assert.ok(mh.includes('&lt;i&gt;<em>先</em>&lt;/i&gt;左后右'))
// 主色不是合法颜色时不会注入 CSS
const bad = { ...t0, style: { ...t0.style, accent: 'red;}</style><script>' } }
assert.ok(!buildCardPage(bad, 'knowledge', prepareData('knowledge', kn.data), 1).includes('<script>'))

// ── 隐私：手机号、排名、多个孩子 ──
for (const s of ['13812345678', '138-1234-5678', '+86 138 1234 5678', '手机0003']) assert.ok(hasPhone(s), s)
assert.ok(!hasPhone('第 3 课，共 12345 个词'))
const weekly = { student: '张小雨', grade: '四年级', metrics: [{ value: '4/4', label: '到课' }, { value: '86%', label: '正确率' }], learned: '过去式', good: '主动回答', improve: '不规则动词', tips: '每天说一句', teacher: '林老师' }
assert.match(checkRaw('parent', { ...weekly, tips: '有事打 13812345678' }), /手机号/)
assert.match(checkRaw('student', { title: '电话 138 1234 5678' }), /手机号/)
assert.match(checkRaw('parent', { ...weekly, good: '人员A001 和 人员A002 都很棒' }), /一个孩子/)
assert.equal(checkRaw('parent', { ...weekly, student: '人员A001', teacher: '人员A009' }), null, '老师署名不算孩子')
for (const s of ['班级排名第 3 名', '年级第一', '超过了 80% 的同学', '比其他同学进步快', '全班第 2']) assert.match(checkFinal('parent', { x: s }) ?? '', /排名|比较/, s)
assert.equal(checkFinal('parent', { x: '比上周进步了 12%' }), null)
assert.equal(checkFinal('student', { x: '排名' }), null, '学生卡不查排名')

// ── 孩子称呼：只写名 / 不写名字 ──
assert.equal(givenName('张小雨'), '小雨'); assert.equal(givenName('欧阳小雨'), '小雨'); assert.equal(givenName('小雨'), '小雨'); assert.equal(givenName('Lucy Wang'), 'Lucy'); assert.equal(givenName('李雨'), '雨')
const w1 = applyNamePolicy({ student: '张小雨', good: '张小雨上课很专注', tips: '请和小雨一起读' }, 'first')
assert.equal(w1.student, '小雨'); assert.equal(w1.good, '小雨上课很专注')
const w2 = applyNamePolicy({ student: '张小雨', good: '张小雨上课很专注，小雨很棒', tips: '请和小雨一起读' }, 'none')
assert.equal(w2.student, ''); assert.equal(w2.good, '孩子上课很专注，孩子很棒'); assert.equal(w2.tips, '请和孩子一起读')
const ph = buildCardPage(listTemplates('parent')[0], 'weekly', prepareData('weekly', parseCardContent('weekly', { ...weekly, student: undefined }).data), 1)
assert.ok(ph.includes('孩子的本周学习情况'))

// ── 设置：默认模板、孩子称呼 ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-cards-'))
assert.deepEqual(readCardSettings(dataDir), { defaults: { student: 's01', parent: 'p01' }, childName: 'first' })
assert.throws(() => writeCardSettings(dataDir, { defaults: { student: 'p01' } }))
writeCardSettings(dataDir, { defaults: { student: 's05' } }); writeCardSettings(dataDir, { childName: 'none' })
assert.deepEqual(readCardSettings(dataDir), { defaults: { student: 's05', parent: 'p01' }, childName: 'none' })
fs.writeFileSync(path.join(dataDir, 'share-cards.json'), '{坏')
assert.equal(readCardSettings(dataDir).defaults.student, 's01', '坏文件退回默认')
writeCardSettings(dataDir, { defaults: { student: 's05' }, childName: 'first' })

// ── 出图流程（假渲染）：用默认模板、存成图片产出、文件在 exports 里能发企业微信 ──
const used = []
setCardRenderer(async (t, kind, data) => { used.push({ id: t.id, kind, data }); return { png: Buffer.alloc(3000, 1), width: 1086, height: 1448, scale: 1 } })
const ctx = { sessionId: 'sess_c', dataDir }
const m1 = await cardMake.run({ audience: 'student', kind: 'knowledge', content: longKnowledge }, ctx)
assert.match(m1.message, /卡片已做好/); assert.match(m1.message, /截断/)
assert.equal(used[0].id, 's05', '不给 templateId 用设置里的默认')
const m2 = await cardMake.run({ audience: 'parent', kind: 'weekly', templateId: 'p03', content: weekly }, ctx)
assert.equal(used[1].id, 'p03'); assert.equal(used[1].data.student, '小雨')
const list = S.listOutputs({ dataDir, sessionId: 'sess_c' })
assert.deepEqual(list.map(e => [e.id, e.type, e.status]), [['i1', 'image', 'done'], ['i2', 'image', 'done']])
assert.equal(S.readContent({ dataDir, sessionId: 'sess_c' }, 'i1').type, 'image')
const p1 = S.entryPath({ dataDir, sessionId: 'sess_c' }, 'i1')
assert.ok(p1.includes(`${path.sep}exports${path.sep}`) && fs.existsSync(p1))
assert.equal(checkSendAllowed(p1, ctx, {}), null, '卡片图在会话 exports 里，企业微信 send file 放行')
// 被拒的情况
await assert.rejects(() => cardMake.run({ audience: 'parent', kind: 'weekly', content: { ...weekly, tips: '加我 13812345678' } }, ctx), /手机号/)
await assert.rejects(() => cardMake.run({ audience: 'parent', kind: 'weekly', content: { ...weekly, good: '全班第 2 名' } }, ctx), /排名/)
await assert.rejects(() => cardMake.run({ audience: 'student', kind: 'weekly', content: weekly }, ctx), /对不上/)
await assert.rejects(() => cardMake.run({ audience: 'student', kind: 'knowledge', templateId: 'p01', content: longKnowledge }, ctx), /家长用的/)
await assert.rejects(() => cardMake.run({ audience: 'student', kind: 'knowledge', templateId: 'zz', content: longKnowledge }, ctx), /没有编号/)
assert.equal(S.listOutputs({ dataDir, sessionId: 'sess_c' }).length, 2, '被拒的不生成产出')
// 孩子称呼设为不写名字
writeCardSettings(dataDir, { childName: 'none' })
await makeCard({ dataDir, sessionId: 'sess_c' }, { audience: 'parent', kind: 'weekly', content: weekly })
assert.equal(used[used.length - 1].data.student, '')
// 模板列表工具
const lst = await cardTemplates.run({ audience: 'student' }, ctx)
assert.equal(lst.message.split('\n').length, 10); assert.ok(lst.message.includes('s05｜') && /s05｜[^\n]*｜默认/.test(lst.message))
assert.deepEqual(CARD_TOOLS.map(t => [t.name, t.level]), [['card_templates', 'read'], ['card_make', 'draft']])
assert.match(cardMake.description, /手机号/); assert.match(cardMake.description, /排名/)
setCardRenderer(null)
console.log('share-cards ok')
