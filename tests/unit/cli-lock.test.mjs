// M7 命令行：运行锁（窗口和命令行互斥、命令行之间互斥、陈旧锁清理）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { acquireRunLock, readLock, releaseRunLock, isProcessAlive, LOCK_FILE } from '../../src/main/cli/lock.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-lock-'))
// 另起一个「活着的别人」
const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
assert.ok(isProcessAlive(other.pid))

// 空目录：拿得到，写下 pid / mode
const a = acquireRunLock(dir, 'cli'); assert.ok(a.ok)
assert.equal(readLock(dir).pid, process.pid); assert.equal(readLock(dir).mode, 'cli')
// 同一个进程重复拿 = 拿到（不报错）
assert.ok(acquireRunLock(dir, 'cli').ok)
a.release(); assert.equal(readLock(dir), null, '释放后锁文件没了')

// 别人（活着）持有：窗口 / 命令行都拿不到，holder 里能看出是 gui 还是 cli
fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: other.pid, mode: 'gui', startedAt: 'x' }))
const g = acquireRunLock(dir, 'cli'); assert.equal(g.ok, false); assert.equal(g.holder.mode, 'gui'); assert.equal(g.holder.pid, other.pid)
fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: other.pid, mode: 'cli', startedAt: 'x' }))
const c = acquireRunLock(dir, 'gui'); assert.equal(c.ok, false); assert.equal(c.holder.mode, 'cli')
// 不是自己的锁不能释放
releaseRunLock(dir); assert.equal(readLock(dir).pid, other.pid, '别人的锁释放不掉')

// 陈旧锁：持有者已经没了 → 清掉重来
other.kill('SIGKILL')
await new Promise(r => other.on('exit', r))
assert.equal(isProcessAlive(other.pid), false)
const s = acquireRunLock(dir, 'cli'); assert.ok(s.ok, '陈旧锁被清掉'); assert.equal(readLock(dir).pid, process.pid); s.release()
// 损坏的锁文件也当陈旧
fs.writeFileSync(path.join(dir, LOCK_FILE), '不是 json'); assert.ok(acquireRunLock(dir, 'gui').ok)
fs.rmSync(dir, { recursive: true, force: true })
console.log('cli-lock.test ✓')
