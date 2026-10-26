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
  const yd = /【年度变化摘要】\n([\s\S]*?)\n\n请按 system/.exec(user)?.[1]?.trim() ?? '（无）'
  return {
    filter: one(/【筛选条件】(.*)/), sample: /【样本】(\d+) 份卷子，(\d+) 道题；覆盖学年：(.*)/.exec(user) ?? [], warn: one(/【样本提示】(.*)/),
    kp: block(user, SECTIONS.KP).map(l => l.split(' | ')), qt: block(user, SECTIONS.QT).map(l => l.split(' | ')), diff: block(user, SECTIONS.DIFF).map(l => l.split(' | ')),
    err: block(user, SECTIONS.ERR).map(l => l.split(' | ')), yearDiff: yd
  }
}

const table = (head, rows, take = 10) => {
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const r of rows.slice(0, take)) out.push(`| ${r.join(' | ')} |`)
  if (rows.length > take) out.push('', '其余略。')
  return out
}

function build(user, quirks = {}) {
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
    if (quirks.boldCite) { const m = /\[[^\[\]\n·]{1,60} · [^\[\]\n·]{1,30}\]/.exec(e[3]); if (m) L.push('', `重点题：**${m[0]}**`) }
    if (quirks.badCite) L.push('', '补充：另见 [不存在的卷 · 99] 的第 99 题。')
  }
  L.push('')
  if (t.yearDiff !== '（无）') {
    L.push('## 年度变化', '**结论**：与更早的学年相比有变化。', '**依据**：', ...t.yearDiff.split('\n').map(x => `- ${x}`), '**建议**：关注新增的知识点。', '')
  }
  if (!quirks.noAdvice) L.push('## 教学建议', '1. 优先复习出现份数最多的知识点（知识点分布）。', '2. 对易错点做专项讲评（易错点预警）。', '3. 保持题型与难度梯度（题型与分值）。')
  return L.join('\n')
}

const isP3 = (sys, user) => /考情分析报告/.test(sys) && /【知识点分布】/.test(user)

module.exports = { build, parse, isP3 }
