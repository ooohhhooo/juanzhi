// 命令行交互界面的纯逻辑：Markdown 终端渲染、对话状态（事件折叠）、输入框编辑、斜杠命令匹配、报错框。界面本身（Ink）在 tests/e2e/run-tui.cjs 里测。
import assert from 'node:assert/strict'
import { charWidth, textWidth, clipWidth, parseMarkdown, inlineSpans, tableLines, tableFallback, simplifyRefs } from '../../src/main/cli/tui/markdown.ts'
import { ChatModel, argHint, fmtTokens, fmtUsage, fmtMs, itemsFromSteps } from '../../src/main/cli/tui/chat-model.ts'
import * as ed from '../../src/main/cli/tui/editor.ts'
import { matchSlash, parseSlash, splitPaths, SLASH_COMMANDS } from '../../src/main/cli/tui/slash-defs.ts'
import { boxLines, errorBox, wrapWidth } from '../../src/main/cli/tui/box.ts'

// ── 显示宽度 ──
assert.equal(textWidth('abc'), 3)
assert.equal(textWidth('卷知'), 4, '中文每字 2 列')
assert.equal(textWidth('a卷b'), 4)
assert.equal(charWidth(0x0301), 0, '组合符不占列')
assert.equal(clipWidth('卷知英语工作台', 7), '卷知英…')
assert.equal(clipWidth('abc', 5), 'abc')

// ── Markdown ──
const md = ['# 标题', '', '正文 **粗体** 和 `代码` 以及 *斜体*。', '', '- 第一项', '- 第二项 [[query:6]]', '1. 编号', '', '> 引用', '', '```js', 'a = 1', '```', '', '| 项目 | 数 |', '|---|--:|', '| 甲 | 12 |', '| 乙乙 | 3 |', '', '---'].join('\n')
const blocks = parseMarkdown(md)
assert.deepEqual(blocks.map(b => b.k), ['h', 'p', 'li', 'li', 'li', 'quote', 'code', 'table', 'hr'])
assert.equal(blocks[0].level, 1)
const p = blocks[1].spans
assert.ok(p.some(s => s.b && s.t === '粗体') && p.some(s => s.code && s.t === '代码') && p.some(s => s.i && s.t === '斜体'))
assert.equal(blocks[2].marker, '•'); assert.equal(blocks[4].marker, '1.')
assert.ok(blocks[3].spans.some(s => s.dim && s.t === '〔#6〕'), '引用标签变成淡色短标记')
assert.deepEqual(blocks[6].lines, ['a = 1'])
assert.deepEqual(blocks[7].header, ['项目', '数']); assert.deepEqual(blocks[7].align, ['l', 'r'])
const tl = tableLines(blocks[7], 60)
assert.equal(tl.length, 6)
assert.ok(tl[0].startsWith('┌') && tl[5].startsWith('└'))
assert.ok(tl.every(l => textWidth(l) === textWidth(tl[0])), '每行等宽（中文按 2 列算）')
assert.equal(tableLines(blocks[7], 8), null, '放不下返回 null')
assert.deepEqual(tableFallback(blocks[7]), ['项目：甲 · 数：12', '项目：乙乙 · 数：3'])
assert.equal(simplifyRefs('见[[q:abc]]与[[lesson:5]]'), '见〔题〕与〔课〕')
assert.deepEqual(inlineSpans('[文字](https://a.b/c)').map(s => s.t), ['文字', ' (https://a.b/c)'])
assert.deepEqual(parseMarkdown('第一行\n第二行').map(b => b.k), ['p'], '连续的行合成一段')
assert.equal(parseMarkdown('```\n没有结尾').length, 1, '没闭合的代码块不死循环')

// ── 对话状态 ──
const labels = { run_query: '查询数据', update_plan: '更新计划' }
let now = 1000
const m = new ChatModel({ toolLabel: n => labels[n] ?? n, now: () => now })
let versions = 0
const un = m.subscribe(() => { versions++ })
m.beginRun('帮我看看')
assert.equal(m.live.running, true); assert.equal(m.items.at(-1).kind, 'user')
m.apply({ sessionId: 's1', type: 'delta', text: '好的，' }); m.apply({ sessionId: 's1', type: 'delta', text: '我先查' })
assert.equal(m.live.stream, '好的，我先查'); assert.equal(m.sessionId, 's1')
m.apply({ sessionId: 's1', type: 'reset' }); assert.equal(m.live.stream, '', '重试时清掉半截文字')
m.apply({ sessionId: 's1', type: 'step', kind: 'plan', payload: { items: [{ content: '查', status: 'doing' }, { content: '写', status: 'todo' }] } })
assert.equal(m.live.plan.length, 2)
now = 1200
m.apply({ sessionId: 's1', type: 'step', kind: 'tool_call', payload: { id: 'c1', n: 1, name: 'run_query', args: '{"sql":"SELECT 1"}', level: 'read' } })
assert.equal(m.live.tools.length, 1); assert.equal(m.live.tools[0].label, '查询数据'); assert.equal(m.live.tools[0].hint, 'SELECT 1')
m.apply({ sessionId: 's1', type: 'tool-progress', id: 'c1', done: 2, total: 5 }); assert.equal(m.live.tools[0].total, 5)
m.apply({ sessionId: 's1', type: 'step', kind: 'tool_result', ms: 80, payload: { id: 'c1', n: 1, name: 'run_query', ok: true, summary: '3 行', text: '..' } })
assert.equal(m.live.tools.length, 0)
const tool = m.items.at(-1)
assert.equal(tool.kind, 'tool'); assert.equal(tool.label, '查询数据'); assert.equal(tool.summary, '3 行'); assert.equal(tool.ms, 80); assert.equal(tool.ok, true)
m.apply({ sessionId: 's1', type: 'step', kind: 'tool_call', payload: { id: 'c2', n: 2, name: 'update_plan', args: '{}', level: 'read' } })
m.apply({ sessionId: 's1', type: 'step', kind: 'tool_result', ms: 1, payload: { id: 'c2', n: 2, name: 'update_plan', ok: true, summary: '', text: '' } })
assert.equal(m.items.at(-1), tool, 'update_plan 的结果不单独占一行')
// 提问
m.apply({ sessionId: 's1', type: 'step', kind: 'ask', payload: { id: 'a1', question: '看哪个范围？', options: ['全部', '四年级'], allowOther: true, planReview: false } })
assert.deepEqual(m.live.pending, { type: 'ask', id: 'a1', question: '看哪个范围？', options: ['全部', '四年级'], allowOther: true, planReview: false })
// 审批
m.apply({ sessionId: 's1', type: 'approval', id: 'p1', name: 'wecom_send', summary: '发到企业微信', args: '{}', preview: { target: '企业微信群：A', content: '你好', privacyWarning: '含手机号' } })
assert.deepEqual(m.live.pending, { type: 'approval', id: 'p1', name: 'wecom_send', summary: '发到企业微信', target: '企业微信群：A', content: '你好', privacyWarning: '含手机号' })
// 进度与用量
m.apply({ sessionId: 's1', type: 'progress', rounds: 2, tokensIn: 1200, tokensOut: 300, money: 0.02 })
assert.deepEqual(m.totalUsage(), { tokensIn: 1200, tokensOut: 300, money: 0.02 })
// 回答：计划定稿、文字
m.live.pending = null
m.apply({ sessionId: 's1', type: 'step', kind: 'answer', payload: { text: '## 结论\n没问题', removedRefs: 0, stop: 'answered' } })
assert.equal(m.items.at(-1).kind, 'text'); assert.ok(m.items.some(i => i.kind === 'plan'), '回答时把当前计划存成一条')
m.apply({ sessionId: 's1', type: 'done', status: 'answered' })
assert.equal(m.live.running, false); assert.equal(m.usage.tokensIn, 1200)
// 第二次提问累计
m.beginRun('再问一个'); m.apply({ sessionId: 's1', type: 'progress', rounds: 1, tokensIn: 800, tokensOut: 100, money: 0.01 })
assert.equal(m.totalUsage().tokensIn, 2000); assert.ok(Math.abs(m.totalUsage().money - 0.03) < 1e-9)
// 中断 / 出错 / 超限
m.apply({ sessionId: 's1', type: 'step', kind: 'error', payload: { code: 'x', message: '网络不通' } })
assert.deepEqual([m.items.at(-1).kind, m.items.at(-1).tone, m.items.at(-1).text], ['notice', 'error', '网络不通'])
m.apply({ sessionId: 's1', type: 'done', status: 'stopped' })
assert.equal(m.items.at(-1).text, '已中断'); assert.equal(m.live.running, false)
m.beginRun('x'); m.apply({ sessionId: 's1', type: 'step', kind: 'answer', payload: { text: '部分', removedRefs: 0, stop: 'tokens' } })
assert.ok(m.items.at(-1).text.includes('用量')); m.apply({ sessionId: 's1', type: 'done', status: 'tokens' })
// 价格没填：money 为 null 时累计也是 null
const m2 = new ChatModel(); m2.beginRun('q'); m2.apply({ type: 'progress', tokensIn: 10, tokensOut: 5 })
assert.equal(m2.totalUsage().money, null); assert.equal(fmtUsage(m2.totalUsage(), false), '15 tokens · 未设价格'); assert.equal(fmtUsage(m2.totalUsage(), true), '15 tokens')
// 清屏 / 新对话
const ep = m.epoch; m.clearItems(); assert.equal(m.items.length, 0); assert.equal(m.epoch, ep + 1)
m.resetSession(); assert.equal(m.sessionId, undefined); assert.equal(m.totalUsage().tokensIn, 0)
assert.ok(versions > 10); un()
// 启动失败
const m3 = new ChatModel(); m3.beginRun('q'); m3.failRun('这个角色暂时还不能用'); assert.equal(m3.live.running, false); assert.equal(m3.items.at(-1).tone, 'error')
// 回放
const replay = itemsFromSteps([
  { kind: 'user', payload: { text: 'Q' } },
  { kind: 'tool_call', payload: { id: 'x', name: 'run_query', args: '{"sql":"S"}' } },
  { kind: 'tool_result', ms: 5, payload: { id: 'x', name: 'run_query', ok: false, summary: '出错' } },
  { kind: 'plan', payload: { items: [{ content: 'a', status: 'done' }] } },
  { kind: 'answer', payload: { text: 'A' } }
], n => labels[n] ?? n)
assert.deepEqual(replay.map(i => i.kind), ['user', 'tool', 'plan', 'text'])
assert.equal(replay[1].hint, 'S'); assert.equal(replay[1].ok, false)
assert.equal(argHint({ sql: '  SELECT\n 1 ' }), 'SELECT 1'); assert.equal(argHint('not json'), 'not json'); assert.equal(argHint(null), '')
assert.deepEqual([fmtTokens(999), fmtTokens(1234), fmtTokens(15000), fmtTokens(2_500_000)], ['999', '1.2k', '15k', '2.5M'])
assert.deepEqual([fmtMs(40), fmtMs(1500), fmtMs(65_000)], ['40ms', '1.5s', '1m5s'])

// ── 输入框编辑 ──
let e = ed.empty()
e = ed.insert(e, '你好'); e = ed.insert(e, '\n世界')
assert.equal(e.text, '你好\n世界'); assert.equal(e.cur, 5)
assert.deepEqual(ed.posOf(e), { row: 1, col: 2, lines: ['你好', '世界'] })
e = ed.backspace(e); assert.equal(e.text, '你好\n世')
e = ed.up(e); assert.equal(e.cur, 1, '上移一行，尽量保持显示列')
assert.equal(ed.up(e), null, '第一行再上移交给历史')
e = ed.lineEnd(e); assert.equal(e.cur, 2); e = ed.down(e); assert.equal(ed.down(e), null)
e = ed.fromText('abc def'); e = ed.deleteWord(e); assert.equal(e.text, 'abc ')
e = ed.fromText('第一行\n第二行'); e = ed.killToStart(e); assert.equal(e.text, '第一行\n')
e = { text: 'abcdef', cur: 2 }; assert.equal(ed.killToEnd(e).text, 'ab'); assert.equal(ed.del(e).text, 'abdef')
assert.equal(ed.left({ text: 'ab', cur: 0 }).cur, 0); assert.equal(ed.right({ text: 'ab', cur: 2 }).cur, 2)
e = ed.insert(ed.empty(), '😀a'); assert.equal(e.cur, 2, '表情按一个字算'); assert.equal(ed.backspace(e).text, '😀')
assert.deepEqual(ed.viewLines({ text: 'ab\ncd', cur: 1 }), [{ before: 'a', at: 'b', after: '' }, { plain: 'cd' }])
assert.deepEqual(ed.viewLines({ text: 'ab', cur: 2 }), [{ before: 'ab', at: ' ', after: '' }], '光标在末尾画成空格')

// ── 斜杠命令 ──
assert.deepEqual(matchSlash('/').map(d => d.name), SLASH_COMMANDS.map(d => d.name))
assert.deepEqual(matchSlash('/pa').map(d => d.name), ['papers'])
assert.equal(matchSlash('/im')[0].name, 'import')
assert.deepEqual(matchSlash('/import x'), [], '已经有参数就不再弹')
assert.deepEqual(matchSlash('你好'), [])
assert.ok(matchSlash('/切换').length >= 2, '说明里的字也能搜到')
for (const n of ['help', 'status', 'import', 'papers', 'report', 'datasets', 'role', 'mode', 'model', 'new', 'history', 'clear', 'exit']) assert.ok(SLASH_COMMANDS.some(d => d.name === n), `有 /${n}`)
assert.deepEqual(parseSlash('/import a.pdf b.pdf'), { name: 'import', arg: 'a.pdf b.pdf' })
assert.deepEqual(parseSlash('/QUIT'), { name: 'exit', arg: '' }); assert.equal(parseSlash('hello'), null)
assert.deepEqual(splitPaths("'/a b/c.pdf' /d/e.png", '/home/u'), ['/a b/c.pdf', '/d/e.png'])
assert.deepEqual(splitPaths('/a\\ b/c.pdf ~/x.docx', '/home/u'), ['/a b/c.pdf', '/home/u/x.docx'], '拖进终端的路径空格前有反斜杠')
assert.deepEqual(splitPaths('file:///a%20b/c.pdf', '/h'), ['/a b/c.pdf'])
assert.deepEqual(splitPaths('"C:\\\\x y\\\\z.pdf"', '/h'), ['C:\\x y\\z.pdf'])

// ── 报错框 ──
const bl = boxLines('✦ 卷知', '另一个卷知命令行任务（进程 123）正在使用数据，请等它结束后再试', 50)
assert.ok(bl[0].startsWith('╭') && bl.at(-1).startsWith('╰'))
assert.ok(bl.every(l => textWidth(l) === textWidth(bl[0])), '框是齐的')
assert.ok(bl.every(l => textWidth(l) <= 50))
assert.equal(wrapWidth('卷知卷知卷', 6).join('|'), '卷知卷|知卷')
assert.ok(!errorBox('x', { columns: 40, color: false }).includes('\x1b'), '无色时没有控制码')
assert.ok(errorBox('x', { columns: 40, color: true }).includes('\x1b[38;2;'))

console.log('cli-tui.test ✓')
