/**
 * 服务地址与密钥相关的纯函数（不依赖 electron，单测直接加载）。
 */

/** http(s) 地址的 origin；不是合法 http(s) URL 返回 null */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

export function isHttpUrl(url: string): boolean {
  return originOf(url) !== null
}

/**
 * 已存的密钥能否继续用于新地址：两边都必须是合法地址且 origin 相同。
 * 任何一边为空/非法一律 false——「已存地址为空」不能成为绕过守卫的缝（审核 P1-5）。
 */
export function sameServer(a: string, b: string): boolean {
  const x = originOf(a)
  const y = originOf(b)
  return x !== null && y !== null && x === y
}

/** 明文 http 且不是本机：密钥会在网络上明文传输，界面要提示 */
export function isPlainHttpRemote(url: string): boolean {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:') return false
    return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) && !u.hostname.endsWith('.localhost')
  } catch {
    return false
  }
}

/** 把文本里看起来像密钥的内容和已知密钥替换掉，再用于展示/落库（服务商有时会在 400 里回显鉴权信息） */
export function redact(text: string, secrets: string[] = []): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('［密钥已隐藏］')
  return out
    .replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}/gi, '［密钥已隐藏］')   // 不含 ep-：豆包的推理接入点 ID（ep-…）是模型名，不是密钥
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1［密钥已隐藏］')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '［密钥已隐藏］')   // Google 形态
    // 其它长串（base62 / 十六进制 / base64url，至少 24 位且字母数字混合）：不认识的密钥也不能原样出去
    // 不含连字符的 24 位以上混合串，或 40 位以上含连字符的串；模型名（如 Qwen3-235B-A22B-Instruct-2507）各段都短，不会被误伤
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}(?![A-Za-z0-9_-])/g, '［密钥已隐藏］')
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '［密钥已隐藏］')
}

/**
 * 视觉模型这次请求该带哪把密钥（纯函数）。规则：
 *  - 界面上刚输入的视觉密钥：随便发（用户当场给的）；
 *  - 已存的视觉密钥：只发往「已存的视觉地址」同一个服务；
 *  - 界面上刚输入的文本密钥：只发往界面上当前的文本地址同一个服务；
 *  - 已存的文本密钥：只发往「已存的文本地址」同一个服务（不看界面上改过的地址）。
 * 都不满足 = null，调用方要提示「先输入对应的 API Key」。
 */
export function pickVisionKey(a: {
  targetUrl: string; savedVisionUrl: string; savedTextUrl: string; draftTextUrl: string
  draftVisionKey?: string; draftTextKey?: string; storedVisionKey?: string | null; storedTextKey?: string | null
}): string | null {
  const dv = a.draftVisionKey?.trim()
  if (dv) return dv
  if (a.storedVisionKey && sameServer(a.savedVisionUrl, a.targetUrl)) return a.storedVisionKey
  const dt = a.draftTextKey?.trim()
  if (dt && sameServer(a.draftTextUrl, a.targetUrl)) return dt
  if (a.storedTextKey && sameServer(a.savedTextUrl, a.targetUrl)) return a.storedTextKey
  return null
}
