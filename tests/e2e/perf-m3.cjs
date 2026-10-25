// M3 性能测试：约 500 份卷子 × 40 题（2 万道题、约 3 万条知识点标注）的库，记录各统计接口的耗时。目标：单个接口 < 300ms。
// 两种口径：① 直接在 Node 里对同一份库调统计函数（纯 SQL 聚合耗时）；② 真实 Electron 应用里从渲染端调 IPC（含序列化与往返）。
// 用法：npm run test:perf   （脚本需 --experimental-strip-types 才能直接加载 .ts；需在沙箱外运行 Electron）
const L = require('./lib.cjs')
const { DatabaseSync } = require('node:sqlite')
const { launch, withDb, path, fs, os } = L

const PAPERS = Number(process.env.PERF_PAPERS || 500)
const QS = Number(process.env.PERF_QUESTIONS || 40)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-perf-'))
const ud = path.join(work, 'userData')

// 可复现的伪随机
let seed = 20261025
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = a => a[Math.floor(rnd() * a.length)]

function seedDb() {
  const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
  db.exec('PRAGMA foreign_keys=ON')
  const kps = db.prepare('SELECT code, parent_code, level FROM kps').all()
  const hasKid = new Set(kps.map(k => k.parent_code).filter(Boolean))
  const leaves = kps.filter(k => !hasKid.has(k.code))
  const qtypes = db.prepare("SELECT code FROM qtypes WHERE code <> 'OTHER'").all().map(q => q.code)
  // 题目标注按「幂律」分布：少数知识点占大头，更接近真实卷子
  const weights = leaves.map((_, i) => 1 / (1 + i) ** 0.7)
  const wsum = weights.reduce((a, b) => a + b, 0)
  const pickLeaf = () => { let r = rnd() * wsum; for (let i = 0; i < leaves.length; i++) { r -= weights[i]; if (r <= 0) return leaves[i].code } return leaves.at(-1).code }
  const insP = db.prepare(`INSERT INTO papers (id, title, grade, semester, school_year_start, exam_type, textbook, region, file_name, file_hash, status, page_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`)
  const insQ = db.prepare(`INSERT INTO questions (id, paper_id, ord, no_label, no, section, qtype, stem, options, score, difficulty, error_prone, error_reason, page_idx, bbox_json, bbox_source, confidence, reviewed, flags_json)
    VALUES (?, ?, ?, ?, ?, '一', ?, ?, '[]', ?, ?, ?, ?, ?, ?, 'manual', 1, 1, '[]')`)
  const insK = db.prepare('INSERT INTO question_kps (question_id, kp_code, is_primary) VALUES (?, ?, ?)')
  let n = 0
  const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025]
  let qCount = 0, kCount = 0
  db.exec('BEGIN')
  for (let i = 0; i < PAPERS; i++) {
    const id = uid()
    const status = i % 25 === 0 ? 'reviewing' : 'done'
    insP.run(id, `性能卷${i}`, String(3 + (i % 4)), pick(['上', '下']), years[i % years.length], pick(['期中', '期末', '单元测试']), pick(['人教PEP', '外研版', '北师大版']), pick(['北京', '上海', '广州']), `p${i}.pdf`, `h${i}`, status, `2026-01-${String(1 + (i % 28)).padStart(2, '0')} 08:00:00`)
    for (let j = 0; j < QS; j++) {
      const qid = uid()
      const err = rnd() < 0.1
      insQ.run(qid, id, j + 1, String(j + 1), j + 1, pick(qtypes), `题干 ${i}-${j} Look at the picture and choose the right answer.`, rnd() < 0.05 ? null : 1 + Math.floor(rnd() * 5), 1 + Math.floor(rnd() * 5), err ? 1 : 0, err ? pick(['单复数', '时态', '拼写', '词序']) : '', 1 + (j % 2), JSON.stringify([0.1, 0.05 + (j % 20) * 0.04, 0.8, 0.04]))
      qCount++
      insK.run(qid, pickLeaf(), 1); kCount++
      if (rnd() < 0.35) { const s = pickLeaf(); try { insK.run(qid, s, 0); kCount++ } catch { /* 与主知识点相同 */ } }
    }
  }
  db.exec('COMMIT')
  // 给「2025 vs 之前 · 二级」这个同比范围放一条旧的 AI 缓存：让 ai.compareAnalysis 走「有缓存、要重算指纹」的慢路径（没有缓存时它很快）
  const scopeKey = require('node:crypto').createHash('sha256').update(JSON.stringify({ filter: {}, target: 2025, base: { lt: 2025 }, level: 2, align: true })).digest('hex')
  db.prepare(`INSERT INTO ai_analyses (scope_key, kind, cache_key, prompt_version, fingerprint, scope_json, markdown, refs_json, warnings_json, model, usage_json) VALUES (?, 'p2_yoy', 'x', 'v1.1', 'old', '{}', '## 旧的分析', '[]', '[]', 'mock', '{}')`).run(scopeKey)
  db.close()
  return { qCount, kCount, leaves: leaves.length }
}

const stat = xs => {
  const s = [...xs].sort((a, b) => a - b)
  return { cold: Math.round(xs[0] * 10) / 10, median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, max: Math.round(s.at(-1) * 10) / 10, runs: xs.length }
}

async function main() {
  // 先让应用建好 v6 库
  let r = await launch({ userDataDir: ud })
  await r.app.close()
  const t0 = Date.now()
  const info = seedDb()
  console.log(`造数据：${PAPERS} 份卷子 × ${QS} 题 = ${info.qCount} 题、${info.kCount} 条知识点标注（${info.leaves} 个叶子知识点），用时 ${Date.now() - t0} ms；库大小 ${Math.round(fs.statSync(path.join(ud, 'workbench-data', 'db.sqlite')).size / 1024 / 1024)} MB`)

  const S = await import('../../src/main/stats/core.ts')
  const db = new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'), { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000')
  const cases = [
    ['overview（全部）', f => S.overview(db, f), {}],
    ['overview（含待审核）', f => S.overview(db, f), { includeReviewing: true }],
    ['scopeNotes（范围说明）', f => S.scopeNotes(db, f), {}],
    ['distribution', f => S.distribution(db, f), {}],
    ['distribution（年级=4）', f => S.distribution(db, f), { grade: '4' }],
    ['matrix 一级行', f => S.matrix(db, f, 1), {}],
    ['matrix 二级行', f => S.matrix(db, f, 2), {}],
    ['hot 二级', f => S.hot(db, f, 2), {}],
    ['hot 三级', f => S.hot(db, f, 3), {}],
    ['compare 2025 vs 之前 一级', f => S.compare(db, f, 2025, { lt: 2025 }, 1), {}],
    ['compare 2025 vs 之前 二级', f => S.compare(db, f, 2025, { lt: 2025 }, 2), {}],
    ['compare 2025 vs 之前 三级', f => S.compare(db, f, 2025, { lt: 2025 }, 3), {}],
    ['compare 2025 vs 2024 二级', f => S.compare(db, f, 2025, { eq: 2024 }, 2), {}]
  ]
  const direct = {}
  for (const [name, fn, f] of cases) {
    const xs = []
    process.stdout.write(`  … ${name}\n`)
    for (let i = 0; i < Number(process.env.PERF_RUNS || 8); i++) { const t = performance.now(); fn(f); xs.push(performance.now() - t) }
    direct[name] = stat(xs)
  }
  db.close()
  console.log('\n① Node 里直接调统计函数（纯 SQL 聚合，单位 ms）')
  for (const [k, v] of Object.entries(direct)) console.log(`  ${k.padEnd(28)} 首次 ${String(v.cold).padStart(6)}  中位 ${String(v.median).padStart(6)}  最大 ${String(v.max).padStart(6)}`)

  if (process.env.PERF_SKIP_APP) { console.log('(跳过 Electron 部分)'); return }
  // ② 真实应用里经 IPC
  r = await launch({ userDataDir: ud })
  const { page } = r
  await page.evaluate(() => { location.hash = '#/overview' })
  await page.waitForSelector('[data-testid=card-papers]', { timeout: 30000 })   // 等页面自己的首批查询跑完，免得和下面的计时抢主进程
  await new Promise(r => setTimeout(r, 1500))
  const viaIpc = await page.evaluate(async () => {
    const stat = xs => { const s = [...xs].sort((a, b) => a - b); return { cold: Math.round(xs[0] * 10) / 10, median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, max: Math.round(s.at(-1) * 10) / 10, runs: xs.length } }
    const A = window.api.stats
    const cases = [
      ['stats.overview', () => A.overview({})],
      ['stats.overview（含待审核）', () => A.overview({ includeReviewing: true })],
      ['stats.distribution', () => A.distribution({})],
      ['stats.matrix 一级', () => A.matrix({}, 1)],
      ['stats.matrix 二级', () => A.matrix({}, 2)],
      ['stats.notes（范围说明）', () => A.notes({})],
      ['stats.hot 二级', () => A.hot({}, 2)],
      ['stats.hot 三级', () => A.hot({}, 3)],
      ['stats.compare 二级', () => A.compare({}, 2025, 'before', 2)],
      ['stats.compare 三级', () => A.compare({}, 2025, 'before', 3)],
      ['stats.questions（抽屉）', () => A.questions({}, { kind: 'year', year: 2025 }, 'GR', 30)],
      ['ai.compareAnalysis（缓存状态）：首次=要重新核对指纹，之后=修订号没变直接读', () => window.api.ai.compareAnalysis({ filter: {}, target: 2025, base: 'before', level: 2, align: true })]
    ]
    const out = {}
    for (const [name, fn] of cases) {
      const xs = []
      for (let i = 0; i < 8; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t) }
      out[name] = stat(xs)
    }
    return out
  })
  console.log('\n② 真实 Electron 里从渲染端调 IPC（含序列化与往返，单位 ms）')
  for (const [k, v] of Object.entries(viaIpc)) console.log(`  ${k.padEnd(40)} 首次 ${String(v.cold).padStart(6)}  中位 ${String(v.median).padStart(6)}  最大 ${String(v.max).padStart(6)}`)
  // 看板整页首次渲染到出数字
  const t1 = Date.now()
  await page.evaluate(() => { location.hash = '#/dashboard' })
  await page.waitForSelector('[data-testid=dist-papers]', { timeout: 30000 })
  const renderMs = Date.now() - t1
  console.log(`\n③ 打开看板「分布」页签到出现数字：${renderMs} ms（含渲染与 treemap/细目表）`)
  await r.app.close()

  const worst = Math.max(...Object.values(direct).map(v => v.max), ...Object.values(viaIpc).map(v => v.max))
  const worstMedian = Math.max(...Object.values(direct).map(v => v.median), ...Object.values(viaIpc).map(v => v.median))
  console.log(`\n全部接口最慢一次 ${worst} ms，各接口中位数的最大值 ${worstMedian} ms；目标 < 300 ms：${worst < 300 ? '达到' : '未全部达到（见上表）'}`)
  fs.writeFileSync(path.join(__dirname, 'last-perf-m3.json'), JSON.stringify({ papers: PAPERS, questionsPerPaper: QS, ...info, direct, viaIpc, dashboardRenderMs: renderMs, worstMs: worst, worstMedianMs: worstMedian, at: new Date().toISOString() }, null, 2))
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
