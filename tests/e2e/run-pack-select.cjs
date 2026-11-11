// 数据包「自己选带哪些」端到端：导出对话框里勾选（范围 / 内容 / 数量 / 真名提示）→ 导出 → 导入到另一个全新的数据目录核对。
//   · 默认：试卷、报告、课程大纲勾着，表格 / 文档 / Skill / 角色 / 对话没勾；包里没有 extras、没有代号对照表、没有用量和对话表
//   · 勾「数据页表格」：出现「只带代号，不带学员真名」提示；包里的表格没有真名 / 手机号 / 学号，没有 *.codes.json
//   · 只导某个学科：manifest.scope.subject 对得上，别的学科的卷子不在包里
//   · 导入到另一个数据目录（userData B）：摘要写明带了数据页表格；合并导入后表格在、里面是代号，没有对照表
// 用法：npm run test:e2e:pack-select   （沙箱外运行：Electron 被沙箱限制）
const M = require('./m4-lib.cjs')
const { SPEC, seed } = require('./fixtures-m3.cjs')
const { DatabaseSync } = require('node:sqlite')
const JSZip = require('jszip')
const { check, sleep, waitFor, withDb, fs, path, work, pageImg, ctx, T, txt, goto, api, stubSave, stubOpen, open, closeApp, L } = M

const gotoSettings = async () => { await goto('#/settings?admin=1&tab=data'); await T('data-pack').waitFor() }
const NAMES = []
for (const a of '赵钱孙李周') for (const b of '明华强伟芳娜敏静') NAMES.push(a + b + '宇')

async function exportVia(zipPath, steps) {
  await gotoSettings()
  await stubSave(zipPath)
  await T('pack-export').click()
  await T('export-confirm').waitFor()
  if (steps) await steps()
  await T('export-confirm').click()
  await waitFor(async () => (await T('pack-done').count()) > 0 || (await T('pack-error').count()) > 0, 90000)
  await sleep(300)
}
const manifestOf = async f => JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(f))).file('manifest.json').async('string'))

async function main() {
  const ud = path.join(work, 'userPS')
  const r0 = await open(ud)
  await r0.app.close()
  seed(ud, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(ud)

  // 造一个带姓名 / 手机号 / 学号的表格（走真实的导入）
  const csv = path.join(work, '成绩单.csv')
  fs.writeFileSync(csv, ['姓名,学号,手机号,评语,分数', ...NAMES.map((n, i) => `${n},${20230001 + i},${13900000000 + i},老师说${n}进步很大,${60 + i}`)].join('\n'))
  await stubOpen(csv)
  const picked = await api(() => window.api.datasets.pick())
  const imp = await api(p => window.api.datasets.import(p), picked)
  check('准备', '导入一个带姓名、手机号、学号的表格', imp.length === 1 && imp[0].ok === true, JSON.stringify(imp))
  const dsId = imp[0].id

  // ── 1. 默认导出 ──
  const z1 = path.join(work, 'default.ewb.zip')
  await exportVia(z1, async () => {
    await T('export-count-papers').waitFor()
    const st = async id => ({ checked: await T(id).isChecked(), disabled: await T(id).isDisabled() })
    const s = { papers: await st('export-papers'), reports: await st('export-reports'), course: await st('export-course'), datasets: await st('export-datasets'), documents: await st('export-documents'), assets: await st('export-assets'), chats: await st('export-chats') }
    check('对话框', '默认：试卷、报告（没有报告就灰着）、课程大纲不勾或灰；数据页表格、文档、Skill / 角色、对话都没勾', s.papers.checked && !s.datasets.checked && !s.documents.checked && !s.assets.checked && !s.chats.checked, JSON.stringify(s))
    check('对话框', '每项旁边显示数量：试卷数 = 种子数据的卷数；数据页表格 1 个', (await txt('export-count-papers')).includes(`${SPEC.length}`) && (await txt('export-count-datasets')).includes('1'), await txt('export-count-papers'))
    check('对话框', '没勾表格时不显示「只带代号」提示', (await T('export-datasets-hint').count()) === 0)
  })
  {
    const z = await JSZip.loadAsync(fs.readFileSync(z1))
    const names = Object.keys(z.files)
    const m = await manifestOf(z1)
    check('默认导出', '没有 extras/、没有代号对照表；manifest 写明没带表格；格式版本 1（旧版本软件也能导入）', !names.some(n => n.startsWith('extras/')) && !names.some(n => /codes/.test(n)) && m.contents?.datasets === false && m.formatVersion === 1, JSON.stringify(m.contents))
    fs.writeFileSync(path.join(work, 'default-db.sqlite'), await z.file('db.sqlite').async('nodebuffer'))
    const d = new DatabaseSync(path.join(work, 'default-db.sqlite'), { readOnly: true })
    const c = t => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    check('默认导出', '快照里没有用量记录、报告草稿、解析记录、助手对话', c('ai_usage') + c('ai_drafts') + c('parse_runs') + c('parse_batches') + c('agent_sessions') + c('agent_steps') === 0)
    d.close()
  }

  // ── 2. 勾选数据页表格 ──
  const z2 = path.join(work, 'with-dataset.ewb.zip')
  await exportVia(z2, async () => {
    await T('export-datasets').click()
    check('对话框', '勾了数据页表格：出现「只带代号，不带学员真名」提示', /只带代号，不带学员真名/.test(await txt('export-datasets-hint')))
    await T('export-documents').isDisabled().then(dis => check('对话框', '没有文档时「数据页文档」灰着', dis === true))
  })
  {
    const z = await JSZip.loadAsync(fs.readFileSync(z2))
    const names = Object.keys(z.files)
    const m = await manifestOf(z2)
    check('勾选表格', '包里有 extras/datasets，没有任何 codes.json；manifest 写 formatVersion 2、datasets = 1', names.includes('extras/datasets/catalog.json') && names.includes(`extras/datasets/${dsId}.sqlite`) && !names.some(n => /codes/.test(n)) && m.formatVersion === 2 && m.counts?.datasets === 1, JSON.stringify(m.counts))
    const buf = await z.file(`extras/datasets/${dsId}.sqlite`).async('nodebuffer')
    const cat = await z.file('extras/datasets/catalog.json').async('string')
    const leak = NAMES.find(n => buf.includes(Buffer.from(n)) || cat.includes(n))
    check('勾选表格', '表格数据和目录里没有任何真名、手机号、学号', !leak && !buf.includes(Buffer.from('13900000001')) && !buf.includes(Buffer.from('20230001')) && !cat.includes('13900000001') && !cat.includes('20230001'), leak ?? '')
  }

  // ── 3. 只导某个学科（数学：种子数据里没有数学卷） ──
  const z3 = path.join(work, 'math.ewb.zip')
  await exportVia(z3, async () => {
    await T('export-subject-math').click()
    await sleep(600)
    check('对话框', '选「只导数学」：数量跟着变（试卷 0），试卷项灰着', (await txt('export-count-papers')).includes('0') && (await T('export-papers').isDisabled()))
  })
  {
    const m = await manifestOf(z3)
    const z = await JSZip.loadAsync(fs.readFileSync(z3))
    check('按学科导出', 'manifest.scope.subject = math；包里没有任何卷子的文件', m.scope?.subject === 'math' && m.paperCount === 0 && !Object.keys(z.files).some(n => n.startsWith('files/') && !n.endsWith('/')), JSON.stringify(m.scope))
  }

  // ── 4. 导入到另一个全新的数据目录 ──
  await closeApp()
  const B = path.join(work, 'userPS-B')
  await open(B)
  await gotoSettings()
  await stubOpen(z2)
  await T('pack-import').click()
  await T('pack-summary').waitFor({ timeout: 60000 })
  check('导入', '摘要里写明数据包里带了 1 个数据页表格，并说明表格里只有代号', /1 个数据页表格/.test(await txt('pack-extras-note')) && /没有对应的真名/.test(await txt('pack-extras-note')), await txt('pack-extras-note').catch(() => ''))
  await T('pack-confirm').click()
  await waitFor(async () => (await T('pack-result-text').count()) > 0, 60000)
  check('导入', '合并导入完成，结果里写了数据页表格 1 个', /数据页表格 1 个/.test(await txt('pack-result-text')), await txt('pack-result-text'))
  await T('pack-result-ok').click()
  const bDir = path.join(B, 'workbench-data', 'datasets')
  const cat = JSON.parse(fs.readFileSync(path.join(bDir, 'catalog.json'), 'utf8'))
  check('导入', '新数据目录里有这个表格，没有代号对照表', cat.datasets.length === 1 && cat.datasets[0].id === dsId && fs.existsSync(path.join(bDir, `${dsId}.sqlite`)) && !fs.readdirSync(bDir).some(f => /codes/.test(f)), fs.readdirSync(bDir).join(','))
  const list = await api(() => window.api.datasets.list())
  check('导入', '界面里能看到这个表格', list.length === 1 && list[0].id === dsId)
  const prev = await api(async id => { const l = await window.api.datasets.list(); return window.api.datasets.preview(id, l[0].tables[0].name, 5) }, dsId)
  check('导入', '预览里姓名列是代号（没有真名）', NAMES.every(n => !JSON.stringify(prev).includes(n)) && /人员[A-Z]\d{3}/.test(JSON.stringify(prev)), JSON.stringify(prev).slice(0, 200))
  check('导入', '试卷也进来了', withDb(B, d => d.prepare('SELECT COUNT(*) c FROM papers').get().c) === SPEC.length)
  await closeApp()
}

main().then(() => {
  const failed = L.finish(path.join(__dirname, 'last-result-pack-select.json'))
  process.exit(failed ? 1 : 0)
}).catch(async e => {
  console.error(e)
  check('运行', '测试脚本异常退出', false, String(e && e.stack ? e.stack : e).slice(0, 400))
  try { const f = path.join(work, 'failure.png'); await ctx.page.screenshot({ path: f }); console.error('失败现场截图：', f) } catch { /* 忽略 */ }
  L.finish(path.join(__dirname, 'last-result-pack-select.json'))
  try { await closeApp() } catch { /* 忽略 */ }
  process.exit(1)
})
