// M7 命令行：参数解析、筛选参数、退出码表、输出格式。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseArgs, cliArgvOf, statsFilterFromFlags, paperFilterFromFlags, readerFromFlags, exportFormatFromFlags, levelFromFlags, CliError, EXIT_CODES, COMMANDS, okResult, failResult, failFromError, serializeResult, helpData, asciiJson, scanOutputFlags } from '../../src/main/cli/args.ts'

const fails = (args, re, code = 'usage') => assert.throws(() => parseArgs(args), e => e instanceof CliError && e.code === code && re.test(e.message), `${args.join(' ')} 应报错 ${re}`)

// ── 进程参数里取出 cli 之后的部分 ──
assert.deepEqual(cliArgvOf(['/Applications/卷知.app/Contents/MacOS/卷知', 'cli', 'status'], true), ['status'])
assert.deepEqual(cliArgvOf(['electron', '/app', 'cli', 'status', '--quiet'], false), ['status', '--quiet'])
assert.equal(cliArgvOf(['/x/卷知', '--inspect'], true), null, '没有 cli 子命令 = 图形界面')
assert.equal(cliArgvOf(['electron', '/app'], false), null)
assert.equal(cliArgvOf(['/x/卷知', 'status', 'cli'], true), null, 'cli 必须是第一个（非开关）参数')
assert.deepEqual(cliArgvOf(['/x/卷知', '--use-mock-keychain', 'cli', 'status'], true), ['status'], '前面的 Chromium 开关跳过')

// ── 每条命令能解析 ──
{
  const a = parseArgs(['status']); assert.equal(a.command, 'status'); assert.deepEqual(a.positionals, [])
  const b = parseArgs(['import', 'a.pdf', 'b b.png', '--wait']); assert.equal(b.command, 'import'); assert.deepEqual(b.positionals, ['a.pdf', 'b b.png']); assert.equal(b.flags.wait, true)
  const c = parseArgs(['papers', 'list', '--grade', '4', '--status=reviewing']); assert.equal(c.command, 'papers list'); assert.equal(c.flags.grade, '4'); assert.equal(c.flags.status, 'reviewing')
  assert.equal(parseArgs(['papers', 'show', 'abc']).positionals[0], 'abc')
  assert.equal(parseArgs(['papers', 'confirm', 'abc', '--i-reviewed']).flags['i-reviewed'], true)
  assert.equal(parseArgs(['stats', 'overview']).command, 'stats overview')
  assert.equal(parseArgs(['stats', 'hot', '--level', '3', '--grade', '5']).flags.level, '3')
  assert.equal(parseArgs(['stats', 'compare', '--target', '2025', '--base', 'before']).command, 'stats compare')
  assert.equal(parseArgs(['report', 'generate', '--reader', 'boss']).command, 'report generate')
  assert.equal(parseArgs(['report', 'list']).command, 'report list')
  assert.equal(parseArgs(['report', 'show', 'x']).command, 'report show')
  const e = parseArgs(['report', 'export', 'id1', '--format', 'docx', '--out', 'r.docx'])
  assert.equal(e.command, 'report export'); assert.equal(e.flags.out, 'r.docx')
  assert.equal(e.jsonOut, null, 'report export 里 --out 是文档路径，不是 JSON 副本')
  assert.equal(parseArgs(['status', '--out', 'r.json']).jsonOut, 'r.json', '其他命令里 --out 是 JSON 副本')
  assert.equal(parseArgs(['status', '--result-file', 'r.json']).resultFile, 'r.json')
  assert.equal(parseArgs(['status', '--quiet']).quiet, true)
  assert.equal(parseArgs(['status', '--timeout', '30']).timeoutSec, 30)
  assert.equal(parseArgs(['status']).timeoutSec, 3600)
}
// 每个命令表里的命令都能解析（带上必需的位置参数）
for (const [cmd, spec] of Object.entries(COMMANDS)) {
  const pos = Array.from({ length: spec.args.min }, (_, i) => `p${i}`)
  assert.equal(parseArgs([...cmd.split(' '), ...pos]).command, cmd)
}
// 文件名里有空格 / 中文 / 以 -- 之后的内容都当文件
assert.deepEqual(parseArgs(['import', '--wait', '--', '--odd.pdf', '卷子 1.pdf']).positionals, ['--odd.pdf', '卷子 1.pdf'])

// ── 缺参数 / 未知命令 / 未知参数 ──
fails(['bogus'], /没有「bogus」这个命令/)
// 命令名不能撞上 Object.prototype 上的名字（constructor / toString / __proto__ 要报 usage，不是 internal）
for (const w of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'papers constructor']) fails(w.split(' '), /没有「/)
fails(['papers'], /后面要接子命令/)
fails(['papers', 'frobnicate'], /没有「papers frobnicate」/)
fails(['import'], /需要 <文件…>/)
fails(['papers', 'show'], /需要 <id>/)
fails(['papers', 'show', 'a', 'b'], /多了参数/)
fails(['status', 'extra'], /多了参数/)
fails(['status', '--bogus'], /不认识参数 --bogus/)
assert.equal(parseArgs(['report', 'export', 'x', '--format', 'md', '--out', 'a.md', '--overwrite']).flags.overwrite, true)
fails(['status', '--overwrite'], /不认识参数 --overwrite/)
fails(['papers', 'list', '--wait'], /不认识参数 --wait/)
fails(['import', 'a.pdf', '--grade', '4'], /不认识参数 --grade/)
fails(['papers', 'list', '--grade'], /--grade 需要一个值/)
fails(['papers', 'list', '--grade', '--status', 'done'], /--grade 需要一个值/)
fails(['status', '--wait=1'], /不认识参数 --wait|不需要值/)
fails(['status', '--timeout', 'abc'], /秒数/)
fails(['status', '--timeout', '0'], /秒数/)
// 没有命令 / --help = 帮助
assert.equal(parseArgs([]).help, true); assert.equal(parseArgs(['--help']).help, true)

// ── 命令写错时也要能找到 --result-file / --out（错误 JSON 也要写进调用方指定的文件）──
assert.deepEqual(scanOutputFlags(['bogus', '--result-file', 'r.json', '--out=o.json']), { resultFile: 'r.json', jsonOut: 'o.json' })
assert.deepEqual(scanOutputFlags(['report', 'export', 'id', '--out', 'doc.md', '--result-file', 'r.json']), { resultFile: 'r.json', jsonOut: null }, 'report export 里 --out 是文档路径')
assert.deepEqual(scanOutputFlags(['status']), { resultFile: null, jsonOut: null })

// ── 筛选参数 → StatsFilter（和界面一致）──
assert.deepEqual(statsFilterFromFlags({}), {})
assert.deepEqual(statsFilterFromFlags({ grade: '4', semester: '下', year: '2025', 'exam-type': '期末', textbook: '人教PEP', region: '北京', 'include-reviewing': true, 'include-duplicates': true }),
  { grade: '4', semester: '下', school_year_start: 2025, exam_type: '期末', textbook: '人教PEP', region: '北京', includeReviewing: true, includeDuplicates: true })
const bad = (flags, re) => assert.throws(() => statsFilterFromFlags(flags), e => e instanceof CliError && e.code === 'usage' && re.test(e.message))
bad({ grade: '7' }, /--grade 只能是/); bad({ semester: '春' }, /--semester 只能是/); bad({ year: '1999' }, /--year/); bad({ year: 'x' }, /--year/)
bad({ 'exam-type': '统考' }, /--exam-type 只能是/); bad({ textbook: ' ' }, /--textbook/)
assert.deepEqual(paperFilterFromFlags({ grade: '3', status: 'done', year: '2024' }), { grade: '3', status: 'done', school_year_start: 2024 })
assert.throws(() => paperFilterFromFlags({ status: 'weird' }), /--status 只能是/)
// 筛选结果能通过界面同一个 zod 模式
{
  const { StatsFilterSchema } = await import('../../src/main/stats/filter.ts')
  const f = statsFilterFromFlags({ grade: '4', semester: '上', year: '2024', 'exam-type': '期中', 'include-reviewing': true })
  assert.deepEqual(StatsFilterSchema.parse(f), f)
}
assert.equal(readerFromFlags({ reader: 'parent' }), 'parent')
assert.throws(() => readerFromFlags({}), /--reader/); assert.throws(() => readerFromFlags({ reader: 'ceo' }), /--reader 只能是/)
assert.equal(exportFormatFromFlags({ format: 'pdf' }), 'pdf'); assert.throws(() => exportFormatFromFlags({}), /--format/); assert.throws(() => exportFormatFromFlags({ format: 'txt' }), /--format 只能是/)
assert.equal(levelFromFlags({}, 2), 2); assert.equal(levelFromFlags({ level: '3' }, 2), 3); assert.throws(() => levelFromFlags({ level: '4' }, 2), /--level/)

// ── 输出格式 ──
{
  const ok = serializeResult(okResult({ a: 1, 中文: '值', 表情: '😀' }))
  assert.equal(ok, '{"ok":true,"data":{"a":1,"\\u4e2d\\u6587":"\\u503c","\\u8868\\u60c5":"\\ud83d\\ude00"}}'); assert.ok(!ok.includes('\n'), '单行')
  // 输出是纯 ASCII（Windows 控制台按 GBK / OEM 解码也不会乱），但解析回来还是原来的中文
  assert.ok(/^[\x00-\x7f]*$/.test(ok)); assert.deepEqual(JSON.parse(ok).data, { a: 1, 中文: '值', 表情: '😀' })
  assert.ok(/^[\x00-\x7f]*$/.test(serializeResult(failResult('usage', '参数不对，请检查「筛选」'))))
  assert.equal(JSON.parse(asciiJson(JSON.stringify({ m: '含 \u007f 和 \uffff 的字符' }))).m, '含 \u007f 和 \uffff 的字符')
  const f = failResult('app_running', '卷知窗口正在运行，请先关闭卷知窗口再用命令行')
  assert.deepEqual(f, { ok: false, code: 'app_running', message: '卷知窗口正在运行，请先关闭卷知窗口再用命令行', exit: 3 })
  assert.ok(serializeResult(f).includes('"ok":false'), 'Windows 包装脚本用 findstr 查 "ok":false，不能加空格')
  assert.equal(failResult('import_failed', 'x', { papers: [] }).data.papers.length, 0)
  assert.equal(failFromError(new CliError('timeout', 't')).exit, 10)
  const internal = failFromError(new Error('boom')); assert.equal(internal.code, 'internal'); assert.match(internal.message, /boom/)
  const z = failFromError(Object.assign(new Error('x'), { name: 'ZodError', issues: [{ path: ['grade'], message: '不对' }] })); assert.equal(z.code, 'usage'); assert.match(z.message, /grade：不对/)
}

// ── 退出码表：互不相同、不含 0；文档和 Skill 里逐个写明 ──
{
  const codes = Object.values(EXIT_CODES)
  assert.equal(new Set(codes).size, codes.length, '退出码互不相同'); assert.ok(codes.every(c => c >= 1))
  assert.deepEqual(Object.keys(EXIT_CODES).sort(), ['ai_failed', 'ai_not_configured', 'app_running', 'busy', 'cli_busy', 'confirmation_required', 'data_unavailable', 'export_blocked', 'import_failed', 'internal', 'invalid_state', 'not_found', 'timeout', 'usage'].sort())
  for (const f of ['docs/命令行.md', 'skills/juanzhi/SKILL.md', 'docs/M7-命令行接口设计.md']) {
    if (!fs.existsSync(f)) continue
    const md = fs.readFileSync(f, 'utf8')
    for (const [code, n] of Object.entries(EXIT_CODES)) assert.ok(md.includes(code) && new RegExp(`\\b${n}\\b`).test(md), `${f} 里要写明错误码 ${code}（${n}）`)
  }
  const h = helpData(); assert.ok(h.commands.length === Object.keys(COMMANDS).length); assert.equal(h.exitCodes.ok, 0)
}
// ── Skill 说明书：frontmatter 有 name / description，正文里有命令清单和「不能做的事」──
{
  const md = fs.readFileSync('skills/juanzhi/SKILL.md', 'utf8')
  const m = /^---\nname: (juanzhi)\ndescription: (.+)\n---\n/.exec(md)
  assert.ok(m && m[2].length > 40, 'SKILL.md 要有 name / description 的 frontmatter')
  for (const cmd of Object.keys(COMMANDS)) assert.ok(md.includes('`' + cmd.replace(/ .*/, '')) || md.includes(cmd), `SKILL.md 里要有命令 ${cmd}`)
  for (const must of ['--i-reviewed', 'AI 草稿 · 未经老师核对，请勿直接发给家长', '不能做的事', '不能设置、读取、询问 API Key', 'juanzhi status', '提醒用户人工审核']) assert.ok(md.includes(must), `SKILL.md 缺：${must}`)
}
console.log('cli-args.test ✓')
