/**
 * 导入文件的大小 / 页数上限和提示文字（试卷、课程大纲共用）。纯函数，单测直接加载。
 *
 * 500 MB 的依据：PDF 现在由渲染窗口按需分块读取（Range），主进程只做流式哈希和复制，内存与文件大小无关；
 * 实测 600 MB 的合成 PDF 也能导入不崩（tests/e2e/run-big-file.cjs）。500 MB 留出余量，同时挡住明显不对的文件（整盘镜像、视频改了后缀）。
 */
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024

/** 课程表（有表格或几页的清单）最多处理的页数 */
export const COURSE_MAX_PAGES = 20
/** 教材 / 整本书最多处理的页数 */
export const TEXTBOOK_MAX_PAGES = 300

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** 文件太大时的提示（带实际大小和上限）；没超返回 null */
export function tooBigMessage(size: number, max = MAX_IMPORT_BYTES): string | null {
  return size > max ? `文件太大了：${formatBytes(size)}，超过 ${formatBytes(max)} 的上限。可以先用 PDF 工具截取需要的页，或压缩后再上传` : null
}

/**
 * 页码范围文字（如 "1-60, 75, 90-100"）→ 排序去重后的页码列表。
 * 空串 = 全部（返回 null）；语法不对 / 超出总页数 / 范围倒置 → 抛 Error（文字是给用户看的）。
 */
export function parsePageRange(text: string, total: number): number[] | null {
  const t = text.replace(/[，、；;]/g, ',').replace(/[－—–~～至到]/g, '-').replace(/\s+/g, '').replace(/^,+|,+$/g, '')
  if (!t) return null
  const set = new Set<number>()
  for (const part of t.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) throw new Error(`页码范围看不懂：「${part}」。写法例如 1-60 或 1-30,45,80-100`)
    const a = Number(m[1]), b = m[2] == null ? a : Number(m[2])
    if (a < 1 || b < a) throw new Error(`页码范围不对：「${part}」`)
    if (b > total) throw new Error(`页码超出了：这份文件一共 ${total} 页，范围里有第 ${b} 页`)
    for (let i = a; i <= b; i++) set.add(i)
  }
  return [...set].sort((x, y) => x - y)
}

/** 页数超限的提示（带实际页数、上限，并告诉用户可以选页码范围） */
export function tooManyPagesMessage(pages: number, max: number, total = pages): string {
  return `这份 PDF 有 ${total} 页${pages !== total ? `（选中 ${pages} 页）` : ''}，超过了 ${max} 页的上限。可以在「页码范围」里只选需要的页（比如 1-${Math.min(max, total)}），或先截取再上传`
}
