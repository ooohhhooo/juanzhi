/**
 * 命令行写文件的安全规则（M7 评审 P1-5）：`--result-file` / `--out`（JSON 副本）/ 环境变量 JUANZHI_RESULT_FILE 不能把数据库、数据目录里的东西或别的文件覆盖掉；
 * `report export --out` 已经存在的文件默认不覆盖。纯文件系统逻辑，不依赖 electron，单测直接加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CliError } from './args.ts'

/** 真实路径：路径本身不存在时取最近的、存在的上级目录的真实路径再接上剩下的部分（解开符号链接，防止绕过） */
export function realPathLoose(p: string): string {
  const abs = path.resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()) } catch {
      const up = path.dirname(cur)
      if (up === cur) return abs
      rest.push(path.basename(cur)); cur = up
    }
  }
}

const norm = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)
export function isInside(child: string, parent: string): boolean {
  const c = norm(realPathLoose(child)), d = norm(realPathLoose(parent))
  return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep)
}

const RESULT_HEAD = '{"ok":'
/** 已经存在的文件是不是「本程序以前写的结果文件」（以 {"ok": 开头的 JSON） */
function looksLikeOurResult(file: string): boolean {
  try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b.toString('utf8').startsWith(RESULT_HEAD) } finally { fs.closeSync(fd) } } catch { return false }
}

/**
 * 检查一个「JSON 结果文件」的路径能不能写：不在禁区目录里、扩展名是 .json / .txt / 没有、没有符号链接指向别处、
 * 已经存在的话必须是本程序以前写的结果文件。不行就抛 CliError('usage')。
 */
export function assertResultFileWritable(file: string, forbiddenDirs: string[]): string {
  const abs = path.resolve(file)
  for (const d of forbiddenDirs) if (d && isInside(abs, d)) throw new CliError('usage', `结果文件不能放在卷知的数据目录里（${d}）：${file}`)
  const ext = path.extname(abs).toLowerCase()
  if (!['', '.json', '.txt'].includes(ext)) throw new CliError('usage', `结果文件的扩展名只能是 .json、.txt 或不写扩展名：${file}`)
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(abs) } catch { /* 不存在：可以写 */ }
  if (st) {
    if (st.isSymbolicLink()) throw new CliError('usage', `结果文件不能是符号链接：${file}`)
    if (!st.isFile()) throw new CliError('usage', `结果文件不是普通文件：${file}`)
    if (st.size > 0 && !looksLikeOurResult(abs)) throw new CliError('usage', `${file} 已经存在，而且不是卷知以前写的结果文件，不会覆盖。请换一个文件名`)
  }
  return abs
}

/** 原子地写：先写同目录的临时文件再改名（崩溃时不会留下半截文件） */
export function writeFileAtomic(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  try { fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, abs) } catch (e) { try { fs.unlinkSync(tmp) } catch { /* 忽略 */ } throw e }
}

/** 导出文档的目标路径：不在数据目录里；已经存在的文件默认不覆盖（加 --overwrite 才行），符号链接、目录一律不行 */
export function assertExportTarget(file: string, forbiddenDirs: string[], overwrite: boolean): string {
  const abs = path.resolve(file)
  for (const d of forbiddenDirs) if (d && isInside(abs, d)) throw new CliError('usage', `导出的文件不能放在卷知的数据目录里（${d}）：${file}`)
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(abs) } catch { /* 不存在 */ }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) throw new CliError('usage', `导出目标不是普通文件（符号链接或目录不能覆盖）：${file}`)
    if (!overwrite) throw new CliError('usage', `${file} 已经存在。要覆盖它请加 --overwrite，或者换一个文件名`)
  }
  return abs
}
