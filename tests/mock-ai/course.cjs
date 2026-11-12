// mock 的课程对照应答：认列（p5_course_cols）、知识点匹配（p5_course_match）、家长话术（p5_course_advice）、家长版一句话（p5_course_hint）。
// 和真实模型一样「只解读输入」：认列从预览里的表头文字判断；匹配从课程行里找知识点的例词；话术里的课令牌取自输入。全部内容虚构。
//
// quirks（模拟真实模型会犯的错，在 mock.quirks.course 里设置）：
//   colsBad       —— 认列回答不是 JSON（程序应退回按表头文字猜）
//   colsNoSeq     —— 认列回答里没有课次 / 标题列（同上）
//   matchBadQuote —— 每个知识点的第一条对应，quote 换成课次里没有的句子（应降为 low，标「仅凭主题推测」）
//   matchBadLesson—— 每个知识点多给一条不存在的课次 #999999（应丢弃）
//   matchBadJson  —— 匹配回答不是 JSON（这一批不保存）
//   extractBad    —— 文字整理（p5_course_extract）的回答不是 JSON
//   extractInvent —— 文字整理时多编一课原文里没有的（应被程序核对后去掉）
//   textbookBadFor —— 教材挑知识点：单元标题里含这个字样的单元回答不是 JSON（这个单元整理失败，其余照常；用来测“只重试失败的单元”）
//   textbookInvent —— 教材挑知识点：每个单元多给一个知识点树里没有的代码（应被丢弃）
//   textbookFake   —— 教材挑知识点：每个单元的引用原文都换成原文里没有的句子（应降为低把握）
//   advicePrice   —— 话术里混进价格 / 优惠 / 保证提分（应整句删除）
//   adviceShort   —— 话术只有几十个字（应判失败）
//   adviceLong    —— 话术远超 200 字（应告警，不裁剪）
//   adviceBadToken—— 话术里写了输入里没有的课令牌 [课#999999]（应删除并告警）
//   adviceRule    —— 话术里多一句证据里没有的英语规则（应标「未核实」）
const COLS_RE = /请只判断「哪几行是表头/
const MATCH_RE = /请以课为单位判断每节课主要讲了哪些考点/
const ADVICE_RE = /要写一段能直接发给家长的话（150–200 字/
const EXTRACT_RE = /请把其中的「每一课」整理成表格的行/
const HINT_RE = /要给家长版报告写结尾处的一句课程建议/
const TEXTBOOK_RE = /请从候选里挑出这个单元主要教的知识点/

const kindOf = (sys) => COLS_RE.test(sys) ? 'cols' : MATCH_RE.test(sys) ? 'match' : ADVICE_RE.test(sys) ? 'advice' : HINT_RE.test(sys) ? 'hint' : EXTRACT_RE.test(sys) ? 'extract' : TEXTBOOK_RE.test(sys) ? 'textbook' : null

const FIELD_RULES = [
  ['textbook_ref', /对标|教材|课本/], ['level', /级别|等级/], ['seq', /课次|课序|序号/], ['title', /标题|课名/], ['theme', /主题|话题/],
  ['phonics', /字母|语音|拼读/], ['word', /词汇|单词/], ['pattern', /句型|句式|语法/], ['expression', /表达|口语/], ['skill', /能力|目标/], ['note', /备注|说明/]
]
const PRICE = /价格|学费|费用|优惠|折扣|元/

/** 认列：预览行形如「行3: 1=课次 | 2=主题」；先找出表头占几行（第一行有课次数字的数据行之前），再逐列判断 */
function buildCols(user) {
  const rows = [...user.matchAll(/^行(\d+): (.*)$/gm)].map(m => ({ n: Number(m[1]), cells: Object.fromEntries(m[2].split(' | ').map(x => x.split('=')).filter(p => p.length >= 2).map(p => [Number(p[0]), p.slice(1).join('=')])) }))
  const first = rows.find(r => Object.values(r.cells).some(v => /^\d+$/.test(v)))
  const headerRows = first ? first.n - 1 : 1
  const labels = {}
  for (const r of rows.filter(r => r.n <= headerRows)) for (const [c, v] of Object.entries(r.cells)) labels[c] = labels[c] ? `${labels[c]}·${v}` : v
  const columns = []
  for (const [c, label] of Object.entries(labels)) {
    if (PRICE.test(label)) { columns.push({ col: Number(c), field: 'ignore' }); continue }
    const hit = FIELD_RULES.find(([, re]) => re.test(label))
    columns.push({ col: Number(c), field: hit ? hit[0] : 'ignore' })
  }
  return { header_rows: headerRows, level_name: '', columns, skip_markers: [], uncertain: [] }
}

/** 匹配（以课为单位）：每节课的行里找哪些知识点的例词（第 4 段）出现了，最多 3 个；找到的原样摘一段做 quote。「已认出:K..」的不重复给 */
function buildMatch(user, quirks) {
  const outline = (/【课程大纲】[^\n]*\n([\s\S]*?)\n\n【考点表】/.exec(user)?.[1] ?? '').split('\n').filter(Boolean)
  const kps = (/【考点表】[^\n]*\n([\s\S]*?)\n\n请按 system/.exec(user)?.[1] ?? '').split('\n').filter(Boolean).map(line => {
    const [tok, name, , hints] = line.split(' | ')
    return { tok, name, words: (hints || '').split(/[\/、,，\s]+/).map(w => w.trim()).filter(w => w.length >= 3 && w !== '—') }
  })
  const results = []
  for (const l of outline) {
    const id = /^#(\d+)/.exec(l)?.[1]
    if (!id) continue
    const known = new Set((/已认出:([^|]*)/.exec(l)?.[1] ?? '').trim().split(/\s+/).filter(Boolean))
    const items = []
    for (const k of kps) {
      if (known.has(k.tok) || items.length >= 3) continue
      const w = k.words.find(x => l.toLowerCase().includes(x.toLowerCase()))
      if (!w) continue
      const at = l.toLowerCase().indexOf(w.toLowerCase())
      items.push({ kp: k.tok, confidence: items.length === 0 ? 'high' : 'medium', quote: quirks.matchBadQuote && items.length === 0 ? '这一句课程里根本没有' : l.slice(at, at + w.length), reason: `例词 ${w} 在这一课里出现` })
    }
    results.push({ lesson: `#${id}`, kps: items })
  }
  if (quirks.matchBadLesson) results.push({ lesson: '#999999', kps: [{ kp: kps[0]?.tok ?? 'K1', confidence: 'high', quote: 'x', reason: '不存在的课' }] })
  return JSON.stringify({ results })
}

/** 话术：用输入里的课令牌和考点名写一段约 170 字的话 */
function buildAdvice(user, quirks) {
  const lines = (/【可以复习的课】[^\n]*\n([\s\S]*?)\n\n【题目解释/.exec(user)?.[1] ?? '').split('\n').filter(Boolean)
  const tokens = [...user.matchAll(/\[课#\d+\]/g)].map(m => m[0])
  const first = lines[0]?.split(' → ')[0] ?? '这个考点'
  const t1 = tokens[0] ?? '', t2 = tokens[1] ?? ''
  if (quirks.adviceShort) return `这类试卷里常见的易错点是${first}，可以多练一练。`
  let s = `这类试卷里常见的易错点是${first}。孩子在家可以这样练：每天用英语说三句昨天做过的事，家长只要听一听动词有没有变形就能判断对不对。刚开始说错很正常，让孩子多说几遍，慢慢就顺了。` +
    `如果想系统地复习，可以看看 ${t1}，里面有对应的词汇和句型${t2 ? `；再翻翻 ${t2}，把相近的说法一起过一遍` : ''}。练习的时候不用着急，每次十分钟就够。家长不用急着纠正，先听完再轻轻提醒一下就好，过几天再回头检查一遍有没有进步。`
  if (quirks.advicePrice) s += '这个课程现在报名有优惠，每节课只要99元，保证提分。'
  if (quirks.adviceBadToken) s += '也可以参考 [课#999999]。'
  if (quirks.adviceRule) s += '记住：time for 后面一定接动词原形。'
  if (quirks.adviceLong) s += '另外，家长还可以每天和孩子一起读一小段英语，读的时候不用逐字翻译，先听懂大意再看细节，遇到不会的词先圈出来，等读完再一起查。这样坚持一两周，孩子的语感会慢慢建立起来，做题时也更有把握，不容易被陷阱选项绕进去。'
  return s
}

function buildHint(user) {
  const tokens = [...user.matchAll(/\[课#\d+\]/g)].map(m => m[0])
  return `这类题常见易错，可以复习 ${tokens[0] ?? ''}。`
}

/** 文字整理：输入是「L12: 文字」逐行；课 = 以「第 N 课」或 Lesson N 开头的行，后面紧跟的「词汇：」「句型：」行归这一课。只摘输入里的原文 */
function buildExtract(user, quirks) {
  const lines = [...user.matchAll(/^L(\d+): (.*)$/gm)].map(m => ({ n: Number(m[1]), t: m[2] }))
  const lessons = []
  for (const l of lines) {
    const m = /^(第\s*\d+\s*课|Lesson\s*\d+)[\s:：.、-]*(.+)$/i.exec(l.t)
    if (m) { lessons.push({ line: l.n, level: '', seq: m[1], title: m[2].trim(), theme: '', words: '', patterns: '' }); continue }
    const cur = lessons[lessons.length - 1]
    const w = /^词汇[:：]\s*(.+)$/.exec(l.t), p = /^句型[:：]\s*(.+)$/.exec(l.t)
    if (cur && w) cur.words = w[1]
    if (cur && p) cur.patterns = p[1]
  }
  if (quirks.extractInvent) lessons.push({ line: 999, level: '', seq: '第99课', title: '凭空多出来的一课', theme: '', words: '', patterns: '' })
  return JSON.stringify({ lessons })
}

/**
 * 教材：从 user 里读出单元标题、小节标题和候选知识点（「代码 | 名称」）。和真实模型一样只解读输入：
 * 名称出现在标题 / 小节标题里的候选就挑出来（引用 = 那一小段原文）；名称对不上的单元，按单元序号从候选里确定性地挑 3 个，引用取第一个小节标题（模拟「凭主题推测」）；
 * 标题里带 Review 的单元什么都不挑（应被标成需核对）。
 */
function buildTextbook(user, quirks) {
  const title = /^单元：(.*?)（第 (\d+) \/ (\d+) 个单元/m.exec(user)
  const unitTitle = title?.[1] ?? '', no = Number(title?.[2] ?? 1)
  if (quirks.textbookBadFor && unitTitle.includes(quirks.textbookBadFor)) return '好的，我来看看这个单元……'
  const heads = (/【这个单元的小节标题和栏目名】\n([\s\S]*?)\n\n【开头的几行文字】/.exec(user)?.[1] ?? '').split('\n').filter(x => x && !x.startsWith('（'))
  const cands = (/【候选知识点】[^\n]*\n([\s\S]*?)\n\n请按 system/.exec(user)?.[1] ?? '').split('\n').filter(Boolean).map(l => { const [code, path] = l.split(' | '); return { code, name: (path ?? '').split(' / ').pop() } })
  if (/review/i.test(unitTitle) || !cands.length) return JSON.stringify({ kps: [] })
  const hay = [unitTitle, ...heads].join('\n')
  let kps = cands.filter(c => c.name && c.name.length >= 2 && hay.includes(c.name)).slice(0, 4).map(c => ({ code: c.code, confidence: 'high', quote: c.name }))
  if (!kps.length) kps = [0, 1, 2].map(j => ({ code: cands[(no * 3 + j) % cands.length].code, confidence: j === 0 ? 'medium' : 'low', quote: heads[0] ?? unitTitle }))
  if (quirks.textbookFake) kps = kps.map(k => ({ ...k, confidence: 'high', quote: '这一句书里根本没有' }))
  if (quirks.textbookInvent) kps.push({ code: 'ZZ.NOT.IN.TREE', confidence: 'high', quote: unitTitle })
  return JSON.stringify({ kps })
}

function build(kind, user, quirks = {}) {
  if (kind === 'textbook') return buildTextbook(user, quirks)
  if (kind === 'extract') return quirks.extractBad ? '好的，我来整理……' : buildExtract(user, quirks)
  if (kind === 'cols') {
    if (quirks.colsBad) return '好的，我来看看这张表……'
    const j = buildCols(user)
    if (quirks.colsNoSeq) j.columns = j.columns.filter(c => c.field !== 'seq' && c.field !== 'title')
    return JSON.stringify(j)
  }
  if (kind === 'match') return quirks.matchBadJson ? '抱歉，我无法完成。' : buildMatch(user, quirks)
  if (kind === 'advice') return buildAdvice(user, quirks)
  if (kind === 'hint') return buildHint(user)
  return ''
}

module.exports = { kindOf, build }
