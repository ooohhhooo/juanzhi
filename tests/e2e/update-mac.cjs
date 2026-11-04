// Mac 应用内更新的端到端测试：用两个真实打包的版本（旧 1.x.y、新 1.x.(y+1)），在临时目录里把旧版更新成新版。
//
//   npm run test:e2e:update-mac
//   EWB_UPDATE_OLD_DIR=<旧版 dist 输出目录>  EWB_UPDATE_NEW_DIR=<新版 dist 输出目录>   不给就自己打两次包（慢，各约 4 分钟）
//
// 流程：旧版 .app 拷到临时文件夹（不是 /Applications）→ 本地 HTTP 服务器放新版 zip + latest-mac.yml → EWB_UPDATE_FEED 指过去 →
//  A 成功：自动检查弹出小提示 → 点「更新」→ 下载校验 → 点「重启并完成更新」→ 核对：临时文件夹里的 .app 版本变了、codesign 通过、没有隔离标记、旧包 / 暂存 / 临时目录都清掉了
//  B 校验失败：服务器给的 sha512 是错的 → 界面报错、旧版原样不动
//  C 不能写入：所在文件夹只读 → 界面说明要手动更新、没有「下载并更新」按钮
// 全程临时 EWB_USER_DATA_DIR，不碰真实数据目录，不装进 /Applications。
// 重启这一步：helper 脚本里的 `open` 会被临时数据目录之外的环境启动（LaunchServices 不继承环境变量，会打开真实数据目录），所以测试里在 PATH 前面放一个假 `open`，
// 它用同样的参数直接启动新版可执行文件并带上测试用的数据目录。真实的 `open` 没有被端到端覆盖（替换、去隔离、清理都是真的）。
'use strict'
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const pkg = require('../../package.json')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`)
}
async function waitFor(fn, ms = 120000, step = 300) {
  const t0 = Date.now()
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step) }
}
const cleanEnv = extra => {
  const env = { ...process.env, ...extra }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'ELECTRON_RUN_AS_NODE']) delete env[k]
  return env
}

function buildIfNeeded() {
  let oldDir = process.env.EWB_UPDATE_OLD_DIR, newDir = process.env.EWB_UPDATE_NEW_DIR
  if (oldDir && newDir) return { oldDir, newDir }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-update-build-'))
  const [maj, min, pat] = pkg.version.split('.').map(Number)
  const newVersion = `${maj}.${min}.${pat + 1}`
  oldDir = path.join(base, 'old'); newDir = path.join(base, 'new')
  for (const [dir, version] of [[oldDir, null], [newDir, newVersion]]) {
    console.log(`[build] ${version || pkg.version} → ${dir}`)
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/dist.cjs'), 'mac'], { cwd: root, stdio: 'inherit', env: cleanEnv({ EWB_BUILD_DIR: dir, ...(version ? { EWB_DIST_VERSION: version } : {}) }) })
    if (r.status !== 0) throw new Error('打包失败')
  }
  return { oldDir, newDir }
}

const plistVersion = app => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const codesignOk = app => spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).status === 0
const hasQuarantine = app => /com\.apple\.quarantine/.test(spawnSync('/usr/bin/xattr', ['-lr', app], { encoding: 'utf8' }).stdout || '')
const exeOf = app => path.join(app, 'Contents/MacOS/卷知')
const juanzhiTemps = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('juanzhi-update-') && n !== 'juanzhi-update.log')

function serve(dir) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const f = path.join(dir, u)
    if (u.startsWith('/stall/') && u.endsWith('.zip') && fs.existsSync(f)) {   // 发一点数据后就卡住（模拟网络中断）
      res.writeHead(200, { 'content-length': fs.statSync(f).size }); res.write(Buffer.alloc(200_000)); return
    }
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res)
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)))
}

async function main() {
  if (process.platform !== 'darwin') { console.log('只在 macOS 上运行'); return }
  const { oldDir, newDir } = buildIfNeeded()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-update-e2e-'))
  const oldApp = path.join(oldDir, arch === 'arm64' ? 'mac-arm64' : 'mac', '卷知.app')
  if (!fs.existsSync(oldApp)) throw new Error('找不到旧版 .app：' + oldApp)
  const zip = fs.readdirSync(newDir).find(f => f.endsWith(`-mac-${arch}.zip`))
  const ymlSrc = fs.readFileSync(path.join(newDir, 'latest-mac.yml'), 'utf8')
  const newVersion = /^version:\s*(\S+)/m.exec(ymlSrc)[1]
  const oldVersion = plistVersion(oldApp)
  check('前提：新旧版本不同', newVersion !== oldVersion, `${oldVersion} → ${newVersion}`)

  // 服务器：/ok 正确清单；/bad 清单里的 sha512 被改坏
  const feed = path.join(work, 'feed'); fs.mkdirSync(path.join(feed, 'ok'), { recursive: true }); fs.mkdirSync(path.join(feed, 'bad')); fs.mkdirSync(path.join(feed, 'stall'))
  const notes = '\nreleaseNotes: |\n  - 一键更新（测试说明）\n  - 修复若干问题\n'
  fs.symlinkSync(path.join(newDir, zip), path.join(feed, 'ok', zip)); fs.symlinkSync(path.join(newDir, zip), path.join(feed, 'bad', zip))
  fs.symlinkSync(path.join(newDir, zip), path.join(feed, 'stall', zip)); fs.writeFileSync(path.join(feed, 'stall', 'latest-mac.yml'), ymlSrc.trimEnd() + notes)
  fs.writeFileSync(path.join(feed, 'ok', 'latest-mac.yml'), ymlSrc.trimEnd() + notes)
  fs.writeFileSync(path.join(feed, 'bad', 'latest-mac.yml'), ymlSrc.replace(/sha512: (.)/g, (m, c) => `sha512: ${c === 'A' ? 'B' : 'A'}`).trimEnd() + notes)
  const srv = await serve(feed)
  const base = `http://127.0.0.1:${srv.address().port}`

  // 假 open：用测试数据目录启动新版（见文件头注释）
  const fakeBin = path.join(work, 'bin'); fs.mkdirSync(fakeBin)
  const openLog = path.join(work, 'open.log')
  fs.writeFileSync(path.join(fakeBin, 'open'), `#!/bin/sh\necho "open $1" >> "${openLog}"\nEWB_USER_DATA_DIR="$FAKE_UD" EWB_DISABLE_UPDATE_CHECK=1 nohup "$1/Contents/MacOS/卷知" --use-mock-keychain >/dev/null 2>&1 &\n`, { mode: 0o755 })

  const tempsBefore = new Set(juanzhiTemps())
  const stagings = parent => fs.readdirSync(parent).filter(n => n.startsWith('.juanzhi-update-'))
  const launch = async (appDir, ud, feedPath, extra = {}) => {
    const env = cleanEnv({ EWB_USER_DATA_DIR: ud, EWB_UPDATE_FEED: `${base}/${feedPath}`, EWB_UPDATE_CHECK_DELAY_MS: '500', FAKE_UD: ud, PATH: `${fakeBin}:${process.env.PATH}`, ...extra })
    const app = await electron.launch({ executablePath: exeOf(path.join(appDir, '卷知.app')), args: ['--use-mock-keychain'], env, timeout: 90000 })
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid=dropzone]', { timeout: 60000 })
    return { app, page }
  }
  const freshCopy = name => {
    const dir = path.join(work, name + ' 应用 目录'); fs.mkdirSync(dir)
    execFileSync('/usr/bin/ditto', [oldApp, path.join(dir, '卷知.app')])
    return dir
  }

  try {
    // ───────── A 成功 ─────────
    {
      const dir = freshCopy('A'); const target = path.join(dir, '卷知.app'); const ud = path.join(work, 'udA')
      const before = plistVersion(target)
      fs.mkdirSync(path.join(dir, '.juanzhi-update-111')); fs.writeFileSync(path.join(dir, '.juanzhi-update-111', 'x'), 'partial')
      fs.mkdirSync(path.join(dir, '.juanzhi-update-222', 'backup'), { recursive: true })
      const { app, page } = await launch(dir, ud, 'ok')
      check('A 启动时清掉上次留下的暂存目录（没备份的删、有备份且不满一天的留）', !fs.existsSync(path.join(dir, '.juanzhi-update-111')) && fs.existsSync(path.join(dir, '.juanzhi-update-222')))
      fs.rmSync(path.join(dir, '.juanzhi-update-222'), { recursive: true })
      const notice = await page.waitForSelector('[data-testid=update-notice]', { timeout: 30000 }).catch(() => null)
      check('A 启动后静默检查，弹出新版小提示', !!notice)
      const text = notice ? await notice.innerText() : ''
      check('A 小提示带版本号、更新说明和三个按钮', text.includes('一键更新（测试说明）') && !!(await page.$('[data-testid=update-notice-later]')) && !!(await page.$('[data-testid=update-notice-skip]')), text.slice(0, 80))
      await page.screenshot({ path: path.join(work, 'A-notice.png') })
      await page.click('[data-testid=update-notice-go]')
      const inst = await page.waitForSelector('[data-testid=update-install]', { timeout: 180000 }).catch(() => null)
      check('A 下载并校验后出现「重启并完成更新」', !!inst, inst ? '' : await page.innerText('[data-testid=update-settings]').catch(() => ''))
      check('A 下载完成前旧版没有被动过', plistVersion(target) === before)
      await page.screenshot({ path: path.join(work, 'A-ready.png') })
      const closed = new Promise(r => app.process().once('exit', r))
      await page.click('[data-testid=update-install]').catch(() => undefined)
      await Promise.race([closed, sleep(60000)])
      const swapped = await waitFor(() => { try { return plistVersion(target) === newVersion } catch { return false } }, 60000)
      check('A 退出后 .app 被换成新版', !!swapped, `${plistVersion(target)}`)
      const relaunched = await waitFor(() => fs.existsSync(openLog) && spawnSync('/usr/bin/pgrep', ['-f', exeOf(target)]).status === 0, 30000)
      check('A 新版被重新打开', !!relaunched, fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim() : '没调用 open')
      // 备份和暂存目录在新版起来之后清理
      const cleaned = await waitFor(() => stagings(dir).length === 0, 30000)
      check('A 旧包备份 / 暂存目录已清理', !!cleaned, stagings(dir).join(','))
      check('A 下载 / 解压的临时目录已清理', juanzhiTemps().every(n => tempsBefore.has(n)), juanzhiTemps().filter(n => !tempsBefore.has(n)).join(','))
      spawnSync('/usr/bin/pkill', ['-f', exeOf(target)]); await sleep(2500)
      check('A codesign --verify --deep --strict 通过', codesignOk(target))
      check('A 没有 com.apple.quarantine', !hasQuarantine(target))
      const cli = spawnSync(exeOf(target), ['cli', 'status'], { env: cleanEnv({ EWB_USER_DATA_DIR: ud }), encoding: 'utf8', timeout: 60000 })
      let v = null; try { v = JSON.parse(cli.stdout).data.version } catch { /* 下面会失败 */ }
      check('A cli status 报告新版本号', v === newVersion, `${v} ${cli.stderr.slice(0, 100)}`)
      check('A 文件夹里除了卷知.app 没有别的残留', fs.readdirSync(dir).join() === '卷知.app', fs.readdirSync(dir).join())
    }

    // ───────── B 校验失败 ─────────
    {
      const dir = freshCopy('B'); const target = path.join(dir, '卷知.app'); const ud = path.join(work, 'udB')
      const snapshot = execFileSync('/usr/bin/find', [target, '-type', 'f', '-newer', '/dev/null'], { maxBuffer: 1 << 28 }).length
      const { app, page } = await launch(dir, ud, 'bad', { EWB_UPDATE_CHECK_DELAY_MS: '600000' })
      await page.evaluate(() => { location.hash = '#/settings?tab=about' })
      await page.waitForSelector('[data-testid=update-check]')
      await page.click('[data-testid=update-check]')
      await page.waitForSelector('[data-testid=update-download]', { timeout: 30000 })
      await page.click('[data-testid=update-download]')
      const err = await page.waitForSelector('[data-testid=update-error]', { timeout: 180000 }).catch(() => null)
      const t = err ? await err.innerText() : ''
      check('B sha512 不一致 → 界面报错并给「手动下载」', !!err && /不完整或被改动/.test(t) && !!(await page.$('[data-testid=update-manual]')), t.slice(0, 120))
      check('B 没有「重启并完成更新」按钮', !(await page.$('[data-testid=update-install]')))
      await page.screenshot({ path: path.join(work, 'B-error.png') })
      await app.close().catch(() => undefined); await sleep(1500)
      check('B 旧版原样不动（版本、签名、文件清单）', plistVersion(target) === oldVersion && codesignOk(target) && execFileSync('/usr/bin/find', [target, '-type', 'f', '-newer', '/dev/null'], { maxBuffer: 1 << 28 }).length === snapshot && stagings(dir).length === 0)
      check('B 失败后临时目录已清理', juanzhiTemps().every(n => tempsBefore.has(n)), juanzhiTemps().filter(n => !tempsBefore.has(n)).join(','))
    }

    // ───────── D 下载卡住 → 超时报错；E 取消下载 ─────────
    for (const [tag, extra] of [['D', { EWB_UPDATE_STALL_MS: '3000' }], ['E', { EWB_UPDATE_STALL_MS: '600000' }]]) {
      const dir = freshCopy(tag); const target = path.join(dir, '卷知.app'); const ud = path.join(work, 'ud' + tag)
      const { app, page } = await launch(dir, ud, 'stall', { EWB_UPDATE_CHECK_DELAY_MS: '600000', ...extra })
      await page.evaluate(() => { location.hash = '#/settings?tab=about' })
      await page.waitForSelector('[data-testid=update-check]')
      await page.click('[data-testid=update-check]')
      await page.waitForSelector('[data-testid=update-download]', { timeout: 30000 })
      await page.click('[data-testid=update-download]')
      if (tag === 'E') { await page.waitForSelector('[data-testid=update-cancel]', { timeout: 30000 }); await sleep(1500); await page.click('[data-testid=update-cancel]') }
      const err = await page.waitForSelector('[data-testid=update-error]', { timeout: 60000 }).catch(() => null)
      const t = err ? await err.innerText() : ''
      check(tag === 'D' ? 'D 下载卡住 30 秒（测试里 3 秒）没数据 → 友好报错' : 'E 点「取消下载」→ 回到错误状态并说明已取消', !!err && (tag === 'D' ? /下载中断/ : /已取消/).test(t) && /。/.test(t), t.replace(/\s+/g, ' ').slice(0, 100))
      check(tag + ' 旧版原样不动、没有暂存目录', plistVersion(target) === oldVersion && codesignOk(target) && stagings(dir).length === 0)
      // busyOp 已复位：可以再检查一次
      await page.click('[data-testid=update-check]'); const again = await page.waitForSelector('[data-testid=update-download]', { timeout: 30000 }).catch(() => null)
      check(tag + ' 失败后可以重新检查（状态已复位）', !!again)
      await app.close().catch(() => undefined); await sleep(1000)
      check(tag + ' 临时目录已清理', juanzhiTemps().every(n => tempsBefore.has(n)), juanzhiTemps().filter(n => !tempsBefore.has(n)).join(','))
    }

    // ───────── C 文件夹不可写 ─────────
    {
      const dir = freshCopy('C'); const ud = path.join(work, 'udC')
      fs.chmodSync(dir, 0o555)
      try {
        const { app, page } = await launch(dir, ud, 'ok', { EWB_UPDATE_CHECK_DELAY_MS: '600000' })
        await page.evaluate(() => { location.hash = '#/settings?tab=about' })
        await page.waitForSelector('[data-testid=update-check]')
        await page.click('[data-testid=update-check]')
        const b = await page.waitForSelector('[data-testid=update-blocker]', { timeout: 30000 }).catch(() => null)
        check('C 文件夹不可写 → 说明原因并给「手动下载」', !!b && !!(await page.$('[data-testid=update-manual]')), b ? (await b.innerText()).slice(0, 100) : '')
        check('C 没有「下载并更新」按钮', !(await page.$('[data-testid=update-download]')))
        await page.screenshot({ path: path.join(work, 'C-blocker.png') })
        await app.close().catch(() => undefined)
      } finally { fs.chmodSync(dir, 0o755) }
    }
  } finally {
    srv.closeAllConnections?.(); srv.close()
    spawnSync('/usr/bin/pkill', ['-f', work])
  }
  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过。截图和日志：${work}`)
  if (!failed.length) fs.rmSync(path.join(work, 'feed'), { recursive: true, force: true })
  if (fs.existsSync(path.join(os.tmpdir(), 'juanzhi-update.log'))) console.log('helper 日志：\n' + fs.readFileSync(path.join(os.tmpdir(), 'juanzhi-update.log'), 'utf8'))
  process.exit(failed.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
