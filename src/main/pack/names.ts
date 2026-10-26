/**
 * 数据包（.ewb.zip）里允许出现的条目名——白名单。导入的包一律视为不可信输入：
 * 任何不在白名单里的名字（路径穿越、绝对路径、盘符、反斜杠、重复条目、系统垃圾文件……）都让整个包被拒绝，
 * 而不是「跳过」——一个被篡改过的包不值得部分信任。
 * 纯函数模块，单测直接加载。
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type EntryClass =
  | { kind: 'manifest' }
  | { kind: 'db' }
  | { kind: 'file'; paperId: string; rel: string }
  | { kind: 'dir' }

const FILE_RES: RegExp[] = [
  /^files\/([0-9a-f-]{36})\/(original\.(?:pdf|jpg|jpeg|png|heic|docx))$/,
  /^files\/([0-9a-f-]{36})\/(page-\d{1,4}\.png)$/,
  /^files\/([0-9a-f-]{36})\/(media\/\d{1,4}\.(?:png|jpg|gif))$/
]
const DIR_RES: RegExp[] = [/^files\/$/, /^files\/[0-9a-f-]{36}\/$/, /^files\/[0-9a-f-]{36}\/media\/$/]

/** 返回条目的分类；不合法返回 null */
export function classifyEntry(name: string): EntryClass | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
  // 控制字符（含 NUL）、反斜杠、绝对路径、盘符、. / .. 段、空段都直接拒绝
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return null
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const segs = name.replace(/\/$/, '').split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return null
  if (name === 'manifest.json') return { kind: 'manifest' }
  if (name === 'db.sqlite') return { kind: 'db' }
  if (name.endsWith('/')) {
    if (!DIR_RES.some(re => re.test(name))) return null
    const m = /^files\/([0-9a-f-]{36})\//.exec(name)
    if (m && !UUID_RE.test(m[1])) return null
    return { kind: 'dir' }
  }
  for (const re of FILE_RES) {
    const m = re.exec(name)
    if (m) return UUID_RE.test(m[1]) ? { kind: 'file', paperId: m[1], rel: m[2] } : null
  }
  return null
}

/** 名字归一化后用来查重（大小写不敏感的文件系统上 A.png 和 a.png 是同一个文件） */
export const dedupeKey = (name: string): string => name.normalize('NFC').toLowerCase()
