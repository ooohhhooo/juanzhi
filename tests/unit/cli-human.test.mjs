// 命令行「人读输出」、卷卷像素画、窗口正在运行面板、运行锁的「请窗口退出」请求。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { humanWanted, renderHuman, renderTable, colorWanted, ERROR_HINTS } from '../../src/main/cli/human.ts'
import { EXIT_CODES, serializeResult, okResult, failResult, parseArgs } from '../../src/main/cli/args.ts'
import { textWidth } from '../../src/main/cli/tui/markdown.ts'
import { MASCOT_GRID, mascotRows, mascotPlain } from '../../src/main/cli/tui/mascot.ts'
import { windowRunningPanel, PANEL_TEXT, PANEL_PROMPT, BUSY_MESSAGE } from '../../src/main/cli/running-panel.ts'
import { acquireRunLock, sendLockRequest, inspectRunLock } from '../../src/main/cli/lock.ts'

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')

// ── 什么时候走人读输出 ──
const base = { stdoutTty: true, json: false, resultFile: null, jsonOut: null, envResultFile: undefined }
assert.equal(humanWanted(base), true)
assert.equal(humanWanted({ ...base, stdoutTty: false }), false, '管道 / 重定向 / Agent：JSON')
assert.equal(humanWanted({ ...base, json: true }), false, '--json：JSON')
assert.equal(humanWanted({ ...base, resultFile: '/x/r.json' }), false, '--result-file：JSON')
assert.equal(humanWanted({ ...base, jsonOut: '/x/o.json' }), false, '--out：JSON')
assert.equal(humanWanted({ ...base, envResultFile: '/x/e.json' }), false, 'Windows 包装脚本的结果文件：JSON')
assert.equal(colorWanted({}), true); assert.equal(colorWanted({ NO_COLOR: '1' }), false); assert.equal(colorWanted({ NO_COLOR: '' }), false); assert.equal(colorWanted({ TERM: 'dumb' }), false)

// ── --json 是合法的全局参数；机器输出的序列化没变 ──
assert.equal(parseArgs(['status', '--json']).command, 'status')
assert.equal(parseArgs(['papers', 'list', '--json', '--grade', '4']).flags.grade, '4')
assert.equal(serializeResult(failResult('app_running', '卷知')), '{"ok":false,"code":"app_running","message":"\\u5377\\u77e5","exit":3}', '机器模式仍是纯 ASCII 的一行')

// ── 表格：对齐（按显示宽度）──
const P = { accent: s => s, ok: s => s, err: s => s, warn: s => s, dim: s => s, bold: s => s }
{
  const t = renderTable(['名称', '题数'], [['期末卷', '12'], ['abc', '3']], { columns: 80, right: [1], p: P })
  assert.equal(t.length, 4)
  assert.ok(t.every(l => textWidth(l) === textWidth(t[0])) || textWidth(t[2]) === textWidth(t[3]), '各行同宽')
  const narrow = renderTable(['名称'], [['很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长']], { columns: 30, p: P })
  assert.ok(narrow.every(l => textWidth(l) <= 30), '太宽会截断')
}

// ── status ──
const statusData = { version: '1.4.0', platform: 'darwin', arch: 'arm64', schema: 30, dataDir: '/Users/a/卷知数据', papers: { total: 23, byStatus: { done: 20, reviewing: 2, failed: 1 } }, ai: { configured: true, model: 'gpt-x' }, ocr: { available: false, detail: '没装' } }
{
  const out = renderHuman(okResult(statusData), 'status', { color: false, columns: 80 })
  assert.ok(!out.includes('\\u') && !/\\u[0-9a-f]{4}/.test(out), '没有 \\u 转义')
  assert.ok(/卷知 v1\.4\.0/.test(out) && /数据目录\s+\/Users\/a\/卷知数据/.test(out) && /共 23 份/.test(out))
  assert.ok(/✓ 已配置\s+模型 gpt-x/.test(out) && /✗ 不可用（没装）/.test(out))
  assert.ok(/待审核\s+2/.test(out) && /已确认\s+20/.test(out) && /失败\s+1/.test(out), '各状态份数')
  assert.ok(!out.includes('\x1b'), '无色')
  const colored = renderHuman(okResult(statusData), 'status', { color: true, columns: 80 })
  assert.ok(colored.includes('\x1b[32m') && colored.includes('\x1b[31m'), '✓ 绿 ✗ 红')
  assert.equal(strip(colored), out, '去掉颜色后和无色一样')
}
// ── papers list ──
{
  const d = { papers: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: '四年级上册期末', status: 'reviewing', questions: 30, grade: '4', semester: '上', examType: '期末' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: '', fileName: 'x.pdf', status: 'failed', questions: 0 }
  ] }
  const out = renderHuman(okResult(d), 'papers list', { color: false, columns: 80 })
  assert.ok(/编号\s+试卷\s+状态\s+题数\s+年级学期/.test(out) && /aaaaaaaa\s+四年级上册期末\s+待审核\s+30\s+4年级 上 期末/.test(out) && /bbbbbbbb\s+x\.pdf\s+失败/.test(out))
  assert.ok(/共 2 份试卷/.test(out))
  assert.ok(/还没有试卷/.test(renderHuman(okResult({ papers: [] }), 'papers list', { color: false, columns: 80 })))
}
// ── 错误：✗ + 原因 + 提示；每个错误码都有提示 ──
for (const code of Object.keys(EXIT_CODES)) assert.ok(ERROR_HINTS[code], `${code} 有提示`)
{
  const out = renderHuman(failResult('ai_not_configured', '还没有配置 AI'), 'report generate', { color: false, columns: 80 })
  assert.ok(/✗ 还没有配置 AI/.test(out) && /→ 打开卷知窗口/.test(out))
  const busy = renderHuman(failResult('app_running', BUSY_MESSAGE), 'status', { color: false, columns: 80 })
  assert.ok(busy.includes(BUSY_MESSAGE) && !busy.includes('→'), '忙时不再叫人去退出窗口')
  assert.ok(renderHuman(failResult('usage', '没有这个命令'), '', { color: true, columns: 80 }).includes('\x1b[31m✗'))
}
// ── 其他命令：成功提示 + 键值 / 表 ──
{
  const out = renderHuman(okResult({ reports: [{ id: 'r1', title: '周报', draft: true }] }), 'report list', { color: false, columns: 80 })
  assert.ok(/✓ report list 完成/.test(out) && /id\s+title\s+draft/.test(out) && /周报/.test(out))
  assert.ok(/✓ 完成/.test(renderHuman(okResult({}), '', { color: false, columns: 80 })))
  const help = renderHuman(okResult({ commands: [{ command: 'status', usage: 'cli status', summary: '版本' }] }), '', { color: false, columns: 80 })
  assert.ok(/juanzhi status\s+版本/.test(help))
}

// ── 卷卷 ──
assert.equal(MASCOT_GRID.length, 10); assert.ok(MASCOT_GRID.every(r => r.length === 10), '10 × 10 像素')
assert.equal(mascotRows().length, 5); assert.ok(mascotRows().every(r => r.length === 10), '5 行 × 10 列')
assert.ok(mascotPlain().every(l => textWidth(l) === 10) && mascotPlain().length === 5)
assert.ok(mascotRows().flat().some(c => c.fg === '#F5E6C8') && mascotRows().flat().some(c => c.fg === '#8F94FF'), '奶油 + 蓝紫')

// ── 窗口正在运行面板 ──
{
  const panel = strip(windowRunningPanel({ columns: 80, color: false }))
  assert.ok(panel.includes(PANEL_TEXT) && panel.includes(PANEL_PROMPT))
  assert.equal(PANEL_TEXT, '卷知窗口正在运行。命令行和窗口不能同时用同一份数据。')
  assert.equal(PANEL_PROMPT, '按 Enter 让卷知窗口退出并继续，按 Esc 取消')
  assert.equal(BUSY_MESSAGE, '卷知正在处理任务，请等它结束后再试')
  assert.ok(!windowRunningPanel({ columns: 80, color: false }).includes('\x1b'))
}

// ── 运行锁：请窗口退出 ──
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-human-'))
{
  const dir = tmp()
  const seen = []
  const gui = await acquireRunLock(dir, 'gui', process.pid, { onRequest: cmd => { seen.push(cmd); return { result: 'busy' } } })
  assert.ok(gui.ok)
  assert.equal(await sendLockRequest(dir, 'quit'), 'busy', '窗口忙：回 busy')
  assert.deepEqual(seen, ['quit'])
  // 普通探测（抢锁失败看持有者）仍然拿得到信息
  const cli = await acquireRunLock(dir, 'cli')
  assert.ok(!cli.ok && cli.holder?.mode === 'gui')
  assert.equal((await inspectRunLock(dir))?.mode, 'gui')
  gui.release()
}
{
  const dir = tmp()
  const gui = await acquireRunLock(dir, 'gui', process.pid, { onRequest: () => ({ result: 'quitting' }) })
  assert.equal(await sendLockRequest(dir, 'quit'), 'quitting')
  gui.release()
  const cli = await acquireRunLock(dir, 'cli')
  assert.ok(cli.ok, '窗口释放之后命令行拿得到锁'); cli.release()
}
{
  // 旧版窗口（不认请求）：没有第二行回复 → null
  const dir = tmp()
  const old = await acquireRunLock(dir, 'gui')
  assert.equal(await sendLockRequest(dir, 'quit', 2000), null)
  old.release()
  // 没人持有：连不上 → null
  assert.equal(await sendLockRequest(dir, 'quit', 1000), null)
}
{
  // 请求处理抛错：不崩，连接关掉
  const dir = tmp()
  const gui = await acquireRunLock(dir, 'gui', process.pid, { onRequest: () => { throw new Error('boom') } })
  assert.equal(await sendLockRequest(dir, 'quit', 2000), null)
  assert.ok((await inspectRunLock(dir))?.mode === 'gui', '持有者还在')
  gui.release()
}
await sleep(10)
console.log('cli-human.test ✓')
