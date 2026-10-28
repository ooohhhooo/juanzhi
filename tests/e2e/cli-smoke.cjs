// 命令行（M7）的冒烟：被 smoke-packaged.cjs 在窗口关闭之后调用（同一份 userData、mock AI 还活着），也可以被开发版测试调用。
//   · 从 Node 里 spawn 可执行文件：status → 导入一份 PDF（mock AI）→ 确认 → 生成老板版 / 家长版 → 导出家长版 docx（草稿标记）
//   · 环境里带 ELECTRON_RUN_AS_NODE=1（WorkBuddy、VS Code 终端等基于 Electron 的 Agent）时，直接调用可执行文件、通过 juanzhi 短命令都要照样返回 ok:true（打包版关了 RunAsNode 熔丝）
//   · Windows 额外验证「GUI 子系统程序拿不到输出和退出码」这个问题的解法：
//       - juanzhi.cmd 在 PowerShell 和 cmd 里都是同步的，读得到 stdout 和退出码（成功 0、失败非 0）
//       - 直接调用 exe：--result-file + Start-Process -Wait -PassThru 读得到结果和退出码
//       - 直接调用 exe 再接管道（| Out-String）：只记录能不能拿到 stdout（软检查，不算失败）
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')

const BANNER = 'AI 草稿 · 未经老师核对，请勿直接发给家长'
const squash = s => s.normalize('NFKC').replace(/⻓/g, '长').replace(/\s+/g, '')

function run(cmd, args, { env = {}, timeout = 300000, cwd, verbatim = false } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let p
    try { p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, windowsHide: true, windowsVerbatimArguments: verbatim }) } catch (e) { return resolve({ code: -1, out: '', err: String(e), json: null, ms: 0 }) }
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout)
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e), json: null, ms: Date.now() - t0 }) })
    p.on('close', code => {   // close（不是 exit）：stdout / stderr 管道读完了才算结束，不会读到截断的 JSON
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).filter(l => l.trim())
      let json = null
      try { json = JSON.parse(lines[lines.length - 1] ?? '') } catch { /* 不是 JSON */ }
      resolve({ code, out, err, json, lines, ms: Date.now() - t0 })
    })
  })
}

/**
 * o = { exe, preArgs, env, userData, check, work, isWin, isMac, mock, pkgVersion, shim, sample }
 *   env 必须带 EWB_USER_DATA_DIR（临时目录）：没带就直接报错，不能让命令行碰到真实数据目录；userData = 同一个临时目录，用来核对每条命令输出的 dataDir
 *   exe / preArgs：可执行文件和它前面的参数（开发版是 electron + [appDir]；打包版是 exe + 可选的 --use-mock-keychain）
 *   shim：juanzhi 短命令脚本的路径（已安装时）；sample：一份没导入过的试卷文件（不同字节的副本）
 */
module.exports = async function cliSmoke(o) {
  const { exe, preArgs = [], env = {}, userData, check, work, isWin, mock, pkgVersion, shim, sample } = o
  // 守卫：命令行必须用临时数据目录（评审 P1-7：之前没传，打包版命令行读写了真实的数据目录）
  if (!env.EWB_USER_DATA_DIR || !userData || path.resolve(env.EWB_USER_DATA_DIR) !== path.resolve(userData)) throw new Error('cli-smoke：没有把临时 EWB_USER_DATA_DIR 传给命令行，拒绝运行（会读写真实数据目录）')
  const cli = (args, opt = {}) => run(exe, [...preArgs, 'cli', ...args], { env, ...opt })
  const everything = []   // 所有命令行输出、导出文件的文字、结果文件：最后一起搜密钥
  const note = r => { everything.push(r.out, r.err); return r }
  const crashed = r => r.code === null || r.code < 0 || r.code > 255   // 访问违规（0xC0000005）之类：进程崩溃
  const one = r => r.json && typeof r.json.ok === 'boolean' && r.lines.length === 1

  const st = note(await cli(['status']))
  // 再核对一次：命令行报告的数据目录必须在临时目录下
  if (!(st.json?.data?.dataDir || '').startsWith(path.resolve(userData))) { check('CLI 数据目录', `命令行用的数据目录必须是临时目录（${userData}），不能是真实数据目录`, false, st.json?.data?.dataDir ?? st.out.slice(0, 200)); throw new Error('命令行没有使用临时数据目录，中止') }
  check('CLI 数据目录', '命令行用的是传进去的临时数据目录（不是真实数据目录）', true, st.json.data.dataDir)
  check('CLI status', '打包版 `cli status`：退出码 0，stdout 一段 JSON，版本号对、AI 已配置、OCR 状态可读', st.code === 0 && one(st) && st.json.ok && st.json.data.version === pkgVersion && st.json.data.ai.configured === true && typeof st.json.data.ocr.available === 'boolean', `${st.code} ${st.out.slice(0, 200)} ${st.err.slice(-150)}`)
  const bad = note(await cli(['papers', 'show', 'not-an-id']))
  check('CLI 退出码', '失败时退出码非 0、JSON 里 ok:false 带中文 message（`papers show not-an-id` → 2）', bad.code === 2 && one(bad) && bad.json.ok === false && bad.json.code === 'usage' && /[一-鿿]/.test(bad.json.message), `${bad.code} ${bad.out.slice(0, 160)}`)

  const imp = note(await cli(['import', sample, '--wait', '--timeout', '900'], { timeout: 960000 }))
  const pid = imp.json?.data?.papers?.[0]?.paperId
  check('CLI 导入', '`cli import <图片或 pdf> --wait`：提取（OCR / 文字层）+ mock AI 解析，等到「待审核」，返回 paperId 和题数', imp.code === 0 && imp.json?.ok && imp.json.data.papers[0].status === 'reviewing' && imp.json.data.papers[0].questions >= 3, `${imp.code} ${imp.out.slice(0, 240)} ${imp.err.slice(-200)}`)
  if (pid) {
    const cf = await cli(['papers', 'confirm', pid, '--i-reviewed'])
    check('CLI 确认', '`papers confirm <id> --i-reviewed`：整份确认', cf.code === 0 && cf.json?.data?.status === 'done', `${cf.code} ${cf.out.slice(0, 160)}`)
  }
  const boss = note(await cli(['report', 'generate', '--reader', 'boss', '--timeout', '600'], { timeout: 660000 }))
  check('CLI 报告', '`cli report generate --reader boss`：mock AI 生成，返回 id / markdown / unverified / warnings', boss.code === 0 && boss.json?.ok && boss.json.data.markdown.length > 50 && Array.isArray(boss.json.data.unverified), `${boss.code} ${boss.out.slice(0, 160)} ${boss.err.slice(-150)}`)
  const par = note(await cli(['report', 'generate', '--reader', 'parent', '--timeout', '600'], { timeout: 660000 }))
  check('CLI 家长版草稿', '家长版没有老师核对：返回 parentDraft = true 和「AI 草稿 · 未经老师核对，请勿直接发给家长」', par.code === 0 && par.json?.data?.parentDraft === true && (par.json.data.warning || '').includes(BANNER), `${par.code} ${par.out.slice(0, 160)}`)
  if (par.json?.data?.id) {
    const f = path.join(work, 'cli-parent-draft.docx')
    const ex = await cli(['report', 'export', par.json.data.id, '--format', 'docx', '--out', f])
    let xml = ''
    try { xml = (await (await JSZip.loadAsync(fs.readFileSync(f))).file('word/document.xml').async('string')).replace(/<[^>]+>/g, '') } catch { /* 文件没生成 */ }
    check('CLI 导出', '`cli report export <家长版> --format docx`：文件里有草稿标记，JSON 里 draft = true', ex.code === 0 && ex.json?.data?.draft === true && squash(xml).includes(squash(BANNER)), `${ex.code} ${ex.out.slice(0, 200)}`)
    const pdfExport = await cli(['report', 'export', par.json.data.id, '--format', 'pdf', '--out', path.join(work, 'cli-parent-draft.pdf')])
    check('CLI 导出 PDF', '打包版用命令行导出 PDF（隐藏的离屏窗口 printToPDF）：成功，%PDF 头', pdfExport.code === 0 && fs.existsSync(path.join(work, 'cli-parent-draft.pdf')) && fs.readFileSync(path.join(work, 'cli-parent-draft.pdf')).subarray(0, 5).toString('latin1') === '%PDF-', `${pdfExport.code} ${pdfExport.out.slice(0, 160)}`)
  }
  check('CLI 没有崩溃', '命令行的每个命令都正常结束（退出码在 0–255 之内，没有访问违规 0xC0000005 之类的崩溃），并且都有 JSON 输出', [st, bad, imp, boss, par].every(r => !crashed(r) && r.json), [st, bad, imp, boss, par].map(r => crashed(r) || !r.json ? `${r.code}: ${r.err.slice(-300)}` : r.code).join(' | '))
  // 密钥：所有输出、导出的文件文字、结果文件里都不能有 API Key，也不能有加密后的密钥字段名
  for (const f of ['cli-parent-draft.docx', 'cli-parent-draft.pdf']) { try { everything.push(fs.readFileSync(path.join(work, f)).toString('latin1')) } catch { /* 没生成 */ } }
  const apiKeyLeak = everything.join('\n').match(/sk-smoke-key|ai_key_enc/)
  check('CLI 密钥', '命令行的所有输出和导出的文件里没有 API Key，也没有 ai_key_enc 字样', !apiKeyLeak, apiKeyLeak ? String(apiKeyLeak[0]) : '')

  // ── ELECTRON_RUN_AS_NODE=1（WorkBuddy、VS Code 终端等基于 Electron 的 Agent 会带着它）：打包版关了 RunAsNode 熔丝，必须照样当卷知运行 ──
  // 上面的 GUI 启动和普通命令行检查都是干净环境，这个问题以前被它们藏住了（smoke-packaged 会删掉这个变量）
  const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  const okStatus = r => r.code === 0 && one(r) && r.json.ok === true && r.json.data.version === pkgVersion && (r.json.data.dataDir || '').startsWith(path.resolve(userData))
  if (!isWin) {
    const direct = note(await run(exe, [...preArgs, 'cli', 'status'], { env: nodeEnv }))
    check('CLI ELECTRON_RUN_AS_NODE 直接调用', '环境里有 ELECTRON_RUN_AS_NODE=1 时直接调用可执行文件：`cli status` 仍是 ok:true 的 JSON，退出码 0（不是 Cannot find module / bad option）', okStatus(direct), `${direct.code} ${direct.out.slice(0, 160)} ${direct.err.slice(-200)}`)
    const flag = note(await run(exe, [...preArgs, 'cli', 'status', '--app=x'], { env: nodeEnv }))
    check('CLI ELECTRON_RUN_AS_NODE 带参数', '同样的环境里 `cli status --app=x` 不报 bad option（参数交给卷知自己解析）', !/bad option/.test(flag.out + flag.err) && !!flag.json, `${flag.code} ${(flag.out + flag.err).slice(0, 200)}`)
    if (shim && fs.existsSync(shim)) {
      const viaShim = note(await run(shim, ['status'], { env: nodeEnv }))
      check('CLI ELECTRON_RUN_AS_NODE 短命令', '环境里有 ELECTRON_RUN_AS_NODE=1 时运行已安装的 juanzhi 短命令：ok:true，退出码 0', okStatus(viaShim), `${viaShim.code} ${viaShim.out.slice(0, 160)} ${viaShim.err.slice(-200)}`)
    } else {
      check('CLI ELECTRON_RUN_AS_NODE 短命令', '没有安装短命令 juanzhi，跳过短命令检查（只在 CI 或 EWB_SMOKE_INSTALL_CLI=1 时安装；CI 上缺它就是失败）', process.env.CI !== 'true', String(shim))
    }
  }

  // ── Windows：GUI 子系统程序的输出和退出码 ──
  if (isWin) {
    const ps = (script, opt) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, ...opt })
    const q = s => `'${s.replace(/'/g, "''")}'`
    if (shim && fs.existsSync(shim)) {
      const a = await ps(`& ${q(shim)} status; exit $LASTEXITCODE`)
      check('CLI Windows PowerShell', 'PowerShell 里运行 juanzhi.cmd：等到进程结束，stdout 是一段 JSON，$LASTEXITCODE = 0', a.code === 0 && a.json?.ok === true && a.json.data.version === pkgVersion, `${a.code} ${a.out.slice(0, 200)} ${a.err.slice(0, 200)}`)
      check('CLI Windows 输出编码', 'juanzhi 的 stdout 是纯 ASCII（中文写成 \\uXXXX）：任何控制台编码下都不会乱码，解析出来是正确的中文', /^[\x00-\x7f]*$/.test(a.out) && a.json?.ok === true, JSON.stringify(a.out.slice(0, 80)))
      const b = await ps(`& ${q(shim)} papers show not-an-id; exit $LASTEXITCODE`)
      check('CLI Windows PowerShell 退出码', 'PowerShell 里 juanzhi.cmd 失败的命令：$LASTEXITCODE = 2，JSON 里 ok:false', b.code === 2 && b.json?.ok === false && b.json.code === 'usage' && /试卷 id/.test(b.json.message) && /^[\x00-\x7f]*$/.test(b.out), `${b.code} ${b.out.slice(0, 200)}`)
      const c = await run('cmd.exe', ['/d', '/s', '/c', `""${shim}" status"`], { env, verbatim: true })
      check('CLI Windows cmd', 'cmd 里运行 juanzhi.cmd：stdout 是一段 JSON，退出码 0', c.code === 0 && c.json?.ok === true, `${c.code} ${c.out.slice(0, 200)}`)
      const d = await run('cmd.exe', ['/d', '/s', '/c', `""${shim}" papers show not-an-id"`], { env, verbatim: true })
      check('CLI Windows cmd 退出码', 'cmd 里 juanzhi.cmd 失败的命令：退出码 2', d.code === 2 && d.json?.ok === false, `${d.code} ${d.out.slice(0, 200)}`)
    } else {
      check('CLI Windows 短命令', `没有安装短命令 juanzhi.cmd，跳过 PowerShell / cmd 里的 juanzhi 检查（只在 CI 或 EWB_SMOKE_INSTALL_CLI=1 时安装；CI 上缺它就是失败）`, process.env.CI !== 'true', String(shim))
    }
    // ELECTRON_RUN_AS_NODE=1：直接调用 exe（熔丝关了，必须忽略它）和 juanzhi.cmd（脚本里还会再清一次），PowerShell 和 cmd 里都验证
    {
      const rfn = path.join(work, 'direct-run-as-node.json')
      const n1 = await ps(`$p = Start-Process -FilePath ${q(exe)} -ArgumentList 'cli','status','--result-file',${q(rfn)} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`, { env: nodeEnv })
      const rn = fs.existsSync(rfn) ? JSON.parse(fs.readFileSync(rfn, 'utf8')) : null
      check('CLI ELECTRON_RUN_AS_NODE 直接调用', 'Windows：环境里有 ELECTRON_RUN_AS_NODE=1 时直接调用 exe：退出码 0，结果文件里 ok:true、版本号对', n1.code === 0 && rn?.ok === true && rn.data.version === pkgVersion, `${n1.code} ${n1.err.slice(0, 200)}`)
      if (shim && fs.existsSync(shim)) {
        const n2 = note(await ps(`& ${q(shim)} status; exit $LASTEXITCODE`, { env: nodeEnv }))
        check('CLI ELECTRON_RUN_AS_NODE PowerShell', 'PowerShell 里环境带 ELECTRON_RUN_AS_NODE=1 运行 juanzhi.cmd：ok:true，$LASTEXITCODE = 0', okStatus(n2), `${n2.code} ${n2.out.slice(0, 200)} ${n2.err.slice(0, 200)}`)
        const n3 = note(await run('cmd.exe', ['/d', '/s', '/c', `""${shim}" status"`], { env: nodeEnv, verbatim: true }))
        check('CLI ELECTRON_RUN_AS_NODE cmd', 'cmd 里环境带 ELECTRON_RUN_AS_NODE=1 运行 juanzhi.cmd：ok:true，退出码 0', okStatus(n3), `${n3.code} ${n3.out.slice(0, 200)}`)
      }
    }
    // 直接调用 exe：--result-file + Start-Process -Wait -PassThru
    const rf = path.join(work, 'direct-result.json')
    const e1 = await ps(`$p = Start-Process -FilePath ${q(exe)} -ArgumentList 'cli','status','--result-file',${q(rf)} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`)
    const r1 = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null
    check('CLI Windows 直接调用', '直接调用 exe：Start-Process -Wait -PassThru 等到结束，退出码 0，--result-file 里是结果 JSON', e1.code === 0 && r1?.ok === true, `${e1.code} ${e1.err.slice(0, 200)}`)
    const rf2 = path.join(work, 'direct-fail.json')
    const e2 = await ps(`$p = Start-Process -FilePath ${q(exe)} -ArgumentList 'cli','bogus','--result-file',${q(rf2)} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`)
    check('CLI Windows 直接调用 退出码', '直接调用 exe 失败的命令：退出码 2，结果文件里 ok:false', e2.code === 2 && fs.existsSync(rf2) && JSON.parse(fs.readFileSync(rf2, 'utf8')).ok === false, `${e2.code}`)
    // 软检查：直接调用后接管道，stdout 能不能拿到（记录下来，不算失败）
    const e3 = await ps(`$o = & ${q(exe)} cli status | Out-String; Write-Output $o`)
    let piped = null
    try { piped = JSON.parse(e3.out.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* 没拿到 */ }
    check('CLI Windows 管道（软检查）', `直接调用 exe 再接管道，stdout ${piped?.ok ? '拿得到' : '拿不到'}（只记录，不算失败；拿不到就用 juanzhi.cmd 或 --result-file）`, true, `${e3.code} ${e3.out.slice(0, 160)}`)
  }
}
