/**
 * 书库：切词与词形归一（纯函数）。
 * 英文：小写、撇号统一、缩写展开（who's → who be）、保守的词形归一（is/are → be，复数、-ed、-ing 去尾）。
 * 中文：按字和相邻两字切（“分数的初步认识” → 分 数 的 … 分数 数的 的初 …）。
 * 归一出来的“词根”只在内部用来比对，不会显示给老师看。
 */
import { normalizeChars } from './text.ts'

const BE = new Set(['am', 'is', 'are', 'was', 'were', 'been', 'being', 'be'])
const IRREGULAR: Record<string, string> = {
  has: 'have', had: 'have', having: 'have', does: 'do', did: 'do', done: 'do', doing: 'do',
  went: 'go', gone: 'go', goes: 'go', saw: 'see', seen: 'see', ate: 'eat', eaten: 'eat', took: 'take', taken: 'take',
  made: 'make', came: 'come', got: 'get', gave: 'give', given: 'give', ran: 'run', sang: 'sing', sung: 'sing',
  said: 'say', told: 'tell', bought: 'buy', brought: 'bring', thought: 'think', knew: 'know', known: 'know',
  wrote: 'write', written: 'write', read: 'read', drew: 'draw', drawn: 'draw', swam: 'swim', flew: 'fly', drank: 'drink',
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose', people: 'people',
  me: 'i', my: 'my', mine: 'my', i: 'i'
}
/** 看着像复数 / 过去式但其实不是的常见词，不去尾 */
const KEEP = new Set(['this', 'his', 'yes', 'bus', 'class', 'glass', 'dress', 'grass', 'its', 'us', 'plus', 'news', 'maths', 'physics', 'always', 'sometimes', 'across', 'pants', 'jeans', 'red', 'bed', 'need', 'feed', 'speed', 'seed', 'hundred', 'sled', 'was', 'does', 'goes', 'miss', 'boss', 'chess', 'dolls', 'ours', 'yours', 'hers', 'theirs', 'thus', 'bias', 'lens', 'gas', 'ice', 'nice', 'twice', 'once', 'since', 'rice', 'juice', 'mice', 'fridge', 'zoo', 'too', 'two', 'shoe', 'toe', 'eye', 'bye'])

/** 单个英文词 → 内部词根（保守）；只处理长度 ≥ 4 的词的去尾 */
export function lemmaKey(word: string): string {
  const w = word.toLowerCase()
  if (BE.has(w)) return 'be'
  if (IRREGULAR[w]) return IRREGULAR[w]
  if (w.length <= 3 || KEEP.has(w)) return w
  let s = w
  if (/ies$/.test(s) && s.length > 4) s = s.slice(0, -3) + 'y'
  else if (/(ches|shes|xes|sses|zes)$/.test(s)) s = s.slice(0, -2)
  else if (/oes$/.test(s) && s.length > 5) s = s.slice(0, -2)
  else if (/[^su]s$/.test(s) && !/(ss|us|is|ous)$/.test(s)) s = s.slice(0, -1)
  else if ((/ing$/.test(s) && s.length - 3 >= 3) || (/ed$/.test(s) && s.length - 2 >= 3 && !/eed$/.test(s))) {
    const ing = /ing$/.test(s)
    if (!ing && /ied$/.test(s)) s = s.slice(0, -3) + 'y'
    else {
      s = s.slice(0, ing ? -3 : -2)
      if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|ff|zz)$/.test(s)) s = s.slice(0, -1)   // running → run
      else if (/[cvzu]$/.test(s) || (/[^aeiou][aeiou][^aeiouwxy]$/.test(s) && (s.match(/[aeiouy]+/g) ?? []).length === 1)) s += 'e'   // making → make, liked → like（只补短词）
    }
  }
  return s
}

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\bshan't\b/g, 'shall not'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [/\blet's\b/g, 'let us'],
  [/\b(what|who|where|when|how|that|it|he|she|here|there|why)'s\b/g, '$1 is']
]

/** 英文词序列（已展开缩写、小写）；不含词根转换 */
export function englishWords(text: string): string[] {
  let t = normalizeChars(text).toLowerCase()
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to)
  return t.replace(/'s\b/g, '').match(/[a-z]+(?:-[a-z]+)*/g)?.flatMap(w => w.split('-')) ?? []
}

export const englishLemmas = (text: string): string[] => englishWords(text).map(lemmaKey)

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g

/** 中文：每个汉字和每相邻两个字 */
export function cjkGrams(text: string): { uni: string[]; bi: string[] } {
  const uni: string[] = [], bi: string[] = []
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length; i++) { uni.push(run[i]); if (i + 1 < run.length) bi.push(run.slice(i, i + 2)) }
  }
  return { uni, bi }
}

/** 页里要建索引的全部词（给全文索引用，空格分隔） */
export function indexTokens(text: string): string[] {
  const g = cjkGrams(text)
  return [...new Set([...englishLemmas(text), ...g.bi, ...g.uni])]
}

/** 英文里太常见、命中了也不说明什么的词（打分时权重很低） */
export const STOP = new Set(['the', 'a', 'an', 'be', 'i', 'you', 'your', 'my', 'we', 'it', 'he', 'she', 'to', 'of', 'in', 'on', 'at', 'and', 'or', 'do', 'not', 'is', 'this', 'that', 'what', 'who', 'how', 'can', 'have', 'there', 'for', 'with', 'are', 'let', 'us', 'please', 'am', 'its', 'his', 'her', 'they', 'me'])
export const CJK_STOP = new Set(['的', '了', '是', '在', '和', '有', '个', '一', '不', '为', '以', '其', '之', '与', '及', '也', '都', '就', '把', '被', '这', '那', '们', '吗', '呢', '吧', '啊'])

// ───────────────────────── 给题干用：去掉干扰 ─────────────────────────

/**
 * 题干 → 适合拿去搜的文字：去掉题号、选项字母和选项、下划线 / 空格括号、题型说明（“选择”“填空”），
 * 保留题干原话。选项整行（A. xxx）直接去掉，因为选项里是干扰项，不是书上的原话。
 */
export function cleanQuestion(raw: string): string {
  let s = normalizeChars(raw)
  s = s.replace(/\r/g, '')
  // 选项：行首 A. / A) / (A) / A、 … 以及行内连续的 “A. xx B. xx C. xx”
  s = s.split('\n').filter(l => !/^\s*[(\uff08]?[A-Da-d][)\uff09.\u3001\uff0e:\uff1a]\s*\S/.test(l)).join('\n')
  s = s.replace(/\s[(\uff08]?[A-D][)\uff09.\u3001\uff0e]\s*[^\n]*$/m, ' ')
  // 题号
  s = s.replace(/^\s*(?:第\s*\d+\s*题|\d{1,3}\s*[.\u3001\uff0e)\uff09]|[(\uff08]\s*\d{1,3}\s*[)\uff09]|no\.?\s*\d{1,3})\s*/gim, '')
  // 下划线 / 空括号 / 省略号占位
  s = s.replace(/[_\uff3f]{2,}|\u2014{2,}|[(\uff08]\s*[)\uff09]|\.{4,}|\u2026{2,}/g, ' ')
  s = s.replace(/[\u2460-\u2473\u2776-\u277f]/g, ' ')
  // 题型说明
  s = s.replace(/(?:单项选择|选择正确的?答案|选择填空|请选择|根据.{0,12}填空|看图.{0,6}选择|用.{0,6}填空)/g, ' ')
  return s.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim()
}

/** 句子切分（题干里有多句时逐句搜） */
export function splitSentences(s: string): string[] {
  return s.split(/(?<=[.!?;。！？；])\s*/).map(x => x.trim()).filter(x => x.length >= 2)
}
