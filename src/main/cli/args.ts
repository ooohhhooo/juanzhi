/**
 * 命令行接口（M7）的参数解析、命令表、退出码和输出格式。纯函数，不依赖 electron，单测直接加载。
 * 设计见 docs/M7-命令行接口设计.md。
 */

/** 错误码 → 退出码（文档里的表；改这里要同步 docs/命令行.md 和 skills/juanzhi/SKILL.md，单测会核对） */
export const EXIT_CODES = {
  internal: 1,
  usage: 2,
  app_running: 3,
  cli_busy: 4,
  ai_not_configured: 5,
  not_found: 6,
  invalid_state: 7,
  confirmation_required: 8,
  import_failed: 9,
  timeout: 10,
  export_blocked: 11,
  busy: 12,
  data_unavailable: 13,
  ai_failed: 14
} as const
export type CliErrorCode = keyof typeof EXIT_CODES

export class CliError extends Error {
  readonly code: CliErrorCode
  /** 失败时仍然要带给调用方的数据（比如 import 里每份文件的结果） */
  readonly data?: unknown
  constructor(code: CliErrorCode, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
  get exit(): number { return EXIT_CODES[this.code] }
}

// ───────────────────────── 输出格式 ─────────────────────────

export interface CliOk { ok: true; data: unknown }
export interface CliFail { ok: false; code: CliErrorCode; message: string; exit: number; data?: unknown }

/** stdout 上的那一行 JSON（单行；`"ok":false` 这种写法 Windows 的包装脚本会用 findstr 查，不要加空格） */
export const serializeResult = (r: CliOk | CliFail): string => asciiJson(JSON.stringify(r))
/**
 * 把 JSON 文本里所有非 ASCII 字符写成 \uXXXX（仍是合法 JSON，任何 JSON 解析器读出来都是原来的中文）。
 * 原因：Windows 上 PowerShell / cmd 按各自的控制台编码（中文系统是 GBK）解码子进程的输出字节，UTF-8 的中文会变成乱码；纯 ASCII 在任何编码下都不会乱。
 */
export const asciiJson = (json: string): string => json.replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
export const okResult = (data: unknown): CliOk => ({ ok: true, data })
export function failResult(code: CliErrorCode, message: string, data?: unknown): CliFail {
  return data === undefined ? { ok: false, code, message, exit: EXIT_CODES[code] } : { ok: false, code, message, exit: EXIT_CODES[code], data }
}
/** 任何抛出的东西 → 失败结果（不是 CliError 的归为 internal；message 取错误文字） */
export function failFromError(e: unknown): CliFail {
  if (e instanceof CliError) return failResult(e.code, e.message, e.data)
  if ((e as { name?: string })?.name === 'ZodError') {
    const issues = ((e as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues ?? []).map(i => `${(i.path ?? []).join('.') || '参数'}：${i.message}`)
    return failResult('usage', `参数不符合要求：${issues.join('；') || '格式不对'}`)
  }
  const msg = (e as Error)?.message ?? String(e)
  return failResult('internal', `命令行运行出错：${msg}`)
}

// ───────────────────────── 命令表 ─────────────────────────

export interface CommandSpec {
  /** 位置参数：min / max 个（max = Infinity 表示不限） */
  args: { min: number; max: number; name: string }
  /** 这条命令接受的参数（不含全局参数） */
  flags: string[]
  summary: string
}

const FILTER_FLAGS = ['grade', 'semester', 'year', 'exam-type', 'textbook', 'region', 'include-reviewing', 'include-duplicates']

export const COMMANDS: Record<string, CommandSpec> = {
  status: { args: { min: 0, max: 0, name: '' }, flags: [], summary: '版本、数据目录、卷子数、AI 是否已配置、OCR 是否可用' },
  import: { args: { min: 1, max: Infinity, name: '<文件…>' }, flags: ['wait'], summary: '导入试卷并自动提取、AI 解析' },
  'papers list': { args: { min: 0, max: 0, name: '' }, flags: ['grade', 'semester', 'year', 'exam-type', 'textbook', 'region', 'status'], summary: '试卷列表' },
  'papers show': { args: { min: 1, max: 1, name: '<id>' }, flags: [], summary: '一份试卷的信息和题目' },
  'papers confirm': { args: { min: 1, max: 1, name: '<id>' }, flags: ['i-reviewed'], summary: '跳过人工审核，直接确认整份试卷（必须带 --i-reviewed）' },
  'stats overview': { args: { min: 0, max: 0, name: '' }, flags: FILTER_FLAGS, summary: '总览' },
  'stats hot': { args: { min: 0, max: 0, name: '' }, flags: [...FILTER_FLAGS, 'level'], summary: '重难点（综合得分排序）' },
  'stats compare': { args: { min: 0, max: 0, name: '' }, flags: [...FILTER_FLAGS, 'target', 'base', 'level', 'no-align'], summary: '同比：目标学年 vs 之前的学年' },
  'report generate': { args: { min: 0, max: 0, name: '' }, flags: [...FILTER_FLAGS, 'reader'], summary: '生成报告' },
  'report list': { args: { min: 0, max: 0, name: '' }, flags: [], summary: '报告列表' },
  'report show': { args: { min: 1, max: 1, name: '<id>' }, flags: [], summary: '一份报告的详情' },
  'report export': { args: { min: 1, max: 1, name: '<id>' }, flags: ['format', 'out', 'overwrite'], summary: '导出报告文件（md / docx / pdf）；目标文件已存在时要加 --overwrite 才覆盖' }
}

/** 不带值的参数（其余参数都要带一个值） */
const BOOLEAN_FLAGS = new Set(['wait', 'overwrite', 'i-reviewed', 'include-reviewing', 'include-duplicates', 'no-align', 'quiet', 'help'])
/** 所有命令都接受的全局参数 */
const GLOBAL_FLAGS = ['out', 'result-file', 'timeout', 'quiet', 'help']

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | true>
  /** 全局参数 */
  resultFile: string | null
  /** `--out`：除 `report export` 外，是 JSON 的副本文件；`report export` 里 --out 是导出文档的路径，不在这里 */
  jsonOut: string | null
  timeoutSec: number
  quiet: boolean
  help: boolean
}

const DEFAULT_TIMEOUT_SEC = 3600

/**
 * 不依赖命令能不能解析成功，先把 --result-file / --out（JSON 副本）从原始参数里找出来：
 * 命令写错了（退出码 2）时，调用方指定的结果文件里也要有那段 ok:false 的 JSON。`report export` 里的 --out 是文档路径，不算。
 */
export function scanOutputFlags(args: string[]): { resultFile: string | null; jsonOut: string | null } {
  const val = (name: string): string | null => {
    let out: string | null = null
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out = args[i + 1]
      else if (args[i].startsWith(`--${name}=`)) out = args[i].slice(name.length + 3)
    }
    return out
  }
  const isExport = args.slice(0, 3).join(' ').startsWith('report export')
  return { resultFile: val('result-file'), jsonOut: isExport ? null : val('out') }
}
const usage = (msg: string) => new CliError('usage', msg)

/** 从进程参数里取出 cli 之后的部分；不是命令行模式返回 null。packaged：[exe, 'cli', …]；开发 / 测试：[electron, appDir, 'cli', …] */
export function cliArgvOf(argv: string[], packaged: boolean): string[] | null {
  // 程序名之后可能先有 Chromium / Electron 的开关（如自动化测试用的 --use-mock-keychain）：跳过它们，第一个不是开关的参数必须是 cli
  const rest = argv.slice(packaged ? 1 : 2)
  let i = 0
  while (i < rest.length && rest[i].startsWith('-')) i++
  return rest[i] === 'cli' ? rest.slice(i + 1) : null
}

/** 解析 `cli` 之后的参数。出错抛 CliError('usage')，message 是中文白话 */
export function parseArgs(args: string[]): ParsedArgs {
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  const missing: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { words.push(...args.slice(i + 1)); break }
    if (!a.startsWith('--') || a === '--') { words.push(a); continue }
    const eq = a.indexOf('=')
    const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2))
    if (!name) throw usage(`参数写法不对：${a}`)
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) throw usage(`参数 --${name} 不需要值`)
      flags[name] = true
    } else {
      let val: string | undefined
      if (eq >= 0) val = a.slice(eq + 1)
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) { val = args[i + 1]; i++ }
      // 缺值先记下来：要等命令确定之后，先报「不认识的参数」，再报「缺值」
      if (val === undefined) missing.push(name)
      else flags[name] = val
    }
  }
  // 命令名：先试两个词（papers list），再试一个词（status）
  let command = ''
  let used = 0
  if (words.length >= 2 && Object.hasOwn(COMMANDS, `${words[0]} ${words[1]}`)) { command = `${words[0]} ${words[1]}`; used = 2 }
  else if (words.length >= 1 && Object.hasOwn(COMMANDS, words[0])) { command = words[0]; used = 1 }
  const help = flags.help === true
  if (!command) {
    if (help || words.length === 0) return { command: '', positionals: [], flags, resultFile: null, jsonOut: null, timeoutSec: DEFAULT_TIMEOUT_SEC, quiet: false, help: true }
    const first = words[0]
    if (['papers', 'stats', 'report'].includes(first)) {
      const subs = Object.keys(COMMANDS).filter(c => c.startsWith(first + ' ')).map(c => c.split(' ')[1]).join(' / ')
      throw usage(words.length >= 2 ? `没有「${first} ${words[1]}」这个命令。${first} 的子命令：${subs}` : `「${first}」后面要接子命令：${subs}`)
    }
    throw usage(`没有「${words.slice(0, 2).join(' ')}」这个命令。可用命令：${Object.keys(COMMANDS).join('、')}`)
  }
  const spec = COMMANDS[command]
  const positionals = words.slice(used)
  const allowed = new Set([...spec.flags, ...GLOBAL_FLAGS])
  for (const k of [...Object.keys(flags), ...missing]) if (!allowed.has(k)) throw usage(`「${command}」不认识参数 --${k}`)
  if (missing.length) throw usage(`参数 --${missing[0]} 需要一个值`)
  if (positionals.length < spec.args.min) throw usage(`「${command}」需要 ${spec.args.name}`)
  if (positionals.length > spec.args.max) throw usage(`「${command}」多了参数：${positionals.slice(spec.args.max).join(' ')}`)

  let timeoutSec = DEFAULT_TIMEOUT_SEC
  if (flags.timeout !== undefined) {
    const n = Number(flags.timeout)
    if (!Number.isFinite(n) || n < 1 || n > 86400) throw usage('--timeout 要是 1 到 86400 之间的秒数')
    timeoutSec = Math.floor(n)
  }
  // report export 的 --out 是文档路径，JSON 副本只能用 --result-file
  const jsonOut = command === 'report export' ? null : (typeof flags.out === 'string' ? flags.out : null)
  return {
    command, positionals, flags,
    resultFile: typeof flags['result-file'] === 'string' ? flags['result-file'] : null,
    jsonOut, timeoutSec, quiet: flags.quiet === true, help
  }
}

// ───────────────────────── 筛选参数 ─────────────────────────

const GRADES = ['1', '2', '3', '4', '5', '6']
const SEMESTERS = ['上', '下']
const EXAM_TYPES = ['单元测试', '期中', '期末', '月考', '其他']
const STATUSES = ['imported', 'extracting', 'extracted', 'parsing', 'reviewing', 'done', 'failed']

function oneOf(flag: string, v: string | true | undefined, allowed: string[]): string | undefined {
  if (v === undefined) return undefined
  if (v === true || !allowed.includes(v)) throw usage(`--${flag} 只能是：${allowed.join('、')}`)
  return v
}
function intIn(flag: string, v: string | true | undefined, lo: number, hi: number): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (v === true || !Number.isInteger(n) || n < lo || n > hi) throw usage(`--${flag} 要是 ${lo} 到 ${hi} 之间的整数`)
  return n
}
function text(flag: string, v: string | true | undefined): string | undefined {
  if (v === undefined) return undefined
  if (v === true || !v.trim() || v.length > 100) throw usage(`--${flag} 要是不超过 100 字的文字`)
  return v.trim()
}

/** 统计 / 报告用的筛选（和界面的 StatsFilter 一致）；没有任何筛选参数返回 {} */
export function statsFilterFromFlags(flags: Record<string, string | true>): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  const set = (k: string, v: unknown) => { if (v !== undefined) f[k] = v }
  set('grade', oneOf('grade', flags.grade, GRADES))
  set('semester', oneOf('semester', flags.semester, SEMESTERS))
  set('school_year_start', intIn('year', flags.year, 2000, 2100))
  set('exam_type', oneOf('exam-type', flags['exam-type'], EXAM_TYPES))
  set('textbook', text('textbook', flags.textbook))
  set('region', text('region', flags.region))
  if (flags['include-reviewing']) f.includeReviewing = true
  if (flags['include-duplicates']) f.includeDuplicates = true
  return f
}

/** 试卷列表用的筛选（PaperFilter） */
export function paperFilterFromFlags(flags: Record<string, string | true>): Record<string, unknown> {
  const f: Record<string, unknown> = {}
  const set = (k: string, v: unknown) => { if (v !== undefined) f[k] = v }
  set('grade', oneOf('grade', flags.grade, GRADES))
  set('semester', oneOf('semester', flags.semester, SEMESTERS))
  set('school_year_start', intIn('year', flags.year, 2000, 2100))
  set('exam_type', oneOf('exam-type', flags['exam-type'], EXAM_TYPES))
  set('textbook', text('textbook', flags.textbook))
  set('region', text('region', flags.region))
  set('status', oneOf('status', flags.status, STATUSES))
  return f
}

export const READER_FLAGS = ['boss', 'teacher', 'parent', 'full']
export function readerFromFlags(flags: Record<string, string | true>): string {
  const r = flags.reader
  if (r === undefined) throw usage('报告要用 --reader 指定读者：boss（老板）、teacher（老师）、parent（家长）、full（完整数据）')
  return oneOf('reader', r, READER_FLAGS)!
}
export function exportFormatFromFlags(flags: Record<string, string | true>): 'md' | 'docx' | 'pdf' {
  const f = flags.format
  if (f === undefined) throw usage('导出要用 --format 指定格式：md、docx 或 pdf')
  return oneOf('format', f, ['md', 'docx', 'pdf']) as 'md' | 'docx' | 'pdf'
}
export function levelFromFlags(flags: Record<string, string | true>, dflt: number): number {
  return intIn('level', flags.level, 1, 3) ?? dflt
}

/** 帮助文字（`cli --help` / 不带命令时返回的 data） */
export function helpData(): { commands: Array<{ command: string; usage: string; summary: string }>; filters: string[]; global: string[]; exitCodes: Record<string, number> } {
  return {
    commands: Object.entries(COMMANDS).map(([command, s]) => ({ command, usage: `cli ${command}${s.args.name ? ' ' + s.args.name : ''}${s.flags.length ? ' [' + s.flags.map(f => '--' + f).join(' ') + ']' : ''}`, summary: s.summary })),
    filters: FILTER_FLAGS.map(f => '--' + f),
    global: ['--out <文件>', '--result-file <文件>', '--timeout <秒>', '--quiet'],
    exitCodes: { ok: 0, ...EXIT_CODES }
  }
}
