// R1 家长版：例句要和要点对上（真实输出里的坏例子做夹具）、术语写法、排版、字数口径。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fixParent, fixItemExample, stripItemTitle, itemProblems, endWithPeriod, splitParent, matchKp, fixParentJargon, PARENT_GREETING, fixTeacherExamples, softenOverclaims, bossJargon } from '../../src/shared/parent-fix.ts'
import { finishReport } from '../../src/main/report/finish.ts'
import { confirmBlockReason, parentItemCount } from '../../src/shared/report-post.ts'
import { markdownToWechat } from '../../src/shared/report-post.ts'

const KPS = [
  { name: '名词复数', plain: '一个变多个，词尾怎么变', example_en: 'I see two **dogs**.', example_zh: '我看到两只狗。', hint_words: 'books / boxes / children / sheep' },
  { name: '介词固定搭配', plain: '固定搭配：time for、look at 等', example_en: "It's time **for** lunch.", example_zh: '到午饭时间了。', hint_words: 'time for / look at / listen to' },
  { name: '购物问价', plain: '问多少钱，回答价格', example_en: '**How much** is this skirt?', example_zh: '这条裙子多少钱？', hint_words: 'How much is ...? / It\'s ... yuan' }
]
const wlen = md => markdownToWechat(md, { spaced: true }).length

// ── 真实输出（tutor-parent.md）里的两个坏例句 ──
{
  // 第 1 条讲 tomato / sheep，配了 dogs；第 3 条讲问价，配了 Those are my shoes
  const bad1 = { marker: '名词复数', text: '**一个变多个，词尾怎么变**：tomato 要加 -es；sheep 一只和很多只都是 sheep，不加 -s。在家拿西红柿和绵羊图卡问“一个、很多个”，让孩子说并写。例句：I see two dogs. 我看到两只狗。'.replace('例句：I see two dogs. 我看到两只狗。', '例句：I see two dogs.（我看到两只狗。）') }
  const r1 = fixItemExample(bad1, KPS)
  assert.equal(r1.action, 'drop', '点名的词是 tomato / sheep，例句里没有，知识点自带的例句也没有 → 去掉，不留对不上的例句')
  assert.ok(!/dogs/.test(r1.text) && /tomato/.test(r1.text))
  const bad3 = { marker: '购物问价', text: '**问价钱，看清是一条还是一双**：鞋子两只用 are，短裙一条用 is。在家拿鞋和短裙问“多少钱”，孩子先选 are 还是 is。例句：Those are my shoes.（那些是我的鞋子。）' }
  const r3 = fixItemExample(bad3, KPS)
  assert.equal(r3.action, 'replace'); assert.ok(r3.text.includes('How much is this skirt?（这条裙子多少钱？）'), r3.text)
  assert.ok(!/Those are my shoes/.test(r3.text))
  // 对得上的不动
  const ok = { marker: '介词固定搭配', text: '**到点该做什么**：吃饭前说 time for，做动作前说 time to。例：It\'s time for lunch.（到午饭时间了。）' }
  assert.equal(fixItemExample(ok, KPS).action, 'keep')
  // 没写例句的不加
  assert.equal(fixItemExample({ marker: null, text: '每天读两遍。' }, KPS).action, 'none')
}
// 没有【考点】标记时按要点文字猜知识点
assert.equal(matchKp({ marker: null, text: '问多少钱时 How much 后面要看清是 is 还是 are' }, KPS)?.name, '购物问价')
assert.equal(matchKp({ marker: '名词复数', text: 'x' }, KPS)?.name, '名词复数')

// ── 术语写法 ──
{
  const j = fixParentJargon('tomato 要加 -es；sheep 不加 -s。time for 接早饭，time to 接动作。词尾怎么变')
  assert.ok(j.text.includes('要加 es') && j.text.includes('不加 s') && !/-es|-s/.test(j.text), '「-es」改成「es」')
  assert.deepEqual(j.left.sort(), ['接', '词尾'].sort(), '改不了的报出来')
  assert.deepEqual(fixParentJargon('孩子先说 tomatoes，再写一遍。').left, [])
}

// ── 整份：问候、空行、字数口径 ──
{
  const raw = [
    '1. **一个变很多个**：西红柿 tomato 要在后面加 es，绵羊 sheep 一只和很多只一样。拿图片问孩子“有几个”，说对是 two tomatoes。例：Two tomatoes.（两个西红柿。）【考点：名词复数】',
    '2. **“到…时间了”**：吃饭前说 time for，做动作前说 time to。例：It\'s time for lunch.（到午饭时间了。）【考点：介词固定搭配】',
    '3. **问价钱**：鞋子是两只用 are，短裙是一条用 is。例：Those are my shoes.（那些是我的鞋子。）【考点：购物问价】',
    '不用太担心，抓住这 3 点就行。'
  ].join('\n')
  const r = fixParent(raw, KPS, wlen)
  assert.ok(r.text.startsWith(PARENT_GREETING), '没写问候就补')
  assert.ok(!/【考点/.test(r.text) && !/^# /m.test(r.text), '去掉标记，不写标题')
  assert.ok(r.text.includes('\n\n1. ') && r.text.includes('\n\n2. ') && r.text.includes('\n\n3. ') && r.text.includes('\n\n不用太担心'), '条与条之间空一行')
  assert.ok(!r.text.includes('Those are my shoes') && r.text.includes('How much is this skirt?'), '问价那条的例句换成知识点自带的')
  assert.ok(r.text.includes('Two tomatoes.'), '对得上的保留')
  const w = markdownToWechat(r.text, { spaced: true })
  assert.ok(w.length <= 300, `复制到微信的字数 ≤ 300：${w.length}`)
  assert.ok(w.includes('\n\n1. ') && w.includes('\n\n2. '), '微信文本里条与条之间也空一行')
  assert.ok(r.warnings.some(x => /已换成/.test(x)) && r.warnings.some(x => /补一句/.test(x)))
}
// 超过 300 字：从最后一条起去掉例句，字数以微信文本为准
{
  const long = Array.from({ length: 3 }, (_, i) => `${i + 1}. **要点${i}**：${'孩子在家每天读一读说一说，'.repeat(8)}例：It's time for lunch.（到午饭时间了。）`).join('\n') + '\n不用担心。'
  const r = fixParent(long, KPS, wlen)
  assert.ok(wlen(r.text) < wlen(long), '去掉了一些例句')
  assert.ok(!/It's time for lunch/.test(r.text.split('\n\n3. ')[1] ?? ''), '最后一条的例句先去')
}
// 已经有问候的不重复补
assert.ok(!fixParent('各位家长好，这次有 1 个地方：\n1. a。\n不用担心。', KPS, wlen).text.includes(PARENT_GREETING))
assert.equal(splitParent('各位家长好\n1. 甲\n2. 乙\n不担心').items.length, 2)
// ── 老师版：例句和考点配套（真实输出：语音配 fish and fox）──
{
  const kps = [...KPS, { name: '字母与字母组合发音', plain: '读音', example_en: 'The **sh**eep is big.', example_zh: '这只绵羊很大。', hint_words: 'sheep / farm / car / warm' }]
  const md = ['## 易错点', '### 语音', '- **错在哪**：warm 中 ar 读 /ɔː/，与 farm、car 的 /ɑː/ 不同。', '- **讲解要点**：用“fish and fox 鱼和狐狸，开头读音相同。”让孩子先找相同音。', '### 介词固定搭配', '- **讲解要点**：用“It\'s time for lunch. 到午饭时间了。”记住 time for 后面跟吃的。'].join('\n')
  const r = fixTeacherExamples(md, kps)
  assert.ok(r.unmatched.includes('语音') || r.replaced === 1, JSON.stringify(r))
  assert.ok(r.text.includes('It\'s time for lunch. 到午饭时间了。'), '对得上的不动')
  const r2 = fixTeacherExamples(md.replace('farm、car', 'sheep、shirt'), kps)
  assert.ok(!/fish and fox/.test(r2.text) && /The sheep is big\./.test(r2.text), '换成含有本节词的例句：' + r2.text)
}
// ── 老板版：声明「不下难点结论」时正文不能写难点结论；术语 ──
{
  const s = softenOverclaims('名词复数 6 道题可能全部易错；介词搭配是本次难点；这类题孩子都容易错。')
  assert.ok(!/全部易错|是本次难点|都容易错/.test(s.text) && s.changed === 3, s.text)
  assert.equal(softenOverclaims('不下“难点”结论，只能说这几份卷子里是这样。').changed, 0)
  // 整句改写：不生成「学生AI 估计容易错的比较多」这样半截替换出来的病句；否定句不动；标点保留
  const cases = [
    ['学生都容易错，要重点补。', '学生在 AI 估计里容易错的题偏多。'],
    ['这两块全部易错，建议先投。', '这两块在 AI 估计里容易错的题偏多。'],
    ['介词搭配是本次难点；其他一般。', '介词搭配在 AI 估计里容易错的题偏多；其他一般。'],
    ['- **教研重点**：名词复数 6 道题可能全部易错，应先投。', '- **教研重点**：名词复数 6 道题在 AI 估计里容易错的题偏多。']
  ]
  for (const [a, b] of cases) assert.equal(softenOverclaims(a).text, b)
  assert.equal(softenOverclaims('名词复数不是难点').text, '名词复数不是难点', '否定句不动')
  assert.ok(!/学生AI|块AI|多题/.test(cases.map(c => softenOverclaims(c[0]).text).join('')))
  assert.deepEqual(bossJargon('目标学年和基线学年各 1 份，出现率'), ['基线学年', '目标学年', '基线', '出现率'].filter(x => '目标学年和基线学年各 1 份，出现率'.includes(x)))
}


// ── r2 真实输出里被判「读不通」的坏片段（parent-r2-wechat.txt）：必须被拦下，后处理不能留半句话 ──
{
  const R2 = [
    '**西红柿绵羊**：西红柿加 es，绵羊不加 s。在家做：问西红柿说 two tomatoes 就对了',
    '**到时间**：time for 配吃饭，time to 配动作。在家做：问午饭说 time for lunch 就对了',
    '**缩写和分类**：can not = can\'t；tomato 一个其他多个。在家做：问 can not，答 can\'t'
  ]
  // 小标题去掉；「西红柿绵羊：」这种名词堆在一起的标题不会留下
  assert.equal(stripItemTitle(R2[0]).startsWith('西红柿加 es'), true)
  assert.equal(stripItemTitle('缩写和分类：can not = can\'t。').startsWith('can not'), true)
  assert.equal(stripItemTitle('孩子容易把 tomato 写成 tomatos。'), '孩子容易把 tomato 写成 tomatos。', '正常句子不动')
  // 句末缺句号 → 补上；已经有标点的不动
  assert.ok(endWithPeriod('在家做：问午饭说 time for lunch 就对了').endsWith('了。'))
  assert.equal(endWithPeriod('例：It is big.（它很大。）'), '例：It is big.（它很大。）')
  // 电报式「问 X，答 Y」、名词堆标题、半句话
  assert.ok(itemProblems('can not 要写成 can\'t。在家做：问 can not，答 can\'t。').some(x => /问……，答/.test(x)))
  assert.ok(itemProblems('缩写和分类：can not = can\'t。').some(x => /名词堆/.test(x)))
  assert.ok(itemProblems('孩子容易把 tomato 写成').length > 0)
  assert.ok(itemProblems('tomato 一个其他多个').some(x => /完整的话|句末/.test(x)))
  // 好的写法通过
  const GOOD1 = '孩子容易忘记 tomato（西红柿）变多个要加 es，而 sheep（绵羊）一只和很多只写法一样。在家做：问孩子“两个西红柿怎么说”，说出 two tomatoes 就对了。'
  assert.deepEqual(itemProblems(GOOD1), [])
  // 整份：好的保留，坏的整条去掉（不拼接、不截断），不够 3 条给出提示
  const raw = ['1. ' + GOOD1, '2. ' + R2[2], '3. 孩子容易把 time for 和 time to 用混。在家做：问孩子“到午饭时间了怎么说”，说出 It\'s time for lunch 就对了。', '整体不用太担心，抓住这几点就行'].join('\n')
  const r = fixParent(raw, KPS, wlen)
  assert.equal(r.brokenItems, 1)
  assert.ok(!/缩写和分类|问 can not，答/.test(r.text), '坏的那条整条去掉')
  assert.ok(r.text.includes('\n\n2. 孩子容易把 time for'), '后面的条重新编号')
  assert.ok(/不用太担心|不用太担心，抓住这几点就行。/.test(r.text) || r.text.includes('整体不用太担心，抓住这几点就行。'), '结尾补句号')
  assert.ok(r.warnings.some(x => /只剩 2 条/.test(x)))
  // 每一条、每个结尾都有标点
  for (const it of splitParent(r.text).items) assert.ok(/[。？！）]$/.test(it.text), it.text)
  // 超长：不截断句子，要么去整句例句、要么去整条
  const long = ['1. ' + GOOD1 + '例：I see two dogs.（我看到两只狗。）', '2. ' + GOOD1.repeat(2), '3. ' + GOOD1.repeat(2), '不用担心。'].join('\n')
  const rl = fixParent(long, KPS, wlen, 200)
  assert.ok(wlen(rl.text) <= 200 || splitParent(rl.text).items.length === 2, `超长后：${wlen(rl.text)}`)
  for (const it of splitParent(rl.text).items) assert.deepEqual(itemProblems(it.text), [], it.text)
}

// ── 端到端回放：真实输出原样走一遍 fixParent / finishReport ──
{
  const read = f => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8').replace(/^<!--.*-->\s*/, '')
  const P = { title: 't', knownRefs: new Set(), knownCodes: [], sampleWarning: '无', evidence: [], usedDefaultPrompt: true, reader: 'parent' }
  // r2：三条都读不通（名词堆标题 / 句末没标点 / 「问……，答……」），必须被整条去掉，剩下的家长版不能核对
  const r2 = read('parent-r2.md')
  const f2 = fixParent(r2, KPS, wlen)
  assert.equal(f2.brokenItems, 3, f2.text)
  assert.equal(splitParent(f2.text).items.length, 0)
  const fin2 = finishReport({ ...P, raw: r2 })
  assert.ok(confirmBlockReason({ reader: 'parent', markdown: fin2.text, unverified: fin2.unverified }), '被删空的家长版不能核对、复制、导出：\n' + fin2.text)
  assert.ok(fin2.warnings.some(w => /只剩 0 条/.test(w)))
  // 另外四条坏条目逐条（原样）：每条单独走 fixParent 都被去掉
  const BAD = [
    '**西红柿绵羊**：西红柿加 es，绵羊不加 s。在家做：问西红柿说 two tomatoes 就对了',
    '**缩写和分类**：can not = can\'t；tomato 一个其他多个。在家做：问 can not，答 can\'t',
    '缩写和分类：can not = can\'t。在家做：问 can not，答 can\'t。',
    'tomato 一个其他多个',
    '孩子容易写错 tomato 的',
    '西红柿绵羊：tomato 一个其他多个'
  ]
  for (const b of BAD) {
    const r = fixParent(`各位家长好：\n1. ${b}\n2. ${b}\n不用担心。`, KPS, wlen)
    assert.equal(r.brokenItems, 2, `应被整条去掉：${b} → ${r.text}`)
    assert.ok(!/tomato 一个其他多个|写错 tomato 的|问 can not，答/.test(r.text), r.text)
  }
  // r3：通过真实 AI 的两次输出原样通过，一条都不能误删，也不能被改写
  for (const f of ['parent-r3.md', 'parent-r3-try1.md']) {
    const md = read(f)
    const before = splitParent(md).items
    const r = fixParent(md, KPS, wlen)
    assert.equal(r.brokenItems, 0, `${f} 被误删：${r.warnings.join('|')}`)
    assert.deepEqual(splitParent(r.text).items.map(x => x.text), before.map(x => x.text), `${f} 的条目不能被改写`)
    const fin = finishReport({ ...P, raw: md })
    assert.equal(confirmBlockReason({ reader: 'parent', markdown: fin.text, unverified: fin.unverified }), null, `${f} 应该能核对：${fin.warnings.join('|')}`)
    assert.equal(parentItemCount(fin.text), 3)
    assert.ok(markdownToWechat(fin.text, { spaced: true }).length <= 300)
  }
  // 开头问候按考试类型来写，不写死「期末」
  assert.match(fixParent('1. 孩子容易忘记 tomato 要加 es。\n2. 孩子要记住 sheep 不加 s。\n不用担心。', KPS, wlen, 300, '期中').text, /这次期中英语/)
  assert.doesNotMatch(fixParent('1. 孩子容易忘记 tomato 要加 es。\n2. 孩子要记住 sheep 不加 s。\n不用担心。', KPS, wlen).text, /期末/)
  // 「例句：」「易错点：」开头的承上启下的话不是小标题，不被削掉
  assert.equal(stripItemTitle('例句：It is big.（它很大。）'), '例句：It is big.（它很大。）')
  assert.equal(stripItemTitle('孩子常错：tomato 少写 es。'), '孩子常错：tomato 少写 es。')
}

console.log('parent-fix.test ✓')
