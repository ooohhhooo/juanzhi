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
}
