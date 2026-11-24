// 行动记录：把一次提问的步骤整理成白话摘要 + 时间线；脱敏；老对话（没有审批记录）也能看
import assert from 'node:assert/strict'
import { buildTurnLogs, formatRaw, formatSeconds, argSentence, resultSentence, redactText } from '../../src/main/agent/action-log.ts'

const label = n => ({ papers_list: '看试卷清单', run_query: '查数据', wecom_send: '发到企业微信', output_export: '导出文件' }[n] ?? n)
const call = (seq, id, name, args, level = 'read', extra = {}) => ({ seq, kind: 'tool_call', payload: { id, n: seq, name, args, level, ...extra } })
const res = (seq, id, name, summary, ok = true, ms = 500, text = 'T') => ({ seq, kind: 'tool_result', ms, payload: { id, n: seq, name, ok, summary, text, truncated: false } })

const steps = [
  { seq: 1, kind: 'user', payload: { text: '问' }, createdAt: '2026-11-24 10:00:00' },
  call(2, 'a', 'papers_list', { grade: '四年级' }), res(3, 'a', 'papers_list', '14 条'),
  call(4, 'b', 'run_query', { sql: 'select 1' }), res(5, 'b', 'run_query', '3 条'),
  call(6, 'c', 'wecom_send', { targetName: '运营群', kind: 'text', content: '内容', webhook: 'https://x/?key=SECRET' }, 'write', { approval: 'session' }), res(7, 'c', 'wecom_send', '12 字'),
  call(8, 'd', 'wecom_send', { targetName: '运营群' }, 'write', { approval: 'auto' }), res(9, 'd', 'wecom_send', '12 字'),
  { seq: 10, kind: 'ask', payload: { question: '要发吗', answer: '发', planReview: false } },
  { seq: 11, kind: 'answer', payload: { text: '好' }, ms: 12400, createdAt: '2026-11-24 10:00:12' },
  { seq: 12, kind: 'user', payload: { text: '再问' }, createdAt: '2026-11-24 10:01:00' },
  { seq: 13, kind: 'answer', payload: { text: '直接答' }, createdAt: '2026-11-24 10:01:00' }
]

{
  const m = buildTurnLogs(steps, label)
  assert.equal(m.size, 2)
  const t = m.get(11)
  assert.equal(t.counts.reads, 2); assert.equal(t.counts.writes, 2)
  assert.equal(t.counts.confirms, 1); assert.equal(t.counts.autos, 1)
  assert.ok(t.summary.startsWith('查了 2 次数据 · 用了 2 个工具 · 你确认了 1 次'), t.summary)
  assert.ok(t.summary.endsWith('用时 12 秒'), t.summary)
  assert.equal(t.items[0].resultText, '找到 14 份卷子')
  assert.equal(t.items[0].label, '看试卷清单')
  assert.equal(t.items[0].argText, '年级：四年级')
  assert.equal(t.items[1].argText, '按条件查询数据')
  assert.equal(t.items[2].approval, 'session')
  assert.match(t.items[2].approvalText, /本次对话都允许/)
  assert.equal(t.items[3].approval, 'auto')
  assert.equal(t.items.find(i => i.kind === 'ask').resultText, '你选了：发')
  // 摘要里不泄露正文 / 网址
  assert.ok(!t.items[2].argText.includes('SECRET') && !t.items[2].argText.includes('内容'))
  assert.equal(m.get(13).summary, '直接回答，没有查数据 · 用时 不到 1 秒')
}

// 老对话：没有 approval 字段；被拒绝的写操作靠结果文字识别；失败的步骤计入出错
{
  const old = [
    { seq: 1, kind: 'user', payload: {} },
    call(2, 'a', 'wecom_send', {}, 'write'), res(3, 'a', 'wecom_send', '用户没有同意这个操作，没有执行。请换一种方式', false, 10),
    call(4, 'b', 'run_query', {}), res(5, 'b', 'run_query', '数据库没了', false, 2000),
    { seq: 6, kind: 'answer', payload: {} }
  ]
  const t = buildTurnLogs(old, label).get(6)
  assert.equal(t.counts.denies, 1); assert.equal(t.counts.errors, 1)
  assert.equal(t.items[0].resultText, '你没有同意，已取消'); assert.equal(t.items[0].approval, 'deny')
  assert.ok(t.summary.includes('你拒绝了 1 次') && t.summary.includes('出错 1 次'))
  assert.ok(t.summary.endsWith('用时 2 秒'), t.summary)   // 没有时间戳：退回工具耗时
}

// 内部步骤不算「查数据」；提醒会记一条
{
  const t = buildTurnLogs([{ seq: 1, kind: 'user', payload: {} }, call(2, 'p', 'update_plan', {}), res(3, 'p', 'update_plan', '1 字'), { seq: 4, kind: 'assistant', payload: { nudge: true } }, { seq: 5, kind: 'answer', payload: {}, ms: 70000 }], label).get(5)
  assert.equal(t.counts.reads, 0); assert.equal(t.items.length, 1); assert.equal(t.items[0].kind, 'nudge')
  assert.ok(t.summary.endsWith('用时 1 分 10 秒'), t.summary)
}

// 脱敏与截断
{
  const r = formatRaw({ apiKey: 'sk-abcdefghijklmnop1234', url: 'https://qyapi.weixin.qq.com/send?key=abc123&x=1', h: 'Bearer abcdefghijkl', nested: { password: 'p', ok: 1 } })
  assert.ok(!/sk-abcdefghijklmnop|abc123|abcdefghijkl|"p"/.test(r.text), r.text)
  assert.ok(r.text.includes('"ok": 1') && r.text.includes('***'))
  const big = formatRaw('x'.repeat(10000))
  assert.ok(big.truncated && big.text.length < 3100)
  assert.equal(formatRaw('{"a":1}').text, '{\n  "a": 1\n}')
  assert.equal(redactText('call sk-AAAAAAAAAAAAAAAAAAAA now'), 'call sk-*** now')
  assert.equal(formatSeconds(0.2), '不到 1 秒'); assert.equal(argSentence({ sql: 'x' }), '按条件查询数据')
  assert.equal(resultSentence('x', true, '5 字'), '拿到了内容（5 字）')
}

// 长对话够快：2000 轮、1.8 万步 < 1 秒
{
  const big = []
  for (let i = 0; i < 2000; i++) {
    big.push({ seq: i * 10 + 1, kind: 'user', payload: {} })
    for (let k = 0; k < 4; k++) { big.push(call(i * 10 + 2 + k * 2, `i${i}k${k}`, 'run_query', { sql: 'x' })); big.push(res(i * 10 + 3 + k * 2, `i${i}k${k}`, 'run_query', '1 条')) }
    big.push({ seq: i * 10 + 10, kind: 'answer', payload: {}, ms: 1000 })
  }
  const t0 = Date.now(); const m = buildTurnLogs(big, label)
  assert.equal(m.size, 2000); assert.ok(Date.now() - t0 < 1000)
}
console.log('agent-action-log OK')
