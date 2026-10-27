/**
 * 运行锁（M7）：图形界面和命令行不能同时使用同一份数据，命令行之间也不能同时跑。
 *
 * 锁 = 一个「监听中的本地套接字」（Windows：命名管道；Mac / Linux：unix 套接字）。谁在监听谁就持有锁，进程死了（崩溃、强杀、断电）系统自动释放，
 * 所以没有「陈旧锁永不过期」、没有 pid 被别的进程复用的问题；也没有「删掉别人刚建的锁文件」这类竞态。
 * 持有者在别人连上来时回一行 JSON {pid, mode, startedAt}，让对方知道是窗口还是命令行、是哪个进程。
 *
 * 唯一残留的东西是 unix 套接字文件：进程崩溃后文件还在，但没人监听（连接会被拒绝）。清理它时和抢锁一样要串行化——
 * 用一个「守卫目录」（mkdir 是原子的）保护「探测 → 删除陈旧套接字 → 监听」这一段；守卫本身 10 秒后视为过期。
 * 守卫内部每个竞争者都会重新探测一次，所以不会出现「A 刚建好、B 拿着旧判断把 A 的套接字删掉」。
 *
 * 不依赖 electron，单测直接加载（含多进程并发抢锁）。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export type LockMode = 'gui' | 'cli'
export interface LockInfo { pid: number; mode: LockMode; startedAt: string }

/** 套接字路径：Windows 用命名管道；其余放在 userData 里（不受 TMPDIR 之类环境变量影响，路径太长时退回 /tmp 下按目录哈希命名） */
export function lockEndpoint(dir: string, platform: NodeJS.Platform = process.platform): string {
  const abs = path.resolve(dir)
  const hash = crypto.createHash('sha1').update(platform === 'win32' ? abs.toLowerCase() : abs).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\juanzhi-run-${hash}`
  const inDir = path.join(abs, 'ewb-run.sock')
  if (Buffer.byteLength(inDir) <= 100) return inDir      // unix 套接字路径上限约 104 字节
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `/tmp/juanzhi-${uid}-${hash}.sock`
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 连上去问一句「谁在持有」：连得上 = 活着的持有者（返回它的信息）；连不上（没人监听 / 文件是陈旧的）= null */
function probe(endpoint: string, timeoutMs = 1500): Promise<{ alive: boolean; info: LockInfo | null }> {
  return new Promise(resolve => {
    const s = net.connect(endpoint)
    let buf = ''
    let settled = false
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      s.destroy()
      let info: LockInfo | null = null
      try { const j = JSON.parse(buf.split('\n')[0]); if (j && Number.isInteger(j.pid) && (j.mode === 'gui' || j.mode === 'cli')) info = j } catch { /* 对方没来得及回 */ }
      resolve({ alive, info })
    }
    const timer = setTimeout(() => done(true), timeoutMs)   // 连上了但没回话：持有者很忙，仍然当作活着
    s.setEncoding('utf8')
    s.on('connect', () => { /* 等对方回信息；对方回完会关连接 */ })
    s.on('data', d => { buf += d })
    s.on('end', () => done(true))
    s.on('close', () => { if (buf) done(true) })
    s.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      // ECONNREFUSED / ENOENT = 没人监听（陈旧文件或根本没有）；其他错误（权限、繁忙）保守地当作活着
      done(!(code === 'ECONNREFUSED' || code === 'ENOENT'))
    })
  })
}

function listen(endpoint: string, info: LockInfo): Promise<net.Server | 'busy'> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      try { sock.end(JSON.stringify(info) + '\n') } catch { /* 对方已经走了 */ }
      sock.on('error', () => { /* 忽略 */ })
    })
    server.once('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') resolve('busy')
      else reject(e)
    })
    server.listen(endpoint, () => { server.removeAllListeners('error'); server.on('error', () => { /* 运行中的错误不影响持锁 */ }); resolve(server) })
  })
}

/** 守卫目录：保护「探测 → 清陈旧套接字 → 监听」。mkdir 原子；超过 10 秒的守卫当作持有者崩溃，清掉 */
async function withGuard<T>(guardDir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 8000
  for (;;) {
    try { fs.mkdirSync(guardDir); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(guardDir).mtimeMs > 10_000) { fs.rmdirSync(guardDir); continue } } catch { /* 刚好被别人清了 */ }
      if (Date.now() > deadline) throw new Error('抢运行锁超时（另一个进程卡在抢锁的过程里）')
      await sleep(15 + Math.floor(Math.random() * 25))
    }
  }
  try { return await fn() } finally { try { fs.rmdirSync(guardDir) } catch { /* 已经没了 */ } }
}

// ── 退路：套接字被禁止时（有的沙箱不让监听本地套接字）退回「锁文件」。内容用 link 原子地带着完整内容创建；
//    是不是陈旧看 pid 是否活着 + 启动时间是否早于本次开机；所有清理都在守卫目录里串行进行，所以没有「删掉别人新锁」的竞态。 ──
const FILE_LOCK = 'ewb-run.lock'
const bootTimeMs = (): number => Date.now() - os.uptime() * 1000
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
function readFileLock(dir: string): LockInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE_LOCK), 'utf8')) as LockInfo
    return j && Number.isInteger(j.pid) && (j.mode === 'gui' || j.mode === 'cli') ? j : null
  } catch { return null }
}
/** 锁文件的持有者还算不算活着：进程在，并且启动时间不早于本次开机（挡住「重启后 pid 被无关进程占用」） */
function fileLockAlive(i: LockInfo): boolean {
  const started = Date.parse(i.startedAt)
  if (Number.isFinite(started) && started < bootTimeMs() - 5000) return false
  return pidAlive(i.pid)
}
function acquireFileLock(dir: string, info: LockInfo): AcquireResult {
  const file = path.join(dir, FILE_LOCK)
  for (let attempt = 0; attempt < 4; attempt++) {
    const tmp = path.join(dir, `ewb-run.${info.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(info))
    try { fs.linkSync(tmp, file); fs.unlinkSync(tmp); return { ok: true, endpoint: file, release: () => { const cur = readFileLock(dir); if (cur && cur.pid === info.pid) { try { fs.unlinkSync(file) } catch { /* 已经没了 */ } } } } } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const holder = readFileLock(dir)
    if (holder && holder.pid === info.pid) { fs.writeFileSync(file, JSON.stringify(info)); return { ok: true, endpoint: file, release: () => { const cur = readFileLock(dir); if (cur && cur.pid === info.pid) { try { fs.unlinkSync(file) } catch { /* */ } } } } }
    if (holder && fileLockAlive(holder)) return { ok: false, holder }
    try { fs.unlinkSync(file) } catch { /* 已经没了 */ }   // 陈旧或损坏：在守卫里清掉再抢
  }
  return { ok: false, holder: readFileLock(dir) }
}

export type AcquireResult = { ok: true; release: () => void; endpoint: string } | { ok: false; holder: LockInfo | null }

/** 拿锁。已有活着的持有者返回 { ok:false, holder }（holder 为 null = 连得上但对方没回信息）；拿到后一直持有到 release() 或进程结束 */
export async function acquireRunLock(dir: string, mode: LockMode, pid = process.pid): Promise<AcquireResult> {
  fs.mkdirSync(dir, { recursive: true })
  const endpoint = lockEndpoint(dir)
  const info: LockInfo = { pid, mode, startedAt: new Date().toISOString() }
  const guard = path.join(dir, 'ewb-run.guard')
  return withGuard(guard, async (): Promise<AcquireResult> => {
    // 先看有没有「锁文件」形式的活持有者（上一个被禁止监听套接字的进程留下的）
    const fl = readFileLock(dir)
    if (fl && fl.pid !== pid && fileLockAlive(fl)) return { ok: false, holder: fl }
    for (let attempt = 0; attempt < 4; attempt++) {
      let s: net.Server | 'busy'
      try { s = await listen(endpoint, info) } catch (e) {
        // 不让监听（沙箱）：退回锁文件
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EAFNOSUPPORT') return acquireFileLock(dir, info)
        throw e
      }
      if (s !== 'busy') {
        let released = false
        const release = () => {
          if (released) return
          released = true
          try { s.close() } catch { /* 已关闭 */ }
          if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint) } catch { /* 已经没了 */ } }
        }
        return { ok: true, release, endpoint }
      }
      const p = await probe(endpoint)
      if (p.alive) return { ok: false, holder: p.info }
      // 连不上：陈旧的套接字文件（上一个持有者崩溃了）。守卫保证此刻没有别的竞争者在清理 / 抢锁
      try { fs.unlinkSync(endpoint) } catch { /* 已经没了 */ }
    }
    return { ok: false, holder: null }
  })
}

/** 只读地看现在是谁持有（不抢锁）：没人持有返回 null */
export async function inspectRunLock(dir: string): Promise<LockInfo | null> {
  const p = await probe(lockEndpoint(dir))
  if (p.alive) return p.info ?? { pid: 0, mode: 'cli', startedAt: '' }
  const fl = readFileLock(dir)
  return fl && fileLockAlive(fl) ? fl : null
}

