// M4 E2E（二）：数据包导出 / 导入（往返、合并、覆盖回滚、恶意包）、更改数据目录、示例数据、首次启动引导、知识点树编辑。
const M = require('./m4-lib.cjs')
const naive = require('./naive.cjs')
const { SPEC } = require('./fixtures-m3.cjs')
const { check, sleep, waitFor, withDb, fs, path, work, SECRET, ctx, T, txt, stat, goto, shot, setFilter, api, stubSave, stubOpen, cfgFor, saveCfg, root, clean, open, closeApp, waitStat, dataDirOf, L, pathToFileURL, readDb } = M

const NP = SPEC.length
const NQ = SPEC.reduce((n, p) => n + p.q.length, 0)
const sha = f => require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex')
function treeHash(dir) {
  const out = {}
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const counts = () => withDb(ctx.ud, d => ({ papers: d.prepare('SELECT COUNT(*) c FROM papers').get().c, questions: d.prepare('SELECT COUNT(*) c FROM questions').get().c, pages: d.prepare('SELECT COUNT(*) c FROM pages').get().c, kps: d.prepare('SELECT COUNT(*) c FROM kps').get().c }))
const statSnap = () => api(async () => {
  const f = { grade: '4' }
  return JSON.stringify([await window.api.stats.overview({}), await window.api.stats.distribution({}), await window.api.stats.hot({}, 2), await window.api.stats.matrix({}, 1), await window.api.stats.compare(f, 2025, 'before', 2)])
})
/** 暂存目录真的是空的（或不存在）：导入成功 / 失败 / 被拒绝之后都不能留着解出来的文件 */
const stagingEmpty = () => { const d = path.join(dataDirOf(), '.import-staging'); return !fs.existsSync(d) || fs.readdirSync(d).length === 0 }
const gotoSettings = async () => { await goto('#/settings'); await T('data-pack').waitFor() }

// 把零件拼成一个"恶意"数据包（用单测里的手写 zip 构造器）
async function makeBad(name, entries) {
  const { makeZip } = await import(pathToFileURL(path.join(root, 'tests/unit/helpers/zip.mjs')).href)
  const f = path.join(work, `${name}.ewb.zip`)
  fs.writeFileSync(f, makeZip(entries))
  return f
}
const importUi = async (zip, { mode = 'merge', expect = 'summary' } = {}) => {
  // 上一个弹窗（比如导入结果）必须已经关掉，免得读到它残留的内容
  await waitFor(async () => (await ctx.page.locator('.ant-modal-wrap:visible').count()) === 0 && (await T('pack-result-text').count()) === 0, 8000)
  await stubOpen(zip)
  await T('pack-import').click()
  if (expect === 'error') return waitFor(async () => (await T('pack-error').count()) > 0, 30000)
  const ok = await waitFor(async () => (await T('pack-summary').count()) > 0, 60000)
  if (!ok) return false
  if (mode === 'overwrite') { await T('pack-mode-overwrite').click(); await T('pack-ack').click() }
  return true
}

// ───────── 阶段 3：数据包 往返 / 合并 / 覆盖回滚 / 恶意包 ─────────
async function phasePack() {
  const A = ctx.ud
  // 先在 A 里留一些"这台电脑专属"的东西：已配置的 AI（密钥）、自定义提示词、引导状态；报告已在上一阶段生成
  await api(() => window.api.settings.set('default_textbook', '人教PEP'))
  await gotoSettings()
  const aSnap = await statSnap()
  const aCounts = counts()
  const aFiles = treeHash(path.join(dataDirOf(), 'files'))
  const aKeyEnc = withDb(A, d => d.prepare("SELECT value_json FROM settings WHERE key = 'ai_key_enc'").get()?.value_json)
  const aReports = withDb(A, d => d.prepare("SELECT id FROM reports WHERE kind = 'report'").all().map(r => r.id))
  check('数据包 准备', `源库（A）：${NP} 份卷子、${NQ} 道题，有加密保存的 API 密钥、2 份 AI 报告、2 张有页面图的卷子`, aCounts.papers === NP && aCounts.questions === NQ && !!aKeyEnc && aReports.length === 2 && Object.keys(aFiles).length === 2, JSON.stringify(aCounts))

  // ── 导出（走界面）──
  const zip = path.join(work, '换电脑.ewb.zip')
  await stubSave(zip)
  await T('pack-export').click()
  const done = await waitFor(async () => (await T('pack-done').count()) > 0, 60000)
  check('数据包 导出', '设置页点「导出数据包」→ 提示已导出，文件存在，文件名以 .ewb.zip 结尾，提示里写明「不包含 API 密钥」', done && fs.existsSync(zip) && /\.ewb\.zip$/.test(zip) && new RegExp(`${NP} 份试卷、${NQ} 道题`).test(await txt('pack-done')) && /API 密钥/.test(await txt('data-pack')), done ? await txt('pack-done') : '')
  await shot('06-pack-export')
  // 复审 P1-A：导出时读文件失败（文件被占用 / 刚被删）→ 不崩主进程、不卡死；给出中文原因；不留 .part；之后导出 / 导入都照常
  {
    await ctx.app.evaluate(() => {
      globalThis.__uncaught = []
      globalThis.__uncaughtFn = e => globalThis.__uncaught.push(String(e))
      process.on('uncaughtException', globalThis.__uncaughtFn)
      const fs = process.getBuiltinModule('fs')
      globalThis.__realCreate = fs.createReadStream
      fs.createReadStream = (p, ...rest) => {
        if (String(p).endsWith('page-1.png')) {
          const { Readable } = process.getBuiltinModule('stream')
          const r = new Readable({ read() {} })
          setImmediate(() => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; r.destroy(e) })
          return r
        }
        return globalThis.__realCreate.call(fs, p, ...rest)
      }
    })
    const failZip = path.join(work, '会失败.ewb.zip')
    await stubSave(failZip)
    await T('pack-export').click()
    const failed = await waitFor(async () => (await T('pack-error').count()) > 0, 30000)
    const failTxt = failed ? await txt('pack-error') : ''
    const uncaught = await ctx.app.evaluate(() => globalThis.__uncaught)
    check('数据包 导出失败', '导出时读文件失败（被占用）：界面给出中文原因（占用 / 没有权限），按钮恢复可点；主进程没有未捕获异常；不留 .part，也没有半截数据包', failed && /占用|写入权限|导出失败/.test(failTxt) && uncaught.length === 0 && !fs.existsSync(failZip + '.part') && !fs.existsSync(failZip) && !(await T('pack-export').isDisabled()), failTxt + ' / uncaught=' + JSON.stringify(uncaught))
    await ctx.app.evaluate(() => { process.getBuiltinModule('fs').createReadStream = globalThis.__realCreate; process.off('uncaughtException', globalThis.__uncaughtFn) })
    // 失败之后锁没有残留：再导出一次成功，选这个包导入也能走到摘要（不会被「正在导出 / 正在…」挡住）
    const again = path.join(work, '失败后重导.ewb.zip')
    await stubSave(again)
    await T('pack-export').click()
    const doneAgain = await waitFor(async () => (await T('pack-done').count()) > 0, 60000)
    await stubOpen(again)
    const pk = await api(async () => { try { const r = await window.api.data.pickPack(); if (r.picked) await window.api.data.discardPack(r.token); return r.picked ? 'picked' : 'not' } catch (e) { return e.message } })
    const exp2 = await api(async () => { try { return (await window.api.data.exportPack()).saved === true } catch (e) { return e.message } })   // 对话框还指向 again.zip，已存在会被覆盖——正常
    check('数据包 导出失败', '失败之后同一个会话里：再导出成功（文件在、没有 .part）、选包导入走到摘要、API 再导出也成功——导出锁 / 操作锁都已释放', doneAgain && fs.existsSync(again) && !fs.existsSync(again + '.part') && pk === 'picked' && exp2 === true, `${pk} / ${exp2}`)
    await stubSave(zip)
  }
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(zip))
  const names = Object.keys(z.files).filter(n => !z.files[n].dir)
  const man = JSON.parse(await z.file('manifest.json').async('string'))
  const dbBytes = await z.file('db.sqlite').async('nodebuffer')
  check('数据包 内容', 'zip 里只有 manifest.json、db.sqlite 和 files/<uuid>/…；manifest 写明 schema v9、全部卷数和题数、导出时间、应用版本', names.every(n => n === 'manifest.json' || n === 'db.sqlite' || /^files\/[0-9a-f-]{36}\/(original\.\w+|page-\d+\.png|media\/\d+\.\w+)$/.test(n)) && man.format === 'ewb-pack' && man.schemaVersion === 9 && man.paperCount === NP && man.questionCount === NQ && /^\d{4}-\d{2}-\d{2}T/.test(man.exportedAt) && man.appVersion === '0.4.0', JSON.stringify(man))
  check('数据包 内容', '页面图在包里（C2、C5 两张卷子的 page-1.png）', names.filter(n => /page-1\.png$/.test(n)).length === 2)
  const keyPlain = Buffer.from(SECRET)
  const keyEnc = Buffer.from(JSON.parse(aKeyEnc))
  check('数据包 密钥', '密钥不进包：数据库快照里搜不到明文密钥、搜不到 safeStorage 的密文，也没有 ai_key_enc / ai_config 这些设置行；整个 zip 文件里也搜不到明文', !dbBytes.includes(keyPlain) && !dbBytes.includes(keyEnc) && !dbBytes.includes(Buffer.from('ai_key_enc')) && !dbBytes.includes(Buffer.from('"base_url"')) && !dbBytes.includes(Buffer.from(ctx.mock.baseUrl)) && !fs.readFileSync(zip).includes(keyPlain))

  // ── 换一个全新 userData：导入（合并，空库）──
  await closeApp()
  const B = path.join(work, 'userB')
  await open(B)
  await gotoSettings()
  const emptyKey = await api(() => window.api.ai.getConfig())
  check('数据包 导入', '全新电脑（userData B）：没有任何卷子，也没有 API 密钥', counts().papers === 0 && emptyKey.hasKey === false)
  check('数据包 导入', `选数据包后先给摘要：${NP} 份试卷 / ${NQ} 道题 / 本机现有 0 份 / ${NP} 份是新的；默认模式是「合并」`, await importUi(zip) && new RegExp(`${NP} 份试卷、${NQ} 道题`).test(await txt('pack-summary')) && /本机现有 0 份真实试卷/.test(await txt('pack-summary')) && new RegExp(`${NP} 份是新的`).test(await txt('pack-summary')) && (await T('pack-mode-merge').isChecked()), await txt('pack-summary').catch(() => ''))
  await T('pack-mode-overwrite').click()
  const needAck = await T('pack-confirm').isDisabled()
  await T('pack-ack').click()
  const afterAck = await T('pack-confirm').isDisabled()
  await shot('07-pack-import-modal')
  await T('pack-mode-merge').click()
  check('数据包 导入', '选「覆盖」时「开始导入」按钮是灰的，必须勾选"我知道了"才能点；切回合并不需要', needAck === true && afterAck === false)
  await T('pack-confirm').click()
  const imported = await waitFor(async () => (await T('pack-result-text').count()) > 0, 60000)
  check('数据包 导入', `导入完成：提示新增 ${NP} 份试卷、${NQ} 道题`, imported && new RegExp(`合并导入完成：新增 ${NP} 份试卷、${NQ} 道题`).test(await txt('pack-result-text')), imported ? await txt('pack-result-text') : '')
  await shot('08-pack-import-result')
  await T('pack-result-ok').click()
  const bCounts = counts()
  check('数据包 往返', '导入后卷数 / 题数 / 页数 / 知识点数与源库完全一致', JSON.stringify(bCounts) === JSON.stringify(aCounts), JSON.stringify(bCounts))
  check('数据包 往返', '所有统计接口（总览、分布、重难点、细目表、同比）的返回值与源库逐字一致——看板数字一致', (await statSnap()) === aSnap)
  await goto('#/overview')
  check('数据包 往返', '总览页数字与源库一致：18 份、58 题、16 个知识点、待审核 2', await waitStat('card-papers', 18) && (await stat('card-questions')) === '58' && (await stat('card-kps')) === '16' && (await stat('card-pending')) === '2')
  const bFiles = treeHash(path.join(dataDirOf(), 'files'))
  check('数据包 往返', '文件逐个哈希一致（页面图 / 原件目录）：截图一致', JSON.stringify(bFiles) === JSON.stringify(aFiles) && Object.keys(bFiles).length === 2)
  // 页面图真的能显示，裁出来的题目截图内容对（真实 OCR）
  const cropOut = path.join(work, 'b-crop.png')
  await L.cropPage(ctx.app, path.join(dataDirOf(), 'files', ctx.ids.C2, 'page-1.png'), ctx.bbox, cropOut)
  const ocrTxt = L.ocrText(cropOut)
  check('数据包 往返', '导入后用 C2 第 1 题的定位框从导入的页面图裁出截图，真实 OCR 读出 skirt、不含相邻题', /skirt/i.test(ocrTxt) && !/sheep|library/i.test(ocrTxt), ocrTxt.slice(0, 60))
  const stB = withDb(ctx.ud, d => Object.fromEntries(d.prepare('SELECT file_name, status, error FROM papers').all().map(p => [p.file_name, p])))
  check('数据包 往返', 'I1「刚导入」的卷子（源库重启时已被标成失败：上次提取被中断）导入后仍是失败并提示重试，不会假装在队列里；已确认 / 待审核 / 失败的状态原样保留', stB['I1.pdf'].status === 'failed' && /重试/.test(stB['I1.pdf'].error) && stB['C1.pdf'].status === 'done' && stB['R1.pdf'].status === 'reviewing' && stB['F1.pdf'].status === 'failed', JSON.stringify(Object.fromEntries(['I1.pdf', 'C1.pdf', 'R1.pdf', 'F1.pdf'].map(k => [k, stB[k]?.status]))))
  check('数据包 往返', 'API 密钥没有跟过来（B 的 hasKey = 否），自定义提示词 / 默认教材这类设置跟过来了', (await api(() => window.api.ai.getConfig())).hasKey === false && (await api(() => window.api.settings.get('default_textbook'))) === '人教PEP')
  // 报告随包走，而且导入后仍然是"最新"（过期按实际文本判断，与机器无关）
  const bReports = await api(() => window.api.report.list())
  check('数据包 往返', '两份 AI 报告随包导入；因为数据和提示词没变，导入后仍标「最新」（不会因为换了电脑就全部过期）', bReports.length === 2 && bReports.every(r => r.status === 'fresh') && JSON.stringify(bReports.map(r => r.id).sort()) === JSON.stringify(aReports.slice().sort()), JSON.stringify(bReports.map(r => r.status)))
  check('数据包 往返', '导入没有留下临时文件：暂存目录已清掉，没有 journal，覆盖备份目录不存在（合并不备份）', !fs.existsSync(path.join(dataDirOf(), '.import-staging', 'x')) && !fs.existsSync(path.join(dataDirOf(), 'import-journal.json')) && !fs.existsSync(path.join(dataDirOf(), 'backups')))

  // ── 合并：再导入同一个包 → 不产生重复；删掉两份后合并 → 只补回这两份 ──
  await gotoSettings()
  await importUi(zip)
  const sumTxt = await txt('pack-summary')
  check('数据包 合并', `再次导入同一个包：摘要写明 ${NP} 份本机已经有了、0 份是新的`, new RegExp(`${NP} 份本机已经有了.*0 份是新的`).test(sumTxt), sumTxt)
  await T('pack-confirm').click()
  await waitFor(async () => (await T('pack-result-text').count()) > 0, 60000)
  const again = await txt('pack-result-text')
  await T('pack-result-ok').click()
  check('数据包 合并', `合并导入不产生重复：新增 0 份、跳过 ${NP} 份，库里仍是 ${NP} 份 / ${NQ} 题，看板数字不变`, new RegExp(`新增 0 份试卷、0 道题；跳过 ${NP} 份已存在的`).test(again) && JSON.stringify(counts()) === JSON.stringify(aCounts) && (await statSnap()) === aSnap, again)
  const gone = [ctx.ids.A1, ctx.ids.C3]
  for (const id of gone) await api(i => window.api.papers.remove(i), id)
  check('数据包 合并', `在 B 里删掉 2 份卷子（A1、C3），库里剩 ${NP - 2} 份`, counts().papers === NP - 2)
  await gotoSettings()
  await importUi(zip)
  await T('pack-confirm').click()
  await waitFor(async () => (await T('pack-result-text').count()) > 0, 60000)
  const part = await txt('pack-result-text')
  await T('pack-result-ok').click()
  check('数据包 合并', `再合并一次同一个包：只补回被删的 2 份（新增 2 份、跳过 ${NP - 2} 份），仍然没有重复；补回的卷子带着文件`, /新增 2 份试卷/.test(part) && new RegExp(`跳过 ${NP - 2} 份已存在的`).test(part) && counts().papers === NP && (await statSnap()) === aSnap && withDb(ctx.ud, d => d.prepare('SELECT COUNT(*) c FROM papers WHERE id IN (?, ?)').get(...gone).c) === 2, part)

  // B 先配好自己的 AI（地址 + 密钥）：后面覆盖导入之后它必须原样还在（本机的 AI 设置不能被包覆盖或清掉）
  await saveCfg(cfgFor(ctx.mock, { model: 'b-local-model' }), SECRET)
  const bCfg = await api(() => window.api.ai.getConfig())
  check('数据包 覆盖准备', 'B 先配好了自己的 AI（有密钥、模型 b-local-model）', bCfg.hasKey === true && bCfg.model === 'b-local-model')

  // ── 覆盖：失败时回滚（故障注入：换完目录、提交之前出错）──
  await api(i => window.api.papers.remove(i), ctx.ids.B1)
  await api(i => window.api.papers.remove(i), ctx.ids.C5)          // C5 有页面图文件
  await api(() => window.api.settings.set('ui_theme', 'dark-before'))
  const before = { counts: counts(), files: treeHash(path.join(dataDirOf(), 'files')), stats: await statSnap(), rows: withDb(ctx.ud, d => d.prepare('SELECT id, title, status FROM papers ORDER BY id').all()), rev: withDb(ctx.ud, d => d.prepare('SELECT rev FROM data_rev').get().rev) }
  check('数据包 覆盖准备', `B 里现在和包不一样：只有 ${NP - 2} 份（B1、C5 被删，C5 的页面图目录也没了）`, before.counts.papers === NP - 2 && Object.keys(before.files).length === 1)
  await ctx.app.evaluate(() => { process.env.EWB_TEST_FAULT = 'after-swap' })
  await gotoSettings()
  await importUi(zip, { mode: 'overwrite' })
  await T('pack-confirm').click()
  const failed = await waitFor(async () => (await T('pack-error').count()) > 0, 60000)
  const errTxt = failed ? await txt('pack-error') : ''
  const after = { counts: counts(), files: treeHash(path.join(dataDirOf(), 'files')), stats: await statSnap(), rows: withDb(ctx.ud, d => d.prepare('SELECT id, title, status FROM papers ORDER BY id').all()), rev: withDb(ctx.ud, d => d.prepare('SELECT rev FROM data_rev').get().rev) }
  check('数据包 覆盖回滚', '覆盖导入在"换完 files 目录、还没提交"时失败：提示「已全部撤销，现有数据没有变化」', failed && /已全部撤销/.test(errTxt), errTxt)
  check('数据包 覆盖回滚', '回滚后库里的卷子 / 题 / 页 / 知识点、所有统计、数据修订号、files 目录里每个文件的哈希，和导入前完全一样', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after.counts))
  check('数据包 覆盖回滚', '没有遗留：journal 已清、没有多出的备份目录、没有 files.rejected-* 残留、暂存目录已清', !fs.existsSync(path.join(dataDirOf(), 'import-journal.json')) && !fs.existsSync(path.join(dataDirOf(), 'backups')) && !fs.readdirSync(dataDirOf()).some(n => n.startsWith('files.rejected')) && stagingEmpty(), fs.readdirSync(dataDirOf()).join(','))
  await goto('#/overview')
  await T('card-papers').waitFor({ timeout: 15000 })
  check('数据包 覆盖回滚', '失败后应用照常可用：总览页数字 = 回滚前的统计，界面没有卡在导入中', (await stat('card-papers')) === String(JSON.parse(before.stats)[0].cards.papers), await stat('card-papers'))
  // 去掉故障，同一个包重新覆盖导入 → 成功，备份出现
  await ctx.app.evaluate(() => { delete process.env.EWB_TEST_FAULT })
  await gotoSettings()
  await importUi(zip, { mode: 'overwrite' })
  await T('pack-confirm').click()
  const okOver = await waitFor(async () => (await T('pack-result-text').count()) > 0, 60000)
  const overTxt = okOver ? await txt('pack-result') : ''
  await shot('09-pack-overwrite-result')
  await T('pack-result-ok').click()
  const backups = fs.existsSync(path.join(dataDirOf(), 'backups')) ? fs.readdirSync(path.join(dataDirOf(), 'backups')) : []
  const bk = backups[0] ? path.join(dataDirOf(), 'backups', backups[0]) : null
  const bkRows = bk ? (() => { const d = readDb(bk); try { return d.prepare('SELECT COUNT(*) c FROM papers').get().c } finally { d.close() } })() : -1
  check('数据包 覆盖', `覆盖导入成功：库回到包里的 ${NP} 份 / ${NQ} 题、看板数字与源库一致、文件哈希与源库一致；提示里写明备份位置`, okOver && JSON.stringify(counts()) === JSON.stringify(aCounts) && (await statSnap()) === aSnap && JSON.stringify(treeHash(path.join(dataDirOf(), 'files'))) === JSON.stringify(aFiles) && /已备份到/.test(overTxt), overTxt.slice(0, 120))
  check('数据包 覆盖', `覆盖前自动备份：backups/pre-import-… 里有导入前的库（${NP - 2} 份）和导入前的 files 目录（只有 C2 的一个文件夹）`, backups.length === 1 && bkRows === NP - 2 && Object.keys(treeHash(path.join(bk, 'files'))).length === 1, `${backups.join(',')} 备份库 ${bkRows} 份`)
  const cfgAfter = await api(() => window.api.ai.getConfig())
  check('数据包 覆盖', '本机的 AI 设置不被覆盖：B 覆盖导入前配好的 AI（密钥、地址、模型 b-local-model）覆盖后原样还在，包里没有的机器专属设置没被清掉', cfgAfter.hasKey === true && cfgAfter.model === 'b-local-model' && cfgAfter.base_url === bCfg.base_url, JSON.stringify([cfgAfter.hasKey, cfgAfter.model]))
  await gotoSettings()
  check('数据包 备份', '设置页列出这份覆盖前备份（可打开 / 删除），并显示备份所在的完整路径', await waitFor(async () => (await T('backup-list').count()) > 0, 8000) && (await T('backup-list').innerText()).includes(path.join(dataDirOf(), 'backups', backups[0])), backups[0])

  // ── 恶意 / 不兼容的包：都拒绝，且没有写出任何文件、库没变 ──
  const base = JSON.stringify({ format: 'ewb-pack', formatVersion: 1, schemaVersion: 9, appVersion: '0.4.0', exportedAt: '2026-10-26T00:00:00Z', paperCount: 1, questionCount: 1 })
  const dbOk = z0 => z0
  const goodDb = dbBytes
  const snapBefore = JSON.stringify([counts(), await statSnap()])
  const bads = [
    ['路径穿越', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: goodDb }, { name: '../../evil.txt', data: 'x' }], /不允许的文件(名|路径)/],
    ['绝对路径', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: goodDb }, { name: '/tmp/evil.txt', data: 'x' }], /不允许的文件(名|路径)/],
    ['符号链接', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: goodDb }, { name: `files/${ctx.ids.C2}/page-1.png`, data: '/etc/passwd', mode: 0o120777 }], /符号链接/],
    ['未知文件名', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: goodDb }, { name: 'payload.exe', data: 'MZ' }], /不允许的文件(名|路径)/],
    ['manifest 版本过新', [{ name: 'manifest.json', data: JSON.stringify({ ...JSON.parse(base), schemaVersion: 99 }) }, { name: 'db.sqlite', data: goodDb }], /更新版本的软件/],
    ['数据库版本过新', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: (() => { const b = Buffer.from(goodDb); b.writeUInt32BE(99, 60); return b })() }], /更新版本的软件（数据库版本 v99/],
    ['损坏的数据库', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: Buffer.from(goodDb).subarray(0, 6000) }], /损坏|打不开|无法读取|完整性/],
    ['不是数据库', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: 'hello, I am not a database '.repeat(300) }], /损坏|打不开|无法读取|完整性|不是本软件/],
    ['缺 manifest', [{ name: 'db.sqlite', data: goodDb }], /manifest/],
    ['超大文件', [{ name: 'manifest.json', data: base }, { name: 'db.sqlite', data: goodDb, method: 8 }, { name: `files/${ctx.ids.C2}/page-1.png`, data: Buffer.alloc(260 * 1024 * 1024), method: 8 }], /太大/]
  ]
  for (const [name, entries, re] of bads) {
    const f = await makeBad(name, entries)
    await gotoSettings()
    await stubOpen(f)
    await T('pack-import').click()
    const e = await waitFor(async () => (await T('pack-error').count()) > 0, 90000)
    const msg = e ? await txt('pack-error') : ''
    check('数据包 恶意输入', `${name}：被拒绝，给出中文原因`, e && re.test(msg), msg)
    if (e) await T('pack-error').locator('.ant-alert-close-icon').click().catch(() => {})
    await sleep(150)
  }
  check('数据包 恶意输入', '所有恶意 / 不兼容的包被拒绝后：库、统计不变；没有在数据目录之外多出 evil.txt 这类文件；暂存目录已清空', JSON.stringify([counts(), await statSnap()]) === snapBefore && !fs.existsSync(path.join(path.dirname(dataDirOf()), 'evil.txt')) && !fs.existsSync(path.join(path.dirname(path.dirname(dataDirOf())), 'evil.txt')) && !fs.existsSync('/tmp/evil.txt') && stagingEmpty())
  // 渲染端拿不到别的路径：pickPack 只走对话框，传一个路径参数不会被当成数据包
  const hijack = await api(async () => { try { return await window.api.data.importPack('11111111-1111-4111-8111-111111111111', 'overwrite') } catch (e) { return String(e.message) } })
  check('数据包 恶意输入', '页面脚本直接调用 importPack 带一个伪造的 token：被拒绝（没有对应的已解包数据包），什么都不会写', /已经失效/.test(hijack), hijack)
}

module.exports = { phasePack, counts, statSnap, treeHash, gotoSettings }
