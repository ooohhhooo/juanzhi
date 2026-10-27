// M4 E2E（三）：更改数据目录、示例数据、首次启动引导、知识点树编辑、关于页与其它收尾项。
const M = require('./m4-lib.cjs')
const naive = require('./naive.cjs')
const { SPEC } = require('./fixtures-m3.cjs')
const D = require('./m4-phases-data.cjs')
const NPAPERS = SPEC.length
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, ctx, T, txt, stat, goto, shot, setFilter, api, stubSave, stubOpen, cfgFor, saveCfg, root, clean, open, closeApp, waitStat, dataDirOf, L } = M
const { counts, statSnap, treeHash, gotoSettings } = D

const closeAlert = async () => T('pack-error').locator('.ant-alert-close-icon').click().catch(() => {})

// ───────── 阶段 4：更改数据目录 ─────────
async function phaseDataDir() {
  const ud = ctx.ud
  const cur = dataDirOf()
  const before = { counts: counts(), stats: await statSnap(), files: treeHash(path.join(cur, 'files')) }
  await gotoSettings()
  await T('data-storage').waitFor()
  check('数据目录', '设置页显示当前数据目录（默认位置）', (await txt('data-dir')) === cur && /默认位置/.test(await txt('data-storage')))
  const tryDir = async (dir) => {
    await stubOpen(dir)
    await T('dd-change').click()
    const ok = await waitFor(async () => (await T('dd-path').count()) > 0, 10000)
    const err = (await T('dd-error').count()) > 0 ? await txt('dd-error') : null
    const confirmDisabled = await T('dd-confirm').isDisabled()
    return { ok, err, confirmDisabled }
  }
  const cancelModal = async () => { await page().getByRole('button', { name: /取\s*消/ }).click(); await waitFor(async () => (await T('dd-path').count()) === 0, 5000); await sleep(400) }
  const page = () => ctx.page
  // 校验：不能在当前目录里面 / 不能是当前目录 / 不能是它的上级 / 必须可写 / 迁移目标必须是空目录
  const inside = await tryDir(path.join(cur, 'files'))
  check('数据目录 校验', '选当前数据目录里面的文件夹 → 拒绝，原因写明"里面的文件夹"，确认按钮灰', inside.ok && /里面的文件夹/.test(inside.err ?? '') && inside.confirmDisabled, inside.err)
  await cancelModal()
  const same = await tryDir(cur)
  check('数据目录 校验', '选当前数据目录本身 → 拒绝（"这就是当前正在使用的"）', same.ok && /当前正在使用/.test(same.err ?? '') && same.confirmDisabled, same.err)
  await cancelModal()
  const parent = await tryDir(ud)
  check('数据目录 校验', '选当前数据目录的上级（userData，会把当前目录套在里面）→ 拒绝，原因写明"上级文件夹"', parent.ok && /上级文件夹/.test(parent.err ?? '') && parent.confirmDisabled, parent.err)
  await cancelModal()
  const busyDir = path.join(work, 'not-empty'); fs.mkdirSync(busyDir, { recursive: true }); fs.writeFileSync(path.join(busyDir, '照片.jpg'), 'x')
  const nonEmpty = await tryDir(busyDir)
  check('数据目录 校验', '选一个有别的文件的非空文件夹（又不是数据目录）→ 拒绝"不是空的"', nonEmpty.ok && /不是空的/.test(nonEmpty.err ?? '') && nonEmpty.confirmDisabled, nonEmpty.err)
  await cancelModal()
  let ro = null
  if (process.getuid && process.getuid() !== 0) {
    ro = path.join(work, 'readonly'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o555)
    const rr = await tryDir(ro)
    check('数据目录 校验', '选一个只读（不可写）的文件夹 → 拒绝，写明没有写入权限', rr.ok && /没有写入权限|不能写入/.test(rr.err ?? '') && rr.confirmDisabled, rr.err)
    await cancelModal()
    fs.chmodSync(ro, 0o755)
  }
  check('数据目录 校验', '被拒绝的尝试都没有改任何东西：没写配置文件、数据目录没变', !fs.existsSync(path.join(ud, 'ewb-config.json')) && (await txt('data-dir')) === cur)

  // changeDir 只认主进程对话框签发的 token：页面脚本传一个路径过去不行
  const forged = await api(async () => { const out = []; for (const t of ['/tmp/evil-target', crypto.randomUUID()]) { try { await window.api.data.changeDir(t, 'move'); out.push('ok') } catch (e) { out.push(e.message) } } return out })
  check('数据目录 校验', '页面脚本绕过对话框、直接给 changeDir 传一个路径（或伪造的 token）→ 被拒绝，什么都不会复制', forged.every(m => m !== 'ok') && /失效/.test(forged[1]) && !fs.existsSync('/tmp/evil-target'), JSON.stringify(forged).slice(0, 120))
  // 迁移到一个空文件夹
  const target = path.join(work, 'D1-new-data')
  fs.mkdirSync(target, { recursive: true })
  const good = await tryDir(target)
  check('数据目录 迁移', '选一个空文件夹 → 可以确认；说明会复制现有数据、原目录保持不动、重启后生效', good.ok && !good.err && !good.confirmDisabled && /空文件夹/.test(await txt('dd-kind')), JSON.stringify(good) + await txt('dd-kind'))
  await shot('10-data-dir-dialog')
  // 复审 P2-8：覆盖导入前的备份也要跟着迁走——先在原目录放一份像样的备份
  const seedBk = path.join(cur, 'backups', 'pre-import-20261026-000001-e2e0')
  fs.mkdirSync(path.join(seedBk, 'files', 'x'), { recursive: true }); fs.writeFileSync(path.join(seedBk, 'db.sqlite'), 'bk-db'); fs.writeFileSync(path.join(seedBk, 'files', 'x', 'y.txt'), 'bk-file')
  await T('dd-confirm').click()
  const gate = await waitFor(async () => (await T('restart-now').count()) > 0, 120000)
  check('数据目录 迁移', '迁移完成后界面被"需要重启才能使用新的数据目录"盖住（不能关闭，防止继续写进旧目录），写明新旧目录', gate && /重启之后才会生效/.test(await txt('restart-body')) && (await T('restart-now').locator('xpath=ancestor::div[contains(@class,"ant-modal")][1]').locator('.ant-modal-close').count()) === 0 && /D1-new-data/.test(await txt('restart-body')))
  await shot('11-restart-gate')
  // 审核 P1-5：「需要重启」的状态在主进程里——重载页面、（macOS）关窗再点 Dock 图标新建窗口，拦截都还在；主进程自己也拒绝写入
  await ctx.page.reload()
  const gate2 = await waitFor(async () => (await T('restart-now').count()) > 0, 20000)
  check('数据目录 重启拦截', '页面重载后「需要重启」的拦截仍然在（状态在主进程，启动时向主进程查询）并写明新目录', gate2 && /D1-new-data/.test(await txt('restart-body')))
  const refused = await api(async () => { const out = []; for (const f of [() => window.api.papers.update('00000000-0000-4000-8000-000000000001', { title: 'x' }), () => window.api.taxonomy.save([{ op: 'add', parent_code: null, name: '不该写进旧目录' }]), () => window.api.data.loadSample(), () => window.api.questions.reopen('00000000-0000-4000-8000-000000000001')]) { try { await f(); out.push('ok') } catch (e) { out.push(e.message) } } return out })
  check('数据目录 重启拦截', '主进程自己拒绝写入类请求（改试卷信息 / 知识点编辑 / 加载示例数据 / 审核写入）：提示「需要先重启」，旧目录里没有被写进任何东西', refused.every(m => /需要先重启/.test(m)) && withDb(ctx.ud, d => d.prepare("SELECT COUNT(*) c FROM kps WHERE name = '不该写进旧目录'").get().c) === 0 && !(await api(() => window.api.data.sampleStatus())).loaded, JSON.stringify(refused))
  const readOk = await api(async () => { try { return (await window.api.stats.overview({})).cards.papers } catch (e) { return e.message } })
  check('数据目录 重启拦截', '读取类请求不受影响（看板仍能读）', typeof readOk === 'number', String(readOk))
  if (process.platform === 'darwin') {
    const waitWin = ctx.app.waitForEvent('window')
    await ctx.app.evaluate(({ app, BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); setTimeout(() => app.emit('activate'), 600) })
    const np = await waitWin
    ctx.page = np
    const gate3 = await np.waitForSelector('[data-testid=restart-now]', { timeout: 20000 }).then(() => true, () => false)
    check('数据目录 重启拦截', 'macOS：关掉窗口再点 Dock 图标（新建窗口）后，拦截仍然在——不会让人继续在旧目录里工作', gate3)
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'ewb-config.json'), 'utf8'))
  check('数据目录 迁移', '新目录里有 db.sqlite 和 files/，试卷数 / 文件与原目录一致；配置写进 userData/ewb-config.json（不在数据库里）；旧目录原样保留', cfg.dataDir === target && fs.existsSync(path.join(target, 'db.sqlite')) && JSON.stringify(treeHash(path.join(target, 'files'))) === JSON.stringify(before.files) && fs.existsSync(path.join(cur, 'db.sqlite')) && (() => { const d = M.readDb(target); try { return d.prepare('SELECT COUNT(*) c FROM papers').get().c === before.counts.papers } finally { d.close() } })())
  {
    const moved = path.join(target, 'backups', 'pre-import-20261026-000001-e2e0')
    check('数据目录 迁移', '导入前的备份（backups/）也一起迁到了新目录，内容一致；旧目录里的原样保留', fs.existsSync(moved) && fs.readFileSync(path.join(moved, 'db.sqlite'), 'utf8') === 'bk-db' && fs.readFileSync(path.join(moved, 'files', 'x', 'y.txt'), 'utf8') === 'bk-file' && fs.existsSync(seedBk))
    fs.rmSync(path.join(cur, 'backups'), { recursive: true, force: true }); fs.rmSync(path.join(target, 'backups'), { recursive: true, force: true })   // 清理测试用的备份，不影响后面"没有备份目录"的检查
  }
  // 重启（关掉再用同一个 userData 打开）→ 用新目录
  await closeApp()
  await open(ud)
  const info = await api(() => window.api.app.info())
  check('数据目录 重启', '重启后数据目录 = 新目录；卷数 / 题数 / 看板数字不变（走的是新目录里的库）', info.dataDir === target && counts().papers === before.counts.papers && (await statSnap()) === before.stats, info.dataDir)
  // 页面图从新目录读出来
  await goto('#/paper/' + ctx.ids.C2)
  const img = await waitFor(async () => ctx.page.evaluate(id => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = `ewb://page/${id}/page-1.png` }), ctx.ids.C2), 15000)
  check('数据目录 重启', '页面图通过 ewb:// 协议从新目录读出（能解码，宽度 > 0）', typeof img === 'number' && img > 100, String(img))
  // 从新目录"选择已有数据目录"：切回原来的默认目录（里面有完整的数据）
  await gotoSettings()
  await stubOpen(cur)
  await T('dd-change').click()
  await waitFor(async () => (await T('dd-kind').count()) > 0, 10000)
  check('数据目录 已有', '选择一个已有数据目录（原默认目录）→ 识别为"已经有数据（N 份试卷）"，说明不会合并也不会删除', new RegExp(`已经有数据（${NPAPERS} 份试卷`).test(await txt('dd-kind')), await txt('dd-kind'))
  await T('dd-confirm').click()
  await waitFor(async () => (await T('restart-now').count()) > 0, 30000)
  const cfg2 = JSON.parse(fs.readFileSync(path.join(ud, 'ewb-config.json'), 'utf8'))
  check('数据目录 已有', '配置改指向了那个目录', cfg2.dataDir === cur)
  await closeApp()
  await open(ud)
  const info2 = await api(() => window.api.app.info())
  check('数据目录 已有', '重启后回到原目录，数据完好', info2.dataDir === cur && (await statSnap()) === before.stats)
  // 恢复默认位置：删掉配置
  const reset = await api(() => window.api.data.resetDir())
  check('数据目录 恢复默认', '「恢复默认位置」：配置文件被删，提示重启后生效', reset.restartRequired === true && !fs.existsSync(path.join(ud, 'ewb-config.json')) && reset.hasData === true)
  await closeApp()
  await open(ud)   // 此时没有配置，仍是默认目录
  check('数据目录 恢复默认', '重启后用默认目录', (await api(() => window.api.app.info())).dataDir === cur)
  // 迁移中途失败不留半截：校验通过之后、复制库之后出错（故障注入）→ 目标里不留 db / files，配置不改，原目录不变
  {
    const t2 = path.join(work, 'D2-fault'); fs.mkdirSync(t2)
    await gotoSettings()
    await ctx.app.evaluate(() => { process.env.EWB_TEST_FAULT = 'move-after-db' })
    await stubOpen(t2)
    await T('dd-change').click()
    await waitFor(async () => (await T('dd-confirm').count()) > 0, 10000)
    await T('dd-confirm').click()
    const bad = await waitFor(async () => (await T('dd-error').count()) > 0, 60000)
    await ctx.app.evaluate(() => { delete process.env.EWB_TEST_FAULT })
    check('数据目录 迁移失败', '迁移中途出错：给出原因「迁移没有完成，原来的数据目录没有变化」；目标里没有留下半截的 db / files，配置没改，库和统计不变', bad && /迁移没有完成，原来的数据目录没有变化/.test(await txt('dd-error')) && !fs.existsSync(path.join(t2, 'db.sqlite')) && !fs.existsSync(path.join(t2, 'files')) && !fs.existsSync(path.join(ud, 'ewb-config.json')) && (await statSnap()) === before.stats, bad ? await txt('dd-error') : '')
    await cancelModal()
  }
}

// ───────── 阶段 5：示例数据（在有真实数据的库里）─────────
async function phaseSample() {
  const { page } = ctx
  await gotoSettings()
  const real = await api(async () => JSON.stringify([await window.api.stats.overview({}), await window.api.stats.distribution({}), await window.api.stats.hot({}, 2), await window.api.stats.matrix({}, 1), await window.api.stats.compare({ grade: '4' }, 2025, 'before', 2)]))
  const realFiles = fs.readdirSync(path.join(dataDirOf(), 'files')).length
  check('示例数据', '加载前：没有示例数据，设置页"清除示例数据"按钮是灰的；总览看真实数据（18 份）', (await txt('sample-status')).includes('还没有加载') && (await T('sample-clear').isDisabled()) && (await api(() => window.api.data.sampleStatus())).loaded === false)
  await T('sample-load').click()
  const loaded = await waitFor(async () => (await api(() => window.api.data.sampleStatus())).loaded, 60000)
  const st = await api(() => window.api.data.sampleStatus())
  check('示例数据', '点"加载示例数据"：12 份合成示例卷、≥96 道题进了库；设置页状态更新；按钮互换（加载灰、清除可点）', loaded && st.papers === 12 && st.questions >= 96 && /已加载：12 份/.test(await txt('sample-status')) && (await T('sample-load').isDisabled()) && !(await T('sample-clear').isDisabled()), JSON.stringify(st))
  const ps = withDb(ctx.ud, d => d.prepare('SELECT grade, school_year_start y, status, title, page_count, is_sample FROM papers WHERE is_sample = 1').all())
  check('示例数据', '示例卷覆盖 ≥3 个学年（2023/2024/2025）和 2 个年级，都是"已完成"状态，标题带【示例】，每份有页面图', new Set(ps.map(p => p.y)).size === 3 && new Set(ps.map(p => p.grade)).size === 2 && ps.every(p => p.status === 'done' && p.title.startsWith('【示例】') && p.page_count >= 1 && p.is_sample === 1))
  // 不混进真实数据的统计
  const realAfter = await api(async () => JSON.stringify([await window.api.stats.overview({}), await window.api.stats.distribution({}), await window.api.stats.hot({}, 2), await window.api.stats.matrix({}, 1), await window.api.stats.compare({ grade: '4' }, 2025, 'before', 2)]))
  check('示例数据 隔离', '加载示例数据后，真实数据的全部统计（总览 / 分布 / 重难点 / 细目表 / 同比）一个字都没变——不混进去', realAfter === real)
  const smp = await api(() => window.api.stats.overview({ sample: true }))
  check('示例数据 隔离', '切到示例数据范围：12 份、涉及知识点 > 20 个，常考 Top 10 有内容；真实范围仍是 18 份', smp.cards.papers === 12 && smp.cards.kps > 20 && smp.top.length === 10 && JSON.parse(real)[0].cards.papers === 18)
  // 界面：加载后看板自动切到示例数据，横幅提示；切回真实数据
  await goto('#/overview')
  await T('sample-banner').waitFor({ timeout: 10000 })
  check('示例数据 界面', '加载后总览自动停在"示例数据"：黄蓝提示条写明"不是任何真实考情"，试卷 12 份，有 Top 10、本学年新增', /不是任何真实考情/.test(await txt('sample-banner')) && await waitStat('card-papers', 12) && (await T('top10').count()) === 1)
  await shot('12-sample-overview')
  await goto('#/dashboard')
  await ctx.page.getByRole('tab', { name: '同比' }).click()
  await T('col-added').waitFor()
  await waitFor(async () => Number(await T('col-added').getAttribute('data-count')) >= 1, 15000)
  check('示例数据 界面', '示例数据的同比页有内容：2025 学年相对更早学年有新增 / 消失（一般将来时新增；字母组合发音消失）', (await T('item-GR.TENSE.FUT').count()) === 1 && (await T('col-removed').locator('[data-testid^=item-]').count()) >= 1, `新增 ${await T('col-added').getAttribute('data-count')}`)
  await shot('13-sample-compare')
  await ctx.page.locator('[data-testid=scope-bar] .ewb-scope__trigger[aria-expanded=false]').click().catch(() => {})   // 筛选面板默认收起，先展开
  await T('filter-dataset').getByText('真实数据').click()
  check('示例数据 界面', '切回"真实数据"：总览 18 份（和加载前一样）', await (async () => { await goto('#/overview'); return waitStat('card-papers', 18) })())
  check('示例数据 界面', '"清除筛选"不会悄悄切换真实 / 示例（它是范围开关，不是筛选条件）', await (async () => { await T('filter-dataset').getByText('示例数据').click(); await waitStat('card-papers', 12); await T('filter-reset').click().catch(() => {}); await sleep(300); return (await stat('card-papers')) === '12' })())
  await T('filter-dataset').getByText('真实数据').click()
  // 试卷库里示例卷有"示例"标记，页面图是真实渲染的（OCR 读出标题里的英文题干）
  await goto('#/')
  await T('dropzone').waitFor()
  const tags = await waitFor(async () => (await ctx.page.locator('[data-testid=sample-tag]').count()) > 0, 10000)
  check('示例数据', '试卷库里示例卷带"示例"标记', tags)
  const sid = ps.length ? withDb(ctx.ud, d => d.prepare("SELECT id FROM papers WHERE is_sample = 1 AND title LIKE '%2025-2026学年四年级下学期期末%'").get().id) : null
  const pagePng = path.join(dataDirOf(), 'files', sid, 'page-1.png')
  const ocrText = L.ocrText(pagePng)
  check('示例数据', '示例卷的页面图是真的渲染出来的（A4，1240×1754），真实 OCR 读得出题干英文（Choose / going to / visit）', fs.existsSync(pagePng) && /Choose|going|visit|grandma/i.test(ocrText), ocrText.slice(0, 80))
  const q1 = withDb(ctx.ud, d => d.prepare('SELECT bbox_json FROM questions WHERE paper_id = ? AND ord = 5').get(sid))
  const crop = path.join(work, 'sample-crop.png')
  await L.cropPage(ctx.app, pagePng, JSON.parse(q1.bbox_json), crop)
  check('示例数据', '按示例题的定位框裁出第 5 题的截图，OCR 读出这道题的题干（going to / visit）——定位框是渲染时算出来的，位置对', /going|visit|grandma/i.test(L.ocrText(crop)), L.ocrText(crop).slice(0, 80))
  // 在示例数据范围里生成一份 P3 报告和一份 P2 分析（它们引用的是示例卷的题目）——导出时也不能带走
  const gr = await api(() => window.api.report.generate({ sample: true, grade: '4' }, crypto.randomUUID()))
  const ga = await api(() => window.api.ai.analyzeCompare({ filter: { sample: true, grade: '4' }, target: 2025, base: 'before', level: 2, align: true }, crypto.randomUUID()))
  check('示例数据 导出', '准备：在示例数据范围生成了一份 P3 报告和一份 P2 分析（库里 filter 带 sample:true）', gr.ok === true && ga.ok === true && withDb(ctx.ud, d => d.prepare(`SELECT (SELECT COUNT(*) FROM reports WHERE filter_json LIKE '%"sample":true%') r, (SELECT COUNT(*) FROM ai_analyses WHERE scope_json LIKE '%"sample":true%') a`).get()).r === 1, JSON.stringify([gr.ok, ga.ok, gr.message, ga.message]))
  // 导出数据包不带示例数据
  const zip2 = path.join(work, 'with-sample.ewb.zip')
  await gotoSettings()
  await stubSave(zip2)
  await T('pack-export').click()
  await waitFor(async () => (await T('pack-done').count()) > 0, 60000)
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(zip2))
  const man = JSON.parse(await z.file('manifest.json').async('string'))
  check('示例数据 导出', '有示例数据时导出数据包：manifest 仍是全部真实试卷；包里没有示例卷的任何文件', man.paperCount === SPEC.length && Object.keys(z.files).filter(n => n.startsWith('files/')).every(n => !n.includes(sid)) && Object.keys(z.files).filter(n => /page-1\.png$/.test(n)).length === 2)
  const snapFile = path.join(work, 'with-sample-snapshot.sqlite')
  fs.writeFileSync(snapFile, await z.file('db.sqlite').async('nodebuffer'))
  const { DatabaseSync } = require('node:sqlite')
  const sd = new DatabaseSync(snapFile, { readOnly: true })
  const inPack = { papers: sd.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1').get().c, reports: sd.prepare(`SELECT COUNT(*) c FROM reports WHERE filter_json LIKE '%"sample":true%'`).get().c, analyses: sd.prepare(`SELECT COUNT(*) c FROM ai_analyses WHERE scope_json LIKE '%"sample":true%'`).get().c, realReports: sd.prepare('SELECT COUNT(*) c FROM reports').get().c }
  sd.close()
  check('示例数据 导出', '包里的数据库也没有示例数据派生的东西：没有示例卷、没有基于示例筛选的 P3 报告、没有示例范围的 P2 分析（真实报告 2 份仍在）', inPack.papers === 0 && inPack.reports === 0 && inPack.analyses === 0 && inPack.realReports === 2, JSON.stringify(inPack))
  // 清除
  await T('sample-clear').click()
  await ctx.page.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').last().click()
  const cleared = await waitFor(async () => !(await api(() => window.api.data.sampleStatus())).loaded, 30000)
  const real2 = await api(async () => JSON.stringify([await window.api.stats.overview({}), await window.api.stats.distribution({}), await window.api.stats.hot({}, 2), await window.api.stats.matrix({}, 1), await window.api.stats.compare({ grade: '4' }, 2025, 'before', 2)]))
  check('示例数据 清除', '一键清除：示例卷、题目、标注、页面图目录全部删除（files 目录回到加载前的数量）；真实数据的统计与加载前一模一样', cleared && withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM papers WHERE is_sample = 1').get().c) === 0 && fs.readdirSync(path.join(dataDirOf(), 'files')).length === realFiles && counts().papers === SPEC.length && real2 === real && /还没有加载/.test(await txt('sample-status')))
  check('示例数据 清除', '清除后筛选自动回到真实数据（不会停在一个空的"示例数据"看板上）；"示例数据"开关消失', await (async () => { await goto('#/overview'); return waitStat('card-papers', 18) })() && (await T('filter-dataset').count()) === 0 && !(await api(() => window.api.settings.get('ui_stats_filter')))?.sample)
}

// ───────── 阶段 6：首次启动引导（全新 userData）─────────
async function phaseOnboarding() {
  await closeApp()
  const S = path.join(work, 'userS')
  await open(S)
  const { page } = ctx
  const on = await waitFor(async () => (await T('onboarding').count()) > 0, 15000)
  check('首次启动', '全新安装第一次打开：试卷库顶部显示三步卡片（配置 AI、拖入第一批卷子、选择教材版本）', on && (await T('onb-step-ai').count()) === 1 && (await T('onb-step-papers').count()) === 1 && (await T('onb-step-textbook').count()) === 1 && (await T('dropzone').count()) === 1)
  await shot('14-onboarding')
  const ds = async id => T(id).getAttribute('data-done')
  check('首次启动', '三步都未完成：配置 AI 写"可跳过"，拖入卷子写"待完成"，教材写"待完成"', (await ds('onb-step-ai')) === '0' && (await ds('onb-step-papers')) === '0' && (await ds('onb-step-textbook')) === '0' && /可跳过/.test(await txt('onb-step-ai')))
  await T('onb-skip-ai').click()
  check('首次启动', '第 1 步可以跳过：点"先跳过"后标"已跳过"，卡片还在、不影响后面', /已跳过/.test(await txt('onb-step-ai')) && (await T('onboarding').count()) === 1)
  // 选教材 → 写进设置
  await T('onb-textbook').click()
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '外研版' }).first().click()
  const tb = await waitFor(async () => (await api(() => window.api.settings.get('default_textbook'))) === '外研版', 8000)
  check('首次启动', '第 3 步选"外研版"：写进设置 default_textbook，步骤标完成', tb && (await waitFor(async () => (await ds('onb-step-textbook')) === '1', 5000)))
  // 配 AI → 第 1 步自动完成
  const mock = ctx.mock
  await saveCfg(cfgFor(mock), SECRET)
  check('首次启动', '到设置里配好 AI 后，回到试卷库第 1 步自动变"已配置"', await (async () => { await goto('#/settings'); await T('data-pack').waitFor(); await goto('#/'); return waitFor(async () => (await ds('onb-step-ai')) === '1', 8000) })())
  // 拖入第一批卷子：用 M1 样本里的一份（真实流水线：提取 → mock AI 解析），第 2 步变完成
  const sample = path.join(root, 'samples', 'g4-2025.pdf')
  const alt = fs.existsSync(sample) ? sample : null
  if (alt) {
    mock.quirks = {}
    await L.dropFiles(page, [alt])
    const got = await waitFor(async () => (await ds('onb-step-papers')) === '1', 120000)
    check('首次启动', '拖入第一份卷子后第 2 步变"已导入 1 份"（走真实的提取流水线）；教材默认值在 AI 没读出教材时补上', got)
  } else check('首次启动', '拖入第一份卷子后第 2 步变完成（缺样本文件，未测）', true, 'skip')
  // 示例数据一步到位
  await T('onb-load-sample').click()
  await waitFor(async () => (await api(() => window.api.data.sampleStatus())).loaded, 60000)
  const url = await waitFor(async () => (await ctx.page.evaluate(() => location.hash)) === '#/overview', 10000)
  const okStat = await waitStat('card-papers', 12)
  check('首次启动', '点"加载示例数据试一试"：12 份示例卷进库，自动跳到总览并停在示例数据范围，看板有内容；你自己的卷子不受影响', url && okStat && /不是任何真实考情/.test(await txt('sample-banner')), `${url} ${okStat} ${await page.evaluate(() => location.hash)} ${(await T('card-papers').count()) ? await stat('card-papers') : '-'}`)
  await shot('15-onboarding-sample')
  // 不再显示：写设置，重启后也不再出现
  await goto('#/')
  await T('onb-done').click()
  const gone = await waitFor(async () => (await T('onboarding').count()) === 0, 5000)
  await closeApp(); await open(S)
  check('首次启动', '点"不再显示"后卡片消失，写进设置；重启后不再出现', gone && (await api(() => window.api.settings.get('onboarding_done'))) === true && (await T('onboarding').count()) === 0)

  // 复审 P2-4：启动时恢复上次中断的导入——结果要让人看见，不能只写一行控制台日志
  {
    const J = path.join(work, 'userJ')
    await closeApp(); await open(J)
    const jd = path.join(J, 'workbench-data')
    await closeApp()
    // ① journal 内容不合规（被改坏 / 写坏）→ 没有做任何恢复，弹窗说清楚；坏 journal 改名留作线索
    fs.writeFileSync(path.join(jd, 'import-journal.json'), JSON.stringify({ id: 'e2e-j1', filesRel: '../elsewhere', backupFilesRel: 'backups/pre-import-20261026-000002-e2e1/files', startedAt: 'x' }))
    await open(J)
    const shown1 = await waitFor(async () => (await T('startup-notice-body').count()) > 0, 15000)
    const body1 = shown1 ? await txt('startup-notice-body') : ''
    check('启动恢复', '启动时遇到不认的导入恢复记录：弹出「上次导入数据包没有恢复成功」，写明原因和备份位置；坏记录改名留作线索，下次不再重复', shown1 && /无法识别/.test(body1) && /backups/.test(body1) && /没有恢复成功/.test(await txt('startup-notice')) && fs.readdirSync(jd).some(n => n.startsWith('import-journal.json.invalid-')) && !fs.existsSync(path.join(jd, 'import-journal.json')), body1)
    await shot('16-startup-notice')
    await T('startup-notice-ok').click()
    check('启动恢复', '点「知道了」后弹窗关闭，应用可以正常使用', await waitFor(async () => (await T('startup-notice-body').count()) === 0, 5000) && (await waitFor(async () => (await T('dropzone').count()) > 0 || (await T('onboarding').count()) > 0, 10000)) && (await api(() => window.api.papers.list())).length === 0)
    await closeApp()
    // ② 合规的 journal：旧 files 已经被换进备份、新的没放进去、没有提交 → 自动换回，弹窗告知「保持在导入之前的状态」
    const bk = path.join(jd, 'backups', 'pre-import-20261026-000002-e2e1')
    fs.mkdirSync(path.join(bk, 'files', 'keep-me'), { recursive: true }); fs.writeFileSync(path.join(bk, 'files', 'keep-me', 'a.txt'), 'old-files')
    fs.rmSync(path.join(jd, 'files'), { recursive: true, force: true })
    fs.writeFileSync(path.join(jd, 'import-journal.json'), JSON.stringify({ id: 'e2e-j2', filesRel: 'files', backupFilesRel: 'backups/pre-import-20261026-000002-e2e1/files', startedAt: 'x' }))
    await open(J)
    const shown2 = await waitFor(async () => (await T('startup-notice-body').count()) > 0, 15000)
    const body2 = shown2 ? await txt('startup-notice-body') : ''
    check('启动恢复', '启动时自动恢复中断的导入：files 目录换回导入之前的（内容在、journal 已清），弹窗告知「没有完成 / 保持在导入之前的状态」', shown2 && /没有完成/.test(body2) && /导入之前/.test(body2) && fs.readFileSync(path.join(jd, 'files', 'keep-me', 'a.txt'), 'utf8') === 'old-files' && !fs.existsSync(path.join(jd, 'import-journal.json')), body2)
    // M5 P2-C：提示由主进程只给一次——页面重载（Ctrl+R / 窗口重建）后不再弹，不用点「知道了」
    await ctx.page.reload()
    await waitFor(async () => (await T('dropzone').count()) > 0 || (await T('onboarding').count()) > 0, 15000)
    check('启动恢复', '提示只显示一次：页面重载后不再弹出（主进程取走即清）', !(await waitFor(async () => (await T('startup-notice-body').count()) > 0, 3000)) && (await ctx.page.evaluate(() => window.api.app.takeStartupNotice())) === null)
    await closeApp(); await open(J)
    check('启动恢复', '再次启动不再弹（恢复只做一次）', !(await waitFor(async () => (await T('startup-notice-body').count()) > 0, 3000)))
    await closeApp()
    // ③ M5 P2-C：journal 合规、files 还没被动过（备份里没有 files）→ 数据完整，如实说「还没有改动文件」，不能吓人说「可能对不上」
    fs.writeFileSync(path.join(jd, 'import-journal.json'), JSON.stringify({ id: 'e2e-j3', filesRel: 'files', backupFilesRel: 'backups/pre-import-20261026-000003-e2e3/files', startedAt: 'x' }))
    fs.mkdirSync(path.join(jd, 'files'), { recursive: true })
    await open(J)
    const shown3 = await waitFor(async () => (await T('startup-notice-body').count()) > 0, 15000)
    const body3 = shown3 ? await txt('startup-notice-body') : ''
    check('启动恢复', '导入崩溃时文件还没被改动：提示「还没有开始改动你的文件，数据完整」，不再说「可能对不上」，标题也不是「没有恢复成功」', shown3 && /还没有开始改动你的文件/.test(body3) && !/对不上|没有成功/.test(body3) && !/没有恢复成功/.test(await txt('startup-notice')) && !fs.existsSync(path.join(jd, 'import-journal.json')), body3)
    await T('startup-notice-ok').click()
  }
}

module.exports = { phaseDataDir, phaseSample, phaseOnboarding }
