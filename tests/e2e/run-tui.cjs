// 命令行交互界面（`juanzhi` 不带参数 / `juanzhi chat`）端到端：在伪终端里启动，用 @xterm/headless 还原屏幕再断言。全程 mock AI。
//   · 机器模式不变：带命令、stdout 不是终端、`cli` 不带参数但没有终端时，仍然只输出一行 JSON
//   · 欢迎框（版本、数据目录、模型 / 没配 AI 的提示、统计、角色、小提示）、输入框、状态栏、/ 命令弹窗与补全、/help /status /papers /datasets /mode /role /new /history /clear /exit
//   · 对话：流式回答、工具行（✓ 耗时）、计划清单、先出计划的确认、ask_user 编号选择、Markdown（标题 / 列表 / 表格）、Esc 中断、token / ¥ 用量
//   · 审批：对外发送一定弹确认（发往哪里、内容、个人信息提醒），按 n 拒绝后假企业微信服务器没有收到；按 y 才发
//   · 运行锁：别的命令行在跑时，交互界面在框里说明原因，不输出 JSON；NO_COLOR 时没有颜色码；窄终端
// 用法：node tests/e2e/run-tui.cjs   （沙箱外运行；先 electron-vite build；Mac / Linux，用 tests/e2e/pty-run.py 开伪终端）
const http = require('node:http')
const { spawn } = require('node:child_process')
const M = require('./m4-lib.cjs')
const { seed } = require('./fixtures-m3.cjs')
const { check, sleep, waitFor, fs, path, work, SECRET, pageImg, ctx, cfgFor, saveCfg, startMock, open, closeApp, L, stubOpen } = M
const { startTui, htmlPage, root, electronBin, cleanEnv } = require('./tui-lib.cjs')
const { generate } = require('../fixtures/gen-ops-data.cjs')

const SHOTS = process.env.EWB_SHOTS || path.join(work, 'shots-tui')
fs.mkdirSync(SHOTS, { recursive: true })
const ENTER = '\r', ESC = '\x1b', CTRL_C = '\x03', DOWN = '\x1b[B'
const allRaw = []

/** 保存一份文字截图（和 PNG 用的 HTML） */
function snap(t, name) {
  fs.writeFileSync(path.join(SHOTS, `${name}.txt`), t.screen() + '\n')
  fs.writeFileSync(path.join(SHOTS, `${name}.html`), htmlPage(t.html(), name))
}

/** 机器模式：普通子进程（stdout 是管道），返回 { code, out, json } */
function runPlain(ud, args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(electronBin, [root, 'cli', ...args], { env: cleanEnv({ EWB_USER_DATA_DIR: ud, ...env }), cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => p.kill('SIGKILL'), 120000)
    p.on('close', code => {
      clearTimeout(timer)
      const lines = out.split('\n').filter(l => l.trim())
      let json = null
      try { json = JSON.parse(lines[lines.length - 1] ?? '') } catch { /* 下面的检查会报 */ }
      resolve({ code, out, err, lines, json })
    })
  })
}

const startFake = () => new Promise(r => {
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => { received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' })) })
  })
  server.listen(0, '127.0.0.1', () => r({ server, received }))
})

/** 退出并收集原始输出（密钥检查用） */
async function quit(t) {
  t.send(CTRL_C); await sleep(200); t.send(CTRL_C)
  const code = await t.waitExit(15000).catch(() => { t.kill(); return null })
  allRaw.push(t.raw())
  return code
}

async function main() {
  const mock = await startMock({ apiKey: SECRET })
  ctx.mock = mock
  const { server: fakeServer, received } = await startFake()
  const hook = `http://127.0.0.1:${fakeServer.address().port}/cgi-bin/webhook/send?key=e2ekey-0123456789abcdef`

  // ── 准备数据目录：A = 空白（没配 AI），B = 配好 AI + 试卷 + 数据集 + 企业微信 ──
  const udA = path.join(work, 'userTuiA')
  await open(udA); await closeApp()
  const udB = path.join(work, 'userTuiB')
  const r0 = await open(udB); await r0.app.close()
  seed(udB, { bboxes: {}, pageImage: pageImg, pageSize: { width: 1224, height: 1584 } })
  await open(udB, { extraEnv: { EWB_TEST_HOOKS: '1' } })
  await saveCfg(cfgFor(mock, { auto_parse: true }), SECRET)
  await ctx.page.evaluate(h => window.api.connectors.save({ type: 'wecom', name: '三年级辅导群', config: { webhook: h } }), hook)
  const opsDir = path.join(work, 'ops')
  await generate(opsDir)
  await stubOpen(path.join(opsDir, 'survey.xlsx'))
  await ctx.page.evaluate(h => { location.hash = h }, '#/assistant'); await ctx.page.locator('[data-testid=assistant-page]').waitFor()
  await ctx.page.locator('[data-testid=assistant-plus]').click(); await ctx.page.locator('[data-testid=assistant-plus-add]').click()
  await waitFor(async () => (await ctx.page.evaluate(() => window.api.datasets.list())).length === 1, 60000)
  await closeApp()

  // ── 1. 机器模式不变 ──
  const st = await runPlain(udB, ['status'])
  check('机器模式', '带命令（status）仍然只输出一行 JSON，ok:true', st.code === 0 && st.lines.length === 1 && st.json?.ok === true && st.json.data?.ai?.configured === true, st.out.slice(0, 120))
  const noArgs = await runPlain(udB, [])
  check('机器模式', '不带参数但 stdout 不是终端：仍然输出一行帮助 JSON（不进交互界面）', noArgs.code === 0 && noArgs.lines.length === 1 && noArgs.json?.ok === true && !!noArgs.json.data?.commands, noArgs.out.slice(0, 120))
  const chatPlain = await runPlain(udB, ['chat'])
  check('机器模式', 'chat 在没有终端时报用法错误（退出码 2，一行 JSON，说明要在终端里运行）', chatPlain.code === 2 && chatPlain.lines.length === 1 && chatPlain.json?.ok === false && chatPlain.json.code === 'usage' && /终端/.test(chatPlain.json.message), chatPlain.out.slice(0, 200))

  // ── 2. 没配 AI：欢迎框、命令弹窗、本地命令 ──
  {
    const t = startTui({ ud: udA, cols: 100, rows: 40 })
    let s = await t.waitFor(/输入问题，或输入 \//, 40000)
    snap(t, '01-welcome-noai')
    check('欢迎框', '圆角框里有卷知名称、版本、数据目录', /╭─+╮/.test(s) && /✦ 卷知\s+v\d+\.\d+/.test(s) && /workbench-data/.test(s), s.split('\n').slice(0, 4).join(' | '))
    check('欢迎框', '没配 AI：提示到窗口里配置', /还没有配置 AI/.test(s) && /设置 → 管理员设置 → AI 服务/.test(s))
    check('欢迎框', '统计（试卷 / 已解析 / 数据集）和当前助手角色', /试卷\s+0 份，已解析 0 份/.test(s) && /数据集\s+0 个/.test(s) && /助手\s+运营/.test(s))
    check('欢迎框', '有小提示：直接提问、/ 查看命令、拖入路径导入', /直接输入问题/.test(s) && /输入 \/ 查看命令/.test(s) && /拖进来/.test(s))
    check('输入框', '底部有圆角输入框和状态栏（角色 · 回答方式 · 模型 · 用量）', /╭─+╮\n│ ❯/.test(s) && /运营\s+·\s+先出计划/.test(s) && /0 tokens/.test(s))

    t.send('/'); s = await t.waitFor(/\/help\s+查看命令/, 8000)
    snap(t, '02-slash-menu')
    check('命令弹窗', '输入 / 弹出命令列表（带说明），第一项高亮', /❯ \/help/.test(s) && /\/import <路径…>/.test(s) && /\/papers/.test(s))
    await t.type('pa'); s = await t.waitFor(/\/papers/, 5000)
    check('命令弹窗', '继续输入 /pa 只剩匹配的命令', /\/papers/.test(s) && !/\/status\s+版本/.test(s.split('\n').slice(-12).join('\n')))
    t.send('\t'); await sleep(300)
    check('命令弹窗', 'Tab 补全成 /papers', /❯ \/papers/.test(t.screen()))
    t.send(ENTER); s = await t.waitFor(/还没有试卷/, 8000)
    check('/papers', '没有试卷时给出提示', /还没有试卷/.test(s))

    await t.type('/help'); t.send(ENTER); s = await t.waitFor(/快捷键/, 8000)
    check('/help', '列出命令和快捷键', /\/import/.test(s) && /Esc/.test(s) && /Ctrl\+J/.test(s))
    await t.type('/status'); t.send(ENTER); s = await t.waitFor(/识别\s/, 15000)
    check('/status', '版本、数据目录、AI 未配置、识别组件', /版本\s+\d/.test(s) && /AI\s+还没有配置/.test(s) && /数据\s+\S+workbench-data/.test(s))
    await t.type('这是一个问题'); t.send(ENTER); s = await t.waitFor(/请打开卷知窗口，到「设置/, 8000)
    check('没配 AI', '直接提问时提示先去配置，不发请求', mock.agentRequests.length === 0)
    await t.type('/mode'); t.send(ENTER); s = await t.waitFor(/回答方式/, 8000)
    snap(t, '03-mode-picker')
    check('/mode', '弹出三选一：直接回答 / 先出计划 / 自动完成', /1\. 直接回答/.test(s) && /2\. 先出计划/.test(s) && /3\. 自动完成/.test(s))
    t.send('3'); s = await t.waitFor(/回答方式：自动完成/, 8000)
    check('/mode', '按数字选 3：状态栏变成自动完成', /运营\s+·\s+自动完成/.test(t.screen().split('\n').slice(-3).join('\n')))
    await t.type('/role'); t.send(ENTER); s = await t.waitFor(/选择助手角色/, 8000)
    check('/role', '列出角色（运营、辅导老师）', /运营/.test(s) && /辅导老师/.test(s))
    t.send(DOWN); await sleep(150); t.send(ENTER); s = await t.waitFor(/已切换到「辅导老师」/, 8000)
    check('/role', '↓ Enter 切换到辅导老师，状态栏跟着变', /辅导老师\s+·/.test(t.screen().split('\n').slice(-3).join('\n')))
    await t.type('/clear'); t.send(ENTER); await sleep(800)
    check('/clear', '清屏后重新显示欢迎框', /✦ 卷知/.test(t.screen()) && !/快捷键/.test(t.screen()))
    await t.type('/exit'); t.send(ENTER)
    const code = await t.waitExit(15000).catch(() => null)
    allRaw.push(t.raw())
    check('/exit', '/exit 退出，退出码 0，屏幕上没有 JSON', code === 0 && !/"ok"\s*:/.test(t.raw()), String(code))
    t.kill()
  }

  // ── 3. 窄终端 + NO_COLOR ──
  {
    const t = startTui({ ud: udA, cols: 48, rows: 30, env: { NO_COLOR: '1' } })
    const s = await t.waitFor(/输入问题/, 40000)
    check('窄终端', '48 列：欢迎框和输入框不超出宽度，仍然有圆角框', t.screen().split('\n').every(l => [...l].length <= 48) && /╭─+╮/.test(s), String(Math.max(...t.screen().split('\n').map(l => [...l].length))))
    const raw = t.raw()
    check('NO_COLOR', 'NO_COLOR 时输出里没有前景色 / 背景色控制码', !/\x1b\[(3[0-7]|9[0-7]|4[0-7]|38;|48;)/.test(raw), (raw.match(/\x1b\[[0-9;]*m/g) ?? []).slice(0, 5).join(' '))
    await quit(t); t.kill()
  }

  // ── 4. 配好 AI：欢迎框、对话 ──
  const t = startTui({ ud: udB, cols: 100, rows: 44 })
  let s = await t.waitFor(/输入问题，或输入 \//, 40000)
  snap(t, '04-welcome')
  check('欢迎框', '配好 AI：显示模型 mock-text-model，不再有配置提示', /模型\s+mock-text-model/.test(s) && !/还没有配置 AI/.test(s))
  check('欢迎框', '统计里有试卷数和数据集 1 个', /试卷\s+\d+ 份，已解析 \d+ 份/.test(s) && /数据集\s+1 个/.test(s) && !/试卷\s+0 份/.test(s), s.split('\n').filter(l => /试卷/.test(l)).join('|'))

  // 4.1 直接回答模式下的普通对话
  await t.type('/mode'); t.send(ENTER); await t.waitFor(/回答方式/, 8000); t.send('1'); await t.waitFor(/回答方式：直接回答/, 8000)
  await t.type('你好，介绍一下自己'); t.send(ENTER)
  s = await t.waitFor(/这是模拟的助手回答/, 30000)
  check('对话', '用户的话以 ❯ 开头回显，助手的回答以 ● 开头显示', /❯ 你好，介绍一下自己/.test(s) && /● 这是模拟的助手回答/.test(s))
  await sleep(600)
  s = t.screen()
  check('状态栏', '一次回答之后，状态栏显示本对话累计 token 和 ¥ 金额', /[1-9]\d*(\.\d)?k? tokens/.test(s.split('\n').slice(-3).join('\n')) && /(¥|未设价格)/.test(s.split('\n').slice(-3).join('\n')), s.split('\n').slice(-2).join('|'))
  check('对话', '发给 AI 的请求带了助手工具（走的是窗口同一套 startRun）', mock.agentRequests.some(r => !r.toolNames.includes('ping') && r.toolNames.includes('stats_overview')))

  // 4.2 先出计划 → 计划清单 → 确认 → ask_user 编号选择 → 工具行 → Markdown 回答
  await t.type('/mode'); t.send(ENTER); await t.waitFor(/回答方式/, 8000); t.send('2'); await t.waitFor(/回答方式：先出计划/, 8000)
  await t.type('/new'); t.send(ENTER); await t.waitFor(/已开始新对话/, 8000)
  await t.type('帮我写本周周报'); t.send(ENTER)
  s = await t.waitFor(/要按这个计划做吗/, 40000)
  snap(t, '05-plan-review')
  check('计划', '先出计划：计划以清单显示（○ 待办 / ◐ 进行中），并问「要按这个计划做吗」', /计划/.test(s) && /◐ 确认范围/.test(s) && /○ 查最常考和最易错的知识点/.test(s) && /1\. 按这个做/.test(s) && /2\. 提修改意见/.test(s), s.split('\n').slice(-14).join('\n'))
  t.send('1')
  s = await t.waitFor(/周报要看哪个范围/, 40000)
  snap(t, '06-ask-user')
  check('ask_user', '助手的提问变成编号选择：选项 + 「其他（自己写）」', /1\. 全部年级/.test(s) && /2\. 只看四年级/.test(s) && /3\. 其他（自己写）/.test(s))
  t.send('2')
  s = await t.waitFor(/学情周报/, 60000)
  await sleep(500); s = t.screen()
  snap(t, '07-answer-tools')
  check('工具行', '工具调用显示成紧凑的一行：✓ 名称 · 摘要 · 耗时', /✓ \S+.*·.*\d+(ms|\.\ds)/.test(s), s.split('\n').filter(l => /✓/.test(l)).slice(0, 3).join('|'))
  check('计划', '回答结束后计划清单全部定下来（✔ 已完成）', /✔ 确认范围/.test(s))
  check('Markdown', '标题加粗、列表、表格画成方框线、引用标签变成短标记', /学情周报/.test(s) && !/## 学情周报/.test(s) && /┌─+┬─+┐/.test(s) && /│ 项目\s+│ 说明\s+│/.test(s) && /代表题：〔题〕/.test(s) && !/\*\*结论\*\*/.test(s))
  check('引用', '对不上的假引用被去掉（和窗口一样的校验）', !/not-a-real-id/.test(s))
  check('选择', '你选了「只看四年级」，记录在对话里', /你选了：只看四年级/.test(s))

  // 4.3 /papers /datasets /history /new
  await t.type('/papers'); t.send(ENTER); s = await t.waitFor(/共 \d+ 份试卷/, 15000)
  check('/papers', '试卷列表是一张表（试卷、状态、题数、年级学期）', /│ 试卷\s+│ 状态\s+│ 题数/.test(s))
  await t.type('/datasets'); t.send(ENTER); s = await t.waitFor(/│ 数据集\s+│ 表数/, 15000)
  check('/datasets', '数据集列表里有 survey（两张表共 305 行）', /survey/.test(s) && /\b30\d\b/.test(s))
  await t.type('/history'); t.send(ENTER); s = await t.waitFor(/回到以前的对话/, 8000)
  snap(t, '08-history-picker')
  check('/history', '列出以前的对话（标题、角色、时间）', /帮我写本周周报/.test(s) && /你好，介绍一下自己/.test(s))
  t.send(ENTER); s = await t.waitFor(/已回到「/, 15000)
  check('/history', '回放以前的对话：问题、回答都在，接着问就行', /❯ 帮我写本周周报/.test(s) && /学情周报/.test(s))

  // 4.4 Esc 中断
  await t.type('/new'); t.send(ENTER); await t.waitFor(/已开始新对话/, 8000)
  await t.type('/mode'); t.send(ENTER); await t.waitFor(/回答方式/, 8000); t.send('1'); await t.waitFor(/回答方式：直接回答/, 8000)
  await t.type('慢慢说'); t.send(ENTER)
  s = await t.waitFor(/好的，我慢慢来/, 30000)
  check('流式', '回答一边生成一边显示，运行中有转圈提示和「Esc 中断」', /Esc 中断/.test(s))
  t.send(ESC)
  s = await t.waitFor(/已中断/, 15000)
  check('中断', 'Esc 中断运行中的回答，显示「已中断」，输入框恢复可用', /已中断/.test(s) && await (async () => { await sleep(500); return /输入问题，或输入 \//.test(t.screen()) })())

  // 4.5 多行输入 + 历史
  await t.type('第一行'); t.send('\x0a'); await t.type('第二行')
  s = t.screen()
  check('多行输入', 'Ctrl+J 换行，输入框变成两行', /❯ 第一行/.test(s) && /│\s+第二行/.test(s), s.split('\n').slice(-6).join('|'))
  t.send(CTRL_C); await sleep(300)
  check('Ctrl+C', '有输入内容时 Ctrl+C 先清空输入', !/第一行/.test(t.screen().split('\n').slice(-6).join('\n')))
  t.send('\x1b[A'); await sleep(300)
  check('历史', '↑ 翻出上一条问的问题', /慢慢说/.test(t.screen().split('\n').slice(-6).join('\n')))
  t.send(CTRL_C); await sleep(200)

  // 4.6 /report
  await t.type('/report'); t.send(ENTER); s = await t.waitFor(/报告给谁看/, 8000)
  snap(t, '09-report-reader')
  check('/report', '先问读者：老师版 / 老板版 / 家长版 / 完整数据', /1\. 老师版/.test(s) && /2\. 老板版/.test(s) && /3\. 家长版/.test(s) && /4\. 完整数据/.test(s))
  t.send('1')
  s = await t.waitFor(/导出到当前目录|已确认的试卷|没有/, 90000)
  await sleep(500); s = t.screen()
  check('/report', '生成完成：显示报告（Markdown 渲染）或说明原因，并问是否导出', /导出到当前目录/.test(s) || /(没有|不足|已确认)/.test(s), s.split('\n').slice(-8).join('|'))
  if (/导出到当前目录/.test(s)) { t.send('1'); await sleep(500) } else { t.send(ESC); await sleep(300) }

  // 4.7 /import：进度 + 结果
  await t.type(`/import ${pageImg}`); t.send(ENTER)
  s = await t.waitFor(/导入结果/, 120000)
  snap(t, '10-import')
  check('/import', '导入时显示进度，结束后给出结果清单', /导入结果/.test(s) && /(✓|✗|重复)/.test(s), s.split('\n').slice(-6).join('|'))
  await t.type('/import /不存在/的文件.pdf'); t.send(ENTER); s = await t.waitFor(/找不到文件/, 8000)
  check('/import', '路径不存在时直接说明', /找不到文件/.test(s))
  await quit(t); t.kill()

  // ── 5. 审批：对外发送一定要确认 ──
  {
    const run = async (answerKey) => {
      const t2 = startTui({ ud: udB, cols: 100, rows: 48, env: { EWB_TEST_HOOKS: '1' } })
      await t2.waitFor(/输入问题，或输入 \//, 40000)
      await t2.type('/mode'); t2.send(ENTER); await t2.waitFor(/回答方式/, 8000); t2.send('3'); await t2.waitFor(/回答方式：自动完成/, 8000)
      await t2.type('分析满意度，出一份看板'); t2.send(ENTER)
      const s2 = await t2.waitFor(/需要你确认/, 180000)
      await sleep(500)
      return { t2, s2: t2.screen(), answerKey }
    }
    let { t2, s2 } = await run('n')
    snap(t2, '11-approval')
    check('审批', '对外发送弹确认框：说明要做什么、发往哪里、完整内容预览、个人信息提醒', /需要你确认/.test(s2) && /发往\s+企业微信群：三年级辅导群/.test(s2) && /!.*(手机|个人|学生|姓名)/.test(s2) && /│ 满意度偏低提醒/.test(s2), s2.split('\n').slice(-18).join('\n'))
    check('审批', '有个人信息提醒时默认高亮「拒绝」（误按 Enter 不会发出去）', /❯ 2\. 拒绝/.test(s2))
    check('审批', '确认前假企业微信服务器没有收到任何东西', received.length === 0)
    t2.send('n'); await t2.waitFor(/已拒绝/, 15000)
    await t2.waitFor(/满意度|结论/, 120000)
    await sleep(1500)
    check('审批', '按 n 拒绝：服务器仍然没有收到，助手继续并给出回答', received.length === 0)
    const toolsFailed = t2.screen().split('\n').filter(l => /✗/.test(l))
    check('审批', '被拒绝的发送显示成 ✗ 工具行', toolsFailed.length >= 1, toolsFailed.join('|'))
    snap(t2, '12-analysis-done')
    await quit(t2); t2.kill()

    ;({ t2, s2 } = await run('y'))
    t2.send('y'); await t2.waitFor(/已同意/, 15000)
    check('审批', '按 y 同意之后才真正发送：服务器收到 1 条', await waitFor(async () => received.length === 1, 30000), String(received.length))
    check('审批', '发出去的是真名 / 真手机号（还原代号），不是代号', received[0] && !/人员A\d+|手机\d{4}/.test(received[0].body))
    await t2.waitFor(/结论|满意度/, 120000)
    await quit(t2); t2.kill()
  }

  // ── 6. 运行锁 ──
  {
    const a = startTui({ ud: udB, cols: 100, rows: 30 })
    await a.waitFor(/输入问题，或输入 \//, 40000)
    const b = startTui({ ud: udB, cols: 100, rows: 30 })
    const code = await b.waitExit(40000).catch(() => null)
    const s3 = b.screen()
    snap(b, '13-lock-busy')
    check('运行锁', '另一个命令行在用数据时：框里说明原因（不是 JSON），退出码非 0', code !== 0 && code !== null && /╭─+╮/.test(s3) && /命令行/.test(s3) && !/"ok"/.test(s3), `${code} ${s3.slice(0, 160)}`)
    allRaw.push(b.raw()); b.kill()
    await quit(a); a.kill()
  }

  check('密钥', '所有终端输出里都没有 API Key', !allRaw.join('').includes(SECRET))
  check('截图', `文字 / HTML 截图已保存到 ${SHOTS}`, fs.readdirSync(SHOTS).length >= 10)
  console.log('SHOTS_DIR=' + SHOTS)
}

const out = path.join(__dirname, 'last-result-tui.json')
main().then(async () => {
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(L.finish(out) ? 1 : 0)
}, async e => {
  console.error('E2E 异常:', e)
  M.check('E2E', '测试脚本未异常退出', false, e.message)
  try { await ctx.app?.close() } catch { /* 已关闭 */ }
  try { await ctx.mock?.stop() } catch { /* 已关闭 */ }
  process.exit(1)
})
