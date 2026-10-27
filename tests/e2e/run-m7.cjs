// M7 端到端：命令行接口（`<程序> cli <命令>`）。全程 mock AI。
//   · 每个命令、每个退出码、stdout 只有一行 JSON、进度写 stderr、--out / --result-file / JUANZHI_RESULT_FILE
//   · 没配 AI 时报错、不能设置 / 读取密钥、不能改数据目录
//   · 窗口占用 / 命令行占用时的互斥（窗口在运行 → 命令行退出码 3；命令行在运行 → 窗口打不开；陈旧锁清掉）
//   · 导入 → 等解析 → 确认 → 统计 → 四种报告 → 导出 md / docx / pdf；家长版没点「我已核对」时导出的文件有草稿标记
//   · 设置页「安装命令行工具」（Mac：写 ~/.local/bin/juanzhi，用临时 HOME）
// 用法：node tests/e2e/run-m7.cjs   （沙箱外运行：Electron、本地端口、Vision OCR）
const M = require('./m4-lib.cjs')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { check, sleep, waitFor, withDb, fs, path, os, work, SECRET, ctx, cfgFor, saveCfg, root, startMock, open, closeApp, pdfInfo, L } = M
const mammoth = require(path.join(root, 'node_modules/mammoth'))
const electronBin = require('electron')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const cleanEnv = extra => { const e = { ...process.env, ...extra }; for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete e[k]; return e }
const allOutput = []

/** 跑一条命令行命令：返回 { code, out, err, json, lines, ms }。ud = 数据（userData）目录 */
function runCli(ud, args, { env = {}, timeout = 240000 } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now()
    const p = spawn(electronBin, [root, 'cli', ...args], { env: cleanEnv({ EWB_USER_DATA_DIR: ud, ...env }), cwd: root })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout)
    p.on('exit', code => {
      clearTimeout(timer)
      allOutput.push(out, err)
      const lines = out.split('\n').filter(l => l.trim())
      let json = null
      try { json = JSON.parse(lines[lines.length - 1] ?? '') } catch { /* 不是 JSON：下面的检查会报 */ }
      resolve({ code, out, err, json, lines, ms: Date.now() - t0 })
    })
  })
}
const okOne = r => r.lines.length === 1 && r.json && typeof r.json.ok === 'boolean' && r.out.endsWith('\n')
const failed = (r, code, exit) => r.code === exit && r.json && r.json.ok === false && r.json.code === code && r.json.exit === exit && typeof r.json.message === 'string' && /[一-龥]/.test(r.json.message)
const brief = r => JSON.stringify({ code: r.code, json: r.json ? { ok: r.json.ok, code: r.json.code, message: r.json.message } : r.out.slice(0, 200), err: r.err.slice(-200) })

/** 准备一个数据目录：用图形界面把 AI 配到 mock 上（命令行不能设置密钥），然后关掉窗口 */
async function prepareDir(name, mock) {
  const ud = path.join(work, name)
  await open(ud)
  await saveCfg(cfgFor(mock), SECRET)
  await closeApp()
  return ud
}
const dbOf = ud => new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'))
const withWriteDb = (ud, fn) => { const d = dbOf(ud); try { return fn(d) } finally { d.close() } }
const txtOfDocx = async f => (await mammoth.extractRawText({ path: f })).value
const squash = s => s.normalize('NFKC').replace(/⻓/g, '长').replace(/\s+/g, '')   // 兼容字形（PDF 里的 ⽼ ⻓）和全 / 半角标点统一后再比
const BANNER = 'AI 草稿 · 未经老师核对，请勿直接发给家长'

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock

  // ───────────────────────── 阶段 1：没配 AI 的全新数据目录 ─────────────────────────
  const udFresh = path.join(work, 'fresh')
  {
    const s = await runCli(udFresh, ['status'], { env: { EWB_CLI_DEBUG: '1' } })
    check('M7 status', 'status：退出码 0，stdout 只有一行 JSON（{ok:true,data}），版本号、数据目录、卷子数、AI 是否已配置、OCR 是否可用都在', s.code === 0 && okOne(s) && s.json.ok === true
      && s.json.data.version === pkg.version && s.json.data.dataDir.startsWith(udFresh) && s.json.data.papers.total === 0 && s.json.data.ai.configured === false && typeof s.json.data.ocr.available === 'boolean', brief(s))
    check('M7 stderr', '进度和日志写 stderr（有 [juanzhi] 或 [db] 日志），stdout 里没有任何日志', s.err.length > 0 && !/\[db\]/.test(s.out), s.err.slice(0, 120))
    check('M7 无窗口', '命令行运行期间没有任何可见窗口，Mac 上没有 Dock 图标', /visibleWindows=0/.test(s.err) && (process.platform !== 'darwin' || /dock=false/.test(s.err)), s.err.split('\n').filter(l => /debug/.test(l)).join(' '))
    const h = await runCli(udFresh, [])
    check('M7 帮助', '不带命令：返回命令清单和退出码表（ok:true），不需要数据库', h.code === 0 && okOne(h) && h.json.data.commands.length >= 11 && h.json.data.exitCodes.usage === 2, brief(h))

    const u1 = await runCli(udFresh, ['bogus'])
    check('M7 退出码 2', '未知命令：退出码 2、code=usage，message 是中文', failed(u1, 'usage', 2) && okOne(u1), brief(u1))
    const u2 = await runCli(udFresh, ['papers', 'show'])
    check('M7 退出码 2', '缺参数 / 非法 id / 非法筛选值 / 未知参数：都是退出码 2', failed(u2, 'usage', 2)
      && failed(await runCli(udFresh, ['papers', 'show', 'abc']), 'usage', 2) && failed(await runCli(udFresh, ['papers', 'list', '--grade', '9']), 'usage', 2) && failed(await runCli(udFresh, ['status', '--bogus']), 'usage', 2), brief(u2))
    // 安全：不能设置 / 读取密钥，不能改数据目录
    const k1 = await runCli(udFresh, ['config', 'set-key', 'sk-xxx'])
    const k2 = await runCli(udFresh, ['status', '--data-dir', '/tmp/elsewhere'])
    const k3 = await runCli(udFresh, ['status', '--api-key', 'sk-xxx'])
    check('M7 安全', '没有设置 / 读取 API Key 的命令，也没有改数据目录的参数（config、--data-dir、--api-key 都是退出码 2）', failed(k1, 'usage', 2) && failed(k2, 'usage', 2) && failed(k3, 'usage', 2), brief(k1) + brief(k2))
    const pdf = path.join(root, 'samples/g4-2025.pdf')
    const n1 = await runCli(udFresh, ['import', pdf])
    check('M7 退出码 5', '没配 AI：import 报 ai_not_configured（退出码 5），提示到「设置 → AI 服务」里填写，命令行不能设置密钥；没有导入任何东西', failed(n1, 'ai_not_configured', 5) && /设置 → 管理员设置 → AI 服务|设置 → AI 服务/.test(n1.json.message) && /不能设置/.test(n1.json.message)
      && withWriteDb(udFresh, d => d.prepare('SELECT COUNT(*) c FROM papers').get().c) === 0, brief(n1))
    const n2 = await runCli(udFresh, ['report', 'generate', '--reader', 'boss'])
    check('M7 退出码 5', '没配 AI：report generate 同样报 ai_not_configured', failed(n2, 'ai_not_configured', 5), brief(n2))
    const c1 = await runCli(udFresh, ['papers', 'confirm', '3f2a4b5c-1111-4222-8333-444455556666'])
    check('M7 退出码 8', 'papers confirm 没带 --i-reviewed：退出码 8、confirmation_required，message 说明风险并让用户在界面里审核', failed(c1, 'confirmation_required', 8) && /界面里/.test(c1.json.message) && /--i-reviewed/.test(c1.json.message), brief(c1))
    check('M7 退出码 6', 'papers show / papers confirm 用了不存在的 id：退出码 6、not_found', failed(await runCli(udFresh, ['papers', 'show', '3f2a4b5c-1111-4222-8333-444455556666']), 'not_found', 6)
      && failed(await runCli(udFresh, ['papers', 'confirm', '3f2a4b5c-1111-4222-8333-444455556666', '--i-reviewed']), 'not_found', 6) && failed(await runCli(udFresh, ['report', 'show', '3f2a4b5c-1111-4222-8333-444455556666']), 'not_found', 6))
    // 退出码 13：之前设置的数据目录找不到（比如移动硬盘没插）：图形界面会弹窗，命令行只能报错
    const udMissing = path.join(work, 'missing-dir'); fs.mkdirSync(udMissing, { recursive: true })
    fs.writeFileSync(path.join(udMissing, 'ewb-config.json'), JSON.stringify({ dataDir: path.join(work, '不存在的移动硬盘', 'workbench-data') }))
    const dm = await runCli(udMissing, ['status'])
    check('M7 退出码 13', '数据目录找不到：退出码 13、data_unavailable，没有弹对话框也没有悄悄建一个空库', failed(dm, 'data_unavailable', 13) && /找不到之前设置的数据目录/.test(dm.json.message) && !fs.existsSync(path.join(work, '不存在的移动硬盘')), brief(dm))
    const rf = path.join(work, 'status-result.json'), of = path.join(work, 'status-out.json')
    const s2 = await runCli(udFresh, ['status', '--result-file', rf, '--out', of], { env: { JUANZHI_RESULT_FILE: path.join(work, 'status-env.json') } })
    check('M7 --out', '--out / --result-file / 环境变量 JUANZHI_RESULT_FILE：把同一段 JSON 同时写进文件（和 stdout 一致）', [rf, of, path.join(work, 'status-env.json')].every(f => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === s2.out.trim()), brief(s2))
    const e1 = await runCli(udFresh, ['report', 'list'])
    check('M7 report list', '空库：report list 返回空列表', e1.code === 0 && e1.json.data.reports.length === 0)
  }

  // ───────────────────────── 阶段 2：配好 AI 的数据目录（只有一份卷子也可以跑完整流程） ─────────────────────────
  const udA = await prepareDir('A', mock)
  const udEmptyAi = await prepareDir('emptyAi', mock)
  const pdfA = path.join(root, 'samples/g4-2025.pdf')
  let pA = null, pF = null
  {
    const s = await runCli(udA, ['status'])
    check('M7 status', '配好 AI 之后：ai.configured = true，只告诉有没有配（输出里没有密钥、没有服务地址）', s.json.data.ai.configured === true && !allOutput.join('').includes(SECRET) && !JSON.stringify(s.json).includes('127.0.0.1'), brief(s))
    const bad = await runCli(udA, ['import', path.join(work, '不存在.pdf')])
    check('M7 退出码 9', '导入不存在的文件：退出码 9、import_failed，data.papers 里有每份的结果', failed(bad, 'import_failed', 9) && bad.json.data.papers[0].status === 'rejected', brief(bad))
    const imp = await runCli(udA, ['import', pdfA, '--wait', '--timeout', '600'])
    pA = imp.json?.data?.papers?.[0]?.paperId
    check('M7 import', 'import <pdf> --wait：提取 + AI 解析（mock），等到「待审核」才返回，每份有 paperId / status / 题数；提示「AI 解析结果未经人工审核」', imp.code === 0 && okOne(imp) && imp.json.data.papers[0].status === 'reviewing' && imp.json.data.papers[0].questions >= 3 && imp.json.data.summary.reviewing === 1 && /人工审核|审核/.test(imp.json.data.note), brief(imp) + ' ' + imp.ms + 'ms')
    check('M7 stderr 进度', 'import 的进度写在 stderr（[juanzhi] 导入 / 状态）', /\[juanzhi\]/.test(imp.err), imp.err.slice(-200))
    const dup = await runCli(udA, ['import', pdfA])
    check('M7 重复导入', '导入内容相同的文件：不重复导入，status = duplicate，summary.duplicates = 1', dup.code === 0 && dup.json.data.papers[0].status === 'duplicate' && dup.json.data.summary.duplicates === 1 && withWriteDb(udA, d => d.prepare('SELECT COUNT(*) c FROM papers').get().c) === 1, brief(dup))
    const slow = L.copyWithTag(path.join(root, 'samples/g4-2026.pdf'), path.join(work, 'g4-2026-slow.pdf'), 'slow')
    mock.delayMs = 8000   // AI 解析要等 8 秒：--timeout 2 一定先到
    const to = await runCli(udA, ['import', slow, '--wait', '--timeout', '2'])
    mock.delayMs = 0
    check('M7 退出码 10', '--timeout 到了还没处理完：退出码 10、timeout，data 里带当前每份的状态', failed(to, 'timeout', 10) && Array.isArray(to.json.data?.papers), brief(to))
    const lst = await runCli(udA, ['papers', 'list'])
    pF = (lst.json.data.papers.find(p => p.fileName === 'g4-2026-slow.pdf') || {}).id
    check('M7 papers list', 'papers list：列出试卷（id / 标题 / 状态 / 题数）；上一次被中断的导入在下一次命令行启动时退回（已提取 / failed），不会一直卡在「处理中」',
      lst.code === 0 && lst.json.data.papers.some(p => p.id === pA && p.status === 'reviewing' && p.questions >= 3) && !!pF && ['extracted', 'failed'].includes(lst.json.data.papers.find(p => p.id === pF).status), JSON.stringify(lst.json.data.papers.map(p => [p.fileName, p.status])))
    const lst2 = await runCli(udA, ['papers', 'list', '--status', 'reviewing'])
    check('M7 papers list 筛选', 'papers list --status reviewing 只给待审核的', lst2.json.data.papers.length === 1 && lst2.json.data.papers[0].id === pA)
    const show = await runCli(udA, ['papers', 'show', pA])
    const CODE_RE = /^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]*)+$/
    check('M7 papers show', 'papers show：题目（题型、分值、知识点、难度、是否已确认），知识点名称里没有内部代码，待审核时写明「还没有经过人工审核」', show.code === 0 && show.json.data.questions.length >= 3
      && show.json.data.questions.every(q => q.kpMainName === null || !CODE_RE.test(q.kpMainName)) && /还没有经过人工审核/.test(show.json.data.reviewState), brief(show))
    // 未确认的卷子：统计默认不计入
    const ov0 = await runCli(udA, ['stats', 'overview'])
    const ov1 = await runCli(udA, ['stats', 'overview', '--include-reviewing'])
    check('M7 stats 待审核', 'stats overview：待审核的卷子默认不计入；加 --include-reviewing 才计入（和界面一致）', ov0.code === 0 && ov1.code === 0 && ov0.json.data.cards.papers === 0 && ov1.json.data.cards.papers >= 1 && ov0.json.data.pendingReviewing >= 1, JSON.stringify([ov0.json.data.cards, ov1.json.data.cards]))
    // 确认
    const cNo = await runCli(udA, ['papers', 'confirm', pA])
    check('M7 papers confirm 守卫', '没带 --i-reviewed：退出码 8，这份卷子仍是待审核', failed(cNo, 'confirmation_required', 8) && withWriteDb(udA, d => d.prepare('SELECT status FROM papers WHERE id = ?').get(pA).status) === 'reviewing', brief(cNo))
    const cBad = await runCli(udA, ['papers', 'confirm', pF, '--i-reviewed'])
    check('M7 退出码 7', '确认一份还没解析完成（已提取 / failed）的卷子：退出码 7、invalid_state', failed(cBad, 'invalid_state', 7), brief(cBad))
    const cOk = await runCli(udA, ['papers', 'confirm', pA, '--i-reviewed'])
    const stAfter = withWriteDb(udA, d => ({ s: d.prepare('SELECT status FROM papers WHERE id = ?').get(pA).status, un: d.prepare('SELECT COUNT(*) c FROM questions WHERE paper_id = ? AND reviewed = 0').get(pA).c }))
    check('M7 papers confirm', '带 --i-reviewed：整份确认（status = done，所有题已确认），返回里再提醒一次「跳过了人工审核」', cOk.code === 0 && cOk.json.data.status === 'done' && stAfter.s === 'done' && stAfter.un === 0 && /跳过人工审核/.test(cOk.json.data.warning), brief(cOk))

    // 统计
    const ov = await runCli(udA, ['stats', 'overview'])
    const hot = await runCli(udA, ['stats', 'hot', '--level', '2'])
    const hot3 = await runCli(udA, ['stats', 'hot', '--level', '3', '--grade', '4'])
    check('M7 stats', 'stats overview / hot：返回和界面一致的统计（确认后卷子计入）；hot 支持 --level 和筛选', ov.code === 0 && ov.json.data.cards.papers >= 1 && hot.code === 0 && hot.json.data.level === 2 && Array.isArray(hot.json.data.rows) && hot3.code === 0 && hot3.json.data.level === 3, brief(ov) + brief(hot))
    check('M7 stats 参数', '非法 --level、compare 缺 --target：退出码 2', failed(await runCli(udA, ['stats', 'hot', '--level', '5']), 'usage', 2) && failed(await runCli(udA, ['stats', 'compare']), 'usage', 2))
    const cmp = await runCli(udA, ['stats', 'compare', '--target', '2025', '--base', 'before', '--grade', '4'])
    check('M7 stats compare', 'stats compare --target 2025 --base before：同比结果（样本不足时有提示，不下结论）', cmp.code === 0 && okOne(cmp) && cmp.json.ok === true, brief(cmp).slice(0, 300))
  }

  // ───────────────────────── 阶段 3：报告 ─────────────────────────
  const gen = {}
  {
    for (const reader of ['boss', 'teacher', 'parent', 'full']) {
      const r = await runCli(udA, ['report', 'generate', '--reader', reader, '--timeout', '600'])
      gen[reader] = r
      check(`M7 report generate ${reader}`, `report generate --reader ${reader}：返回 reportId、markdown、unverified、warnings、draft（没有老师核对都是 AI 草稿）`, r.code === 0 && okOne(r) && r.json.data.reader === reader && /^[0-9a-f-]{36}$/.test(r.json.data.id) && typeof r.json.data.markdown === 'string' && r.json.data.markdown.length > 50
        && Array.isArray(r.json.data.unverified) && Array.isArray(r.json.data.warnings) && r.json.data.draft === true, brief(r))
    }
    const pj = gen.parent.json.data
    check('M7 家长版草稿', '家长版：返回的 JSON 里 parentDraft = true，并有「AI 草稿 · 未经老师核对，请勿直接发给家长」的 warning；没有任何命令能替老师点「我已核对」', pj.parentDraft === true && pj.confirmedAt === null && pj.warning && pj.warning.includes(BANNER)
      && !gen.boss.json.data.parentDraft)
    check('M7 内部代码', '报告正文里没有内部代码（过滤在命令行路径上照样生效）', !/\b[A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*)+\b|\b[A-Z]{2,}_[A-Z]+\b/.test(gen.full.json.data.markdown + gen.boss.json.data.markdown))
    check('M7 退出码 2', 'report generate 缺 --reader / 读者不对：退出码 2', failed(await runCli(udA, ['report', 'generate']), 'usage', 2) && failed(await runCli(udA, ['report', 'generate', '--reader', 'ceo']), 'usage', 2))
    // 退出码 14：AI 服务出错（mock 对报告请求一直返回 500）
    mock.script([{ type: '500', times: 40, only: 'p3' }])
    const af = await runCli(udA, ['report', 'generate', '--reader', 'boss', '--include-reviewing', '--timeout', '600'])
    mock.clearScript()
    check('M7 退出码 14', 'AI 服务调用失败：退出码 14、ai_failed，message 是白话（不含 HTTP 状态码这类技术词）', failed(af, 'ai_failed', 14) && !/\b5\d\d\b|HTTP|token/i.test(af.json.message), brief(af))
    const em = await runCli(udEmptyAi, ['report', 'generate', '--reader', 'boss'])
    check('M7 退出码 7', '范围里没有可统计的卷子：report generate 退出码 7、invalid_state（不花 AI 的钱）', failed(em, 'invalid_state', 7) && /没有计入统计的试卷/.test(em.json.message), brief(em))
    const lst = await runCli(udA, ['report', 'list'])
    check('M7 report list', 'report list：4 份报告，每份有 id / 版本 / 是否草稿', lst.code === 0 && lst.json.data.reports.length === 4 && lst.json.data.reports.every(r => r.draft === true) && ['boss', 'teacher', 'parent', 'full'].every(x => lst.json.data.reports.some(r => r.reader === x)), brief(lst).slice(0, 200))
    const sh = await runCli(udA, ['report', 'show', pj.id])
    check('M7 report show', 'report show <id>：完整 markdown、未核实句子、refs；家长版仍标草稿', sh.code === 0 && sh.json.data.markdown === pj.markdown && sh.json.data.parentDraft === true && Array.isArray(sh.json.data.refs), brief(sh).slice(0, 200))
  }

  // ───────────────────────── 阶段 4：导出 ─────────────────────────
  const outDir = path.join(work, 'exports'); fs.mkdirSync(outDir, { recursive: true })
  {
    const parentId = gen.parent.json.data.id, bossId = gen.boss.json.data.id
    const exp = (id, fmt, name, extra = []) => runCli(udA, ['report', 'export', id, '--format', fmt, '--out', path.join(outDir, name), ...extra])
    // 家长版（没点过「我已核对」）：三种格式都带草稿标记
    const pm = await exp(parentId, 'md', 'parent-draft.md')
    const mdText = fs.existsSync(path.join(outDir, 'parent-draft.md')) ? fs.readFileSync(path.join(outDir, 'parent-draft.md'), 'utf8') : ''
    check('M7 导出 家长版 md', '家长版没核对导出 Markdown：文件开头有醒目的「AI 草稿 · 未经老师核对，请勿直接发给家长」，页脚注释写 AI 草稿；JSON 里 draft = true 并带 warning', pm.code === 0 && pm.json.data.draft === true && pm.json.data.reviewed === false && /AI 草稿/.test(pm.json.data.warning)
      && mdText.includes(`> **${BANNER}**`) && /^<!-- .*AI 草稿/.test(mdText), brief(pm))
    const pw = await exp(parentId, 'docx', 'parent-draft.docx')
    const dx = fs.existsSync(path.join(outDir, 'parent-draft.docx')) ? await txtOfDocx(path.join(outDir, 'parent-draft.docx')) : ''
    check('M7 导出 家长版 docx', '家长版没核对导出 Word：正文开头有草稿标记；JSON 里 draft = true', pw.code === 0 && pw.json.data.draft === true && squash(dx).includes(squash(BANNER)), brief(pw) + dx.slice(0, 80))
    const pp = await exp(parentId, 'pdf', 'parent-draft.pdf')
    const pdfT = fs.existsSync(path.join(outDir, 'parent-draft.pdf')) ? (await pdfInfo(path.join(outDir, 'parent-draft.pdf'))).text : ''
    check('M7 导出 家长版 pdf', '家长版没核对导出 PDF：页面上有草稿标记；JSON 里 draft = true', pp.code === 0 && pp.json.data.draft === true && squash(pdfT).includes(squash(BANNER)), brief(pp) + pdfT.slice(0, 80))
    // 其他版本：正常导出，不加家长版的草稿标记（它们本来就保留「AI 草稿」页脚）
    for (const [r, id] of [['boss', bossId], ['teacher', gen.teacher.json.data.id], ['full', gen.full.json.data.id]]) {
      const e = await exp(id, 'md', `${r}.md`)
      const t = fs.readFileSync(path.join(outDir, `${r}.md`), 'utf8')
      check(`M7 导出 ${r}`, `${r} 导出 Markdown：成功，不带家长版的草稿标记，开头来源注释写明「AI 草稿 · 请老师核对」`, e.code === 0 && e.json.data.draft === false && !t.includes(BANNER) && /^<!-- .*AI 草稿/.test(t), brief(e))
    }
    const noExt = await runCli(udA, ['report', 'export', bossId, '--format', 'md', '--out', path.join(outDir, 'noext')])
    check('M7 导出 扩展名', '--out 没写扩展名：自动补 .md', noExt.code === 0 && fs.existsSync(path.join(outDir, 'noext.md')), brief(noExt))
    const rf = path.join(outDir, 'result.json')
    const withRf = await runCli(udA, ['report', 'export', bossId, '--format', 'md', '--out', path.join(outDir, 'b2.md'), '--result-file', rf])
    check('M7 导出 --result-file', 'report export 里 --out 是文档路径，JSON 副本用 --result-file', withRf.code === 0 && fs.existsSync(path.join(outDir, 'b2.md')) && fs.readFileSync(rf, 'utf8').trim() === withRf.out.trim())
    check('M7 导出 参数', '缺 --out / --format / 格式不对：退出码 2', failed(await runCli(udA, ['report', 'export', bossId, '--format', 'md']), 'usage', 2) && failed(await runCli(udA, ['report', 'export', bossId, '--out', 'x.md']), 'usage', 2) && failed(await runCli(udA, ['report', 'export', bossId, '--format', 'txt', '--out', 'x']), 'usage', 2))

    // 老师在界面里点了「我已核对」之后：导出不再带草稿标记
    await open(udA)
    const confirmed = await ctx.page.evaluate(id => window.api.report.confirm(id, []), parentId).catch(e => String(e.message))
    await closeApp()
    const pc = await exp(parentId, 'md', 'parent-confirmed.md')
    const ct = fs.readFileSync(path.join(outDir, 'parent-confirmed.md'), 'utf8')
    check('M7 家长版已核对', '老师在界面里点过「我已核对」之后，命令行导出的家长版没有草稿标记，JSON 里 draft = false、reviewed = true', confirmed === true && pc.code === 0 && pc.json.data.draft === false && pc.json.data.reviewed === true && !ct.includes(BANNER) && !/AI 草稿/.test(ct.split('\n')[0]), brief(pc) + ct.slice(0, 100))
    // 家长版没通过把关（内容太少）：仍然拒绝导出，退出码 11
    withWriteDb(udA, d => d.prepare("UPDATE reports SET markdown = ? WHERE id = ?").run('各位家长好，这次英语有这几个小地方孩子容易错：\n\n1. 只剩下一条要点的话，写得再长也不够。\n\n整体不用太担心。\n', parentId))
    const blocked = await exp(parentId, 'md', 'parent-blocked.md')
    check('M7 退出码 11', '家长版内容太少（只剩 1 条）：命令行也拒绝导出，退出码 11、export_blocked（把关在命令行路径上照样生效）', failed(blocked, 'export_blocked', 11) && /建议重新生成/.test(blocked.json.message) && !fs.existsSync(path.join(outDir, 'parent-blocked.md')), brief(blocked))
  }

  // ───────────────────────── 阶段 5：互斥 ─────────────────────────
  {
    // 窗口在运行 → 命令行退出码 3
    await open(udA)
    const r3 = await runCli(udA, ['status'])
    check('M7 退出码 3', '卷知窗口正在运行时：命令行退出码 3、app_running，「请先关闭卷知窗口再用命令行」', failed(r3, 'app_running', 3) && /请先关闭卷知窗口再用命令行/.test(r3.json.message), brief(r3))
    const stillOk = await ctx.page.evaluate(() => window.api.papers.list()).then(l => l.length >= 1).catch(() => false)
    check('M7 窗口不受影响', '命令行被拒绝的同时，正在运行的窗口照常工作（命令行没有碰它的数据，也没有抢焦点）', stillOk)
    await closeApp()
    const free = await runCli(udA, ['status'])
    check('M7 窗口关闭后', '窗口关闭后命令行又能用（运行锁已释放）', free.code === 0 && !fs.existsSync(path.join(udA, 'ewb-run.lock')), brief(free))

    // 另一个命令行在运行（锁被活着的进程持有）→ 命令行退出码 4；窗口打不开
    const lockFile = path.join(udA, 'ewb-run.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, mode: 'cli', startedAt: new Date().toISOString() }))
    const r4 = await runCli(udA, ['status'])
    check('M7 退出码 4', '另一个命令行任务正在运行：第二个命令行退出码 4、cli_busy（报错，不会同时改数据）', failed(r4, 'cli_busy', 4), brief(r4))
    const gui = await new Promise(resolve => {
      const p = spawn(electronBin, [root], { env: cleanEnv({ EWB_USER_DATA_DIR: udA, EWB_NO_DIALOG: '1' }), cwd: root })
      let err = ''; p.stderr.on('data', d => { err += d })
      const t = setTimeout(() => p.kill('SIGKILL'), 60000)
      p.on('exit', code => { clearTimeout(t); resolve({ code, err }) })
    })
    check('M7 窗口被拦', '命令行正在运行时打开窗口：不启动，提示「卷知命令行正在使用数据，请等它结束后再打开窗口」（测试里用 EWB_NO_DIALOG 改成写 stderr，退出码 3）', gui.code === 3 && /卷知命令行正在使用数据/.test(gui.err), `${gui.code} ${gui.err.slice(-200)}`)
    fs.unlinkSync(lockFile)

    // 陈旧锁（持有者已经不在了）清掉
    const dead = spawn(process.execPath, ['-e', '0']); await new Promise(r => dead.on('exit', r))
    fs.writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, mode: 'gui', startedAt: 'x' }))
    const st = await runCli(udA, ['status'])
    check('M7 陈旧锁', '锁文件的持有者进程已经不在（窗口崩溃过）：命令行清掉陈旧锁继续运行', st.code === 0 && st.json.ok === true, brief(st))

    // 两个命令行同时启动：不会损坏数据（要么排开各自成功，要么第二个得到退出码 4）
    const [x, y] = await Promise.all([runCli(udA, ['papers', 'list']), runCli(udA, ['status'])])
    const okCodes = [x, y].every(r => (r.code === 0 && r.json.ok) || (r.code === 4 && r.json.code === 'cli_busy'))
    const integrity = withWriteDb(udA, d => d.prepare('PRAGMA integrity_check').get().integrity_check)
    check('M7 同时运行', '两个命令行同时启动：每个要么成功、要么得到退出码 4，数据库完整（integrity_check = ok）', okCodes && integrity === 'ok', `${x.code}/${y.code} ${integrity}`)
  }

  // ───────────────────────── 阶段 6：设置页「安装命令行工具」 ─────────────────────────
  {
    const home = path.join(work, 'home'); fs.mkdirSync(home, { recursive: true })
    const udI = path.join(work, 'install')
    await open(udI, { extraEnv: { HOME: home, USERPROFILE: home, EWB_CLI_INSTALL_DEV: '1' } })
    const { page } = ctx
    await page.evaluate(() => { location.hash = '#/settings?admin=1' })
    await page.locator('[data-testid=cli-settings]').waitFor({ timeout: 15000 })
    check('M7 安装按钮', '设置 → 管理员设置里有「命令行工具」：显示状态、「安装命令行工具」按钮（开发版里是禁用的，打包版可点）', (await page.locator('[data-testid=cli-install]').count()) === 1 && /还没安装/.test(await page.locator('[data-testid=cli-status]').innerText()))
    const st0 = await page.evaluate(() => window.api.cli.status())
    const r = await page.evaluate(() => window.api.cli.install()).catch(e => ({ error: e.message }))
    const shim = path.join(home, '.local', 'bin', 'juanzhi')
    if (process.platform === 'darwin') {
      const body = fs.existsSync(shim) ? fs.readFileSync(shim, 'utf8') : ''
      check('M7 安装命令行工具', 'Mac：写 ~/.local/bin/juanzhi（可执行的 shell 脚本，exec <程序> cli "$@"），返回如何把目录加进 PATH 的提示', r.ok === true && fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0 && /^#!\/bin\/sh/.test(body) && body.includes('cli "$@"') && /PATH/.test(r.hint) && st0.installed === false, JSON.stringify(r).slice(0, 300))
    } else {
      check('M7 安装命令行工具', 'Windows：写 juanzhi.cmd（start /wait + 结果文件回读），并把目录加进用户 PATH', r.ok === true && fs.existsSync(r.path) && fs.readFileSync(r.path, 'utf8').includes('start "" /wait'), JSON.stringify(r).slice(0, 300))
    }
    await page.reload(); await page.waitForSelector('[data-testid=cli-settings]', { timeout: 15000 }).catch(() => {})
    await page.evaluate(() => { location.hash = '#/settings?admin=1' })
    await page.locator('[data-testid=cli-status]').waitFor({ timeout: 10000 })
    check('M7 安装后状态', '安装后设置页显示「已安装」', await waitFor(async () => /已安装/.test(await page.locator('[data-testid=cli-status]').innerText()), 8000))
    await closeApp()
  }

  check('M7 密钥', '所有命令行输出（stdout / stderr）里都没有 API Key', !allOutput.join('').includes(SECRET))
}

const out = path.join(__dirname, 'last-result-m7.json')
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 1)
})
