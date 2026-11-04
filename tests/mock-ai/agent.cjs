// 助手（Agent）的模拟模型：请求里带 tools 时走这里。按「最后一条用户消息」里的关键字选一套预设的工具调用序列：
//   · 含「周报」  → 列计划 → ask_user → 一次并行两个工具（看整体 + 更新计划）→ 查某知识点的题 → 最终回答（带真实题目引用 + 一个假引用）
//   · 含「满意度」→ 数据分析全流程（计划 → 数据集 → 查询 → 统计 → 看板 → 汇报 → 名单 → 发企业微信 → 回答），见下面 analysis()
//   · 含「这批问卷的满意度」→ README 截图专用的同一流程（不发企业微信、不导出，计划随进度更新，最终回答读起来像真的）
//   · 含「发到外部」→ 调用 mcp_*_post_message 外部工具一次（测外部发送必须确认）
//   · 含「慢慢」  → 一条很慢的流式文字回答（给「停止」按钮用）
//   · 含「卡住」  → 一直重复同一个工具调用（测卡住检测）
//   · 其余       → 一句普通回答
// 测试连接用的探测（工具名 ping）→ 返回一个 ping 工具调用；mock.agentNoTools = true 时对带 tools 的请求一律 400（模型不支持工具）。
const sleepMs = ms => new Promise(r => setTimeout(r, ms))

const textOf = c => (typeof c === 'string' ? c : (c ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n'))
const call = (name, args, n) => ({ id: `mock_call_${name}_${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })

const SQL = '\n'
/** 数据分析剧本：数据集编号、老师代号、手机代号都从前面的工具结果里读（模型始终只看到代号） */
function analysis(round, toolTexts, readme = false) {
  const all = toolTexts.join('\n')
  const dsId = /"id":"([0-9a-f-]{36})"/.exec(all)?.[1] ?? 'missing-dataset'
  const teacher = /人员A\d+/.exec(toolTexts.find(t => /偏低|分组|组/.test(t) && /人员A\d+/.test(t)) ?? all)?.[0] ?? '人员A001'
  const phone = /手机\d{4}/.exec(all)?.[0] ?? '手机0001'
  const sql = 'SELECT "c06_班级" AS "班级", "c07_授课老师" AS "授课老师", "c02_家长手机" AS "家长手机", "c09_推荐分" AS "推荐分", "c10_满意度" AS "满意度" FROM d1."问卷"'
  const base = { datasets: [dsId], sql }
  const plan = (a, b, c) => ({ items: [{ content: '看数据概况', status: a }, { content: '查满意度并做统计', status: b }, { content: '搭看板、写汇报', status: c }] })
  const tableId = /"tableId":"(t\d+)"/.exec(all)?.[1] ?? 't1'
  const docId = /"docId":"(d\d+)"/.exec(all)?.[1] ?? 'd1'
  const steps = [
    () => ({ content: '好的，先列个计划。', toolCalls: [call('update_plan', plan('doing', 'todo', 'todo'), 0)] }),
    () => ({ content: '', toolCalls: [call('list_datasets', {}, 1)] }),
    () => ({ content: '', toolCalls: [call('dataset_profile', { datasetId: dsId, table: '问卷' }, 2)] }),
    () => ({ content: '', toolCalls: [call('run_query', { sql, datasets: [dsId] }, 3)] }),
    () => ({ content: '', toolCalls: [call('stat_nps', { ...base, scoreColumn: '推荐分', groupKey: '班级' }, 4)] }),
    () => ({ content: '', toolCalls: [call('stat_compare_groups', { ...base, groupKey: '授课老师', metric: 'mean', column: '满意度' }, 5)] }),
    () => ({ content: '', toolCalls: [call('stat_find_low_groups', { ...base, dimensions: ['班级', '授课老师'], metric: 'mean', column: '满意度' }, 6)] }),
    () => ({ content: '', toolCalls: [call('board_start', { title: '秋季满意度看板', subtitle: '虚构问卷', dataNote: '300 份问卷' }, 7)] }),
    () => ({ content: '', toolCalls: [call('board_add_finding', { title: `${teacher} 的满意度偏低`, body: `${teacher} 班级的满意度均值低于总体。` }, 8), call('board_add_section', { id: 'teacher', title: '按老师看满意度', intro: `${teacher} 偏低。` }, 8)] }),
    () => ({ content: '', toolCalls: [call('board_add_block', { sectionId: 'teacher', block: { type: 'chart', chart: { kind: 'bar', title: '各老师满意度均值', categories: [teacher, '人员A002'], series: [{ name: '满意度', values: [2.5, 3.1] }], valueFormat: 'number' }, source: { queryId: '5' } } }, 9), call('board_set_caliber', { items: ['满意度 1–5 分，取均值'] }, 9)] }),
    () => ({ content: '', toolCalls: [call('doc_create', { name: '满意度汇报', sections: ['一、结论', '二、依据'] }, 10)] }),
    () => ({ content: '', toolCalls: [call('doc_write_section', { docId, sectionId: 's1', title: '一、结论', markdown: `${teacher} 的满意度偏低，需要重点跟进 [[query:6]]。` }, 11), call('doc_write_section', { docId, sectionId: 's2', title: '二、依据', markdown: `按老师分组对比见 [[query:5]]，家长 ${phone} 反馈上课时间不合适。`, last: true }, 11)] }),
    () => ({ content: '', toolCalls: [call('table_save', { name: '本周跟进名单', columns: ['老师', '班级', '家长手机'], rows: [[teacher, '启航A班', phone]] }, 12)] }),
    () => ({ content: '', toolCalls: [call('output_export', { id: tableId, format: 'xlsx' }, 13)] }),
    () => ({ content: '', toolCalls: [call('wecom_send', { targetName: '三年级辅导群', kind: 'markdown', content: `满意度偏低提醒：${teacher} 的班级需要跟进，家长联系方式 ${phone}。` }, 14)] }),
    () => ({
      content: ['## 结论', '', `${teacher} 的满意度偏低 [[query:6]]。`, '', '## 依据', '', `按老师分组对比：${teacher} 明显低于其他老师 [[query:5]]。`, '', '## 下一步', '', `建议先和 ${teacher} 沟通 [[query:99]]。`].join('\n'), toolCalls: []
    })
  ]
  if (readme) return readmeAnalysis(round, steps, plan, teacher)
  return (steps[Math.min(round, steps.length - 1)] ?? steps[steps.length - 1])()
}

/** README 截图专用：同样的数据分析流程，但不发企业微信、不导出文件（没有审批弹窗和失败行），计划随进度更新，最终回答是一段读起来像真的汇报 */
function readmeAnalysis(round, steps, plan, teacher) {
  const withPlan = (i, p) => () => { const o = steps[i](); return { ...o, toolCalls: [...o.toolCalls, call('update_plan', p, 'rm' + i)] } }
  const seq = [
    steps[0], steps[1], steps[2],
    withPlan(3, plan('done', 'doing', 'todo')),
    steps[4], steps[5], steps[6],
    withPlan(7, plan('done', 'done', 'doing')),
    steps[8], steps[9], steps[10], steps[11],
    withPlan(12, plan('done', 'done', 'done')),
    () => ({
      content: [
        '## 结论', '',
        `这次共回收 300 份问卷，整体满意度不错，但 **${teacher} 带的班级明显偏低**：满意度均值只有 2.5 分，其他老师在 3.1 分左右 [[query:6]]。`, '',
        '## 依据', '',
        `- 按授课老师分组对比，${teacher} 比平均水平低约 0.6 分，样本量足够，不是个别家长的情绪 [[query:5]]。`,
        '- 家长的文字意见集中在「上课时间不太合适」和「作业偏多」两类。', '',
        '## 下一步建议', '',
        '1. 本周先和该班家长做一次回访，确认上课时间能不能调整。',
        '2. 汇报和跟进名单已经放在右侧「产出」里，看板也可以直接给团队看。'
      ].join('\n'), toolCalls: []
    })
  ]
  return seq[Math.min(round, seq.length - 1)]()
}

/** 分享卡片剧本（虚构学生）：列模板 → 学生知识卡 → 家长本周学情卡 → 回答；「再做一张卡」只出一张学生卡（不指定模板，用设置里的默认） */
function cards(round, again) {
  const knowledge = { audience: 'student', kind: 'knowledge', content: { title: '不规则动词过去式', hook: '说昨天的事，动词要「变身」！', items: [{ left: 'go', right: 'went' }, { left: 'see', right: 'saw' }, { left: 'eat', right: 'ate' }, { left: 'have', right: 'had' }], example: { en: 'I **went** to the park yesterday.', zh: '我昨天去了公园。' }, warning: '小心！不是 goed，也不是 eated', signature: '小雨的英语小卡', date: '11 月 3 日' } }
  const weekly = { audience: 'parent', kind: 'weekly', content: { student: '张小雨', grade: '四年级', week: '11 月第 1 周', metrics: [{ value: '4/4', label: '按时到课' }, { value: '86%', label: '课后练习正确率' }, { value: '+12%', label: '比上周' }], learned: '一般过去时：说昨天的事，动词要变成过去式。', good: '课堂上主动回答问题，规则动词加 -ed 基本不出错。', improve: '不规则动词（go→went、eat→ate）偶尔还会写错。', tips: '每天 5 分钟，请孩子用英语说一件昨天做的事。', teacher: '辅导老师 林老师', date: '11 月 3 日' } }
  const steps = again
    ? [() => ({ content: '', toolCalls: [call('card_make', knowledge, 0)] }), () => ({ content: '又做好了一张卡片。', toolCalls: [] })]
    : [() => ({ content: '', toolCalls: [call('card_templates', { audience: 'student' }, 0)] }), () => ({ content: '', toolCalls: [call('card_make', knowledge, 1)] }), () => ({ content: '', toolCalls: [call('card_make', weekly, 2)] }), () => ({ content: '两张卡片都做好了，请在右侧预览。', toolCalls: [] })]
  return (steps[Math.min(round, steps.length - 1)])()
}

/** 返回 { content, toolCalls, opts } */
function next(body) {
  const msgs = body.messages
  const toolNames = (body.tools ?? []).map(t => t.function?.name)
  if (toolNames.includes('ping') && toolNames.length === 1) return { content: '', toolCalls: [call('ping', { word: 'ok' }, 0)] }
  let lastUser = -1
  // 程序自己插进去的 user 消息（确认计划 / 修改意见 / 整理后的摘要）不算用户提问
  msgs.forEach((m, i) => { if (m.role === 'user' && !/^(用户确认了计划|用户想修改计划|【前面内容的摘要】)/.test(textOf(m.content))) lastUser = i })
  const q = textOf(msgs[lastUser]?.content)
  const after = msgs.slice(lastUser + 1)
  const revisions = after.filter(m => m.role === 'user' && /^用户想修改计划/.test(textOf(m.content)))
  // 修改计划的那一轮不算脚本里的步骤：它只是重新出一份计划
  const round = after.filter(m => m.role === 'assistant' && m.tool_calls?.length).length - revisions.length
  const lastMsg = msgs[msgs.length - 1]
  const toolTexts = after.filter(m => m.role === 'tool').map(m => textOf(m.content))

  // 跨对话记忆：翻以前的对话 → 读那一段 → 回答里带上读到的内容
  if (/上次那段话术/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('history_search', { query: '话术' }, 0)] }
    if (round === 1) { const id = /对话 ([0-9a-f-]{36})/.exec(toolTexts.join('\n'))?.[1] ?? 'none'; return { content: '', toolCalls: [call('history_read', { sessionId: id }, 1)] } }
    const t = toolTexts.join('\n')
    return { content: /话术示例：坚持练习/.test(t) ? '找到了，上次那段话术是：话术示例：坚持练习。' : '没找到以前的对话。', toolCalls: [] }
  }
  if (/写一段话术/.test(q)) return { content: '好的。话术示例：坚持练习，下学期继续一起进步。', toolCalls: [] }
  // 数据目录：文档资料 + 试卷 / 课程 / 报告
  if (/看看所有资料/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('list_datasets', {}, 0), call('papers_list', {}, 0), call('course_coverage', {}, 0), call('reports_list', {}, 0)] }
    if (round === 1) { const id = /"id":"(doc-[0-9a-f-]+)"/.exec(toolTexts.join('\n'))?.[1] ?? /(doc-[0-9a-f-]{8,})/.exec(toolTexts.join('\n'))?.[1] ?? 'none'; return { content: '', toolCalls: [call('read_document', { documentId: id }, 1)] } }
    return { content: '资料都看过了。', toolCalls: [] }
  }
  if (/出一份家长版报告/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('papers_list', { grade: '4' }, 0)] }
    if (round === 1) return { content: '', toolCalls: [call('report_generate', { reader: 'parent', grade: '4' }, 1)] }
    return { content: /已生成家长版报告/.test(toolTexts.join('\n')) ? '家长版报告已经生成好了，在「报告」页。' : '报告没有生成成功。', toolCalls: [] }
  }
  if (/分成两份导入/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('paper_import', { groups: [{ files: ['截图1.png'], title: '四年级期末卷' }, { files: ['截图2.png'] }] }, 0)] }
    return { content: /已导入 2 份试卷/.test(toolTexts.join('\n')) ? '两份都导入了。' : '没能导入：' + toolTexts.join(' ').slice(0, 200), toolCalls: [] }
  }
  if (/分头查一下/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('delegate_tasks', { tasks: [{ title: '四年级', instructions: '子任务：看四年级试卷的整体情况，写结论' }, { title: '五年级', instructions: '子任务：看五年级试卷的整体情况，写结论' }] }, 0)] }
    const t = toolTexts.join('\n')
    return { content: /2\/2 件做完了/.test(t) ? '两个年级都查完了，汇总如下。' : '子任务没做完：' + t.slice(0, 200), toolCalls: [] }
  }
  if (/^【[^】]+】\n子任务：/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('stats_overview', {}, 0)] }
    return { content: '子助手结论：整体情况已查看（模拟）。', toolCalls: [] }
  }
  if (/把这份卷子导入试卷库/.test(q)) {
    if (round === 0) return { content: '', toolCalls: [call('paper_import', {}, 0)] }
    return { content: /已导入 1 份试卷/.test(toolTexts.join('\n')) ? '已经导入试卷库了，识别完请到「审核」页核对。' : '没能导入。', toolCalls: [] }
  }
  if (/卡住/.test(q)) return { content: '', toolCalls: [call('stats_overview', {}, round)] }
  if (/做一张口诀卡/.test(q)) {
    const m = { audience: 'student', kind: 'mnemonic', content: { title: "Let's 后面跟原形", lines: [{ text: "Let's 后面跟原形", highlight: '原形' }, { text: '不加 to，不加 ing' }, { text: 'go、run 直接站中间' }], examples: [{ label: '去动物园', text: "Let's go to the zoo." }, { label: '一起跑', text: "Let's run together." }] } }
    return round === 0 ? { content: '', toolCalls: [call('card_make', m, 0)] } : { content: '口诀卡做好了。', toolCalls: [] }
  }
  if (/再做一张卡/.test(q)) return cards(round, true)
  if (/做卡片/.test(q)) return cards(round, false)
  if (/这批问卷的满意度/.test(q)) return analysis(round, toolTexts, true)   // README 截图剧本
  if (/满意度/.test(q)) return analysis(round, toolTexts)
  // 外部 MCP 工具：调用名字形如 mcp_<连接名>_post_message 的工具（发到外部），测「外部发送必须先确认」
  if (/发到外部/.test(q)) {
    const t = toolNames.find(n => /^mcp_.*_post_message$/.test(n))
    if (round === 0 && t) return { content: '', toolCalls: [call(t, { text: '本周提醒：请跟进三年级' }, 0)] }
    return { content: t ? '处理完了（模拟）。' : '没有可用的外部工具。', toolCalls: [] }
  }
  if (/慢慢/.test(q)) return { content: '好的，我慢慢来。'.repeat(40), toolCalls: [], opts: { pieceChars: 6, chunkDelayMs: 350 } }
  if (/周报/.test(q) && lastMsg.role === 'user' && /^用户想修改计划/.test(textOf(lastMsg.content))) {
    return { content: '好的，按你的意见改一下。', toolCalls: [call('update_plan', { items: [{ content: '确认范围（已审核）', status: 'doing' }, { content: '查最常考和最易错的知识点', status: 'todo' }, { content: '写周报', status: 'todo' }] }, 'r' + revisions.length)] }
  }
  if (/周报/.test(q)) {
    const plan = (a, b, c) => ({ items: [{ content: '确认范围', status: a }, { content: '查最常考和最易错的知识点', status: b }, { content: '写周报', status: c }] })
    if (round === 0) return { content: '好的，我先列个计划。', toolCalls: [call('update_plan', plan('doing', 'todo', 'todo'), 0)] }
    if (round === 1) return { content: '', toolCalls: [call('ask_user', { question: '周报要看哪个范围？', options: ['全部年级', '只看四年级'], allowOther: true }, 1)] }
    if (round === 2) return { content: '', toolCalls: [call('update_plan', plan('done', 'doing', 'todo'), 2), call('stats_overview', { top: 3 }, 2)] }
    if (round === 3) {
      const stats = toolTexts.find(t => /最常考的知识点/.test(t)) ?? ''
      const code = /（代码 ([A-Z0-9_.]+)）/.exec(stats)?.[1] ?? 'GR'
      return { content: '', toolCalls: [call('kp_questions', { kp: code, limit: 3 }, 3)] }
    }
    const qs = toolTexts.find(t => /\[\[q:/.test(t)) ?? ''
    const qid = /\[\[q:([^\]]+)\]\]/.exec(qs)?.[1] ?? 'none'
    const ans = ['## 学情周报', '', '**结论**：这批试卷的易错点集中在语法。', '', `- 代表题：[[q:${qid}]]`, '- 一个对不上的引用：[[q:not-a-real-id]]', '', '| 项目 | 说明 |', '| --- | --- |', '| 范围 | 已审核的试卷 |'].join('\n')
    return { content: ans, toolCalls: [] }
  }
  return { content: round > 0 ? '查完了，这是模拟回答。' : '这是模拟的助手回答。', toolCalls: [] }
}

/** 按 OpenAI 的格式把（文字 + 工具调用）发出去；stream 时 id/name 在第一块，arguments 拆两块 */
async function send(res, body, out, stream) {
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 1.6), completion_tokens: Math.ceil((out.content.length + JSON.stringify(out.toolCalls).length) / 1.6), prompt_cache_hit_tokens: 0 }
  const finish = out.toolCalls.length ? 'tool_calls' : 'stop'
  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'mock-agent', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: out.content || null, ...(out.toolCalls.length ? { tool_calls: out.toolCalls } : {}) }, finish_reason: finish }], usage }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const w = d => res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`)
  const piece = out.opts?.pieceChars ?? Math.max(1, Math.ceil(out.content.length / 4))
  for (let i = 0; i < out.content.length; i += piece) {
    w({ content: out.content.slice(i, i + piece) })
    if (out.opts?.chunkDelayMs) await sleepMs(out.opts.chunkDelayMs)
    if (res.destroyed || res.writableEnded) return
  }
  out.toolCalls.forEach((t, index) => {
    const a = t.function.arguments, h = Math.floor(a.length / 2)
    w({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.function.name, arguments: a.slice(0, h) } }] })
    w({ tool_calls: [{ index, function: { arguments: a.slice(h) } }] })
  })
  res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}

module.exports = { next, send }
