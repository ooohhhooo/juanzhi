/**
 * 书库：文字清洗（纯函数，不依赖 electron）。
 * 原则：只做“让搜索更准”的清洗，不改写、不概括书里的内容。
 */

const CJK = /[㐀-鿿豈-﫿]/
export const hasCjk = (s: string): boolean => CJK.test(s)
export const cjkRatio = (s: string): number => {
  const letters = s.replace(/[\s\d\p{P}]/gu, '')
  if (!letters.length) return 0
  let n = 0
  for (const ch of letters) if (CJK.test(ch)) n++
  return n / letters.length
}

/** 各种撇号 / 引号统一成 ASCII，全角字母数字转半角 */
export function normalizeChars(s: string): string {
  return s
    .replace(/[‘’‛ʼ′`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/ |　/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[-]/g, '')   // 音标字体映射出来的私有区符号
    .replace(/[ -  ]/g, ' ')
}

/**
 * 统编语文的拼音用特殊字体映射，取出来是 “bS / hSn / huQng” 这类乱码字母，
 * 往往单独成行或夹在汉字之间。清洗：在以汉字为主的页里，去掉不含汉字的纯字母“词”（≤8 个字母）。
 * 返回清洗后的行和去掉的个数（页里记一笔，界面可以提示）。
 */
export function stripPinyinNoise(lines: string[]): { lines: string[]; removed: number } {
  const total = lines.join('').replace(/\s/g, '')
  if (cjkRatio(total) < 0.5) return { lines, removed: 0 }
  let removed = 0
  const out: string[] = []
  for (const line of lines) {
    // 整行只有字母（含 ü）和空格：拼音
    if (/^[A-Za-züÜ\s.]{1,24}$/.test(line) && /[A-Za-z]/.test(line) && !/^\s*$/.test(line)) { removed += (line.match(/[A-Za-züÜ]+/g) ?? []).length; continue }
    // 行内：汉字旁边的短字母串
    const cleaned = line.replace(/(?<=[㐀-鿿\s.，。；：、！？”）])[A-Za-züÜ]{1,8}(?=[㐀-鿿\s.，。；：、！？“（]|$)/g, () => { removed++; return '' })
    out.push(cleaned)
  }
  return { lines: out, removed }
}

/** 把一页的若干行连成一段：汉字与汉字之间不加空格，其他情况加一个空格（行宽造成的断行被抹平） */
export function joinLines(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (!out) { out = line; continue }
    const a = out[out.length - 1], b = line[0]
    out += (CJK.test(a) && CJK.test(b)) || /[，。；：、！？“”（）《》]/.test(a) || /[，。；：、！？“”（）《》]/.test(b) ? line : ' ' + line
  }
  // 汉字之间残留的单个空格（PDF 里“目 录”这类字距）去掉
  return out.replace(/(?<=[㐀-鿿]) (?=[㐀-鿿])/g, '').replace(/ {2,}/g, ' ').trim()
}

/** 把 PDF 的原始文字（一行一个换行）清洗成页文字 */
export function cleanPage(raw: string | string[], stripPinyin = true): { text: string; lines: string[]; pinyinRemoved: number } {
  const lines0 = (Array.isArray(raw) ? raw : raw.split('\n')).map(l => {
    const n = normalizeChars(l).replace(/\s+$/g, '')
    // 文字识别常把英文句子里的标点读成全角（Hello！）：没有汉字的行换回半角，搜索才对得上
    return CJK.test(n) ? n : n.replace(/[！-／：-＠［-｀｛-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  }).filter(l => l.trim())
  const { lines, removed } = stripPinyin ? stripPinyinNoise(lines0) : { lines: lines0, removed: 0 }
  const kept = lines.map(l => l.trim()).filter(Boolean)
  return { text: joinLines(kept), lines: kept, pinyinRemoved: removed }
}

/** 搜索用的归一化：小写、撇号统一、去掉标点（保留撇号和连字符内部）、汉字间无空格 */
export function normForSearch(s: string): string {
  return normalizeChars(s).toLowerCase()
    .replace(/[^\p{L}\p{N}'\s\-]/gu, ' ')
    .replace(/(?<![a-z])['-]|['-](?![a-z])/g, ' ')
    .replace(/(?<=[㐀-鿿])\s+(?=[㐀-鿿])/g, '')
    .replace(/\s+/g, ' ').trim()
}

/** 整本书里有多少行像“拼音乱码”（小写字母 + 大写字母混在一个短词里，如 huQng）；够多就是统编语文那种拼音字体 */
export function looksLikeMappedPinyin(rawPages: string[][]): boolean {
  let n = 0
  for (const lines of rawPages) for (const l of lines) if (/^[a-z]{1,5}[A-ZÜ][a-zü]{0,4}$/.test(l.trim())) n++
  return n >= 30
}
