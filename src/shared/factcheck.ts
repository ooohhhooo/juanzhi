/**
 * AI 内容的事实核对（A3）。纯函数，不依赖 electron / 数据库，单测直接加载。
 *
 * 背景：真实 AI 把 time for / time to 的规则写反了（「It's time for 后接动词」），而同一份报告的另一处是对的——
 * 老师拿去讲给家长听会闹笑话。提示词已经要求「规则只能引用证据」，这里是程序侧的第二道关：
 * 把 AI 文本里的「规则句」逐句拿去和证据（已审核题目的易错说明 + 知识点的白话释义 / 例句）对照：
 *  - 规则句 = 同时有英文词语和「规则的口气」（后接 / 要加 / 变成 / 读作 / 复数 / 搭配 …）的句子；
 *  - 对得上证据 = 通过；
 *  - 同一个英文词语，证据里写的接什么词类，和这句话写的不一样 → 「conflict」（与题目解释矛盾）；
 *  - 证据里找不到依据 → 「unverified」（未核实）。
 * 这是启发式：不保证抓出所有错误，也不会判定「对」——通过只表示「和审核过的题目解释说的一致」。
 */

export interface RuleFinding { sentence: string; kind: 'unverified' | 'conflict'; reason: string }

/** 词类归并：动词 / 动词原形 / 动词原形 都算一类；名词 / 名词短语一类 */
const CLASS_OF: Array<[RegExp, string]> = [
  [/^(动名词|动词\s*-?\s*ing|ing\s*形式|v\s*-\s*ing|doing|-ing|现在分词)$/i, 'ing'],
  [/^(动词原形|动词|动词的原形|原形动词)$/, 'verb'],
  [/^(表示动作的词|动作词|动作)$/, 'verb'],
  [/^(名词|名词短语|名词复数|东西|事物|物品)$/, 'noun'],
  [/^(形容词)$/, 'adj'],
  [/^(副词)$/, 'adv']
]
/** 词类词（长的在前：JS 的 | 取第一个能匹配的） */
const CAT_SRC = '动词原形|动词的原形|原形动词|动名词|动词\\s*-?\\s*ing|ing\\s*形式|v\\s*-\\s*ing|doing|-ing|名词短语|名词复数|名词|形容词|副词|表示动作的词|动作词|动作|东西|事物|物品|动词'
const CAT_RE = new RegExp(CAT_SRC, 'gi')
/** 「英文短语 + 一小段连接的话 + 词类」：证据里的写法（time for + 名词 / time to 后面要接动词）。连接部分至少 1 个字、不含标点和英文字母、最多 10 个字——「be 动词」「Wh- 疑问词」这种英文名词紧跟词类名的不是关系 */
const REL_RE = new RegExp(`([A-Za-z][A-Za-z'’\\-]*(?:\\s+[A-Za-z][A-Za-z'’\\-]*){0,3})\\s*[^，,。；;、A-Za-z\\s][^，,。；;、A-Za-z]{0,9}?(${CAT_SRC})`, 'gi')
/** 否定的口气：词类词前面出现它，说的就是「不能接这类词」 */
const NEG_RE = /不能|不可以|不可|不要|不用|不宜|而不是|而非|不是|并非|别|没有/

/** 「错误描述」的口气：这些词出现在断言前面，说的是学生会怎么写错（典型错误：tomato 变复数不加 -es），断言的方向要反过来看；出现在断言后面的（…，孩子容易错）、只是栏目标签的「易错：」不算 */
const ERR_CTX_RE = /典型错误|常见错误|错误(?:是|在于|[:：])|误加|误用|误写|误以为|写成|写错|读错|选错|用错|多加|漏加|漏写|容易(?:把|给|写|读|说|用|加|选|漏|错成)|常(?:把|给|写成|读成|说成|错成)|会把|总(?:把|是把)/
/** 句子说完了「学生会怎么写错」，接着说正确的是什么：这些词出现之后，后面的断言按正常方向看 */
const ERR_RESET_RE = /其实|应该|应当|正确的?(?:是|写法|说法)|而是|但是|但要|必须|要记住|记住/

/** 规则的口气 */
const CUE_RE = /用\s*[A-Za-z]|后接|后面接|后面跟|后跟|跟着?|要加|加上|加\s*-?(?:s|es|ed|ing)|变成|变为|读作|读成|发音|读音|单复数|复数|单数|第三人称|过去式|过去分词|现在分词|同形|不规则|搭配|固定|用于|用在|表示|要用|应该用|应用|必须|不能|不可|不加|而不是|而非|规则|区别|区分|\+|＋|→|⟶/
const CN_KEYS = ['名词', '动词原形', '动词', '形容词', '副词', '代词', '介词', '冠词', '复数', '单数', '过去式', '过去分词', '现在分词', '第三人称', '原形', '不规则', '规则', '同形', '读音', '发音', '搭配', '后接', '加', '变', '缩写', '序数词', '基数词', '比较级', '最高级', '助动词', '时态', '读作', '读成', '变成', '变为']
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'it', 'its', "it's", 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'be', 'and', 'or', 'of', 'in', 'on', 'at', 'can', 'do', 'does', 'did', 'ok', 'ai', 'pdf'])

const norm = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase()

/** 一行里「只是排版 / 标注」的部分：引用 token（带括号里的样本题说明）、〔…〕标记、** 和反引号 */
const INLINE_JUNK = [
  // 引用 token 连同它前面的空白、后面紧跟的顿号 / 逗号一起当成排版：「结合 [A]、[B] 做对比练习」去掉引用后不会剩下孤零零的「、」
  /\s*\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\](?:（[^）]{0,80}）)?(?:\s*[、，])?/g,
  /〔[^〕]{0,20}〕/g,
  /\*\*/g,
  /`/g
]

/** 去掉排版和标注后的文字，以及每个字在原行里的位置（map[i] = 第 i 个字在原行的下标）：删除 / 写标记要落在原行上，不能靠「去掉之后的文字」当子串去找 */
interface Mapped { text: string; map: number[] }
function mapInline(line: string): Mapped {
  const drop = new Array<boolean>(line.length).fill(false)
  for (const re of INLINE_JUNK) for (const m of line.matchAll(re)) for (let i = m.index!; i < m.index! + m[0].length; i++) drop[i] = true
  let text = ''
  const map: number[] = []
  for (let i = 0; i < line.length; i++) if (!drop[i]) { text += line[i]; map.push(i) }
  return { text, map }
}

/** 去掉 Markdown 记号、引用 token、「（题型：题干摘要）」这类括号里的样本题说明 */
function plainLine(line: string): string {
  return mapInline(line).text.replace(/^[\s>#*\-+\d.、)]+/, '').trim()
}

/** 切句：按句号 / 分号 / 感叹号 / 问号 / 换行；表格行按单元格切。引号 / 书名号 / 括号里的标点不切（「拿“I see two dogs. 我看到两只狗。”讲……」是一句），句末的收尾引号归前一句 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  const OPEN = '“「『（(《', CLOSE = '”」』）)》'
  const splitOne = (t: string) => {
    const res: string[] = []
    let cur = ''
    let depth = 0
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]
      cur += ch
      if (OPEN.includes(ch) && ch !== '(' ) depth++
      else if (ch === '(') depth++
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
      if (depth > 0) continue
      const prev = t[i - 1] ?? ''
      const next = t[i + 1] ?? ''
      const asciiDot = ch === '.' && !/[A-Za-z0-9]/.test(prev) && (next === '' || /\s/.test(next))
      if (/[。！？；;!?]/.test(ch) || asciiDot) {
        // 收尾的引号 / 括号归前一句
        while (i + 1 < t.length && CLOSE.includes(t[i + 1])) { cur += t[++i] }
        res.push(cur); cur = ''
      }
    }
    if (cur) res.push(cur)
    return res
  }
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim()
    if (!t || /^\|?\s*:?-{2,}/.test(t) || /^#{1,6}\s/.test(t)) continue
    const parts = t.includes('|') ? t.split('|') : [t]
    for (const part of parts) {
      for (const piece of splitOne(mapInline(part).text)) {
        const x = piece.replace(/[。！？；;!?]+$/, '').replace(/^[\s>#*\-+\d.、)]+/, '').trim()
        if (x.length >= 4) out.push(x)
      }
    }
  }
  return out
}

function enTerms(s: string): string[] {
  const out: string[] = []
  for (const m of norm(s).matchAll(/[a-z][a-z'\-]*/g)) {
    const w = m[0].replace(/^-+|-+$/g, '')
    if (w.length >= 2 && !STOP.has(w)) out.push(w)
  }
  return out
}

function cnTerms(s: string): string[] {
  // 先取长词，取到后把它从串里挖掉，免得「动词原形」又被当成「动词」「原形」重复计
  let rest = s
  const out: string[] = []
  for (const k of [...CN_KEYS].sort((a, b) => b.length - a.length)) {
    if (rest.includes(k)) { out.push(k); rest = rest.split(k).join(' ') }
  }
  // 「单复数」说的是单数和复数两头
  if (out.includes('单复数')) for (const k of ['单数', '复数']) if (!out.includes(k)) out.push(k)
  return out
}

const classOf = (c: string): string => CLASS_OF.find(([re]) => re.test(c.trim()))?.[1] ?? c.trim()

interface Rel { e: string; c: string }

/** 「英文短语 → 词类」关系（证据里的写法）；英文短语只取最后两个词（It's time for → time for），统一小写 */
export function relationsOf(s: string): Rel[] {
  const out: Rel[] = []
  for (const m of s.matchAll(REL_RE)) {
    const words = norm(m[1]).replace(/[^a-z' \-]/g, ' ').split(/\s+/).filter(Boolean)
    const e = words.slice(-2).join(' ')
    if (e && m[2]) out.push({ e, c: classOf(m[2]) })
  }
  return out
}

/**
 * 句子对某个「英文短语」说了接什么词类：不看连接词怎么说（后接 / 后面要接 / 加 / 要用 / 之后要用 / 的后面应该跟 …），
 * 只看短语后面（到下一个短语、标点或 18 个字为止）出现了哪个词类词，前面有没有「不能 / 不是 / 别」；
 * 后面没有词类词时，看短语前面（「动词前面用 time to」）。
 */
interface Claim { e: string; pos: string[]; neg: string[] }
function phraseClaims(sentence: string, phrases: Set<string>): Claim[] {
  const s = norm(sentence)
  const occ: Array<{ e: string; start: number; end: number }> = []
  for (const e of [...phrases].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![a-z'\\-])${e.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}(?![a-z'\\-])`, 'g')
    for (const m of s.matchAll(re)) {
      const start = m.index!, end = start + m[0].length
      if (!occ.some(o => start < o.end && end > o.start)) occ.push({ e, start, end })
    }
  }
  // 省略写法：句子里已经写全过「time for」，后面单写「for 后面跟东西，to 后面跟动作」时，把单独的 for / to 也当成对应的短语
  for (const e of new Set(occ.map(o => o.e))) {
    const parts = e.split(' ')
    if (parts.length < 2) continue
    const last = parts[parts.length - 1]
    if (last.length > 3) continue
    const first = Math.min(...occ.filter(o => o.e === e).map(o => o.start))
    for (const m of s.matchAll(new RegExp(`(?<![a-z'\\-])${last}(?![a-z'\\-])`, 'g'))) {
      const start = m.index!, end = start + last.length
      if (start > first && !occ.some(o => start < o.end && end > o.start)) occ.push({ e, start, end })
    }
  }
  occ.sort((a, b) => a.start - b.start)
  const DELIM = /[，,。；;、：:]/
  const catsIn = (text: string): Array<{ c: string; neg: boolean }> => {
    const out: Array<{ c: string; neg: boolean }> = []
    let prevEnd = 0
    for (const m of text.matchAll(CAT_RE)) {
      out.push({ c: classOf(m[0]), neg: NEG_RE.test(text.slice(prevEnd, m.index!)) })
      prevEnd = m.index! + m[0].length
    }
    return out
  }
  const claims: Claim[] = []
  occ.forEach((o, i) => {
    let stop = Math.min(o.end + 18, i + 1 < occ.length ? occ[i + 1].start : s.length)
    const d = s.slice(o.end, stop).search(DELIM)
    if (d >= 0) stop = o.end + d
    let found = catsIn(s.slice(o.end, stop))
    if (found.length === 0) {
      let from = Math.max(i > 0 ? occ[i - 1].end : 0, o.start - 14)
      const pre = s.slice(from, o.start)
      const dd = Math.max(pre.lastIndexOf('，'), pre.lastIndexOf(','), pre.lastIndexOf('、'), pre.lastIndexOf('；'), pre.lastIndexOf('。'))
      from += dd + 1
      const before = s.slice(from, o.start)
      if (/前|用|搭配|选|填|配/.test(before)) found = catsIn(before)
    }
    if (found.length) {
      // 说的是学生写错的样子（典型错误：…time to 后动词加了其他形式）：不当成对这个短语的断言（方向无法可靠判断），交给下面的证据覆盖去核
      if (ERR_CTX_RE.test(s.slice(0, o.start))) return
      claims.push({ e: o.e, pos: found.filter(x => !x.neg).map(x => x.c), neg: found.filter(x => x.neg).map(x => x.c) })
    }
  })
  return claims
}

/** 「加 -es / 变成 -ies / 不是加 s」这类词尾说法：词尾 + 是不是否定 */
interface SufClaim { suf: string; neg: boolean }
const SUF_RE = /(而不是|不是|不能|不要|不可以|不可|不用|并非|别|误|错|不)?\s*(?:要加|加上|加|变成|变为)\s*-?\s*(ies|es|ed|ing|s|d)(?![A-Za-z])/g
function suffixClaims(text: string): SufClaim[] {
  const out: SufClaim[] = []
  for (const m of text.matchAll(SUF_RE)) out.push({ suf: m[2], neg: !!m[1] })
  return out
}

/**
 * 一个句子里的词尾说法，按「小句」归到各自的英文词上（「…一般加 -s，再单独记 tomato 加 -es、sheep 不加 -s」：
 * 「加 -s」说的是前面那个小句里的词，不能算到 sheep 头上）。
 * 小句 = 按逗号 / 顿号 / 分号 / 冒号切开；只有英文词、没有说法的小句（「tomato、potato 变复数都加 -es」里的 tomato）并入后面的有说法的小句；
 * 「典型错误：…」「孩子容易给 sheep 加 -s」这类描述学生写错的句子，方向反过来（直到出现「其实 / 应该 / 正确的是」）。
 */
export function suffixSegments(sentence: string): Array<{ words: string[]; claims: SufClaim[] }> {
  const segs = sentence.split(/[，,、；;：:]/)
  const out: Array<{ words: string[]; claims: SufClaim[] }> = []
  let pending: string[] = []
  let errMode = false
  for (const seg of segs) {
    if (ERR_RESET_RE.test(seg)) errMode = false
    const m = ERR_CTX_RE.exec(seg)
    const before = m ? m.index : -1
    const claims = [...seg.matchAll(SUF_RE)].map(c => {
      // 说法在「错误描述」词之后（或前面的小句已经进入了错误描述）→ 反过来；「易误加」的「误」本身已经是否定，不重复反转
      const inv = (errMode || (before >= 0 && before < c.index!)) && !/^(误|错)/.test(c[1] ?? '')
      return { suf: c[2], neg: !!c[1] !== inv }
    })
    if (m) errMode = true
    const words = enTerms(seg)
    if (claims.length === 0) {
      const cjk = (seg.match(/[㐀-鿿]/g) ?? []).length
      if (words.length && cjk <= 1) pending.push(...words)
      else pending = []
      continue
    }
    out.push({ words: [...new Set([...pending, ...words])], claims })
    pending = []
  }
  return out
}

/** 是规则句：有英文词语，又有规则的口气；纯数据句（份数、占比）不算 */
export function isRuleSentence(s: string): boolean {
  if (enTerms(s).length === 0 || !CUE_RE.test(s)) return false
  if (/份卷|占比|出现率|百分点|分值|样本|题数|%/.test(s) && !/后接|读作|变成|复数|搭配/.test(s)) return false
  return true
}

interface Clause { text: string; en: Set<string>; cn: Set<string>; rels: Rel[]; suf: SufClaim[] }

function clausesOf(evidence: string[]): Clause[] {
  const out: Clause[] = []
  for (const e of evidence) {
    for (const part of e.replace(/\r\n/g, '\n').split(/[。；;\n]/)) {
      const t = part.trim()
      if (t.length < 2) continue
      out.push({ text: t, en: new Set(enTerms(t)), cn: new Set(cnTerms(t)), rels: relationsOf(t), suf: suffixClaims(t) })
    }
  }
  return out
}

const CLASS_NAME: Record<string, string> = { verb: '动词', noun: '名词', ing: '-ing', adj: '形容词', adv: '副词' }
const className = (c: string) => CLASS_NAME[c] ?? c

/**
 * 核对一段 AI 文本里的规则句。三道关，前两道看「说的方向对不对」，第三道看「证据里有没有」：
 *  ① 英文短语接什么词类（time for / time to）：证据里写了这个短语接什么，句子说的词类（不管用「后接 / 后面要接 / 加 / 要用」哪种说法，也不管句子有没有规则的口气词）不一致 → 矛盾；
 *  ② 词尾（tomato 的复数加 -es）：句子里的词在证据里有词尾说法，句子说的词尾对不上、或正好是证据里说「易误加」的那个 → 矛盾；
 *  ③ 其余规则句：句子里的英文词语必须有一条证据子句基本覆盖（≥ 80%，两个以内要全部覆盖），并且这条子句说的是同类的语法点，否则 → 未核实。
 * 这是启发式：通过只表示「和审核过的题目解释说的一致」，不表示一定对；证据里没写过的规则、证据里没出现过的短语，会标「未核实」。
 * @param evidence 证据：已审核题目的易错说明、知识点的白话释义 / 例句（每条一个字符串，可含分号 / 换行）
 */
export function checkRules(markdown: string, evidence: string[]): RuleFinding[] {
  const cl = clausesOf(evidence)
  const allRels = cl.flatMap(c => c.rels)
  const phrases = new Set(allRels.map(r => r.e))
  const findings: RuleFinding[] = []
  const seen = new Set<string>()
  for (const s0 of splitSentences(markdown)) {
    if (seen.has(s0)) continue
    seen.add(s0)
    // 括号里纯英文的是「例子」（介词固定搭配（It's time for lunch.）：……），不是对规则的断言：核对时先拿掉；括号里有中文的（「shoes 是复数，be 动词用 are」）照常核对
    const s = s0.replace(/[（(][^（()）\u3400-\u9fff]*[）)]/g, '').replace(/\s{2,}/g, ' ').trim()
    if (s.length < 4) continue

    // ① 英文短语 → 词类
    let verdict: 'ok' | 'conflict' | null = null
    let reason = ''
    for (const claim of phraseClaims(s, phrases)) {
      const known = new Set(allRels.filter(x => x.e === claim.e).map(x => x.c))
      if (known.size === 0) continue
      const bad = claim.pos.length > 0 && !claim.pos.some(c => known.has(c))
      const bad2 = claim.neg.some(c => known.has(c))
      if (bad || bad2) {
        verdict = 'conflict'
        reason = `和已审核题目的解释不一致：题目里写的是「${claim.e}」后接${[...known].map(className).join(' / ')}`
        break
      }
      verdict = verdict ?? 'ok'
    }
    if (verdict === 'conflict') { findings.push({ sentence: s0, kind: 'conflict', reason }); continue }

    if (!isRuleSentence(s) && verdict === null) continue
    if (verdict === 'ok') continue

    // ② 词尾：按小句把说法归到各自的词上，再和证据里同一个词的词尾说法比
    let sufBad = ''
    for (const seg of suffixSegments(s)) {
      for (const w of seg.words) {
        const ev = cl.filter(c => c.en.has(w)).flatMap(c => c.suf)
        if (ev.length === 0) continue
        const evPos = new Set(ev.filter(x => !x.neg).map(x => x.suf)), evNeg = new Set(ev.filter(x => x.neg).map(x => x.suf))
        const sp = seg.claims.filter(x => !x.neg).map(x => x.suf), sn = seg.claims.filter(x => x.neg).map(x => x.suf)
        if (sp.some(x => evNeg.has(x) && !evPos.has(x)) || (evPos.size > 0 && sp.length > 0 && !sp.some(x => evPos.has(x))) || sn.some(x => evPos.has(x))) {
          sufBad = `和已审核题目的解释不一致：题目里写的是「${w}」${[...evPos].map(x => '加 -' + x).join(' / ') || '不加 ' + [...evNeg].map(x => '-' + x).join(' / ')}`
          break
        }
      }
      if (sufBad) break
    }
    if (sufBad) { findings.push({ sentence: s0, kind: 'conflict', reason: sufBad }); continue }

    // ③ 证据覆盖：句子里的每个英文词语都要在证据里出现过，并且出现它的那条证据说的是同类的语法点（中文里的规则用语有重合）
    const en = [...new Set(enTerms(s))]
    const cn = cnTerms(s)
    const missing = en.filter(w => !cl.some(c => c.en.has(w)))
    if (missing.length > 0) {
      findings.push({ sentence: s0, kind: 'unverified', reason: `审核过的题目解释里没有提到「${missing.slice(0, 3).join('、')}」，找不到依据` })
      continue
    }
    const supported = (w: string) => cl.some(c => c.en.has(w) && (cn.length === 0 || cn.filter(k => c.cn.has(k)).length / cn.length >= 0.3))
    if (en.some(w => !supported(w))) findings.push({ sentence: s0, kind: 'unverified', reason: '审核过的题目解释里找不到对应的说法' })
  }
  return findings
}

export const MARK_UNVERIFIED = '〔未核实〕'
export const MARK_CONFLICT = '〔与题目解释矛盾，请核对〕'
export const MARK_RE = /〔(?:未核实|与题目解释矛盾，请核对)〕/g

/** 句子在这一行里的位置：句子是「去掉排版和标注之后」的文字，所以在去掉之后的文字里找，再按位置映射回原行 */
function locate(line: string, sentence: string): Array<{ start: number; end: number }> {
  const m = mapInline(line)
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const i = m.text.indexOf(sentence, from)
    if (i < 0) break
    out.push({ start: m.map[i], end: m.map[i + sentence.length - 1] + 1 })
    from = i + sentence.length
  }
  return out
}

/**
 * 把核对结果写回文本：每个有问题的句子后面紧跟一个标记。标记写进 Markdown 本身，界面、导出的 Markdown / PDF / Word 就都能看见，不用各处再各画一遍。
 * 句子里夹着引用、粗体、反引号也能找到（按字的位置映射回原行）。missed = 在正文里怎么也找不到的句子（只能在「未核实」列表里体现）。
 */
export function markFindings(markdown: string, findings: RuleFinding[]): { text: string; marked: number; missed: RuleFinding[] } {
  if (findings.length === 0) return { text: markdown, marked: 0, missed: [] }
  const lines = markdown.split('\n')
  const hit = new Set<RuleFinding>()
  const out = lines.map(line => {
    let l = line
    for (const f of findings) {
      const mark = f.kind === 'conflict' ? MARK_CONFLICT : MARK_UNVERIFIED
      const spots = locate(l, f.sentence)
      for (let k = spots.length - 1; k >= 0; k--) {
        const end = spots[k].end
        hit.add(f)
        if (l.slice(end).startsWith('〔')) continue
        l = l.slice(0, end) + mark + l.slice(end)
      }
    }
    return l
  })
  return { text: out.join('\n'), marked: hit.size, missed: findings.filter(f => !hit.has(f)) }
}

const TRAILING_JUNK = /^\s*(?:\*\*|`|〔[^〕]{0,20}〕|\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\](?:（[^）]{0,80}）)?)/

/**
 * 把一个句子从 Markdown 里删掉：句子里夹着引用、粗体也能删（按字的位置映射回原行），紧跟在句末的引用、标记和一个句末标点一并删掉；
 * 删掉后粗体记号成单就去掉这一行的粗体；删完整行都空了（只剩列表序号）就连这一行一起删。找不到就原样返回。
 */
export function removeSentence(markdown: string, sentence: string): string {
  const out: string[] = []
  for (const line of markdown.split('\n')) {
    const spots = locate(line, sentence)
    if (spots.length === 0) { out.push(line); continue }
    let l = line
    for (let k = spots.length - 1; k >= 0; k--) {
      let { start, end } = spots[k]
      for (;;) { const m = TRAILING_JUNK.exec(l.slice(end)); if (!m) break; end += m[0].length }
      if (/[。！？；;!?]/.test(l[end] ?? '')) end++
      l = l.slice(0, start) + l.slice(end)
    }
    if ((l.match(/\*\*/g) ?? []).length % 2 === 1) l = l.replace(/\*\*/g, '')
    if (/^\s*(?:[-*+]|\d+[.、)])?\s*$/.test(l)) continue
    out.push(l)
  }
  return out.join('\n')
}

/** 去掉标记（复制到微信等纯文本场景） */
export const stripMarks = (s: string): string => s.replace(MARK_RE, '')
