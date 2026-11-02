// Windows 免安装版的替换脚本（src/main/update/core.ts 的 WIN_SWAP_SCRIPT）真跑一遍：只在 Windows 上运行（CI 的 windows 作业）。
//   node --experimental-strip-types --no-warnings tests/e2e/update-win-swap.mjs
// 路径带空格和中文；「旧 exe」是一个还在运行的 ping.exe 副本——脚本必须等它退出后才替换（这就是免安装版里「外层启动器还占着 exe」的情形）。
// 没覆盖到：真正的免安装版 exe 自己下载新版并启动这个脚本（需要两个真实版本和一个本地更新源，CI 里没做）；NSIS 安装版的 electron-updater。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { WIN_SWAP_SCRIPT } from '../../src/main/update/core.ts'

if (process.platform !== 'win32') { console.log('只在 Windows 上运行，跳过'); process.exit(0) }
const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-win-swap-'))
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** mode：'running' = 等旧进程退出；'dead' = pid 早就不存在，但旧 exe 仍在运行（占着文件）——验证「运行中改名」 */
async function scenario(label, mode) {
  const root = path.join(tmp, label), dir = path.join(root, '免安装 版'), work = path.join(root, 'work')
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(work)
  const target = path.join(dir, '卷知 portable.exe'), neu = `${target}.new`
  fs.copyFileSync(path.join(sys, 'ping.exe'), target)       // 旧版：会一直跑几秒的程序
  fs.copyFileSync(path.join(sys, 'whoami.exe'), neu)        // 新版：启动后马上退出
  fs.writeFileSync(`${target}.old`, 'leftover')             // 上次留下的 .old：脚本必须先清掉，不然改名会失败
  const newHash = sha(neu)
  const old = spawn(target, ['-n', '8', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 500))
  const script = path.join(tmp, `${label}.cmd`)
  fs.writeFileSync(script, WIN_SWAP_SCRIPT.replace(/\n/g, '\r\n'))
  const log = path.join(root, 'swap.log')
  const env = { ...process.env, EWB_NEW: neu, EWB_TARGET: target, EWB_TARGET_NAME: path.basename(target), EWB_LOG: log, EWB_PID: mode === 'dead' ? '999999' : String(old.pid), EWB_WORK: work }
  const t0 = Date.now()
  const r = spawnSync('cmd.exe', ['/c', script], { env, encoding: 'utf8', timeout: 120000 })
  console.log(`[${label}] 退出码 ${r.status}，${Date.now() - t0} ms；日志：${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '（无）'}`)
  assert.equal(r.status, 0, label)
  if (mode === 'running') assert.ok(Date.now() - t0 > 2000, '脚本应该等旧进程退出（ping 要跑几秒）')
  assert.equal(sha(target), newHash, '目标已换成新 exe')
  assert.ok(!fs.existsSync(neu), '.new 已移走')
  assert.ok(!fs.existsSync(work), '临时目录已清理')
  await new Promise(res => setTimeout(res, 3000))
  assert.ok(!fs.existsSync(`${target}.old`), '.old 已清理（含上次的残留）')
  assert.match(fs.readFileSync(log, 'utf8'), /replaced/)
  try { old.kill() } catch { /* 已退出 */ }
}
await scenario('wait-exit', 'running')
await scenario('rename-while-running', 'dead')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('update-win-swap ✓')
