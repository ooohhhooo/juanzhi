/**
 * 对外发送文件的白名单（纯逻辑，不依赖 electron）。
 * 只允许两类文件：
 *  1. 本会话的导出目录 <数据目录>/agent-outputs/<sessionId>/exports 下的文件；
 *  2. 用户刚通过系统文件对话框选的文件（主进程调 allowSendOnce 记一次性许可，用一次就作废，10 分钟过期）。
 * 无论哪一类，数据集目录、代号本（*.codes.json）、catalog.json、db.sqlite*、*.sqlite* 一律拒绝。
 */
import fs from 'node:fs'
import path from 'node:path'

const TTL_MS = 10 * 60 * 1000
const once = new Map<string, number>()

const real = (p: string): string => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

/** 记一次性许可：用户刚用系统文件对话框选了这个文件 */
export function allowSendOnce(p: string): void { if (p) once.set(real(p), Date.now() + TTL_MS) }
/** 是否有（未过期的）一次性许可；consume=true 时用掉 */
export function hasSendPermit(p: string, consume = false): boolean {
  const k = real(p)
  const exp = once.get(k)
  if (exp === undefined) return false
  if (exp < Date.now()) { once.delete(k); return false }
  if (consume) once.delete(k)
  return true
}

const SENSITIVE_NAME = /(^|[\\/])([^\\/]*\.codes\.json|catalog\.json|db\.sqlite[^\\/]*|[^\\/]*\.sqlite[^\\/]*)$/i
const DATASETS_DIR = /[\\/]datasets[\\/]/i
const SESSION_EXPORTS = /[\\/]agent-outputs[\\/]([A-Za-z0-9_-]{1,64})[\\/]exports[\\/]/

export interface SendScope { sessionId?: string; dataDir?: string }

const within = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, file)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 返回拒绝原因，或 null（允许）。strict=false 时（预览阶段）不知道会话，只看「像不像某个会话的导出目录」 */
export function checkSendAllowed(p: string, scope: SendScope = {}, opts: { consume?: boolean; strict?: boolean } = {}): string | null {
  const file = real(p)
  if (SENSITIVE_NAME.test(file) || DATASETS_DIR.test(file) || (scope.dataDir && within(file, real(path.join(scope.dataDir, 'datasets'))))) {
    return '这个文件属于数据集或内部数据，不能发送'
  }
  const strict = opts.strict ?? true
  if (scope.dataDir && scope.sessionId) {
    const exp = real(path.join(scope.dataDir, 'agent-outputs', scope.sessionId, 'exports'))
    if (within(file, exp)) return null
  } else if (!strict && SESSION_EXPORTS.test(file)) return null
  if (hasSendPermit(p, !!opts.consume)) return null
  return '只能发送本次对话导出的文件，或你刚在文件选择框里选的文件。请先把内容导出，或点「选择文件」再发送'
}
