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
import { execFileSync } from 'node:child_process'

export type LockMode = 'gui' | 'cli'
export interface LockInfo {
  pid: number; mode: LockMode; startedAt: string
  /** 套接字持有者写的「伴随」锁文件带这个标记：能监听套接字的进程只要自己 listen 成功，就说明没有活着的套接字持有者，带标记的锁文件一定是陈旧的（不按 pid 判，pid 可能被别的进程复用） */
  socket?: boolean
}

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
function probe(endpoint: string, timeoutMs = 1500): Promise<{ alive: boolean | null; info: LockInfo | null }> {
  return new Promise(resolve => {
    const s = net.connect(endpoint)
    let buf = ''
    let settled = false
    // alive: true = 连上了（持有者活着）；false = 没人监听；null = 连不了（沙箱禁止连接 / 权限），不知道
    const done = (alive: boolean | null) => {
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
      // ECONNREFUSED / ENOENT = 没人监听（陈旧文件或根本没有）；EPERM / EACCES = 沙箱不让连接，不知道（null）；其他错误保守地当作活着
      done(code === 'ECONNREFUSED' || code === 'ENOENT' ? false : code === 'EPERM' || code === 'EACCES' ? null : true)
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
/** 本次开机时间；拿不到（有的沙箱里 os.uptime() 抛 EPERM）返回 null——调用方只用 pid 判断，不能因为这个抛异常 */
const bootTimeMs = (): number | null => { try { return Date.now() - os.uptime() * 1000 } catch { return null } }
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
/**
 * 这个 pid 现在是不是卷知的进程：true / false；判断不了（没有 ps / tasklist、沙箱不让跑）返回 null。
 * 判断得了而且不是卷知 = pid 已经被别的程序复用，锁文件是陈旧的。
 */
/** 命令行里出现卷知的程序（.app 里的可执行文件、Windows 的 exe）或开发 / 测试时的 Electron 本体；不匹配任意带项目路径的进程 */
const PROCESS_NAME_RE = /卷知\.app\/Contents\/MacOS\/|\/MacOS\/卷知|EnglishExamWorkbench\.exe|Juanzhi|Electron\.app\/Contents\/MacOS\/Electron/i
export function pidIsJuanzhi(pid: number, platform: NodeJS.Platform = process.platform, run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    if (platform === 'win32') {
      const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      return /EnglishExamWorkbench\.exe|Juanzhi/i.test(out)
    }
    const cmd = run('ps', ['-p', String(pid), '-o', 'command=']).trim()
    if (!cmd) return null   // ps 没输出：进程刚退出或 ps 被限制，不下结论
    return PROCESS_NAME_RE.test(cmd)
  } catch { return null }
}
let nameCheck: (pid: number) => boolean | null = pid => pidIsJuanzhi(pid)
/** 单测用：替换「这个 pid 是不是卷知」的判断 */
export function __setNameCheck(fn: ((pid: number) => boolean | null) | null): void { nameCheck = fn ?? (pid => pidIsJuanzhi(pid)) }

/** 锁文件的持有者还算不算活着：进程在、启动时间不早于本次开机、进程名（判断得了的话）确实是卷知——挡住「重启 / 崩溃后 pid 被无关进程占用」 */
function fileLockAlive(i: LockInfo): boolean {
  const started = Date.parse(i.startedAt)
  const boot = bootTimeMs()
  if (boot !== null && Number.isFinite(started) && started < boot - 5000) return false
  if (!pidAlive(i.pid)) return false
  return nameCheck(i.pid) !== false
}
/** 套接字持有者同时写一份锁文件（best-effort，原子地带着完整内容创建）：让「禁止监听套接字的沙箱里的命令行」也能看见持有者。返回清理函数 */
function writeCompanionLock(dir: string, info0: LockInfo): () => void {
  const info: LockInfo = { ...info0, socket: true }
  const file = path.join(dir, FILE_LOCK)
  const tmp = path.join(dir, `ewb-run.${info.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(info))
    try { fs.unlinkSync(file) } catch { /* 没有旧文件 */ }   // 能走到这里说明没有活着的文件持有者（调用方已检查），旧的是陈旧文件
    fs.linkSync(tmp, file)
  } catch { /* 目录只读之类：没有锁文件，套接字照样有效 */ } finally { try { fs.unlinkSync(tmp) } catch { /* 忽略 */ } }
  return () => { const cur = readFileLock(dir); if (cur && cur.pid === info.pid) { try { fs.unlinkSync(file) } catch { /* 已经没了 */ } } }
}

function acquireFileLock(dir: string, info: LockInfo, socketGone = false): AcquireResult {
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
    // socketGone = 刚探测过、确定没人监听套接字：带 socket 标记的伴随锁文件（套接字持有者写的）一定是陈旧的，和 inspectRunLock 一致
    if (holder && !(socketGone && holder.socket) && fileLockAlive(holder)) return { ok: false, holder }
    try { fs.unlinkSync(file) } catch { /* 已经没了 */ }   // 陈旧或损坏：在守卫里清掉再抢
  }
  return { ok: false, holder: readFileLock(dir) }
}

export type AcquireResult = { ok: true; release: () => void; endpoint: string } | { ok: false; holder: LockInfo | null }

/** 拿锁。已有活着的持有者返回 { ok:false, holder }（holder 为 null = 连得上但对方没回信息）；拿到后一直持有到 release() 或进程结束 */
export async function acquireRunLock(dir: string, mode: LockMode, pid = process.pid, opts: { noSocket?: boolean } = {}): Promise<AcquireResult> {
  fs.mkdirSync(dir, { recursive: true })
  const endpoint = lockEndpoint(dir)
  const info: LockInfo = { pid, mode, startedAt: new Date().toISOString() }
  const guard = path.join(dir, 'ewb-run.guard')
  return withGuard(guard, async (): Promise<AcquireResult> => {
    // 先看有没有「只有锁文件」的活持有者（被禁止监听套接字的沙箱里的命令行写的，没有 socket 标记）。带 socket 标记的伴随锁文件这里不看：
    // 能监听的进程只要 listen 成功，就说明没有活着的套接字持有者，那份文件一定是陈旧的（按 pid 判会被「pid 被复用」卡住）
    const fl = readFileLock(dir)
    if (fl && !fl.socket && fl.pid !== pid && fileLockAlive(fl)) return { ok: false, holder: fl }
    for (let attempt = 0; attempt < 4; attempt++) {
      let s: net.Server | 'busy'
      try {
        if (opts.noSocket) throw Object.assign(new Error('测试：模拟沙箱禁止监听套接字'), { code: 'EPERM' })   // 只给单测用
        s = await listen(endpoint, info)
      } catch (e) {
        // 不让监听（沙箱）：退回锁文件
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EAFNOSUPPORT') {
          // 本进程不能监听套接字（沙箱）。先看有没有套接字持有者（连接有时不受沙箱限制）；连不了就靠持有者同时写的锁文件
          const pr = await probe(endpoint)
          if (pr.alive === true) return { ok: false, holder: pr.info }
          // 连不上（没人监听，或沙箱不让连）：带 socket 标记的伴随锁文件和只有文件的锁一样，按 pid + 启动时间 + 进程名判断
          return acquireFileLock(dir, info, pr.alive === false)
        }
        throw e
      }
      if (s !== 'busy') {
        let released = false
        const dropCompanion = writeCompanionLock(dir, info)
        const release = () => {
          if (released) return
          released = true
          dropCompanion()
          try { s.close() } catch { /* 已关闭 */ }   // unix 套接字文件由 close() 一起删掉；这里不再手动 unlink（可能删到下一个持有者刚建的）
        }
        return { ok: true, release, endpoint }
      }
      const p = await probe(endpoint)
      if (p.alive !== false) return { ok: false, holder: p.info }   // true = 活着；null = 连不了（不知道）：保守地当作被占用
      // 连不上：陈旧的套接字文件（上一个持有者崩溃了）。守卫保证此刻没有别的竞争者在清理 / 抢锁
      try { fs.unlinkSync(endpoint) } catch { /* 已经没了 */ }
    }
    return { ok: false, holder: null }
  })
}

/** 只读地看现在是谁持有（不抢锁）：没人持有返回 null */
export async function inspectRunLock(dir: string): Promise<LockInfo | null> {
  const p = await probe(lockEndpoint(dir))
  if (p.alive === true) return p.info ?? { pid: 0, mode: 'cli', startedAt: '' }
  const fl = readFileLock(dir)
  if (!fl) return null
  // 能确定「没人监听」（p.alive === false）时，带 socket 标记的伴随锁文件就是陈旧的
  if (fl.socket && p.alive === false) return null
  return fileLockAlive(fl) ? fl : null
}


/**
 * 这个 pid 现在是不是卷知的进程（杀进程之前用：pid 可能已经被别的程序复用）。Mac：命令行里有「卷知」「english-exam-workbench」或 electron 且带 cli；
 * Windows：tasklist 里是 EnglishExamWorkbench.exe（免安装版是 Juanzhi-*-portable.exe 解压出来的同一个 exe 名）。查不到 / 判断不了返回 false（宁可不杀）。
 */
export function processLooksLikeJuanzhi(pid: number, platform: NodeJS.Platform = process.platform, run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: 'utf8', timeout: 4000 })): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    if (platform === 'win32') return /EnglishExamWorkbench\.exe/i.test(run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']))
    const cmd = run('ps', ['-p', String(pid), '-o', 'command='])
    return PROCESS_NAME_RE.test(cmd) && /\bcli\b/.test(cmd)
  } catch { return false }
}

/** 删掉锁文件（给「仍要打开」用：用户确认没有命令行在运行时清掉可能陈旧的伴随锁文件）；套接字不动 */
export function clearLockFile(dir: string): void { try { fs.unlinkSync(path.join(dir, FILE_LOCK)) } catch { /* 没有 */ } }

/**
 * 窗口没拿到锁（点了「仍要打开」、或抢锁出错）时在后台每隔几秒再抢一次：抢到就交给 onAcquired（调用方挂上 releaseRunLock），然后停止。
 * 这样窗口会话里命令行的互斥只缺席「命令行还在跑」的那一段，之后自动恢复。返回停止函数。
 */
export function keepTryingRunLock(dir: string, mode: LockMode, onAcquired: (release: () => void) => void, intervalMs = 2500, pid = process.pid): () => void {
  let stopped = false
  let busy = false
  const timer = setInterval(async () => {
    if (stopped || busy) return
    busy = true
    try {
      const r = await acquireRunLock(dir, mode, pid)
      if (r.ok) {
        if (stopped) r.release()
        else { stopped = true; clearInterval(timer); onAcquired(r.release) }
      }
    } catch { /* 下一轮再试 */ } finally { busy = false }
  }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
