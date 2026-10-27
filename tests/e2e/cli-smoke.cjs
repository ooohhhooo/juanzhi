// 命令行（M7）的冒烟：被 smoke-packaged.cjs 在窗口关闭之后调用（同一份 userData、mock AI 还活着），也可以被开发版测试调用。
//   · 从 Node 里 spawn 可执行文件：status → 导入一份 PDF（mock AI）→ 确认 → 生成老板版 / 家长版 → 导出家长版 docx（草稿标记）
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

function run(cmd, args, { env = {}, timeout = 300000, cwd } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let p
    try { p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, windowsHide: true }) } catch (e) { return resolve({ code: -1, out: '', err: String(e), json: null, ms: 0 }) }
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout)
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e), json: null, ms: Date.now() - t0 }) })
    p.on('exit', code => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).filter(l => l.trim())
      let json = null
      try { json = JSON.parse(lines[lines.length - 1] ?? '') } catch { /* 不是 JSON */ }
      resolve({ code, out, err, json, lines, ms: Date.now() - t0 })
    })
  })
}

/**
 * o = { exe, preArgs, env, check, work, isWin, isMac, mock, pkgVersion, shim, sample }
 *   exe / preArgs：可执行文件和它前面的参数（开发版是 electron + [appDir]；打包版是 exe + 可选的 --use-mock-keychain）
 *   shim：juanzhi 短命令脚本的路径（已安装时）；sample：一份没导入过的试卷文件（不同字节的副本）
 */
module.exports = async function cliSmoke(o) {
  const { exe, preArgs = [], env = {}, check, work, isWin, mock, pkgVersion, shim, sample } = o
  const cli = (args, opt = {}) => run(exe, [...preArgs, 'cli', ...args], { env, ...opt })
  const one = r => r.json && typeof r.json.ok === 'boolean' && r.lines.length === 1

  const st = await cli(['status'])
  check('CLI status', '打包版 `cli status`：退出码 0，stdout 一段 JSON，版本号对、AI 已配置、OCR 状态可读', st.code === 0 && one(st) && st.json.ok && st.json.data.version === pkgVersion && st.json.data.ai.configured === true && typeof st.json.data.ocr.available === 'boolean', `${st.code} ${st.out.slice(0, 200)} ${st.err.slice(-150)}`)
  const bad = await cli(['papers', 'show', 'not-an-id'])
  check('CLI 退出码', '失败时退出码非 0、JSON 里 ok:false 带中文 message（`papers show not-an-id` → 2）', bad.code === 2 && one(bad) && bad.json.ok === false && bad.json.code === 'usage' && /[一-鿿]/.test(bad.json.message), `${bad.code} ${bad.out.slice(0, 160)}`)

  const imp = await cli(['import', sample, '--wait', '--timeout', '900'], { timeout: 960000 })
  const pid = imp.json?.data?.papers?.[0]?.paperId
  check('CLI 导入', '`cli import <图片或 pdf> --wait`：提取（OCR / 文字层）+ mock AI 解析，等到「待审核」，返回 paperId 和题数', imp.code === 0 && imp.json?.ok && imp.json.data.papers[0].status === 'reviewing' && imp.json.data.papers[0].questions >= 3, `${imp.code} ${imp.out.slice(0, 240)} ${imp.err.slice(-200)}`)
  if (pid) {
    const cf = await cli(['papers', 'confirm', pid, '--i-reviewed'])
    check('CLI 确认', '`papers confirm <id> --i-reviewed`：整份确认', cf.code === 0 && cf.json?.data?.status === 'done', `${cf.code} ${cf.out.slice(0, 160)}`)
  }
  const boss = await cli(['report', 'generate', '--reader', 'boss', '--timeout', '600'], { timeout: 660000 })
  check('CLI 报告', '`cli report generate --reader boss`：mock AI 生成，返回 id / markdown / unverified / warnings', boss.code === 0 && boss.json?.ok && boss.json.data.markdown.length > 50 && Array.isArray(boss.json.data.unverified), `${boss.code} ${boss.out.slice(0, 160)} ${boss.err.slice(-150)}`)
  const par = await cli(['report', 'generate', '--reader', 'parent', '--timeout', '600'], { timeout: 660000 })
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
  const apiKeyLeak = [st, imp, boss, par].some(r => /sk-smoke-key/.test(r.out + r.err))
  check('CLI 密钥', '命令行的所有输出里没有 API Key', !apiKeyLeak)

  // ── Windows：GUI 子系统程序的输出和退出码 ──
  if (isWin) {
    const ps = (script, opt) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, ...opt })
    const q = s => `'${s.replace(/'/g, "''")}'`
    if (shim && fs.existsSync(shim)) {
      const a = await ps(`& ${q(shim)} status; exit $LASTEXITCODE`)
      check('CLI Windows PowerShell', 'PowerShell 里运行 juanzhi.cmd：等到进程结束，stdout 是一段 JSON，$LASTEXITCODE = 0', a.code === 0 && a.json?.ok === true && a.json.data.version === pkgVersion, `${a.code} ${a.out.slice(0, 200)} ${a.err.slice(0, 200)}`)
      const b = await ps(`& ${q(shim)} papers show not-an-id; exit $LASTEXITCODE`)
      check('CLI Windows PowerShell 退出码', 'PowerShell 里 juanzhi.cmd 失败的命令：$LASTEXITCODE = 2，JSON 里 ok:false', b.code === 2 && b.json?.ok === false && b.json.code === 'usage', `${b.code} ${b.out.slice(0, 200)}`)
      const c = await run('cmd.exe', ['/d', '/c', `"${shim}" status`], { env })
      check('CLI Windows cmd', 'cmd 里运行 juanzhi.cmd：stdout 是一段 JSON，退出码 0', c.code === 0 && c.json?.ok === true, `${c.code} ${c.out.slice(0, 200)}`)
      const d = await run('cmd.exe', ['/d', '/c', `"${shim}" papers show not-an-id`], { env })
      check('CLI Windows cmd 退出码', 'cmd 里 juanzhi.cmd 失败的命令：退出码 2', d.code === 2 && d.json?.ok === false, `${d.code} ${d.out.slice(0, 200)}`)
    } else {
      check('CLI Windows 短命令', '安装命令行工具后 juanzhi.cmd 存在', false, String(shim))
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
