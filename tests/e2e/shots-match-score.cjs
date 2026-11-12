// 拍教研对照表的新界面（匹配把握 / 校内约占几分 / 教材位置带依据 / 折叠的“把握不高”/ 无试卷的空状态），存到 /tmp/claude-501/match-shots/（不进仓库）。
// 用法：node tests/e2e/shots-match-score.cjs   （沙箱外运行；先 electron-vite build；PATH=/usr/bin:$PATH，去掉代理变量）
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { check, path, fs, work, SECRET, pageImg, ctx, T, goto, setFilter, cfgFor, saveCfg, startMock, open } = M

const OUT = process.env.MATCH_SHOTS || '/tmp/claude-501/match-shots'
fs.mkdirSync(OUT, { recursive: true })
const pep = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/main/seed/textbook-catalog/english-pep.json'), 'utf8'))

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const ud = path.join(work, 'userShots')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)
  const page = ctx.page
  await page.setViewportSize({ width: 1500, height: 1000 })
  await saveCfg(cfgFor(mock, { auto_parse: false }), SECRET)
  await goto('#/courses'); await T('course-settings').waitFor()

  // 机构课程：内容取自人教PEP 四年级上册（拿来当“某机构的四年级课”），对标教材选译林版三上 / 四上
  const units = pep.books.find(b => b.grade === 4 && b.semester === '上').units.filter(u => u.no)
  const lessons = units.map((u, i) => {
    const topic = (u.lessons.find(l => l.startsWith('话题')) ?? '').replace(/^话题[：:]/, '')
    const pat = u.lessons.filter(l => l.startsWith('句型')).map(l => l.replace(/^句型(（概括）)?[：:]/, '')).join('；')
    return { seq: i + 1, noLabel: String(i + 1), title: u.title, theme: topic, textbookRef: '', points: [{ kind: 'pattern', label: '句型', text: pat }], raw: {} }
  })
  // 再加两节有明显标志词的课，展示规则命中
  lessons.push({ seq: 20, noLabel: '20', title: 'Last weekend', theme: '周末', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: 'visited, watched, played' }, { kind: 'pattern', label: '句型', text: 'What did you do yesterday? I was at home.' }], raw: {} })
  lessons.push({ seq: 21, noLabel: '21', title: 'Plurals', theme: '身边的植物', textbookRef: '', points: [{ kind: 'word', label: '词汇', text: 'plants, flowers, trees' }, { kind: 'pattern', label: '句型', text: 'There are two apples and three boxes.' }], raw: {} })
  lessons.unshift(lessons.pop()); lessons.unshift(lessons.pop())   // 两节有标志词的课排在最前面
  lessons.forEach((l, i) => { l.seq = i + 1; l.noLabel = String(i + 1) })
  const saved = await page.evaluate(async lv => window.api.course.save({ name: '示例机构课·四年级', scene: 'org', levels: lv, subject: 'english' }), [{ name: '四年级', lessons }])
  const tb = await page.evaluate(() => window.api.course.addBuiltin({ editionId: 'english-yilin', books: ['3上', '4上'] }))
  // 真实流程：程序先按标志词认，AI（mock）只补认不出来的课
  const res = await page.evaluate(id => window.api.course.match(id, false), saved.id)
  check('匹配', '匹配完成（规则先认，AI 补充）', res.ok, JSON.stringify({ matched: res.matched, byRule: res.byRule, aiLessons: res.aiLessons }))

  await goto('#/courses/research'); await T('research-table').waitFor({ timeout: 20000 })
  await T('research-pick-books').click(); await T('research-book-search').waitFor()
  await T('research-book-search').fill('译林')
  await T('research-edition-english-yilin').waitFor({ timeout: 5000 })
  await T('research-edition-english-yilin').click()
  for (const k of ['3上', '4上']) await T(`research-book-english-yilin-${k}`).click()
  await T('research-book-ok').click()
  await page.screenshot({ path: path.join(OUT, '1-三步选择.png') })
  await T('research-generate').click()
  await T('research-headline').waitFor({ timeout: 30000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, '2-教研对照表.png'), fullPage: false })
  // 滚到有规则命中的两节课
  const l20 = await T('research-grid-wrap').locator('tr', { hasText: 'Last weekend' }).first()
  if (await l20.count()) await l20.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, '3-规则命中的课.png') })
  // 折叠的“把握不高”
  const weak = T('research-weak')
  if (await weak.count()) { await weak.scrollIntoViewIfNeeded(); await weak.locator('summary').click(); await page.waitForTimeout(300); await page.screenshot({ path: path.join(OUT, '4-把握不高的折叠小字.png') }) }
  // 空状态：这个范围里一份试卷都没有（用“学年 2010”模拟）→ 说明 + “去导入试卷”
  await setFilter({ school_year_start: 2010 }, '#/courses/research'); await T('research-table').waitFor({ timeout: 20000 })
  await T('research-pick-books').click(); await T('research-book-search').waitFor()
  await T('research-book-search').fill('译林')
  await T('research-edition-english-yilin').click()
  for (const k of ['3上', '4上']) await T(`research-book-english-yilin-${k}`).click()
  await T('research-book-ok').click()
  await T('research-generate').click()
  await T('research-no-papers').waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
  if (await T('research-no-papers').count()) await page.screenshot({ path: path.join(OUT, '5-无试卷空状态.png') })
  check('空状态', '范围里没有试卷时出现“去导入试卷”', (await T('research-goto-import').count()) === 1)
  console.log('screenshots →', OUT, fs.readdirSync(OUT).join(' '))
  await ctx.app.close()
  mock.close?.()
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
