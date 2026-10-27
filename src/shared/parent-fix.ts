/**
 * 家长版 / 老师版的程序侧校对（M6 验收返工 R1 / R3）：纯函数，单测直接加载。
 *  - 每个要点里的例句要和这个要点讲的东西对得上（真实输出里 tomato / sheep 那条配了 dogs，问价那条配了 Those are my shoes）：
 *    对不上就换成这个知识点自带的例句，知识点没有例句就不写例句，不能留着一个对不上的；
 *  - 家长看不懂的写法（「-es」「词尾」「time for 接…」）：能自动改的改（-es → es），改不了的报出来；
 *  - 排版：开头一句问候、条与条之间空一行、不写标题；
 *  - 字数：以「复制到微信」的字数为准（markdownToWechat），超过 300 就从最后一条起去掉例句。
 */

export interface KpEvidence {
  code?: string
  name: string
  plain: string
  /** 例句里的 ** 已经去掉也可以，这里会再清一遍 */
  example_en: string
  example_zh: string
  hint_words?: string
}

const STOP = new Set(['the', 'and', 'are', 'was', 'were', 'you', 'your', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'for', 'with', 'from', 'have', 'has', 'not', 'can', 'will', 'one', 'two', 'any', 'all', 'but', 'what', 'who', 'how', 'why', 'when', 'where', 'ok', 'is'])
const clean = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
const enWords = (s: string): string[] => [...s.toLowerCase().matchAll(/[a-z][a-z']{2,}/g)].map(m => m[0]).filter(w => !STOP.has(w))
/** 词干：tomatoes → tomato，shoes → shoe（只用来比较「是不是同一个词」，不求准确） */
const stem = (w: string) => w.replace(/(?:es|s)$/, '').replace(/(?:ing|ed)$/, '')
const sameWord = (a: string, b: string) => a === b || stem(a) === stem(b) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))

/** 例句片段：「例：English sentence（中文）」「例句：…」「比如：…」 */
const EXAMPLE_RE = /(?:例句|例如|比如|例)\s*[：:]\s*([A-Za-z][^（(\n]*?[.!?])\s*[（(]\s*([^）)\n]*?)\s*[）)]/
const MARK_RE = /\s*【考点：([^】]{1,40})】/g

export interface ParentItem { index: number; line: number; marker: string | null }

/** 把 markdown 拆成「前面的话 / 编号的要点 / 后面的话」；要点行是 `1. …` */
export function splitParent(md: string): { head: string[]; items: Array<{ text: string; marker: string | null }>; tail: string[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const head: string[] = [], items: Array<{ text: string; marker: string | null }> = [], tail: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const m = /^\s*\d+[.、)]\s*(.*)$/.exec(line)
    if (m) {
      let marker: string | null = null
      const text = m[1].replace(MARK_RE, (_x, name: string) => { marker = name.trim(); return '' }).trim()
      items.push({ text, marker })
    } else if (items.length === 0) head.push(line.replace(MARK_RE, '').trim())
    else tail.push(line.replace(MARK_RE, '').trim())
  }
  return { head, items, tail }
}

/** 这个要点属于哪个知识点：先看要点末尾的【考点：名称】，再看要点文字里提到了谁（名称、例词） */
export function matchKp(item: { text: string; marker: string | null }, kps: KpEvidence[]): KpEvidence | null {
  if (item.marker) {
    const m = item.marker.replace(/\s+/g, '')
    const hit = kps.find(k => k.name.replace(/\s+/g, '') === m) ?? kps.find(k => m.includes(k.name.replace(/\s+/g, '')) || k.name.replace(/\s+/g, '').includes(m))
    if (hit) return hit
  }
  const words = new Set(enWords(item.text.replace(EXAMPLE_RE, '')))
  let best: KpEvidence | null = null, bestScore = 0
  for (const k of kps) {
    let score = 0
    if (item.text.includes(k.name)) score += 3
    for (const w of enWords(`${k.hint_words ?? ''} ${k.example_en}`)) if ([...words].some(x => sameWord(x, w))) score += 2
    if (k.plain && [...k.plain].filter(ch => /[一-龥]/.test(ch) && item.text.includes(ch)).length >= 6) score += 1
    if (score > bestScore) { bestScore = score; best = k }
  }
  return bestScore >= 2 ? best : null
}

/**
 * 校对一个要点的例句。返回改后的要点文字和做了什么：
 *  keep    = 例句和要点对得上（例句里出现了要点点名的英文词，或本来就是这个知识点自带的例句）
 *  replace = 对不上，换成知识点自带的例句
 *  drop    = 对不上而且知识点没有例句，去掉例句
 *  none    = 这个要点本来就没写例句
 */
export function fixItemExample(item: { text: string; marker: string | null }, kps: KpEvidence[]): { text: string; action: 'keep' | 'replace' | 'drop' | 'none' } {
  const m = EXAMPLE_RE.exec(item.text)
  if (!m) return { text: item.text, action: 'none' }
  const kp = matchKp(item, kps)
  const body = item.text.replace(EXAMPLE_RE, '')
  const itemKeys = enWords(body)
  const kpKeys = kp ? enWords(`${kp.hint_words ?? ''} ${kp.example_en}`) : []
  const has = (ex: string, keys: string[]) => enWords(ex).some(w => keys.some(k => sameWord(w, k)))
  // 要点里点名了英文词就看这些词；一个英文词都没点名（「鞋子两只用 are」）就看这个知识点自己的词
  const fits = (ex: string) => (itemKeys.length > 0 ? has(ex, itemKeys) : kpKeys.length === 0 || has(ex, kpKeys))
  const ex = m[1].trim()
  if (fits(ex)) return { text: item.text, action: 'keep' }
  const own = kp && kp.example_en ? clean(kp.example_en) : ''
  // 候选：这个知识点自带的例句，再是别的知识点里正好含有要点点名的词的例句
  const cands: Array<{ en: string; zh: string }> = []
  if (kp && own) cands.push({ en: own, zh: clean(kp.example_zh) })
  for (const k of kps) if (k !== kp && k.example_en) cands.push({ en: clean(k.example_en), zh: clean(k.example_zh) })
  const pick = cands.find(c => fits(c.en))
  if (pick) {
    const label = /例句/.test(m[0]) ? '例句' : '例'
    return { text: item.text.replace(EXAMPLE_RE, `${label}：${pick.en}${pick.zh ? `（${pick.zh}）` : ''}`), action: 'replace' }
  }
  return { text: item.text.replace(EXAMPLE_RE, '').replace(/\s*[。.]\s*$/, '。').replace(/\s{2,}/g, ' ').trim(), action: 'drop' }
}

/** 家长看不懂的写法：能改的改，剩下的报出来 */
const JARGON = ['词尾', '后缀', '前缀', '名词', '动词', '形容词', '副词', '介词', '代词', '冠词', '单复数', '复数形式', '第三人称', '时态', '语法', '词性', '过去式', '原形']
export function fixParentJargon(text: string): { text: string; left: string[] } {
  // 「加 -es」→「加 es」（横线像减号）
  const t = text.replace(/(^|[\s加变成是用写读])-(es|ies|ed|ing|s)(?![A-Za-z])/g, '$1$2')
  const left = JARGON.filter(w => t.includes(w))
  // 「time for 接早饭」：这个「接」是语法书的写法，家长读不顺
  if (/[A-Za-z]\s*接(?!下来|着|受|触|待|送|力|电|通|近|到)/.test(t)) left.push('接')
  return { text: t, left }
}

/** 开头问候：考试类型按卷子来写（期中 / 期末 / 单元测验……），不知道就不写，不能写死「期末」 */
export function parentGreeting(exam?: string | null): string {
  const e = (exam ?? '').replace(/(?:考试|测试|试卷|卷)$/, '').trim()
  return `各位家长好，这次${e ? `${e}` : ''}英语${e ? '' : '考试'}有这几个小地方孩子容易错，在家几分钟就能帮上：`
}
export const PARENT_GREETING = parentGreeting('')

/**
 * 去掉要点开头的小标题（「**西红柿绵羊**：…」「到时间：…」）。真实输出里小标题是把名词堆在一起的（读不通），
 * 家长版不要小标题，每条直接从完整的句子开始。只去开头那一个「短语 + 冒号」，且短语里没有句号 / 逗号。
 */
export function stripItemTitle(text: string): string {
  // 「例句：」「易错点：」「注意读音：」「孩子常错：」这类承上启下的开头不是小标题，不能削掉
  if (/^\s*(?:例|易错|注意|孩子|常|在家|做|问|说|写|读|记|练)[^，。：:]{0,6}[：:]/.test(text) && !/^\s*\*\*/.test(text)) return text.trim()
  return text.replace(/^\s*\*\*[^*\n]{1,20}\*\*\s*[：:]\s*/, '').replace(/^\s*[^，。,.！？!?：:\sA-Za-z（）()“”是的了在要会让把有]{2,8}[：:]\s*(?=\S)/, '').trim()
}

const SENT_END = /[。！？!?）)”"]$/
/** 末尾是汉字 / 字母 / 数字（没有标点收尾，像电报）→ 补一个句号。只补标点，不改句子内容。 */
export function endWithPeriod(text: string): string {
  const t = text.trim()
  if (!t || SENT_END.test(t) || /[.]$/.test(t)) return t
  return /[\u4e00-\u9fa5A-Za-z0-9]$/.test(t) ? `${t}。` : t
}

/** 句子里至少要有个动作 / 判断的字，纯名词堆（「tomato 一个其他多个」）不算一句话 */
const PREDICATE = /容易|要|说|写|问|读|念|用|加|是|有|会|能|做|错|对|变|分|记|练|看|听|拼|选|带|找|比|请|让|别|不|没|该|应/
const EXAMPLE_PART = /例(?:句)?\s*[：:][^（(\n]*[（(][^）)\n]*[）)]/g

/**
 * 校验一个要点是不是一段通顺的话。**必须拿模型写的原文来校验（补句号之前）**，否则「没写完」「没有句号」永远查不出来。
 * 有问题的要点整条不要（后处理不能把句子砍成片段，也不替模型补半句话）：
 *  - 句末没有标点（写得像电报或没写完）、以逗号 / 冒号 / 顿号 / 「的」「和」结尾
 *  - 没有一句够长又带动作的完整句子（「tomato 一个其他多个」）；中文片段里有一段没有动作的字，也算
 *  - 「问 can not，答 can't」这种电报式的做法（家长不知道怎么做）
 *  - 「A 和 B：」「A、B：」这种名词直接堆在一起的小标题（去掉标题之后还留在句子里的）
 */
export function itemProblems(text: string): string[] {
  const t = text.trim()
  const out: string[] = []
  if (!SENT_END.test(t) && !/[.]$/.test(t)) out.push('句末没有标点，像电报或没写完')
  if (/[，,：:、的和与]$/.test(t)) out.push('句子没写完')
  const plain = t.replace(EXAMPLE_PART, '')
  const segs = plain.split(/[。！？\n]/).map(x => x.trim()).filter(x => /[\u4e00-\u9fa5]/.test(x))
  const zh = (x: string) => (x.match(/[\u4e00-\u9fa5]/g) ?? []).length
  if (!segs.some(x => zh(x) >= 4 && PREDICATE.test(x))) out.push('没有一句完整的话（缺少动作，或太短）')
  else if (segs.some(x => !PREDICATE.test(x))) out.push('有一句话没有动作，像名词堆在一起')
  if (/问[^。！？\n]{1,20}[，,]\s*答/.test(t)) out.push('「问……，答……」的写法家长看不懂该怎么做')
  if (/(?:^|[。！？]\s*)[^，。！？：:\n]{1,10}[和与、][^，。！？：:\n]{1,10}[：:]/.test(t)) out.push('名词堆在一起的小标题')
  return out
}

export interface ParentFixResult { text: string; warnings: string[]; replaced: number; dropped: number; brokenItems: number }

/**
 * 家长版收尾：去【考点】标记 → 去小标题 → 校对例句 → 去术语写法 → 整条校验（拿模型写的原文校验，不先补句号）→ 问候 / 空行 → 字数。
 * 后处理只做三件事：删整句（超字数时去掉一条的例句）、把例句整句换成知识点自带的、删整条；绝不截断句子、不拼接。
 * wechatLen = 复制到微信的字数函数（由调用方传，避免循环依赖）。
 */
export function fixParent(md: string, kps: KpEvidence[], wechatLen: (md: string) => number, limit = 300, exam?: string | null): ParentFixResult {
  const { head, items, tail } = splitParent(md)
  const warnings: string[] = []
  let replaced = 0, dropped = 0, brokenItems = 0
  const fixed = items.map(it => {
    const titled = { ...it, text: stripItemTitle(it.text) }
    const r = fixItemExample(titled, kps)
    if (r.action === 'replace') replaced++
    if (r.action === 'drop') dropped++
    const j = fixParentJargon(r.text)
    return { text: j.text, left: j.left }
  })
  // 整条校验：有问题的整条删掉（宁可少一条，也不留半句话）
  const good = fixed.filter(f => {
    const pr = itemProblems(f.text)
    if (pr.length) { brokenItems++; warnings.push(`家长版有一条不通顺（${pr.join('；')}），已整条去掉，不够 3 条时请重新生成`) }
    return pr.length === 0
  })
  const jargon = [...new Set(good.flatMap(f => f.left))]
  const greetingLines = head.filter(Boolean)
  const hasGreeting = greetingLines.some(l => /家长/.test(l))
  const tailLines = tail.map(endWithPeriod)
  const build = (its: string[]): string => {
    const out: string[] = []
    out.push(...(hasGreeting ? greetingLines : [parentGreeting(exam), ...greetingLines]))
    its.forEach((t, i) => out.push(`${i + 1}. ${t}`))
    out.push(...tailLines)
    return out.join('\n\n') + '\n'
  }
  let texts = good.map(f => f.text)
  let text = build(texts)
  // 超过字数：先从最后一条起去掉例句（整句），还超就整条去掉最后一条（至少留 2 条）
  for (let i = texts.length - 1; i >= 0 && wechatLen(text) > limit; i--) {
    const stripped = endWithPeriod(texts[i].replace(EXAMPLE_RE, '').replace(/\s*[。.]\s*$/, '。').trim())
    if (stripped !== texts[i] && itemProblems(stripped).length === 0) { texts = [...texts.slice(0, i), stripped, ...texts.slice(i + 1)]; text = build(texts) }
  }
  while (texts.length > 2 && wechatLen(text) > limit) { texts = texts.slice(0, -1); text = build(texts); warnings.push('家长版超过 300 字，已去掉最后一条') }
  if (replaced) warnings.push(`家长版里有 ${replaced} 条的例句和要点对不上，已换成这个知识点自带的例句`)
  if (dropped) warnings.push(`家长版里有 ${dropped} 条的例句和要点对不上、又没有可替换的例句，已去掉例句`)
  if (jargon.length) warnings.push(`家长版里还有家长可能看不懂的写法（${jargon.join('、')}），发出去之前请老师改成大白话`)
  if (!hasGreeting) warnings.push('模型没写开头的问候，已由程序补一句')
  if (tail.length === 0) warnings.push('家长版结尾没有回答「要不要担心」，请老师补一句')
  if (texts.length < 3) warnings.push(`家长版只剩 ${texts.length} 条，建议重新生成`)
  return { text, warnings, replaced, dropped, brokenItems }
}

// ───────────────────────── 老师版：例句和考点配套 ─────────────────────────

const QUOTED_EXAMPLE = /“([A-Za-z][A-Za-z0-9' ,.\-!?]*?)\s*([\u4e00-\u9fa5][^“”\n]*)?”/

/**
 * 老师版：每个「### 考点」小节里引号中的英文例句要和这个考点配套（真实输出里语音配 fish and fox、词形配 Hot is the opposite of cold）。
 * 对不上：能换成知识点自带 / 别的知识点里含有本节点名词的例句就换；换不了只报出来（句子是整段话的一部分，不能硬删）。
 */
export function fixTeacherExamples(md: string, kps: KpEvidence[]): { text: string; warnings: string[]; replaced: number; unmatched: string[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = [...lines]
  let replaced = 0
  const unmatched: string[] = []
  let start = -1
  const sections: Array<[number, number, string]> = []
  lines.forEach((l, i) => {
    if (/^###\s/.test(l) || /^##\s/.test(l)) { if (start >= 0) sections.push([start, i, lines[start].replace(/^#+\s*/, '')]); start = /^###\s/.test(l) ? i : -1 }
  })
  if (start >= 0) sections.push([start, lines.length, lines[start].replace(/^#+\s*/, '')])
  for (const [a, b, name] of sections) {
    const body = lines.slice(a + 1, b).join('\n')
    const m = QUOTED_EXAMPLE.exec(body)
    if (!m) continue
    const rest = body.replace(QUOTED_EXAMPLE, '')
    const keys = enWords(`${name} ${rest.replace(/\[[^\]]*\]/g, '')}`)
    if (keys.length === 0 || enWords(m[1]).some(w => keys.some(k => sameWord(w, k)))) continue
    const kp = matchKp({ text: `${name} ${rest}`, marker: name }, kps)
    const cands = [...(kp ? [kp] : []), ...kps.filter(k => k !== kp)].filter(k => k.example_en)
    const pick = cands.find(k => enWords(clean(k.example_en)).some(w => keys.some(x => sameWord(w, x))))
    if (pick) {
      for (let i = a + 1; i < b; i++) if (QUOTED_EXAMPLE.test(out[i])) { out[i] = out[i].replace(QUOTED_EXAMPLE, `“${clean(pick.example_en)} ${clean(pick.example_zh)}”`); replaced++; break }
    } else unmatched.push(name)
  }
  const warnings: string[] = []
  if (replaced) warnings.push(`老师版里有 ${replaced} 处例句和考点对不上，已换成配套的例句`)
  if (unmatched.length) warnings.push(`老师版里「${unmatched.join('」「')}」的例句和考点可能对不上，备课时请换一个`)
  return { text: out.join('\n'), warnings, replaced, unmatched }
}

// ───────────────────────── 老板版 ─────────────────────────

/**
 * 样本少（< 3 份）时程序声明了「不下难点结论」，正文就不能再写「可能全部易错」「是难点」这类结论。
 * **整句改写**：命中的这一句改成「<主语>在 AI 估计里容易错的题偏多。」，不在原句里换半截（换半截会生成「学生AI 估计容易错的比较多」这样不通顺的话）；
 * 否定句（「不是难点」）不动。返回改了几句。
 */
const OVERCLAIM_RE: RegExp[] = [
  /(?:可能|大概|应该)?全部(?:都)?(?:是)?(?:容易)?易错(?:题)?/,
  /(?:全都|都|普遍)(?:很)?容易错/,
  /普遍(?:易错|丢分)/,
  /(?:是|属于)(?:本次|这次|该年级|全年级)?(?:的)?(?:最大)?难点/
]
const NEGATED = /(?:不|并非|没有|不算|不属于)\s*$/
const SUBJECT_TAIL = /[\s，,]*(?:都|也|可能|大概|应该|普遍|全部|全都)*$/
export function softenOverclaims(text: string): { text: string; changed: number } {
  let changed = 0
  const out = text.split('\n').map(line => {
    // 保留行首的列表记号 / 粗体 / 序号，只改正文里的句子
    const m = /^(\s*(?:[-*+]\s+|\d+[.、)]\s*)?(?:\*\*[^*]*\*\*\s*[：:]?\s*)?)(.*)$/.exec(line)!
    const prefix = m[1], rest = m[2]
    const parts = rest.split(/(?<=[。！？；;])/)
    const fixed = parts.map(sent => {
      for (const re of OVERCLAIM_RE) {
        const hit = re.exec(sent)
        if (!hit) continue
        if (NEGATED.test(sent.slice(0, hit.index))) continue
        // 主语：命中位置之前最近的一个分句（逗号之后），去掉尾巴上的「都 / 可能……」
        const before = sent.slice(0, hit.index).replace(SUBJECT_TAIL, '')
        const subj = (before.split(/[，,：:]/).pop() ?? '').trim()
        changed++
        return `${subj && subj.length <= 24 ? subj : '这几块'}在 AI 估计里容易错的题偏多${/[。！？；;]\s*$/.exec(sent)?.[0].trim() || ''}`
      }
      return sent
    })
    return prefix + fixed.join('')
  })
  return { text: out.join('\n'), changed }
}

/** 老板版里不该出现的统计 / 内部用词 */
const BOSS_JARGON = ['基线学年', '目标学年', '基线', '出现率', '程序判定', '百分点', '置信度', '样本偏小', '样本不足']
export const bossJargon = (text: string): string[] => BOSS_JARGON.filter(w => text.includes(w))
