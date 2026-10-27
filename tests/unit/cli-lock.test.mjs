// M7 命令行：运行锁（套接字 = 持有者活着才持有）。窗口和命令行互斥、命令行之间互斥、崩溃后自动释放、多进程并发抢锁不会有两个持有者。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireRunLock, inspectRunLock, lockEndpoint } from '../../src/main/cli/lock.ts'

const LOCK_TS = fileURLToPath(new URL('../../src/main/cli/lock.ts', import.meta.url))
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-lock-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 子进程脚本：抢锁，抢到就持有 HOLD 毫秒并打印进入 / 退出时间；没抢到打印 busy
const CHILD = `
import { acquireRunLock } from ${JSON.stringify(LOCK_TS)}
const [dir, mode, hold, startAt] = process.argv.slice(2)
const wait = Number(startAt) - Date.now()
if (wait > 0) await new Promise(r => setTimeout(r, wait))
const r = await acquireRunLock(dir, mode)
if (!r.ok) { console.log(JSON.stringify({ busy: true, holder: r.holder })); process.exit(0) }
const t0 = Date.now()
await new Promise(r => setTimeout(r, Number(hold)))
const t1 = Date.now()
r.release()
console.log(JSON.stringify({ busy: false, t0, t1 }))
process.exit(0)
`
const childFile = path.join(os.tmpdir(), `ewb-lock-child-${process.pid}.mjs`)
fs.writeFileSync(childFile, CHILD)
const runChild = (dir, mode, hold, startAt) => new Promise(resolve => {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', childFile, dir, mode, String(hold), String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()) } catch { /* 下面断言会报 */ } resolve({ code, j, err }) })
})

// ── 基本：拿得到、别人拿不到并且能看出持有者是谁、释放后又能拿 ──
{
  const dir = mkdir()
  assert.equal(await inspectRunLock(dir), null, '没人持有')
  const a = await acquireRunLock(dir, 'cli'); assert.ok(a.ok)
  const seen = await inspectRunLock(dir); assert.equal(seen.pid, process.pid); assert.equal(seen.mode, 'cli')
  const b = await acquireRunLock(dir, 'gui'); assert.equal(b.ok, false); assert.equal(b.holder.mode, 'cli'); assert.equal(b.holder.pid, process.pid)
  a.release(); a.release()   // 重复释放不报错
  assert.equal(await inspectRunLock(dir), null)
  const c = await acquireRunLock(dir, 'gui'); assert.ok(c.ok); c.release()
  // 套接字路径：Windows 是命名管道；其余在 userData 里，太长时退回 /tmp 下按哈希命名
  assert.match(lockEndpoint('C:\\Users\\张三\\AppData\\Roaming\\english-exam-workbench', 'win32'), /^\\\\\.\\pipe\\juanzhi-run-[0-9a-f]{16}$/)
  assert.equal(lockEndpoint('/a/b', 'darwin'), '/a/b/ewb-run.sock')
  assert.match(lockEndpoint('/' + 'x'.repeat(120), 'darwin'), /^\/tmp\/juanzhi-\d+-[0-9a-f]{16}\.sock$/)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 别的进程持有（窗口 / 命令行）：这里拿不到，且知道是谁 ──
{
  const dir = mkdir()
  const holder = runChild(dir, 'gui', 1500, 0)
  await sleep(600)
  const r = await acquireRunLock(dir, 'cli')
  assert.equal(r.ok, false); assert.equal(r.holder.mode, 'gui'); assert.ok(r.holder.pid > 0 && r.holder.pid !== process.pid)
  assert.equal((await holder).j.busy, false)
  const again = await acquireRunLock(dir, 'cli'); assert.ok(again.ok, '持有者退出后可以拿'); again.release()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 崩溃（SIGKILL）：系统自动释放，没有陈旧锁；留下的陈旧套接字文件被清掉 ──
{
  const dir = mkdir()
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', childFile, dir, 'cli', '60000', '0'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !(await inspectRunLock(dir)); i++) await sleep(100)
  assert.ok(await inspectRunLock(dir), '子进程持有锁')
  p.kill('SIGKILL'); await new Promise(r => p.on('exit', r))
  if (process.platform !== 'win32') assert.ok(fs.existsSync(lockEndpoint(dir)), '崩溃后套接字文件还在（陈旧）')
  assert.equal(await inspectRunLock(dir), null, '但没人持有')
  const a = await acquireRunLock(dir, 'gui'); assert.ok(a.ok, '陈旧套接字被清掉，拿到锁'); a.release()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 多进程并发：4 个进程同一时刻抢，每个持有 150ms，同一时刻最多一个持有者；抢到的 + busy 的 = 4（没有进程卡住或崩溃）──
async function race(rounds, beforeEach) {
  const overlaps = []
  for (let r = 0; r < rounds; r++) {
    const dir = mkdir()
    if (beforeEach) await beforeEach(dir)
    const startAt = Date.now() + 1500
    const res = await Promise.all(Array.from({ length: 4 }, (_, i) => runChild(dir, i % 2 ? 'gui' : 'cli', 150, startAt)))
    assert.ok(res.every(x => x.code === 0 && x.j), `子进程都正常结束：${JSON.stringify(res.map(x => [x.code, x.err.slice(0, 120)]))}`)
    const held = res.filter(x => !x.j.busy).map(x => [x.j.t0, x.j.t1]).sort((a, b) => a[0] - b[0])
    assert.ok(held.length >= 1, '至少有一个拿到锁')
    for (let i = 1; i < held.length; i++) if (held[i][0] < held[i - 1][1]) overlaps.push({ r, held })
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(overlaps, [], '同一时刻只能有一个持有者')
}
await race(5)
// 起点是「崩溃留下的陈旧套接字」（评审里 30 轮有 21 轮出现重叠的场景）
if (process.platform !== 'win32') {
  await race(5, async dir => {
    const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', childFile, dir, 'cli', '60000', '0'], { stdio: 'ignore' })
    for (let i = 0; i < 100 && !(await inspectRunLock(dir)); i++) await sleep(100)
    p.kill('SIGKILL'); await new Promise(r => p.on('exit', r))
  })
}
fs.rmSync(childFile, { force: true })
console.log('cli-lock.test ✓')
