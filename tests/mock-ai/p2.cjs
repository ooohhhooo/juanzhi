// mock 的 P2（年度变化分析）应答：从收到的 user 提示词里解析出程序填好的四张表，按 system 约定的结构写一篇 Markdown。
// 所有数字、知识点代码、样本题 token 都原样取自输入——和真实模型「只解读、不自己算」的要求一致，
// 这样 E2E 才能反过来断言「输出里的数字 = 本地统计」。
//
// quirks（模拟真实模型会犯的错）：
//   badCite    —— 在正文里夹一条输入里没有的引用 [不存在的卷 · 99]（程序应移除）
//   badHeading —— 多写一个代码不在输入里的小标题（程序应给出提示）
//   plain      —— 什么都不加
const SECTIONS = { ADDED: '【新增知识点】', REMOVED: '【消失知识点】', CHANGED: '【明显升降的知识点】', HOT: '【跨年高频考点 Top15】' }

function parseTables(user) {
  const out = {}
  for (const [k, head] of Object.entries(SECTIONS)) {
    const i = user.indexOf(head)
    if (i < 0) { out[k] = []; continue }
    const rest = user.slice(i + head.length).split('\n').slice(1)   // 去掉标题行余下部分
    const rows = []
    let started = false
    for (const line of rest) {
      if (!started) { if (line.startsWith('列：')) started = true; continue }
      if (!line.trim() || line.startsWith('【')) break
      if (line.trim() === '（无）') break
      rows.push(line.split(' | ').map(s => s.trim()))
    }
    out[k] = rows
  }
  return out
}

function build(user, quirks = {}) {
  const t = parseTables(user)
  const warn = /【样本提示】(.*)/.exec(user)?.[1]?.trim() ?? '无'
  const L = []
  if (warn !== '无') L.push(`> ${warn} 结论仅供参考。`, '')
  L.push('## 一、总体变化', `本次新增 ${t.ADDED.length} 个、消失 ${t.REMOVED.length} 个、明显升降 ${t.CHANGED.length} 个知识点。`, '')
  L.push('## 二、新增知识点')
  if (t.ADDED.length === 0) L.push('本次筛选下没有新增知识点')
  for (const r of t.ADDED.slice(0, 8)) {
    // 代码 | 名称 | 引入年级 | 目标年出现份数/总份数 | 题数 | 分值占比 | 样本题
    L.push('', `### ${r[0]}｜${r[1]}`,
      `- **数据**：${r[3]} 份卷子出现，${r[4]} 题，分值占比 ${r[5]}`,
      '- **原因判断**：【依据】基线学年从未出现；【推测】可能是命题取舍。',
      `- **常见题型**：${r[6]}`,
      '- **教学建议**：先讲规则，再做同类题型的专项练习。')
  }
  L.push('', '## 三、消失与下降的知识点')
  if (t.REMOVED.length + t.CHANGED.filter(r => r[5] === '下降').length === 0) L.push('本次没有消失或明显下降的知识点。')
  for (const r of t.REMOVED) L.push(`- ${r[0]}｜${r[1]}：基线 ${r[3]} 份出现，目标学年未出现。【推测】“未出现”不等于“不再考”。样本：${r[5]}`)
  for (const r of t.CHANGED.filter(r => r[5] === '下降')) L.push(`- ${r[0]}｜${r[1]}：${r[2]} 降到 ${r[3]}，变化 ${r[4]} 个百分点。`)
  L.push('', '## 四、高频考点与易错预警')
  for (const r of t.HOT.slice(0, 3)) L.push(`- ${r[0]}｜${r[1]}：${r[2]} 份出现，易错原因：${r[5]}。样本：${r[6]}`)
  for (const r of t.CHANGED.filter(r => r[5] === '上升')) L.push(`- 上升：${r[0]}｜${r[1]}，${r[2]} → ${r[3]}（${r[4]}）`)
  L.push('', '## 五、下学期教学与复习建议', '1. 优先复习新增知识点对应的题型（见第二节）。', '2. 下降的知识点不要完全放弃。')
  if (quirks.badCite) L.push('', '补充：另见 [不存在的卷 · 99] 的第 99 题。')
  if (quirks.badHeading) L.push('', '### ZZ.NOT.IN.INPUT｜输入里没有的知识点', '- **数据**：凭空编的。')
  return L.join('\n')
}

const isP2 = (sys, user) => /年度变化分析/.test(sys) && /【新增知识点】/.test(user)

module.exports = { build, parseTables, isP2 }
