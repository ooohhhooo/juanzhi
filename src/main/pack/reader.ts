/**
 * 把 .ewb.zip 安全地解到暂存目录。包是不可信输入：
 *  - 条目名走白名单（names.ts），路径穿越 / 绝对路径 / 盘符 / 反斜杠 / 符号链接 / 加密 / 非常规压缩方式 / 重复条目一律拒绝；
 *  - 条目数、总解压字节数、单个文件字节数都有上限，而且**按实际解出来的字节数计**，不信任头部声明的大小
 *    （zip 炸弹的头部可以写得很小）；超限立刻中止，已写出的内容随暂存目录一起删掉；
 *  - 目标路径由白名单分类结果拼出来，不是直接拿条目名拼，并再校验一次没有越出暂存目录。
 * 只用纯 JS 的 yauzl，不用原生模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { PackError } from './errors.ts'
import { classifyEntry, dedupeKey } from './names.ts'
import { ManifestSchema } from './manifest.ts'
import type { Manifest } from './manifest.ts'

export interface PackLimits {
  maxEntries: number
  maxTotalBytes: number
  maxFileBytes: number
  maxDbBytes: number
  maxManifestBytes: number
}

export const DEFAULT_LIMITS: PackLimits = {
  maxEntries: 100_000,
  maxTotalBytes: 8 * 1024 ** 3,
  maxFileBytes: 200 * 1024 ** 2,
  maxDbBytes: 2 * 1024 ** 3,
  maxManifestBytes: 64 * 1024
}

export interface ExtractProgress { entries: number; totalEntries: number; bytes: number }

export interface ExtractResult {
  manifest: Manifest
  dbPath: string
  filesDir: string
  entries: number
  bytes: number
  /** files/ 下出现过的试卷目录 */
  paperDirs: string[]
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

/**
 * 磁盘 / 权限类的系统错误翻成老师看得懂的话，不要一律说成「数据包已损坏」（M4 复审 P2-7）。
 * 认不出来的返回 null（调用方再按「包有问题」处理）。toRead 表示出错的是读数据包文件（否则是往暂存目录写）。
 */
export function ioProblem(e: unknown, toRead = false): PackError | null {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOSPC': case 'EDQUOT': return new PackError('io', '磁盘空间不足，数据包没能解开。请清理一些空间（或换一个有空间的数据目录）后再试')
    case 'EACCES': case 'EPERM': case 'EROFS':
      return new PackError('io', toRead ? '没有权限读取这个数据包文件，请换一个位置，或检查文件权限后再试' : '没有权限写入数据目录（或磁盘是只读的），数据包没能解开。请检查数据目录的权限')
    case 'EBUSY': case 'ETXTBSY': return new PackError('io', toRead ? '这个数据包文件正被其他程序占用，请关闭占用它的程序后再试' : '数据目录里的文件正被其他程序占用（可能是杀毒软件或同步盘），请稍后再试')
    case 'ENOENT': return toRead ? new PackError('io', '找不到这个数据包文件，它可能已被移动或删除') : null
    case 'EMFILE': case 'ENFILE': return new PackError('io', '系统打开的文件太多，请关闭一些程序后再试')
    case 'EIO': return new PackError('io', toRead ? '读取数据包文件时磁盘出错（可能是移动硬盘或网络盘断开了），请把文件复制到本机再试' : '写入磁盘时出错，数据包没能解开')
    default: return null
  }
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (err, z) => {
      if (err || !z) reject(ioProblem(err, true) ?? new PackError('bad_zip', '这不是一个有效的数据包（不是 zip 文件，或文件已损坏）'))
      else resolve(z)
    })
  })
}

function openStream(z: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    z.openReadStream(entry, (err, s) => (err || !s ? reject(ioProblem(err, true) ?? new PackError('bad_zip', '数据包里的文件无法读取，数据包可能已损坏')) : resolve(s)))
  })
}

/** 限量的计数器：超过 limit 立刻让流报错 */
function limiter(limit: number, onBytes: (n: number) => void, tooBig: () => PackError): Transform {
  let n = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length
      try { onBytes(chunk.length) } catch (e) { cb(e as Error); return }
      if (n > limit) cb(tooBig())
      else cb(null, chunk)
    }
  })
}

export async function extractPack(zipPath: string, stagingDir: string, opts: { limits?: Partial<PackLimits>; onProgress?: (p: ExtractProgress) => void; signal?: AbortSignal } = {}): Promise<ExtractResult> {
  const lim = { ...DEFAULT_LIMITS, ...opts.limits }
  const staging = path.resolve(stagingDir)
  const cleanup = () => { try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* 尽力而为 */ } }
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    return await doExtract(zipPath, staging, lim, opts)
  } catch (e) {
    cleanup()
    if (e instanceof PackError) throw e
    throw ioProblem(e) ?? new PackError('io', `读取数据包失败：${(e as Error).message}`)
  }
}

async function doExtract(zipPath: string, staging: string, lim: PackLimits, opts: { onProgress?: (p: ExtractProgress) => void; signal?: AbortSignal }): Promise<ExtractResult> {
  const z = await openZip(zipPath)
  if (z.entryCount > lim.maxEntries) {
    z.close()
    throw new PackError('too_many', `数据包里的文件太多（${z.entryCount} 个，上限 ${lim.maxEntries} 个），已拒绝导入`)
  }
  const seen = new Set<string>()
  const paperDirs = new Set<string>()
  let total = 0, entries = 0, haveManifest = false, haveDb = false
  const addBytes = (n: number) => {
    total += n
    if (total > lim.maxTotalBytes) throw new PackError('too_big', `数据包解压后超过 ${mb(lim.maxTotalBytes)}，已拒绝导入（可能是被恶意构造的压缩包）`)
  }

  await new Promise<void>((resolve, reject) => {
    let failed = false
    const fail = (e: unknown) => { if (failed) return; failed = true; try { z.close() } catch { /* 已关闭 */ } reject(e) }
    z.on('error', e => {
      if (e instanceof PackError) { fail(e); return }
      // yauzl 自己先拒绝了危险的名字（路径穿越、绝对路径、盘符、反斜杠）——给老师一句说得清的话
      if (/absolute path|invalid relative path|invalid characters in fileName/i.test((e as Error)?.message ?? '')) fail(new PackError('bad_entry', '数据包里有不允许的文件路径（路径穿越、绝对路径或反斜杠），数据包可能被修改过，已拒绝导入'))
      else fail(ioProblem(e, true) ?? new PackError('bad_zip', '数据包已损坏，无法读取'))
    })
    z.on('end', () => { if (!failed) resolve() })
    z.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if (opts.signal?.aborted) throw new PackError('aborted', '已取消')
          const name = entry.fileName
          const cls = classifyEntry(name)
          if (!cls) throw new PackError('bad_entry', `数据包里有不允许的文件名：「${String(name).slice(0, 80).replace(/[\u0000-\u001f]/g, '?')}」。数据包可能被修改过，已拒绝导入`)
          const key = dedupeKey(name)
          if (seen.has(key)) throw new PackError('bad_entry', `数据包里有重复的条目：「${name}」，已拒绝导入`)
          seen.add(key)
          if (entry.isEncrypted()) throw new PackError('bad_entry', '数据包里有加密的文件，不支持')
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new PackError('bad_entry', '数据包用了不支持的压缩方式')
          // 符号链接：Unix 制作的压缩包在外部属性高 16 位里放了文件模式
          if (((entry.versionMadeBy >> 8) & 0xff) === 3 && (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)) {
            throw new PackError('bad_entry', `数据包里有符号链接「${name}」，已拒绝导入`)
          }
          if (cls.kind === 'dir') { entries++; z.readEntry(); return }

          const cap = cls.kind === 'manifest' ? lim.maxManifestBytes : cls.kind === 'db' ? lim.maxDbBytes : lim.maxFileBytes
          // 头部声明的大小只用来快速拒绝；真正的限制按实际解出来的字节数算（下面的 limiter）
          if (entry.uncompressedSize > cap) throw new PackError('too_big', `数据包里的文件「${name}」太大（${mb(entry.uncompressedSize)}），已拒绝导入`)

          let dest: string
          if (cls.kind === 'manifest') dest = path.join(staging, 'manifest.json')
          else if (cls.kind === 'db') dest = path.join(staging, 'db.sqlite')
          else { dest = path.join(staging, 'files', cls.paperId, ...cls.rel.split('/')); paperDirs.add(cls.paperId) }
          const resolved = path.resolve(dest)
          if (!resolved.startsWith(staging + path.sep)) throw new PackError('bad_entry', '数据包里的路径越出了允许的范围，已拒绝导入')
          fs.mkdirSync(path.dirname(resolved), { recursive: true })

          const rs = await openStream(z, entry)
          await pipeline(
            rs as unknown as NodeJS.ReadableStream,
            limiter(cap, addBytes, () => new PackError('too_big', `数据包里的文件「${name}」解压后太大，已拒绝导入（可能是被恶意构造的压缩包）`)),
            fs.createWriteStream(resolved, { flags: 'wx' })
          )
          if (cls.kind === 'manifest') haveManifest = true
          if (cls.kind === 'db') haveDb = true
          entries++
          opts.onProgress?.({ entries, totalEntries: z.entryCount, bytes: total })
          z.readEntry()
        } catch (e) {
          // 系统错误（磁盘满 / 没权限 / 被占用 / 读盘出错）和「包本身坏了」分开说；解压库（zlib / yauzl）的错才是包损坏
          fail(e instanceof PackError ? e : (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? new PackError('bad_entry', '数据包里有重复的条目，已拒绝导入') : ioProblem(e) ?? new PackError('bad_zip', '数据包已损坏，无法读取'))
        }
      })()
    })
    z.readEntry()
  })

  if (!haveManifest) throw new PackError('manifest', '数据包里没有 manifest.json，不是本软件导出的数据包')
  if (!haveDb) throw new PackError('manifest', '数据包里没有数据库（db.sqlite），数据包不完整')
  let manifest: Manifest
  try {
    manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')))
  } catch {
    throw new PackError('manifest', 'manifest.json 的内容不正确，不是本软件导出的数据包')
  }
  return { manifest, dbPath: path.join(staging, 'db.sqlite'), filesDir: path.join(staging, 'files'), entries, bytes: total, paperDirs: [...paperDirs] }
}
