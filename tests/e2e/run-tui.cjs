// 命令行交互界面（`juanzhi` 不带参数 / `juanzhi chat`）端到端：在伪终端里启动，用 @xterm/headless 还原屏幕再断言。全程 mock AI。
//   · 机器模式不变：带命令、stdout 不是终端、`cli` 不带参数但没有终端时，仍然只输出一行 JSON
//   · 开场（卷卷像素画、版本、模型 + 角色、数据目录、概况行、没配 AI 的提示）、两条细线之间的输入框、状态栏（►► 回答方式，Shift+Tab 轮流切换）、/ 命令弹窗与补全、/help /status /papers /datasets /mode /role /new /history /clear /exit
//   · 对话：流式回答、工具行（✓ 耗时）、计划清单、先出计划的确认、ask_user 编号选择、Markdown（标题 / 列表 / 表格）、Esc 中断、token / ¥ 用量
//   · 审批：对外发送一定弹确认（发往哪里、内容、个人信息提醒），按 n 拒绝后假企业微信服务器没有收到；按 y 才发
//   · 运行锁：别的命令行在跑时，交互界面在框里说明原因，不输出 JSON；NO_COLOR 时没有颜色码；窄终端
//   · 人读输出：终端里 status / papers list 是中文表格（没有 \u 转义），--json 在终端里仍是 JSON，非终端字节和以前一致
//   · 窗口正在运行：面板、Esc 取消（退出码 3）、Enter 让窗口体面退出后接着用
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

  {
    const plainJson = await runPlain(udB, ['status', '--json'])
    check('机器模式', '非终端：status 与 status --json 输出逐字节相同，纯 ASCII 单行，是「序列化后的 JSON + 换行」',
      plainJson.out === st.out && /^[\x00-\x7f]*$/.test(st.out) && st.out.endsWith('\n') && st.out.split('\n').length === 2 && st.out === require('node:util').format('%s\n', st.out.trimEnd()), st.out.slice(0, 80))
    const asciiEsc = await runPlain(udB, ['papers', 'list', '--json'])
    check('机器模式', '非终端：papers list 里的中文仍写成 \\uXXXX 转义（ASCII JSON 不变）', asciiEsc.lines.length === 1 && asciiEsc.json?.ok === true && (/\\u[0-9a-f]{4}/.test(asciiEsc.out) || asciiEsc.json.data.papers.length === 0), asciiEsc.out.slice(0, 100))
    const bad = await runPlain(udB, ['nope'])
    check('机器模式', '非终端：命令写错 → 退出码 2，一行 JSON（含 \\u 转义）', bad.code === 2 && bad.lines.length === 1 && bad.json?.code === 'usage' && /\\u[0-9a-f]{4}/.test(bad.out), bad.out.slice(0, 100))
  }

  // ── 1b. 终端里的人读输出 ──
  {
    const ptyRun = async (ud, args, env = {}) => {
      const t0 = startTui({ ud, cols: 100, rows: 30, args, env })
      const code = await t0.waitExit(60000).catch(() => null)
      const raw = t0.raw(); allRaw.push(raw)
      return { t: t0, code, raw, screen: t0.screen() }
    }
    const h = await ptyRun(udB, ['status'])
    snap(h.t, '20-status-human')
    check('人读输出', '终端里 status：中文表格（项目 / 内容），不是 JSON，没有 \\u 转义，退出码 0',
      h.code === 0 && /项目\s+内容/.test(h.screen) && /数据目录/.test(h.screen) && /试卷\s+共 \d+ 份/.test(h.screen) && /✓ 已配置\s+模型 mock-text-model/.test(h.screen) && !/\\u[0-9a-f]{4}/.test(h.raw) && !/"ok"\s*:/.test(h.raw) && !/\[db\]|deprecated/.test(h.raw), h.screen.slice(0, 300))
    check('人读输出', '表格上面没有 [db] 日志和 Electron 弃用警告的杂音', !/\[db\]|deprecated/.test(h.screen), h.screen.slice(0, 200))
    check('人读输出', 'status 里有 ✓ 绿色和各状态份数的小表（试卷状态 / 份数）', /\x1b\[32m/.test(h.raw) && /试卷状态\s+份数/.test(h.screen))
    h.t.kill()
    const hp = await ptyRun(udB, ['papers', 'list'])
    check('人读输出', '终端里 papers list：编号 / 试卷 / 状态 / 题数 / 年级学期 对齐的表格', hp.code === 0 && /编号\s+试卷\s+状态\s+题数\s+年级学期/.test(hp.screen) && /共 \d+ 份试卷/.test(hp.screen) && !/\\u[0-9a-f]{4}/.test(hp.raw), hp.screen.slice(0, 300))
    hp.t.kill()
    const hn = await ptyRun(udB, ['status'], { NO_COLOR: '1' })
    check('人读输出', 'NO_COLOR：表格照样有，但没有颜色控制码', hn.code === 0 && /项目\s+内容/.test(hn.screen) && !/\x1b\[(3[0-7]|9[0-7]|4[0-7]|38;|48;)/.test(hn.raw), (hn.raw.match(/\x1b\[[0-9;]*m/g) ?? []).slice(0, 4).join(' '))
    hn.t.kill()
    const he = await ptyRun(udB, ['papers', 'show', 'not-an-id'])
    snap(he.t, '21-error-human')
    check('人读输出', '终端里出错：✗ + 原因 + → 提示，退出码和以前一样（2）', he.code === 2 && /✗ .*id 的格式不对/.test(he.screen) && /→ 运行 juanzhi --help/.test(he.screen) && !/"ok"/.test(he.raw), he.screen.slice(0, 300))
    he.t.kill()
    const hj = await ptyRun(udB, ['status', '--json'])
    const hjLines = hj.raw.replace(/\r/g, '').split('\n').filter(l => l.startsWith('{'))   // 伪终端里 stderr 的日志行也会混进来，只看 stdout 的 JSON 行
    const hjLine = hjLines[0] ?? ''
    check('--json', '终端里加 --json：stdout 仍然只有一行 JSON（\\u 转义），和非终端逐字节相同', hj.code === 0 && hjLines.length === 1 && hjLine + '\n' === st.out, hj.raw.slice(0, 120))
    hj.t.kill()
    const hf = path.join(work, 'tty-result.json')
    const hr = await ptyRun(udB, ['status', '--result-file', hf])
    check('--result-file', '终端里带 --result-file：stdout 仍是 JSON，文件里也是 JSON', hr.code === 0 && /"ok":true/.test(hr.raw) && fs.existsSync(hf) && JSON.parse(fs.readFileSync(hf, 'utf8')).ok === true, hr.raw.slice(0, 100))
    hr.t.kill()
  }

  // ── 2. 没配 AI：开场、命令弹窗、本地命令 ──
  {
    const t = startTui({ ud: udA, cols: 100, rows: 40 })
    let s = await t.waitFor(/试试「哪些班到课率掉得最厉害」/, 40000)
    snap(t, '01-welcome-noai')
    check('开场', '左上角有卷卷像素画（半块字符、5 行），旁边：卷知 + 版本、模型 + 角色、数据目录', /[▀▄█]{4,}/.test(s) && s.split('\n').slice(0, 6).filter(l => /[▀▄█]/.test(l)).length >= 5 && /卷知\s+v\d+\.\d+/.test(s) && /未配置 AI\s+·\s+运营/.test(s) && /workbench-data/.test(s) && !/╭─+╮/.test(s), s.split('\n').slice(0, 6).join(' | '))
    check('开场', '卷卷用了前景 / 背景色（奶油 + 蓝紫）', (t.raw().match(/\x1b\[(38|48);[25];[\d;]+m/g) ?? []).length >= 10)
    check('开场', '没配 AI：一行淡色提示到窗口里配置', /还没有配置 AI/.test(s) && /设置 → 管理员设置 → AI 服务/.test(s))
    check('开场', '概况行：试卷 / 已解析 / 数据集 / /help', /│ 试卷 0 份（已解析 0）· 数据集 0 个 · \/help 查看命令/.test(s))
    const sl = s.split('\n')
    const rules = sl.map((l, i) => /^─{20,}$/.test(l) ? i : -1).filter(i => i >= 0)
    check('输入框', '输入行夹在两条细线之间（不是圆角框），`❯` 提示符 + 灰色占位符', rules.length >= 2 && rules[1] - rules[0] === 2 && /^❯\s+试试「哪些班到课率掉得最厉害」/.test(sl[rules[0] + 1]) && !/│ ❯/.test(s), sl.slice(-5).join('|'))
    check('状态栏', '细线下面：►► 先出计划（shift+tab 切换），右边淡色的角色 · 模型 · 用量', /►► 先出计划（shift\+tab 切换）/.test(s) && /运营\s+·\s+未配置 AI\s+·\s+0 tokens/.test(s), sl.slice(-2).join('|'))
    const lastLine = () => t.screen().split('\n').slice(-1)[0]
    t.send('\x1b[Z'); await sleep(500)
    check('Shift+Tab', '先出计划 → 直接回答', /►► 直接回答/.test(lastLine()), lastLine())
    t.send('\x1b[Z'); await sleep(500)
    check('Shift+Tab', '直接回答 → 自动完成', /►► 自动完成/.test(lastLine()), lastLine())
    t.send('\x1b[Z'); await sleep(500)
    check('Shift+Tab', '自动完成 → 回到先出计划（轮流切换）', /►► 先出计划/.test(lastLine()), lastLine())
    snap(t, '01b-welcome-noai-after-cycle')

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
    check('/mode', '按数字选 3：状态栏变成自动完成', /►► 自动完成/.test(t.screen().split('\n').slice(-3).join('\n')))
    await t.type('/role'); t.send(ENTER); s = await t.waitFor(/选择助手角色/, 8000)
    check('/role', '列出角色（运营、辅导老师）', /运营/.test(s) && /辅导老师/.test(s))
    t.send(DOWN); await sleep(150); t.send(ENTER); s = await t.waitFor(/已切换到「辅导老师」/, 8000)
    check('/role', '↓ Enter 切换到辅导老师，状态栏跟着变', /辅导老师\s+·/.test(t.screen().split('\n').slice(-3).join('\n')))
    await t.type('/clear'); t.send(ENTER); await sleep(800)
    check('/clear', '清屏后重新显示开场', /卷知\s+v\d/.test(t.screen()) && !/快捷键/.test(t.screen()))
    await t.type('/exit'); t.send(ENTER)
    const code = await t.waitExit(15000).catch(() => null)
    allRaw.push(t.raw())
    check('/exit', '/exit 退出，退出码 0，屏幕上没有 JSON', code === 0 && !/"ok"\s*:/.test(t.raw()), String(code))
    t.kill()
  }

  // ── 3. 窄终端 + NO_COLOR ──
  {
    const t = startTui({ ud: udA, cols: 48, rows: 30, env: { NO_COLOR: '1' } })
    const s = await t.waitFor(/试试「/, 40000)
    check('窄终端', '48 列：开场、两条细线和状态栏都不超出宽度，细线铺满整行', t.screen().split('\n').every(l => [...l].length <= 48) && /^─{40,}$/m.test(s), String(Math.max(...t.screen().split('\n').map(l => [...l].length))))
    const raw = t.raw()
    check('NO_COLOR', 'NO_COLOR 时输出里没有前景色 / 背景色控制码', !/\x1b\[(3[0-7]|9[0-7]|4[0-7]|38;|48;)/.test(raw), (raw.match(/\x1b\[[0-9;]*m/g) ?? []).slice(0, 5).join(' '))
    await quit(t); t.kill()
  }

  // ── 4. 配好 AI：欢迎框、对话 ──
  const t = startTui({ ud: udB, cols: 100, rows: 44 })
  let s = await t.waitFor(/试试「/, 40000)
  snap(t, '04-welcome')
  check('开场', '配好 AI：第二行是 模型 · 角色，不再有配置提示', /mock-text-model\s+·\s+运营/.test(s) && !/还没有配置 AI/.test(s))
  check('开场', '概况行里有试卷数和数据集 1 个', /│ 试卷 \d+ 份（已解析 \d+）· 数据集 1 个/.test(s) && !/试卷 0 份/.test(s), s.split('\n').filter(l => /试卷/.test(l)).join('|'))

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
  check('中断', 'Esc 中断运行中的回答，显示「已中断」，输入框恢复可用', /已中断/.test(s) && await (async () => { await sleep(500); return /试试「哪些班/.test(t.screen()) })())

  // 4.5 多行输入 + 历史
  await t.type('第一行'); t.send('\x0a'); await t.type('第二行')
  s = t.screen()
  check('多行输入', 'Ctrl+J 换行，输入框变成两行', /❯ 第一行/.test(s) && /^\s+第二行/m.test(s), s.split('\n').slice(-6).join('|'))
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
      await t2.waitFor(/试试「哪些班/, 40000)
      await sleep(800)   // 首帧画出来后输入处理还要一会儿才挂上，马上打字偶尔会被吞
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
    await a.waitFor(/试试「哪些班/, 40000)
    const b = startTui({ ud: udB, cols: 100, rows: 30 })
    const code = await b.waitExit(40000).catch(() => null)
    const s3 = b.screen()
    snap(b, '13-lock-busy')
    check('运行锁', '另一个命令行在用数据时：框里说明原因（不是 JSON），退出码 4', code === 4 && code !== 0 && code !== null && /╭─+╮/.test(s3) && /命令行/.test(s3) && !/"ok"/.test(s3), `${code} ${s3.slice(0, 160)}`)
    allRaw.push(b.raw()); b.kill()
    await quit(a); a.kill()
  }

  // ── 7. 卷知窗口正在运行：面板、Esc 取消、Enter 让窗口体面退出、窗口忙时拒绝 ──
  {
    const PANEL = '卷知窗口正在运行。命令行和窗口不能同时用同一份数据。'
    const PROMPT = '按 Enter 让卷知窗口退出并继续，按 Esc 取消'
    const alive = () => ctx.page.evaluate(() => window.api.papers.list()).then(() => true).catch(() => false)
    await open(udB, { extraEnv: { EWB_TEST_HOOKS: '1' } })

    // 7.1 交互界面：面板 → Esc → 退出码 3，窗口不受影响
    {
      const t7 = startTui({ ud: udB, cols: 100, rows: 30 })
      const s7 = await t7.waitFor(/按 Enter 让卷知窗口退出并继续/, 40000)
      snap(t7, '30-app-running-panel')
      check('窗口运行中', '交互界面：面板说明「命令行和窗口不能同时用同一份数据」并提示 Enter / Esc', s7.includes(PANEL) && s7.includes(PROMPT) && /╭─+╮/.test(s7) && !/"ok"/.test(s7), s7.slice(0, 300))
      t7.send(ESC)
      const c7 = await t7.waitExit(20000).catch(() => null)
      const after = t7.screen()
      allRaw.push(t7.raw())
      check('窗口运行中', '按 Esc 取消：退出码 3，说明怎么自己退出（Cmd+Q），不输出 JSON，窗口照常工作', c7 === 3 && /已取消/.test(after) && /Cmd\+Q/.test(after) && !/"ok"/.test(after) && await alive(), `${c7} ${after.slice(-200)}`)
      t7.kill()
    }
    // 7.2 终端里的命令：同样的面板；--json / 非终端：照旧直接报错
    {
      const t7 = startTui({ ud: udB, cols: 100, rows: 30, args: ['status'] })
      const s7 = await t7.waitFor(/按 Enter 让卷知窗口退出并继续/, 40000)
      check('窗口运行中', '终端里的命令（status）也显示面板', s7.includes(PANEL))
      t7.send(ESC)
      const c7 = await t7.waitExit(20000).catch(() => null)
      check('窗口运行中', '命令按 Esc 取消：退出码 3，✗ 加原因', c7 === 3 && /✗ 已取消/.test(t7.screen()), t7.screen().slice(-200))
      allRaw.push(t7.raw()); t7.kill()
      const j7 = startTui({ ud: udB, cols: 100, rows: 30, args: ['status', '--json'] })
      const cj = await j7.waitExit(40000).catch(() => null)
      const rawj = j7.raw().replace(/\r/g, '')
      check('窗口运行中', '终端里加 --json：不问，直接一行 JSON app_running，退出码 3，文字和以前一致', cj === 3 && !rawj.includes('按 Enter') && /"code":"app_running"/.test(rawj) && /请先退出卷知/.test(JSON.parse(rawj.trim()).message) && /Cmd\+Q/.test(JSON.parse(rawj.trim()).message), rawj.slice(0, 200))
      allRaw.push(j7.raw()); j7.kill()
      const pj = await runPlain(udB, ['status'])
      check('窗口运行中', '非终端：仍是原来的一行 JSON app_running，退出码 3（不会卡在等按键）', pj.code === 3 && pj.lines.length === 1 && pj.json?.code === 'app_running' && /请先退出卷知/.test(pj.json.message), pj.out.slice(0, 160))
    }
    // 7.3 窗口有任务在跑（助手对话）：Enter 之后被拒绝，窗口不退出
    {
      const run = await ctx.page.evaluate(() => window.api.agent.run({ role: 'ops', text: '慢慢说', mode: 'direct' }))
      await sleep(1500)
      const t7 = startTui({ ud: udB, cols: 100, rows: 30 })
      await t7.waitFor(/按 Enter 让卷知窗口退出并继续/, 40000)
      t7.send(ENTER)
      const c7 = await t7.waitExit(30000).catch(() => null)
      const s7 = t7.screen()
      snap(t7, '31-app-busy')
      check('窗口运行中', '窗口正在处理任务：Enter 后提示「卷知正在处理任务，请等它结束后再试」，退出码 3，窗口没有被关掉', c7 === 3 && s7.includes('卷知正在处理任务，请等它结束后再试') && await alive(), `${c7} ${s7.slice(-200)}`)
      allRaw.push(t7.raw()); t7.kill()
      await ctx.page.evaluate(sid => window.api.agent.stop(sid), run.sessionId).catch(() => undefined)
      await waitFor(async () => !(await ctx.page.evaluate(sid => window.api.agent.session(sid), run.sessionId).then(x => x?.running ?? false).catch(() => false)), 30000).catch(() => undefined)
      await sleep(1500)
    }
    // 7.4 空闲：Enter → 窗口体面退出 → 命令行接着打开
    {
      const t7 = startTui({ ud: udB, cols: 100, rows: 30 })
      await t7.waitFor(/按 Enter 让卷知窗口退出并继续/, 40000)
      t7.send(ENTER)
      const s7 = await t7.waitFor(/试试「哪些班/, 60000)
      snap(t7, '32-after-window-quit')
      check('窗口运行中', '空闲时按 Enter：窗口退出，交互界面接着打开（有开场和输入框）', /卷知窗口已退出/.test(s7) && /卷知\s+v\d/.test(s7), s7.slice(0, 200))
      const gone = await waitFor(async () => !(await alive()), 20000).then(() => true, () => false)
      check('窗口运行中', '窗口进程确实退出了（不是被杀：正常 quit，数据库已关）', gone)
      await quit(t7); t7.kill()
      ctx.app = null
      const free = await runPlain(udB, ['status'])
      check('窗口运行中', '之后命令行可以正常用', free.code === 0 && free.json?.ok === true, free.out.slice(0, 100))
    }
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
