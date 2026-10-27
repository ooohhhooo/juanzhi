// mock 的 P3（考情分析报告）应答：从收到的 user 提示词里解析出程序填好的几张表，按 system 约定的结构写一篇 Markdown。
// 所有数字、知识点代码、样本题 token 都原样取自输入——和真实模型「只解读、不自己算」的要求一致，
// 这样 E2E 才能反过来断言「报告里的数字 = 本地统计」。
//
// quirks（模拟真实模型会犯的错）：
//   badCite     —— 在「易错点预警」里夹一条输入里没有的引用 [不存在的卷 · 99]（程序应移除并提示）
//   dropWarning —— 有样本提示时不转述（程序应补在开头）
//   noAdvice    —— 省掉最后一节「教学建议」（程序应提示内容可能不完整）
//   boldCite    —— 把引用包在粗体里 **[卷名 · 题号]**（界面不能露出字面的 **）
//   plain       —— 什么都不加
//   backtick    —— 把引用包进反引号（真实模型照抄提示词里的反引号）；程序应去掉
//   echoCodes   —— 在正文里写出内部代码（GR.NOUN.PLURAL、PH_DIFF）；程序应去掉
//   wrongRule   —— 把 time for / time to 的规则写反（真实 AI 犯过的错）；程序应标「与题目解释矛盾」（家长版直接删掉）
//   inventRule  —— 写一条证据里没有的规则；程序应标「未核实」
//   parentStats —— 家长版里混进统计词和百分比；程序应删掉那句
//   readers：按 system 里的「【读者：…】」写四种版本（老板 / 家长 / 老师 / 完整数据）
const SECTIONS = { KP: '【知识点分布】', QT: '【题型分布】', DIFF: '【难度分布】', ERR: '【AI估计的易错点（样本）】' }

function block(user, head) {
  const i = user.indexOf(head)
  if (i < 0) return []
  const lines = user.slice(i + head.length).split('\n').slice(1)
  const rows = []
  let started = false
  for (const line of lines) {
    if (!started) { if (line.startsWith('列：')) started = true; continue }
    if (!line.trim() || line.startsWith('【')) break
    if (line.trim() === '（无）') break
    rows.push(line)
  }
  return rows
}

function parse(user) {
  const one = re => re.exec(user)?.[1]?.trim() ?? ''
  const yd = /【年度变化摘要】\n([\s\S]*?)\n\n(?:【题目解释|请按 system)/.exec(user)?.[1]?.trim() ?? '（无）'
  const ev = /【题目解释（证据）】[^\n]*\n列：[^\n]*\n([\s\S]*?)\n\n请按 system/.exec(user)?.[1]?.trim() ?? ''
  return {
    filter: one(/【筛选条件】(.*)/), sample: /【样本】(\d+) 份卷子，(\d+) 道题；覆盖学年：(.*)/.exec(user) ?? [], warn: one(/【样本提示】(.*)/),
    kp: block(user, SECTIONS.KP).map(l => l.split(' | ')), qt: block(user, SECTIONS.QT).map(l => l.split(' | ')), diff: block(user, SECTIONS.DIFF).map(l => l.split(' | ')),
    err: block(user, SECTIONS.ERR).map(l => l.split(' | ')), yearDiff: yd,
    evidence: ev && ev !== '（无）' ? ev.split('\n').map(l => l.split(' | ')) : []
  }
}

const table = (head, rows, take = 10) => {
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const r of rows.slice(0, take)) out.push(`| ${r.join(' | ')} |`)
  if (rows.length > take) out.push('', '其余略。')
  return out
}

function buildFull(user, quirks = {}) {
  const t = parse(user)
  const L = []
  L.push(`# ${t.filter} 考情分析报告`)
  const note = '说明：难度与易错点为 AI 估计，非学生成绩统计。'
  L.push(t.warn !== '无' && !quirks.dropWarning ? `> ${note}${t.warn}结论仅供参考。` : `> ${note}`, '')
  L.push('## 样本概览', `卷子 ${t.sample[1] ?? '?'} 份，题目 ${t.sample[2] ?? '?'} 道；覆盖学年：${t.sample[3] ?? '?'}。`, '')
  const l1 = t.kp.filter(r => r[0] === '一级'), l2 = t.kp.filter(r => r[0] === '二级')
  L.push('## 知识点分布',
    `**结论**：一级知识点共 ${l1.length} 个，二级知识点里出现份数最多的是 ${l2[0]?.[2] ?? '—'}（${l2[0]?.[3] ?? '—'} 份）。`,
    '**依据**：', ...table(['层级', '代码', '名称', '出现份数/总份数', '题数', '分值占比'], t.kp.map(r => r.slice(0, 6))),
    '**建议**：先抓出现份数最多的几个二级知识点，其余作个例处理。', '')
  L.push('## 题型与分值',
    `**结论**：共 ${t.qt.length} 种题型，题数最多的是 ${t.qt[0]?.[0] ?? '—'}（${t.qt[0]?.[1] ?? '—'} 题）。`,
    '**依据**：', ...table(['题型', '题数', '分值合计', '分值占比', '平均难度'], t.qt),
    '**建议**：按题数从多到少安排练习。', '')
  L.push('## 难度结构', `**结论**：难度分布见下表（AI 估计）。`, '**依据**：', ...table(['难度', '题数', '占比'], t.diff), '**建议**：保持梯度。', '')
  L.push('## 重点与难点', `**结论**：重点看 ${l2.slice(0, 3).map(r => r[2]).join('、') || '—'}。`, `**依据**：出现份数 ${l2.slice(0, 3).map(r => `${r[2]} ${r[3]}`).join('；') || '—'}。`, '**建议**：围绕这几个点出专项练习。', '')
  L.push('## 易错点预警')
  if (t.err.length === 0) L.push('**结论**：本范围内没有 AI 估计的易错题。', '**依据**：易错点表为空。', '**建议**：暂不需要专项预警。')
  else {
    const e = t.err[0]
    L.push(`**结论**：${e[1]} 易错，原因：${e[2]}。`, '**依据**：', ...t.err.slice(0, 6).map(r => `- ${r[0]}｜${r[1]}：${r[2]}。样本：${r[3]}`), '**建议**：对照样本题讲评。')
    if (quirks.echoCodes) L.push('', `补充：${e[0]} 和 PH_DIFF 这两类要重点讲评。`)
    if (quirks.wrongRule) L.push('', "补充：介词搭配要注意，It's time for 后接动词，It's time to 后接名词。")
    if (quirks.inventRule) L.push('', '补充：be good at 后接名词或动名词，不能接动词原形。')
    if (quirks.boldCite) { const m = /\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/.exec(e[3]); if (m) L.push('', `重点题：**${m[0]}**`) }
    if (quirks.badCite) L.push('', '补充：另见 [不存在的卷 · 99] 的第 99 题。')
  }
  L.push('')
  if (t.yearDiff !== '（无）' && !/^样本不足/.test(t.yearDiff)) {
    L.push('## 年度变化', '**结论**：与更早的学年相比有变化。', '**依据**：', ...t.yearDiff.split('\n').map(x => `- ${x}`), '**建议**：关注新增的知识点。', '')
  }
  if (!quirks.noAdvice) L.push('## 教学建议', '1. 优先复习出现份数最多的知识点（知识点分布）。', '2. 对易错点做专项讲评（易错点预警）。', '3. 保持题型与难度梯度（题型与分值）。')
  return L.join('\n')
}

const CITE = /\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/
const firstCite = rows => { for (const r of rows) { const m = CITE.exec(r.join(' | ')); if (m) return m[0] } return null }

function noteLine(t, quirks) {
  const note = '说明：难度与易错点为 AI 估计，非学生成绩统计。'
  return t.warn !== '无' && !quirks.dropWarning ? `> ${note}${t.warn}结论仅供参考。` : `> ${note}`
}

/** 老板版：三句话结论 + 教研重点与课程卖点 + 风险提示；没有表格、没有代码 */
function buildBoss(user, quirks = {}) {
  const t = parse(user)
  const l2 = t.kp.filter(r => r[0] === '二级' && r[8] !== '个例')
  const names = l2.slice(0, 3).map(r => r[2])
  const L = [`# ${t.filter} 考情分析报告`, noteLine(t, quirks), '', '## 三句话结论',
    `1. **今年考什么**：${names.join('、') || '各类基础知识点'}几乎每份卷子都考。`,
    `2. **最容易丢分在哪**：${t.err[0] ? `${t.err[0][1]}（${t.err[0][2]}）` : '没有明显集中的易错点'}。`,
    '3. **建议怎么做**：教研先抓这几个考点，课程里做成专项。', '',
    '## 教研重点与课程卖点',
    ...names.map((n, i) => `- **教研重点**：${n}（每份卷子都有）——${i === 0 ? '占分最多' : '常考'}。`),
    '- **课程卖点**：针对最常考的考点做专项训练，讲清楚易错的地方。', '',
    '## 风险提示', `- 当前只有 ${t.sample[1] ?? '?'} 份卷子，结论仅供参考。`, '- 难度和易错点是 AI 估计，需要教研核对。']
  if (quirks.echoCodes) L.push('- 内部编号 GR.NOUN.PLURAL 仅供测试。')
  if (quirks.noAdvice) L.splice(L.indexOf('## 风险提示'), 6)
  return L.join('\n')
}

/** 家长版：老师口吻的群消息——开头问候、3 个要点（在家做 + 标准答案 + 取自证据的例句 + 【考点】标记）、结尾回答「要不要担心」；不写标题 */
function buildParent(user, quirks = {}) {
  const t = parse(user)
  const ev = t.evidence.filter(r => r[2] && r[2] !== '—').slice(0, 3)
  const items = (ev.length ? ev : [['名词复数', '—', 'Look at the **sheep**. 看那些羊。', '—']]).map((r, i) => {
    const m = /^(.+?[.!?])\s*(.*)$/.exec(r[2].replace(/\*\*/g, '')) ?? [null, r[2], '']
    return `${i + 1}. 孩子在“${r[0]}”这类题上容易出错，${r[1] && r[1] !== '—' ? r[1] : '多读多说'}。在家做：每天陪孩子说一说，说对了就是对的。例：${m[1]}（${m[2] || '请对照例句'}）【考点：${r[0]}】`
  })
  const L = ['各位家长好，这次期末英语有 3 个小地方孩子容易错，在家几分钟就能帮上：', '']
  if (quirks.parentStats) L.push('这类题在 100% 的卷子里出现率都很高，分值占比 12%。', '')
  if (quirks.wrongRule) L.push("提醒孩子：It's time for 后接动词。", '')
  for (const it of items) L.push(it, '')
  L.push('整体不用太担心，抓住这几点就行。')
  return L.join('\n')
}

/** 老师版：易错点（错在哪 / 原卷例题 / 练法 / 讲解要点）+ 备课建议 */
function buildTeacher(user, quirks = {}) {
  const t = parse(user)
  const L = [`# ${t.filter} 考情分析报告`, noteLine(t, quirks), '', '## 易错点（按重要程度排序）']
  if (t.err.length === 0) L.push('本范围内没有 AI 估计的易错题。')
  for (const [i, r] of t.err.slice(0, 4).entries()) {
    L.push(`### ${i + 1}. ${r[1]}`, `- **错在哪**：${r[2]}。`, `- **原卷例题**：${firstCite([r]) ?? '无'}`, '- **练法**：做 5 道同类题，错了的再讲一遍。', '- **讲解要点**：用一句白话讲规则，再举一个例句。')
  }
  if (quirks.badCite) L.push('', '补充：另见 [不存在的卷 · 99]。')
  L.push('', '## 备课建议', '1. 先讲最容易错的两个考点。', '2. 每个考点配 5 道练习。')
  if (quirks.noAdvice) L.splice(L.indexOf('## 备课建议'), 3)
  return L.join('\n')
}

/** 按 system 里的「【读者：…】」写对应版本；没有标记（旧用法）就是完整数据版 */
function build(user, quirks = {}, sys = '') {
  const reader = /【读者：([^】]+)】/.exec(sys)?.[1] ?? ''
  let md = /老板/.test(reader) ? buildBoss(user, quirks) : /家长/.test(reader) ? buildParent(user, quirks) : /辅导老师/.test(reader) ? buildTeacher(user, quirks) : buildFull(user, quirks)
  if (quirks.backtick) md = md.replace(/(\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\])/g, '`$1`')
  return md
}

const isP3 = (sys, user) => /考情分析报告/.test(sys) && /【知识点分布】/.test(user)

module.exports = { build, parse, isP3 }
