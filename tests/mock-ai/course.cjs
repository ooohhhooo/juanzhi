// mock 的课程对照应答：认列（p5_course_cols）、知识点匹配（p5_course_match）、家长话术（p5_course_advice）、家长版一句话（p5_course_hint）。
// 和真实模型一样「只解读输入」：认列从预览里的表头文字判断；匹配从课程行里找知识点的例词；话术里的课令牌取自输入。全部内容虚构。
//
// quirks（模拟真实模型会犯的错，在 mock.quirks.course 里设置）：
//   colsBad       —— 认列回答不是 JSON（程序应退回按表头文字猜）
//   colsNoSeq     —— 认列回答里没有课次 / 标题列（同上）
//   matchBadQuote —— 每个知识点的第一条对应，quote 换成课次里没有的句子（应降为 low，标「仅凭主题推测」）
//   matchBadLesson—— 每个知识点多给一条不存在的课次 #999999（应丢弃）
//   matchBadJson  —— 匹配回答不是 JSON（这一批不保存）
//   advicePrice   —— 话术里混进价格 / 优惠 / 保证提分（应整句删除）
//   adviceShort   —— 话术只有几十个字（应判失败）
//   adviceLong    —— 话术远超 200 字（应告警，不裁剪）
//   adviceBadToken—— 话术里写了输入里没有的课令牌 [课#999999]（应删除并告警）
//   adviceRule    —— 话术里多一句证据里没有的英语规则（应标「未核实」）
const COLS_RE = /请只判断「哪几行是表头/
const MATCH_RE = /请判断每个考点在大纲的哪几课里讲到/
const ADVICE_RE = /要写一段能直接发给家长的话（150–200 字/
const HINT_RE = /要给家长版报告写结尾处的一句课程建议/

const kindOf = (sys) => COLS_RE.test(sys) ? 'cols' : MATCH_RE.test(sys) ? 'match' : ADVICE_RE.test(sys) ? 'advice' : HINT_RE.test(sys) ? 'hint' : null

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

/** 匹配：每个知识点拿例词（第 4 段）和名字去课程行里找；找到的原样摘一段做 quote */
function buildMatch(user, quirks) {
  const outline = (/【课程大纲】[^\n]*\n([\s\S]*?)\n\n【考点】/.exec(user)?.[1] ?? '').split('\n').filter(Boolean)
  const kps = (/【考点】[^\n]*\n([\s\S]*?)\n\n请按 system/.exec(user)?.[1] ?? '').split('\n').filter(Boolean)
  const results = []
  for (const line of kps) {
    const [tok, name, , hints] = line.split(' | ')
    const words = (hints || '').split(/[\/、,，\s]+/).map(w => w.trim()).filter(w => w.length >= 3 && w !== '—')
    const hits = []
    for (const l of outline) {
      const id = /^#(\d+)/.exec(l)?.[1]
      const w = words.find(x => l.toLowerCase().includes(x.toLowerCase()))
      if (id && w) hits.push({ id, quote: l.slice(l.toLowerCase().indexOf(w.toLowerCase()), l.toLowerCase().indexOf(w.toLowerCase()) + w.length) })
    }
    if (!hits.length) { results.push({ kp: tok, none: true }); continue }
    hits.slice(0, 3).forEach((h, i) => results.push({ kp: tok, lesson: `#${h.id}`, confidence: i === 0 ? 'high' : 'medium', quote: quirks.matchBadQuote && i === 0 ? '这一句课程里根本没有' : h.quote, reason: `例词 ${h.quote} 在这一课里出现`, _n: name }))
    if (quirks.matchBadLesson) results.push({ kp: tok, lesson: '#999999', confidence: 'high', quote: 'x', reason: '不存在的课' })
  }
  return JSON.stringify({ results: results.map(({ _n, ...r }) => r) })
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

function build(kind, user, quirks = {}) {
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
