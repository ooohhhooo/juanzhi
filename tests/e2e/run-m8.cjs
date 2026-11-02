// M8 端到端：试卷库的搜索、多选与批量操作，以及「只统计选中的几份卷子」。全程 mock AI。
//   · 搜索（标题 / 学校、不分大小写、输入法组词时不过滤、清除按钮、无结果的提示）
//   · 多选（行勾选、全选当前列表、清除、搜索词变了只保留还看得见的）
//   · 批量删除（确认框写份数与标题、长列表截断、正在处理的不删——界面和主进程两层都挡）
//   · 批量改信息（只改打了勾的项、勾了留空 = 清空、「AI 猜的」标记同单份修改）
//   · 批量重新解析（没配 AI 的提醒、已有题目的覆盖警告、没有页面的跳过、进队列）
//   · 只看选中的卷子：总览数字、范围条与提示条、报告只用这几份、翻页 / 重启后还在、可以回到普通筛选、被删的卷子不出错
// 用法：npm run test:e2e:m8   （沙箱外运行：Electron、本地端口都被沙箱限制；全程用 mock AI，不调用真实服务）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const { DatabaseSync } = require('node:sqlite')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, pageImg, ctx, T, txt, goto, setFilter, api, cfgFor, saveCfg, startMock, open, closeApp, shots, L } = M

const ID = n => `00000000-0000-4000-8000-0000000008${String(n).padStart(2, '0')}`
const DEL = [ID(1), ID(2), ID(3)], RUN1 = ID(4), RUN2 = ID(5), ED = [ID(11), ID(12), ID(13)], RP1 = ID(21), ZZ = ID(31), QD1 = ID(41)
const SCHOOL_A = '实验小学', SCHOOL_B = 'Sunshine School', SCHOOL_C = '解析测试校', SCHOOL_D = '育才小学'

const writeDb = (ud, fn) => { const d = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite')); d.exec('PRAGMA busy_timeout=5000'); d.exec('PRAGMA foreign_keys=ON'); try { return fn(d) } finally { d.close() } }
const papersDb = () => withDb(ctx.ud, d => d.prepare('SELECT * FROM papers').all())
const paperRow = id => withDb(ctx.ud, d => d.prepare('SELECT * FROM papers WHERE id = ?').get(id))
const norm = s => String(s ?? '').toLowerCase()
const expectMatch = q => papersDb().filter(p => norm(p.title || p.file_name).includes(norm(q)) || norm(p.school).includes(norm(q))).map(p => p.id).sort()
const rowKeys = () => ctx.page.$$eval('tr[data-row-key]', els => els.map(e => e.getAttribute('data-row-key')))
const countText = () => txt('lib-count')
const modalBtn = (re) => ctx.page.locator('.ant-modal-confirm-btns button, .ant-modal-footer button').filter({ hasText: re })
const scopeText = async () => (await ctx.page.locator('[data-testid=scope-bar] .ewb-scope__range').innerText()).replace(/\s+/g, ' ').trim()
const setTheme = async (mode) => { await goto('#/'); await ctx.page.evaluate(m => localStorage.setItem('ewb-theme-pref', m), mode); await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }) }
const setFilterFast = async (f, hash) => { await ctx.page.evaluate(v => window.api.settings.set('ui_stats_filter', v), f); await goto(hash); await ctx.page.reload(); await ctx.page.waitForSelector('[data-testid=scope-bar]', { timeout: 30000 }) }
const reloadHere = async () => { await ctx.page.reload(); await ctx.page.waitForSelector('[data-testid=scope-bar]', { timeout: 30000 }) }
const resize = (w, h) => ctx.app.evaluate(({ BrowserWindow }, [a, b]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 300); win.setContentSize(a, b) }, [w, h])
const shot8 = name => ctx.page.screenshot({ path: path.join(shots, `m8-${name}.png`) })

async function search(q, { wait = true } = {}) {
  const box = T('lib-search')
  await box.fill(q)
  if (wait) {
    const n = expectMatch(q).length
    await waitFor(async () => { const t = await countText(); return q.trim() ? t === `找到 ${n} 份，共 ${papersDb().length} 份` : t === `共 ${papersDb().length} 份` }, 6000)
  }
}
const gotoLib = async () => { await goto('#/'); await T('dropzone').waitFor(); await T('lib-search').waitFor() }
const selectAllHeader = () => T('select-all').locator('xpath=ancestor-or-self::label').click()
const tickRow = id => ctx.page.locator(`tr[data-row-key="${id}"] td.ant-table-selection-column .ant-checkbox`).click()
const selCount = async () => ((await T('select-bar').count()) ? Number(await txt('select-count')) : 0)
const reloadLib = async () => { await ctx.page.reload(); await T('dropzone').waitFor({ timeout: 30000 }); await T('lib-search').waitFor() }

async function main() {
  // ───────────────────────── 夹具 ─────────────────────────
  ctx.mock = await startMock({ apiKey: SECRET })
  const mock = ctx.mock
  const ud = path.join(work, 'userM8')
  const r0 = await open(ud)
  await r0.app.close()
  const s = seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  const I = s.ids
  writeDb(ud, db => {
    const ins = db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, school, file_name, file_hash, status, page_count, created_at, ai_meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const add = (id, title, o = {}) => ins.run(id, title, o.grade ?? '3', '上', 2025, o.exam ?? '期中', o.textbook ?? 'PEP老版', o.region ?? '旧地区', o.school ?? null, `${id}.pdf`, `hash-m8-${id}`, o.status ?? 'done', o.pages ?? 0, '2026-10-25 09:00:00', o.ai ?? null)
    DEL.forEach((id, i) => { add(id, `批量删除测试卷${i + 1}`); const dir = path.join(ud, 'workbench-data', 'files', id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'p.txt'), 'x') })
    add(RUN1, '批量删除测试-提取中', { status: 'extracted' }); add(RUN2, '批量删除测试-解析中', { status: 'extracted' })
    add(ED[0], '批量改信息卷1', { ai: '["grade","exam_type","textbook"]' }); add(ED[1], '批量改信息卷2', { ai: '["grade"]' }); add(ED[2], '批量改信息卷3')
    add(RP1, '解析测试-无页面', { status: 'extracted', school: SCHOOL_C })
    add(ZZ, '待删卷Z')
    add(QD1, '排队中测试卷', { status: 'extracted', pages: 1 })
    db.prepare("INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text) VALUES (?, 1, 'page-1.png', 100, 100, 'ocr', '[]', '')").run(QD1)
    // 搜索用的学校
    for (const k of ['C1', 'C3', 'B1']) db.prepare('UPDATE papers SET school = ? WHERE id = ?').run(SCHOOL_A, I[k])
    db.prepare('UPDATE papers SET school = ? WHERE id = ?').run(SCHOOL_B, I.C4)
    for (const k of ['C2', 'C5']) db.prepare('UPDATE papers SET school = ? WHERE id = ?').run(SCHOOL_C, I[k])
  })
  ctx.ids = I
  await open(ud)
  let page = ctx.page
  const total = papersDb().length
  check('夹具', `库里有 ${total} 份试卷（超过一页 20 份，能测跨页全选）`, total > 20, `total=${total}`)

  // ───────────────────────── 1. 搜索 ─────────────────────────
  await gotoLib()
  check('搜索', '试卷库有搜索框；没搜索时显示「共 N 份」', (await T('lib-search').count()) === 1 && (await countText()) === `共 ${total} 份`, await countText())
  {
    const q = '期末'
    await search(q)
    const want = expectMatch(q)
    const keys = (await rowKeys()).sort()
    check('搜索', '按标题搜「期末」：列表只剩标题里有它的试卷（和库里的标题逐条比对）', want.length > 0 && keys.length === Math.min(20, want.length) && keys.every(k => want.includes(k)), `want=${want.length} shown=${keys.length}`)
  }
  {
    await search(SCHOOL_A)
    const want = expectMatch(SCHOOL_A)
    const keys = (await rowKeys()).sort()
    check('搜索', `按学校搜「${SCHOOL_A}」：只剩学校里有它的试卷（C1、C3、B1 三份）`, want.length === 3 && JSON.stringify(keys) === JSON.stringify(want), `want=${want.length} shown=${keys.length}`)
  }
  {
    await search('sunshine')
    const keys = await rowKeys()
    check('搜索', '不分大小写：小写「sunshine」找到学校「Sunshine School」', keys.length === 1 && keys[0] === I.C4, JSON.stringify(keys))
    await search('卷c')
    check('搜索', '不分大小写：小写「卷c」找到标题以 C1–C5 结尾的 5 份卷子', (await rowKeys()).length === 5 && expectMatch('卷c').length === 5)
  }
  {
    // 搜索词同时用于标题或学校：「小学」只在学校里出现
    await search('小学')
    const keys = (await rowKeys()).sort()
    check('搜索', '搜索词在学校里（不在标题里）也能找到', JSON.stringify(keys) === JSON.stringify(expectMatch('小学')) && keys.length >= 3)
  }
  {
    await search('绝对不存在的词zzz')
    const empty = await T('lib-search-empty').count()
    const t = empty ? await txt('lib-search-empty') : ''
    check('搜索', '没有结果时给一句白话：写明搜的是什么、怎么办，并有「清除搜索」', empty === 1 && /没有找到/.test(t) && /绝对不存在的词zzz/.test(t) && /清除搜索/.test(t), t)
    await T('lib-search-empty').locator('button', { hasText: '清除搜索' }).click()
    check('搜索', '点「清除搜索」：输入框清空、列表回到全部', await waitFor(async () => (await countText()) === `共 ${total} 份` && (await T('lib-search').inputValue()) === '', 5000))
  }
  {
    // 输入框右侧的小叉
    await search('期末')
    await T('lib-search').hover()
    await T('lib-search-clear').click()
    check('搜索', '输入框里的清除按钮（小叉）一点就回到全部', await waitFor(async () => (await countText()) === `共 ${total} 份`, 5000))
  }
  {
    // 输入法：组词期间（compositionstart 之后、compositionend 之前）不过滤
    const box = T('lib-search')
    await box.focus()
    await box.dispatchEvent('compositionstart')
    await box.fill('shiyan')
    await sleep(500)
    const during = await countText()
    check('搜索', '输入法组词（拼音还没选字）期间不过滤：列表保持全部', during === `共 ${total} 份`, during)
    await box.fill(SCHOOL_A)
    await box.dispatchEvent('compositionend')
    check('搜索', '选好字（组词结束）后立刻按选定的词过滤', await waitFor(async () => (await countText()) === `找到 ${expectMatch(SCHOOL_A).length} 份，共 ${total} 份`, 5000))
    await search('')
  }
  {
    // 连续快速输入只过滤最后的结果，不卡
    const t0 = Date.now()
    await T('lib-search').pressSequentially('2025', { delay: 20 })
    const ok = await waitFor(async () => (await countText()) === `找到 ${expectMatch('2025').length} 份，共 ${total} 份`, 5000)
    check('搜索', '逐字快速输入后只停在最终结果，且很快（< 3 秒）', ok && Date.now() - t0 < 3000, `${Date.now() - t0}ms`)
    await search('')
  }

  // ───────────────────────── 2. 多选 ─────────────────────────
  {
    check('多选', '没勾任何一份时不显示「已选」条', (await T('select-bar').count()) === 0)
    await selectAllHeader()
    check('多选', `表头勾选框 = 全选当前列表（跨页，共 ${total} 份），出现「已选 ${total} 份」`, await waitFor(async () => (await selCount()) === total, 5000), String(await selCount()))
    check('多选', '「已选」条上有清除选择和四个批量操作（批量改信息 / 重新解析 / 只看这几份的统计 / 删除）', (await T('select-clear').count()) === 1 && (await T('batch-edit-open').count()) === 1 && (await T('batch-reparse').count()) === 1 && (await T('scope-selected').count()) === 1 && (await T('batch-delete').count()) === 1)
    await T('select-clear').click()
    check('多选', '「清除选择」：已选条消失、行上的勾都去掉', await waitFor(async () => (await T('select-bar').count()) === 0, 5000) && (await page.locator('tr[data-row-key] .ant-checkbox-checked').count()) === 0)
    const first = (await rowKeys())[0]
    await tickRow(first)
    check('多选', '点一行的勾选框：已选 1 份，还显示「选中全部 N 份」', await waitFor(async () => (await selCount()) === 1, 5000) && (await T('select-all-matching').count()) === 1)
    await T('select-all-matching').click()
    check('多选', '「选中全部 N 份」：一键选满整个列表', await waitFor(async () => (await selCount()) === total, 5000))
    // 搜索词变了：只保留还看得见的
    await search(SCHOOL_A)
    check('多选', `搜索后，选中的只保留还看得见的（${expectMatch(SCHOOL_A).length} 份），看不见的不再算选中`, await waitFor(async () => (await selCount()) === expectMatch(SCHOOL_A).length, 5000), String(await selCount()))
    await search('')
    check('多选', '搜索清掉后，之前被过滤掉的卷子不会自己变回选中', await waitFor(async () => (await selCount()) === expectMatch(SCHOOL_A).length, 3000))
    await T('select-clear').click()
    // 搜索 + 全选只选匹配的
    await search(SCHOOL_C)
    await selectAllHeader()
    check('多选', '搜索「解析测试校」后全选，只选到匹配的 3 份', await waitFor(async () => (await selCount()) === 3, 5000))
    await T('select-clear').click()
    await search('')
  }

  // ───────────────────────── 3. 批量删除 ─────────────────────────
  {
    // 3.1 长列表确认框：截断，取消不删
    await search('学年')
    const n = expectMatch('学年').length
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === n, 5000)
    await T('batch-delete').click()
    await T('batch-delete-confirm').waitFor()
    const t = await txt('batch-delete-confirm')
    const lis = await T('batch-delete-confirm').locator('li').count()
    check('批量删除', `确认框写明份数（${n}）并列出标题，太长时只列 8 条，其余写「等共 ${n} 份」`, new RegExp(`这 ${n} 份试卷`).test(await page.locator('.ant-modal-confirm-title').innerText()) && lis === 9 && t.includes(`等共 ${n} 份`) && /不能恢复/.test(t), t.slice(0, 120))
    await modalBtn(/取\s?消/).click()
    await sleep(400)
    check('批量删除', '点取消：一份都不删', papersDb().length === total)
    await T('select-clear').click()
    await search('')
  }
  {
    // 3.2 含正在处理的：界面提示 + 主进程再挡一层
    writeDb(ud, db => { db.prepare("UPDATE papers SET status = 'extracting' WHERE id = ?").run(RUN1); db.prepare("UPDATE papers SET status = 'parsing' WHERE id = ?").run(RUN2) })
    await reloadLib()
    await search('批量删除测试')
    check('批量删除', '搜「批量删除测试」得到 5 份（3 份可删、1 份提取中、1 份解析中）', (await rowKeys()).length === 5)
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 5, 5000)
    await T('batch-delete').click()
    await T('batch-delete-confirm').waitFor()
    const t = await txt('batch-delete-confirm')
    check('批量删除', '确认框只列能删的 3 份，并说明另有 2 份正在提取或解析、这次不会删', /这 3 份试卷/.test(await page.locator('.ant-modal-confirm-title').innerText()) && /另有 2 份正在提取或解析/.test(t) && /批量删除测试卷1/.test(t) && !/提取中|解析中/.test(await T('batch-delete-confirm').locator('ul').innerText()), t)
    await shot8('delete-confirm-light')
    await T('batch-delete-ok').click()
    const done = await waitFor(async () => papersDb().filter(p => DEL.includes(p.id)).length === 0, 10000)
    check('批量删除', '确认后 3 份可删的卷子从库里删掉（含文件目录），正在处理的 2 份还在', done && !!paperRow(RUN1) && !!paperRow(RUN2) && DEL.every(id => !fs.existsSync(path.join(ud, 'workbench-data', 'files', id))), '')
    check('批量删除', '删完后列表只剩那 2 份；没删掉的（正在处理的）继续选着', await waitFor(async () => (await rowKeys()).length === 2 && (await selCount()) === 2, 8000))
    check('批量删除', '每行的勾选框有各自唯一的 data-testid（select-row-<id>）', (await T(`select-row-${RUN1}`).count()) === 1 && (await T(`select-row-${RUN2}`).count()) === 1)
    // 主进程这一层：绕过界面直接调，正在处理的仍然删不掉，已不存在的给原因
    const res = await api(ids => window.api.papers.batchRemove(ids), [RUN1, RUN2, DEL[0]])
    check('批量删除', '主进程再挡一层：直接调用批量删除，提取中 / 解析中的拒绝（写明原因），已经不存在的也有说明，整批不抛错',
      res.length === 3 && res.slice(0, 2).every(x => x.ok === false && /正在处理中/.test(x.reason)) && res[2].ok === false && /不存在/.test(res[2].reason) && !!paperRow(RUN1) && !!paperRow(RUN2), JSON.stringify(res))
    const single = await api(id => window.api.papers.remove(id).then(() => 'ok', e => String(e.message)), RUN1)
    check('批量删除', '单份删除对正在处理的试卷同样拒绝（批量沿用同一条规则）', /正在处理中/.test(single) && !!paperRow(RUN1), single)
    // 全是正在处理的：界面直接说现在不能删（上一步没删掉的 2 份还选着）
    await waitFor(async () => (await selCount()) === 2, 5000)
    await T('batch-delete').click()
    check('批量删除', '选中的全是正在处理的：不弹删除确认，只提示现在不能删', await waitFor(async () => (await T('batch-delete-blocked').count()) === 1, 5000) && (await T('batch-delete-ok').count()) === 0)
    await modalBtn(/知道了/).click()
    await T('select-clear').click()
    writeDb(ud, db => { db.prepare("UPDATE papers SET status = 'extracted' WHERE id IN (?, ?)").run(RUN1, RUN2) })
    await search('')
  }
  {
    // 排队中、还没开始提取 / 解析（状态还是「已提取」）的卷子：界面看不出忙，主进程要挡住，挡住的继续选着
    await api(() => window.api.queue.pause())
    await api(id => window.api.parse.start(id, 'locate'), QD1)
    await reloadLib()
    await search('排队中测试卷')
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 1, 5000)
    await T('batch-delete').click()
    await T('batch-delete-confirm').waitFor()
    await T('batch-delete-ok').click()
    await waitFor(async () => (await page.locator('.ant-message-notice').count()) > 0, 8000)
    const m = await page.locator('.ant-message-notice').last().innerText()
    check('批量删除', '排队中（还没开始解析、状态仍是「已提取」）的卷子：界面放行，主进程拒绝；卷子还在，提示写明原因', !!paperRow(QD1) && /没有删除任何试卷|正在处理/.test(m), m)
    check('批量删除', '没删掉的那份继续选着（已选 1 份）', (await selCount()) === 1)
    await api(id => window.api.parse.cancel(id), QD1)
    await api(() => window.api.queue.resume())
    await T('select-clear').click()
    await search('')
  }

  // ───────────────────────── 4. 批量改信息 ─────────────────────────
  {
    await reloadLib()
    await search('批量改信息')
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 3, 5000)
    await T('batch-edit-open').click()
    await T('batch-edit').waitFor()
    check('批量改信息', '弹出「批量改信息」：学校 / 年级 / 学期 / 学年起始 / 考试类型 / 教材 / 地区 七项各有勾选框，一开始都没勾、确定键灰着', (await page.locator('[data-testid^=batch-edit-tick-]').count()) === 7 && (await page.locator('[data-testid^=batch-edit-tick-] input:checked').count()) === 0 && await page.locator('[data-testid=batch-edit-ok]').isDisabled())
    await T('batch-edit-input-school').fill(SCHOOL_D)
    check('批量改信息', '在某一项里填了内容，这一项自动打勾；确定键变成「改这 1 项」', await waitFor(async () => /改这 1 项/.test(await T('batch-edit-ok').innerText()), 3000))
    await T('batch-edit-input-grade').click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '4年级' }).click()
    check('批量改信息', '再选年级 4 年级：共勾了 2 项，并提示 2 份里原来「AI 猜的」年级会被改掉', await waitFor(async () => /改这 2 项/.test(await T('batch-edit-ok').innerText()), 3000) && /其中 2 份/.test(await txt('batch-edit-ai')), await txt('batch-edit-ai').catch(() => ''))
    await shot8('batch-edit-light')
    await T('batch-edit-ok').click()
    await waitFor(async () => paperRow(ED[2]).school === SCHOOL_D, 8000)
    const rows = ED.map(paperRow)
    check('批量改信息', '确认后三份卷子的学校都是「育才小学」、年级都是 4', rows.every(p => p.school === SCHOOL_D && p.grade === '4'), JSON.stringify(rows.map(p => [p.school, p.grade])))
    check('批量改信息', '没打勾的项原样不动：考试类型仍是「期中」、教材仍是「PEP老版」、地区仍是「旧地区」、学期 / 学年不变', rows.every(p => p.exam_type === '期中' && p.textbook === 'PEP老版' && p.region === '旧地区' && p.semester === '上' && p.school_year_start === 2025), JSON.stringify(rows.map(p => [p.exam_type, p.textbook, p.region])))
    const ai = rows.map(p => JSON.parse(p.ai_meta_json ?? '[]'))
    check('批量改信息', '「AI 猜的」标记和单份修改一样处理：被改掉的年级不再标，没动过的考试类型 / 教材还标着', JSON.stringify(ai[0]) === '["exam_type","textbook"]' && JSON.stringify(ai[1]) === '[]' && rows[2].ai_meta_json === null, JSON.stringify(ai))
    check('批量改信息', '改完弹窗关闭、列表里年级显示更新', await waitFor(async () => (await T('batch-edit').count()) === 0, 5000) && /4年级/.test(await page.locator(`tr[data-row-key="${ED[0]}"]`).innerText()))
    // 勾了但留空 = 清空
    await T('batch-edit-open').click()
    await T('batch-edit').waitFor()
    await T('batch-edit-tick-region').locator('xpath=ancestor-or-self::label').click()
    check('批量改信息', '勾了地区但没填：弹窗明确写出「地区勾了但没填，会把这一项清空」', await waitFor(async () => (await T('batch-edit-clearing').count()) === 1 && /地区/.test(await txt('batch-edit-clearing')), 3000))
    await T('batch-edit-ok').click()
    await T('batch-clear-confirm').waitFor({ timeout: 5000 })
    const ct = (await page.locator('.ant-modal-confirm-title').innerText()).replace(/\s+/g, ' ')
    check('批量改信息', '清空任何一项前再确认一次：「会清空 3 份试卷的 地区」，点取消什么都没改', /会清空 3 份试卷的 地区/.test(ct), ct)
    await modalBtn(/取\s?消/).last().click()
    await sleep(500)
    check('批量改信息', '二次确认里点取消：地区原样没动', ED.every(id => paperRow(id).region === '旧地区'))
    await T('batch-edit-ok').click()
    await T('batch-clear-ok').click()
    await waitFor(async () => paperRow(ED[0]).region === null, 8000)
    const rows2 = ED.map(paperRow)
    check('批量改信息', '确认后三份的地区被清空；学校、年级保持上一步改好的值', rows2.every(p => p.region === null && p.school === SCHOOL_D && p.grade === '4'), JSON.stringify(rows2.map(p => [p.region, p.school])))
    // 主进程的校验
    const bad = await api(ids => window.api.papers.batchUpdate(ids, { grade: '9' }).then(() => 'ok', e => String(e.message)), ED)
    const empty = await api(ids => window.api.papers.batchUpdate(ids, {}).then(() => 'ok', e => String(e.message)), ED)
    const withTitle = await api(ids => window.api.papers.batchUpdate(ids, { title: '偷改标题' }).then(() => 'ok', e => String(e.message)), ED)
    const mixed = await api(([a, b]) => window.api.papers.batchUpdate([a, b], { textbook: '新教材' }), [ED[0], '99999999-9999-4999-8999-999999999999'])
    check('批量改信息', '主进程沿用单份修改的校验：年级 9 被拒、空改动被拒、批量不能改标题；其中一份已不存在时，这份标「不存在」，其余照改',
      bad !== 'ok' && empty !== 'ok' && withTitle !== 'ok' && paperRow(ED[0]).title === '批量改信息卷1' && mixed[0].ok === true && mixed[1].ok === false && /不存在/.test(mixed[1].reason) && paperRow(ED[0]).textbook === '新教材', JSON.stringify({ bad: bad.slice(0, 40), mixed }))
    await T('select-clear').click()
    await search('')
  }

  // ───────────────────────── 5. 批量重新解析 ─────────────────────────
  {
    await reloadLib()
    await search(SCHOOL_C)
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 3, 5000)
    // 5.1 没配 AI：和单份一样拦住
    await T('batch-reparse').click()
    await waitFor(async () => (await page.locator('.ant-message-notice').count()) > 0, 5000)
    const msg = await page.locator('.ant-message-notice').first().innerText()
    check('批量重新解析', '没配 AI 服务：提示「尚未配置 AI 服务」，不弹确认、不排队', /尚未配置 AI 服务/.test(msg) && (await T('batch-reparse-confirm').count()) === 0 && (await api(() => window.api.queue.state())).parse.waiting.length === 0, msg)
    const direct = await api(ids => window.api.parse.batchStart(ids).then(() => 'ok', e => String(e.message)), [I.C2])
    check('批量重新解析', '主进程也挡一层：没配 AI 时批量接口整批拒绝', /尚未配置 AI 服务/.test(direct), direct)
    // 5.2 配好 mock 后：先暂停队列，这样排进去的卷子停在「等待」里，不会真的去改夹具数据
    await saveCfg(cfgFor(mock), SECRET)
    await api(() => window.api.queue.pause())
    await page.locator('.ant-message-notice').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    await T('batch-reparse').click()
    await T('batch-reparse-confirm').waitFor()
    const t = await txt('batch-reparse-confirm')
    const qrows = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) n, SUM(reviewed) r FROM questions WHERE paper_id IN (?, ?)').get(I.C2, I.C5))
    check('批量重新解析', `确认框警告覆盖：其中 2 份现在有题目（共 ${qrows.n} 道，${qrows.r} 道已审核确认；2 份已整份确认），审核的修改和确认会作废`,
      /其中 2 份现在有题目/.test(t) && t.includes(`共 ${qrows.n} 道`) && t.includes(`${qrows.r} 道已审核确认`) && /2 份已整份确认/.test(t) && /作废/.test(t) && /要重新审核/.test(t), t)
    check('批量重新解析', '确认框说明同时解析几份（沿用设置里的并发数 2）', /最多同时解析 2 份/.test(t), t)
    check('批量重新解析', '确认键用危险色的「仍然重新解析」（和单份重新解析同样的措辞）', /仍然重新解析/.test(await T('batch-reparse-ok').innerText()))
    await T('batch-reparse-ok').click()
    const q = await waitFor(async () => { const st = await api(() => window.api.queue.state()); return st.parse.waiting.length === 2 ? st : null }, 8000)
    const waitingIds = q ? q.parse.waiting.map(w => w.paperId).sort() : []
    check('批量重新解析', '确认后 2 份有页面的卷子进了 AI 解析队列；没有提取出页面的那份没有进队列', JSON.stringify(waitingIds) === JSON.stringify([I.C2, I.C5].sort()) && !waitingIds.includes(RP1), JSON.stringify(waitingIds))
    // 主进程逐份结果：没页面的跳过并写明原因、已排队的写正在处理
    const res = await api(ids => window.api.parse.batchStart(ids), [RP1, I.C2, '99999999-9999-4999-8999-999999999999'])
    check('批量重新解析', '逐份结果：没有页面的写批量专用的「这份还没提取出页面，请单独打开它重试」，已在队列里的写「正在处理中」，不存在的写「不存在」',
      res.length === 3 && !res[0].ok && /这份还没提取出页面，请单独打开它重试/.test(res[0].reason) && !res[1].ok && /正在处理中/.test(res[1].reason) && !res[2].ok && /不存在/.test(res[2].reason), JSON.stringify(res))
    // 撤销：把排队的取消，队列恢复
    for (const id of [I.C2, I.C5]) await api(i => window.api.parse.cancel(i), id)
    await api(() => window.api.queue.resume())
    check('批量重新解析', '取消排队并恢复队列后，夹具数据没被动过（C2、C5 仍是已确认）', paperRow(I.C2).status === 'done' && paperRow(I.C5).status === 'done')
    await T('select-clear').click()
    await search('')
  }

  // ───────────────────────── 6. 只统计选中的卷子 ─────────────────────────
  const C = ['C1', 'C2', 'C3', 'C4', 'C5'].map(k => I[k])
  const qCount = ids => withDb(ctx.ud, d => d.prepare(`SELECT COUNT(*) n FROM questions WHERE paper_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n)
  let allPapersCount = 0, allQuestions = 0
  {
    await goto('#/overview'); await T('overview').waitFor()
    allPapersCount = Number(await txt('card-papers')); allQuestions = Number(await txt('card-questions'))
    check('统计范围', `没选时总览是全部：${allPapersCount} 份卷子、${allQuestions} 道题`, allPapersCount > 5 && allQuestions > 20, `${allPapersCount}/${allQuestions}`)
    await gotoLib()
    await search('卷c')
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 5, 5000)
    await T('scope-selected').click()
    await T('overview').waitFor({ timeout: 15000 })
    check('统计范围', '点「只看这几份的统计」：跳到总览', (await page.evaluate(() => location.hash)) === '#/overview')
    await waitFor(async () => (await txt('card-papers')) === '5', 10000)
    check('统计范围', `总览的数字只按选中的 5 份算：5 份卷子、${qCount(C)} 道题（不再是全部的 ${allPapersCount} 份 / ${allQuestions} 道）`, (await txt('card-papers')) === '5' && Number(await txt('card-questions')) === qCount(C), `${await txt('card-papers')}/${await txt('card-questions')}`)
    const sc = await scopeText()
    check('统计范围', '范围条写明「看的是选中的 5 份试卷」', /看的是选中的 5 份试卷/.test(sc), sc)
    check('统计范围', '范围条下面有醒目的提示条（选了 5 份、筛选先不起作用），带「回到普通筛选」和「去试卷库改选」', (await T('ids-banner').count()) === 1 && /选的 5 份试卷/.test(await txt('ids-banner')) && (await T('ids-back').count()) === 1 && (await T('ids-library').count()) === 1, await txt('ids-banner').catch(() => ''))
    check('统计范围', '总览的「范围：…」也写成「选中的 5 份试卷」', /选中的 5 份试卷/.test(await txt('overview-filter-label')), await txt('overview-filter-label'))
    await shot8('scope-ids-light')
    // 范围面板里的维度筛选先不起作用（灰着）
    await page.locator('[data-testid=scope-bar] .ewb-scope__trigger').click()
    check('统计范围', '展开「修改范围」：年级 / 学年等筛选灰掉、「清除筛选」也灰着（避免以为还能叠加）', await page.locator('[data-testid=filter-grade].ant-select-disabled').count() === 1 && await page.locator('[data-testid=filter-reset]').isDisabled())
    await page.locator('[data-testid=scope-bar] .ewb-scope__trigger').click()

    // 与规则一起用：看板、统计 IPC 与总览同口径
    const o = await api(ids => window.api.stats.overview({ paperIds: ids }), C)
    check('统计范围', '统计接口 stats:overview 带上 paperIds 得到同样的数字', o.cards.papers === 5 && o.cards.questions === qCount(C))
    // 6.1 翻页 / 重启后还在
    await goto('#/dashboard')
    await waitFor(async () => (await T('ids-banner').count()) === 1, 8000)
    check('统计范围', '换到分析看板，范围条仍写着选中的 5 份试卷', /选中的 5 份试卷/.test(await scopeText()) && (await T('ids-banner').count()) === 1)
    await goto('#/report'); await T('report-page').waitFor()
    check('统计范围', '报告页「按当前筛选生成：选中的 5 份试卷」', await waitFor(async () => /选中的 5 份试卷/.test(await txt('report-scope')), 8000), await txt('report-scope'))
    // 6.2 报告
    const before = withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) n FROM reports").get().n)
    await T('reader-teacher').locator('xpath=ancestor::label').click()
    await waitFor(async () => (await T('report-generate').count()) > 0, 15000)
    await T('report-generate').click()
    const gen = await waitFor(async () => withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) n FROM reports").get().n) > before && (await T('report-running').count()) === 0, 90000)
    const rep = withDb(ctx.ud, d => d.prepare('SELECT * FROM reports ORDER BY created_at DESC, rowid DESC LIMIT 1').get())
    const fj = rep ? JSON.parse(rep.filter_json) : {}
    const req = mock.p3Requests[mock.p3Requests.length - 1]
    check('统计范围', '用选中的 5 份生成报告：报告记录里存的范围就是这 5 份', !!gen && JSON.stringify([...(fj.paperIds ?? [])].sort()) === JSON.stringify([...C].sort()), JSON.stringify(fj).slice(0, 120))
    check('统计范围', '报告标题写「选中的 5 份试卷 … 考情分析报告」，没有「全部年级」', !!rep && /^选中的 5 份试卷 .*考情分析报告（老师版）/.test(rep.title) && !/全部年级/.test(rep.title), rep && rep.title)
    check('统计范围', '发给 AI 的范围说明里写着「选中的 5 份试卷」', !!req && /选中的 5 份试卷/.test(req.user), req ? req.user.slice(0, 160) : 'no request')
    const list = await api(() => window.api.report.list())
    check('统计范围', '报告列表里这份的范围描述是「选中的 5 份试卷」', /选中的 5 份试卷/.test(list[0].filterDesc), list[0].filterDesc)
    // 6.3 重启（刷新）后还在；不含「含待审核」这类开关
    await goto('#/overview'); await T('overview').waitFor()
    await reloadHere(); await T('overview').waitFor()
    await waitFor(async () => (await txt('card-papers')) === '5', 10000)
    check('统计范围', '刷新（相当于重启）后，范围还是选中的 5 份，数字不变', (await txt('card-papers')) === '5' && /选中的 5 份试卷/.test(await scopeText()))
    const stored = withDb(ctx.ud, d => d.prepare("SELECT value_json AS value FROM settings WHERE key = 'ui_stats_filter'").get().value)
    check('统计范围', '范围和别的筛选一样存在设置里（ui_stats_filter），包含这 5 个 id', C.every(id => stored.includes(id)), stored.slice(0, 80))
    // 6.4 回到普通筛选
    await T('ids-back').click()
    await waitFor(async () => (await T('ids-banner').count()) === 0, 8000)
    await waitFor(async () => Number(await txt('card-papers')) === allPapersCount, 10000)
    check('统计范围', '点「回到普通筛选」：提示条消失，总览回到全部（份数和题数与选之前一致）', Number(await txt('card-papers')) === allPapersCount && Number(await txt('card-questions')) === allQuestions && !/选中的/.test(await scopeText()), await scopeText())
    check('统计范围', '退出后设置里的范围不再带 paperIds', !withDb(ctx.ud, d => d.prepare("SELECT value_json AS value FROM settings WHERE key = 'ui_stats_filter'").get().value).includes('paperIds'))
  }
  {
    // 6.5 之前的筛选在选中期间被收起，退出后还原
    await setFilter({ grade: '4' }, '#/overview')
    await T('overview').waitFor()
    await waitFor(async () => /四年级/.test(await scopeText()), 8000)
    const g4 = Number(await txt('card-papers'))
    await gotoLib()
    await search('卷c')
    await selectAllHeader()
    await waitFor(async () => (await selCount()) === 5, 5000)
    await T('scope-selected').click()
    await T('ids-banner').waitFor({ timeout: 15000 })
    await reloadHere()   // 重启后再回到普通筛选，之前的「四年级」也要还原（收起的筛选存在设置里）
    await T('ids-banner').waitFor({ timeout: 15000 })
    await T('ids-back').click()
    await waitFor(async () => (await T('ids-banner').count()) === 0, 8000)
    await waitFor(async () => /四年级/.test(await scopeText()), 8000)
    check('统计范围', '进入前选的「四年级」筛选，退出「只看选中的」后（中间还重启 / 刷新过一次）原样还原', /四年级/.test(await scopeText()) && Number(await txt('card-papers')) === g4, await scopeText())
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    await reloadHere()
  }
  {
    // 6.6 待审核的卷子被选中：只计入已确认的，范围句写明几份计入
    const R1 = I.R1
    await setFilter({ paperIds: [I.C1, R1] }, '#/overview')
    await T('overview').waitFor()
    await waitFor(async () => /选中的 2 份试卷/.test(await scopeText()), 8000)
    await waitFor(async () => (await txt('card-papers')) === '1', 8000)
    const sc = await scopeText()
    check('统计范围', '选了一份已确认 + 一份待审核：只计入已确认的 1 份，范围句写「选中的 2 份试卷（1 份计入统计）」，提示条说明另一份没算进去', (await txt('card-papers')) === '1' && /选中的 2 份试卷（1 份计入统计）/.test(sc) && /其中 1 份计入统计/.test(await txt('ids-banner')), `${sc} | ${await txt('ids-banner')}`)
    await page.locator('[data-testid=scope-bar] .ewb-scope__trigger').click()
    await T('filter-reviewing').click()
    await waitFor(async () => (await txt('card-papers')) === '2', 8000)
    check('统计范围', '打开「含待审核」后，选中的待审核那份也计入（2 份）——计入规则照常', (await txt('card-papers')) === '2' && /选中的 2 份试卷$/.test(await scopeText()))
    await T('filter-reviewing').click()
    await page.locator('[data-testid=scope-bar] .ewb-scope__trigger').click()
    // 6.7 重复导入：同一个文件的两份都选中，只算一份
    await setFilter({ paperIds: [I.H1, I.H1d] }, '#/overview')
    await T('overview').waitFor()
    await waitFor(async () => (await txt('card-papers')) === '1', 8000)
    check('统计范围', '选中了同一个文件导入的两份（H1 和它的副本）：默认只算一份', (await txt('card-papers')) === '1', await txt('card-papers'))
  }
  {
    // 6.8 选中的卷子后来被删了：不出错，份数自动对上
    ctx.consoleErrors.length = 0
    await setFilter({ paperIds: [I.C1, I.C3, ZZ] }, '#/overview')
    await T('overview').waitFor()
    await waitFor(async () => /选中的 3 份试卷/.test(await scopeText()), 8000)
    await api(id => window.api.papers.remove(id), ZZ)
    const ok = await waitFor(async () => /选中的 2 份试卷/.test(await scopeText()), 10000)
    check('统计范围', '选中的一份后来被删掉：范围句自动变成「选中的 2 份试卷」，总览照常显示，没有报错', ok && (await txt('card-papers')) === '2' && ctx.consoleErrors.length === 0, `${await scopeText()} errs=${JSON.stringify(ctx.consoleErrors).slice(0, 200)}`)
    await goto('#/dashboard'); await sleep(800)
    await api(ids => window.api.papers.batchRemove(ids), [I.C1])
    await waitFor(async () => /选中的 1 份试卷/.test(await scopeText()), 10000)
    // 全部都没了 → 回到普通筛选
    await api(ids => window.api.papers.batchRemove(ids), [I.C3])
    const back = await waitFor(async () => (await T('ids-banner').count()) === 0 && !/选中的/.test(await scopeText()), 10000)
    check('统计范围', '选中的卷子全被删光：自动回到普通筛选，不留一个空的「选中 0 份」', !!back, await scopeText())
    // 直接带已不存在的 id 调统计接口
    const gone = await api(() => window.api.stats.overview({ paperIds: ['99999999-9999-4999-8999-999999999999'] }))
    check('统计范围', '统计接口带着已不存在的 id：返回空范围，不抛错', gone.cards.papers === 0)
  }

  // ───────────────────────── 6b. 选中范围里的同比 / 新增、报告描述的份数 ─────────────────────────
  {
    // 只有一个学年（C1–C5 都是 2025）：没有更早学年，写明不做对比，而不是显示一个空的基线
    await setFilterFast({ paperIds: C }, '#/overview')
    await T('overview').waitFor()
    await waitFor(async () => (await T('new-this-year').count()) === 1, 8000)
    check('选中范围', '「今年新出现的知识点」标题写明「只在选中的卷子之间比」；选中的卷子里没有更早学年时写「选中的卷子里没有更早学年的，不做对比」',
      /只在选中的卷子之间比/.test(await txt('new-this-year')) && /选中的卷子里没有更早学年的，不做对比/.test(await txt('new-this-year')), (await txt('new-this-year')).slice(0, 120))
    await goto('#/dashboard'); await T('dashboard').waitFor()
    await page.locator('.ant-tabs-tab', { hasText: '同比' }).click()
    check('选中范围', '同比页签：选中的卷子只有一个学年时，写明「选中的卷子里没有更早学年的，不做对比」', await waitFor(async () => (await T('compare-ids-noearlier').count()) === 1 && /没有更早学年的，不做对比/.test(await txt('compare-ids-noearlier')), 8000))
    // 两个学年：同比和新增只在选中的卷子之间比，并有标注
    const two = [I.B1, I.B2, I.C2, I.C4]   // C1、C3 在前面的测试里已经删掉了
    await setFilterFast({ paperIds: two }, '#/dashboard')
    await T('dashboard').waitFor()
    await page.locator('.ant-tabs-tab', { hasText: '同比' }).click()
    const cmp = await api(ids => window.api.stats.compare({ paperIds: ids }, 2025, 'before', 2, true), two)
    const ov = await api(ids => window.api.stats.overview({ paperIds: ids }), two)
    check('选中范围', '选中 2024 和 2025 两个学年的卷子：同比今年 2 份、去年及以前 2 份（只数选中的）；总览「今年新增」的基线也是这 2 份', cmp.target.papers === 2 && cmp.base.papers === 2 && ov.newThisYear.basePapers === 2 && ov.newThisYear.targetPapers === 2, JSON.stringify([cmp.target.papers, cmp.base.papers, ov.newThisYear.basePapers]))
    check('选中范围', '同比页签顶部标注「只在选中的卷子之间比」', await waitFor(async () => (await T('compare-ids-note').count()) === 1 && /只在选中的卷子之间比/.test(await txt('compare-ids-note')), 8000))
    // 提示条的文字与实际一致：说明同比仍可选学年、筛选不起作用
    check('选中范围', '提示条文字：说明年级 / 学期 / 教材筛选不起作用、同比只在选中的卷子之间比、同比页里仍可选学年', /同比和「今年新增」只在这几份之间比/.test(await txt('ids-banner')) && /仍可以选看哪个学年/.test(await txt('ids-banner')))
    // 报告描述里的份数 = 计入的份数；已删除的 id 不算
    const gone = '99999999-9999-4999-8999-999999999999'
    const f3 = { paperIds: [I.C2, I.C4, I.R1, gone] }
    const pv = await api(f => window.api.report.preview(f, 'full'), f3)
    check('选中范围', '报告预览的范围描述：「选中的 3 份试卷（其中 2 份计入统计）」——已删除的 id 不算在选中里，计入的份数 = 2', /选中的 3 份试卷（其中 2 份计入统计）/.test(pv.filterDesc) && pv.papers === 2, pv.filterDesc)
    const before = withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) n FROM reports').get().n)
    const gr = await api(f => window.api.report.generate(f, crypto.randomUUID(), 'full'), f3)
    const rep = withDb(ctx.ud, d => d.prepare('SELECT * FROM reports ORDER BY created_at DESC, rowid DESC LIMIT 1').get())
    const req = mock.p3Requests[mock.p3Requests.length - 1]
    const pc = req && /【样本】(\d+) 份卷子/.exec(req.user)
    check('选中范围', '发给 AI 的筛选描述写「选中的 3 份试卷（其中 2 份计入统计）」，样本份数也是 2，二者对得上', !!gr.ok && !!req && /选中的 3 份试卷（其中 2 份计入统计）/.test(req.user) && !!pc && pc[1] === '2', req ? req.user.slice(0, 120) : 'none')
    check('选中范围', '报告标题用计入的份数：「选中的 2 份试卷 …」', !!rep && withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) n FROM reports').get().n) === before + 1 && /^选中的 2 份试卷 /.test(rep.title), rep && rep.title)
    await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
  }

  // ───────────────────────── 6c. 超过 1000 份：分段处理、不悄悄截断、不给用户看技术报错 ─────────────────────────
  {
    await closeApp()
    writeDb(ud, db => {
      const ins = db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, school, file_name, file_hash, status, page_count, created_at) VALUES (?, ?, '2', '上', 2022, '期中', 'PEP压测', '压测地', NULL, ?, ?, 'done', 0, '2026-10-26 09:00:00')`)
      db.exec('BEGIN')
      for (let i = 1; i <= 1001; i++) ins.run(`00000000-0000-4000-8000-${String(900000 + i).padStart(12, '0')}`, `压测卷${String(i).padStart(4, '0')}`, `big-${i}.pdf`, `hash-big-${i}`)
      db.exec('COMMIT')
    })
    await open(ud)
    page = ctx.page
    await saveCfg(cfgFor(mock), SECRET)
    await gotoLib()
    await search('压测卷')
    await selectAllHeader()
    check('超过 1000 份', '搜出 1001 份并全选：已选 1001 份', await waitFor(async () => (await selCount()) === 1001, 10000), String(await selCount()))
    await T('scope-selected').click()
    await waitFor(async () => (await page.locator('.ant-message-notice').count()) > 0, 5000)
    const w = await page.locator('.ant-message-notice').last().innerText()
    check('超过 1000 份', '「只看这几份的统计」超过 1000 份：明说「一次最多统计 1000 份，请先用搜索缩小范围」，不跳转、不悄悄截断', /一次最多统计 1000 份，请先用搜索缩小范围/.test(w) && (await page.evaluate(() => location.hash)) === '#/' && !JSON.stringify(await api(() => window.api.settings.get('ui_stats_filter'))).includes('paperIds'), w)
    const raw = await api(ids => window.api.papers.batchUpdate(ids, { region: 'x' }).then(() => 'ok', e => String(e.message)), Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(900000 + i + 1).padStart(12, '0')}`))
    check('超过 1000 份', '主进程一次最多收 1000 份（直接调用会被拒）——所以界面必须自己分段', raw !== 'ok')
    // 界面分段：批量改信息 1001 份全部成功
    await T('batch-edit-open').click()
    await T('batch-edit').waitFor()
    await T('batch-edit-input-school').fill('压测小学')
    await T('batch-edit-ok').click()
    const edited = await waitFor(async () => withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) n FROM papers WHERE school = '压测小学'").get().n) === 1001, 60000)
    check('超过 1000 份', '批量改信息 1001 份：界面分段发送，1001 份全部改到，没有技术报错', !!edited)
    // 批量删除 1001 份：分段，全部删掉
    await T('batch-delete').click()
    await T('batch-delete-confirm').waitFor()
    check('超过 1000 份', '批量删除确认框：写「这 1001 份」，只列 8 条标题', /这 1001 份试卷/.test(await page.locator('.ant-modal-confirm-title').innerText()) && (await T('batch-delete-confirm').locator('li').count()) === 9)
    await T('batch-delete-ok').click()
    const del = await waitFor(async () => withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) n FROM papers WHERE title LIKE '压测卷%'").get().n) === 0, 90000)
    check('超过 1000 份', '批量删除 1001 份：分段发送，全部删掉（界面一直能响应）', !!del)
    await search('')
  }

  // ───────────────────────── 7. 截图（浅色 / 深色，1100 与 900 宽） ─────────────────────────
  {
    for (const [mode, w] of [['light', 1100], ['dark', 1100], ['light', 900], ['dark', 900]]) {
      await setTheme(mode)
      await resize(w, 900)
      await gotoLib()
      await search('学年')
      await selectAllHeader()
      await waitFor(async () => (await selCount()) > 5, 5000)
      await shot8(`library-select-${mode}-${w}`)
      await T('select-clear').click()
      await search('卷F1')
      const frow = page.locator(`tr[data-row-key="${I.F1}"]`)
      await frow.waitFor()
      const more = await frow.locator('button', { hasText: '更多' }).count()
      const oneLine = await frow.locator('.ewb-lib-ops').evaluate(el => { const r = [...el.children].map(c => c.getBoundingClientRect()); return Math.max(...r.map(x => x.bottom)) - Math.min(...r.map(x => x.top)) < 40 && el.scrollWidth <= el.clientWidth + 1 })
      check('失败行操作', `${mode} ${w}px：失败的卷子只有一个「更多」，「重试」「其他方式」「更多」在同一行`, more === 1 && oneLine, `更多×${more} oneLine=${oneLine}`)
      await search('')
      const some = (await papersDb()).filter(p => p.status === 'done' && p.is_sample === 0).slice(0, 5).map(p => p.id)
      await setFilter({ paperIds: some }, '#/overview')
      await T('overview').waitFor()
      await T('ids-banner').waitFor({ timeout: 10000 })
      await sleep(600)
      await shot8(`scope-ids-${mode}-${w}`)
      await page.evaluate(() => window.api.settings.set('ui_stats_filter', {}))
    }
    await setTheme('light')
    await resize(1280, 860)
    check('截图', '浅色 / 深色 × 1100 / 900 宽的试卷库（带已选条）与范围条（选中模式）截图已存到 docs/screenshots/m8-*.png', fs.readdirSync(shots).filter(f => /^m8-.*\.png$/.test(f)).length >= 10)
  }
  check('控制台', '整个测试里页面没有未捕获的错误', ctx.consoleErrors.filter(e => !/DevTools|Autofill/.test(e)).length === 0, JSON.stringify(ctx.consoleErrors).slice(0, 300))
}

const out = path.join(__dirname, 'last-result-m8.json')
const dumpFailure = async () => {
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f); console.error('页面控制台错误：', JSON.stringify(ctx.consoleErrors ?? []).slice(0, 800)) } catch { /* 应用可能已退出 */ }
}
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  await dumpFailure()
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 1)
})
