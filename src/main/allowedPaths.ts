/**
 * 导入路径授权：只接受「对话框返回」或「preload 对真实 File 对象取路径」得到的路径。
 * 渲染端主世界脚本拿不到 ipcRenderer，也伪造不出 File 的真实路径，所以这是一条真边界。
 */
const TTL_MS = 30 * 60 * 1000
const allowed = new Map<string, number>()

export function allowPath(p: string): void {
  if (!p) return
  allowed.set(p, Date.now() + TTL_MS)
}

export function isPathAllowed(p: string): boolean {
  const exp = allowed.get(p)
  if (exp === undefined) return false
  if (exp < Date.now()) { allowed.delete(p); return false }
  return true
}
