/**
 * 命令行给「人」看的输出（M7 续）：在真实终端里运行 `juanzhi <命令>`、又没有要 JSON 时，用带颜色的中文表格和 ✓ / ✗ 提示代替那一行 JSON。
 * 机器契约不变：stdout 不是终端、带 --json、带 --out / --result-file（或环境变量 JUANZHI_RESULT_FILE）时，仍然只输出原来的一行纯 ASCII JSON（见 run.ts 的 humanWanted）。
 * 纯函数，不依赖 electron，单测直接加载。退出码由调用方照旧处理。
 */
import { clipWidth, textWidth } from './tui/markdown.ts'
import type { CliFail, CliOk } from './args.ts'

export interface HumanOpts { color: boolean; columns: number }

/** 要不要走人读输出：stdout 是终端，且没有 --json、没有任何结果文件 */
export function humanWanted(o: { stdoutTty: boolean; json: boolean; resultFile: string | null; jsonOut: string | null; envResultFile: string | undefined }): boolean {
  return o.stdoutTty && !o.json && !o.resultFile && !o.jsonOut && !o.envResultFile
}

export const colorWanted = (env: NodeJS.ProcessEnv = process.env): boolean => !('NO_COLOR' in env) && env.TERM !== 'dumb'

function paint(color: boolean) {
  const w = (open: string, close = '\x1b[0m') => (s: string): string => (color ? `${open}${s}${close}` : s)
  return {
    accent: w('\x1b[38;2;143;148;255m'), ok: w('\x1b[32m'), err: w('\x1b[31m'), warn: w('\x1b[33m'),
    dim: w('\x1b[2m', '\x1b[22m'), bold: w('\x1b[1m', '\x1b[22m')
  }
}
type Paint = ReturnType<typeof paint>

const padEnd = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - textWidth(s)))
const padStart = (s: string, w: number): string => ' '.repeat(Math.max(0, w - textWidth(s))) + s

/** 对齐的表格：列之间两个空格，表头下一条细线；太宽时从最宽的列开始截断。cells 是纯文字（不含颜色码），颜色由 tone 给 */
export function renderTable(
  headers: string[], rows: string[][], o: { columns: number; right?: number[]; tone?: (row: number, col: number) => ((s: string) => string) | undefined; p: Paint; indent?: number }
): string[] {
  const indent = o.indent ?? 2
  const right = new Set(o.right ?? [])
  const widths = headers.map((h, c) => Math.max(textWidth(h), ...rows.map(r => textWidth(r[c] ?? ''))))
  const gap = 2
  const budget = Math.max(20, o.columns - indent - 1)
  const total = (): number => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)
  while (total() > budget) {
    let i = 0
    for (let c = 1; c < widths.length; c++) if (widths[c] > widths[i]) i = c
    if (widths[i] <= 6) break
    widths[i]--
  }
  const cell = (s: string, c: number): string => { const t = textWidth(s) > widths[c] ? clipWidth(s, widths[c]) : s; return right.has(c) ? padStart(t, widths[c]) : padEnd(t, widths[c]) }
  const sp = ' '.repeat(indent)
  const out: string[] = []
  out.push(sp + headers.map((h, c) => o.p.dim(cell(h, c))).join(' '.repeat(gap)))
  out.push(sp + o.p.dim('─'.repeat(Math.min(total(), budget))))
  rows.forEach((r, ri) => out.push(sp + r.map((x, c) => { const t = o.tone?.(ri, c); const s = cell(x ?? '', c); return t ? t(s) : s }).join(' '.repeat(gap))))
  return out
}

const PAPER_STATUS: Record<string, string> = { reviewing: '待审核', done: '已确认', failed: '失败', parsing: '解析中', extracting: '提取中', queued: '排队中', imported: '已导入', extracted: '已提取' }
const statusLabel = (s: string): string => PAPER_STATUS[s] ?? s

/** 各类错误后面跟的「接下来怎么办」 */
export const ERROR_HINTS: Record<string, string> = {
  usage: '运行 juanzhi --help 可以看全部命令和用法',
  app_running: '先退出卷知窗口再用命令行：Mac 按 Cmd+Q（只关窗口不行），Windows 关闭窗口即可',
  cli_busy: '等当前任务结束后再试；如果一直这样，请退出卷知窗口后再试',
  ai_not_configured: '打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写后再试',
  not_found: '用 juanzhi papers list 或 juanzhi report list 查 id',
  invalid_state: '先看看这份数据现在是什么状态（juanzhi status、juanzhi papers list）',
  confirmation_required: '这个操作需要你明确确认，按提示补上对应的参数再运行',
  import_failed: '检查文件是不是 PDF / 图片 / Word、有没有损坏，再试一次',
  timeout: '加大 --timeout 秒数，或稍后再试',
  export_blocked: '先在卷知窗口里处理提示的问题（比如家长版要老师核对）再导出',
  busy: '等正在进行的同类任务结束后再试',
  data_unavailable: '检查数据目录（移动硬盘有没有接上、磁盘空间和权限）；或打开卷知窗口改用默认位置',
  ai_failed: '稍后再试；如果一直失败，到卷知窗口「设置 → 关于 → 导出诊断信息」把诊断包发给开发者',
  course_not_matched: '先运行 juanzhi course match <id> 把知识点匹配到课程体系',
  internal: '再试一次；如果还是这样，运行 juanzhi diagnostics 导出诊断信息'
}

function renderStatus(d: any, o: HumanOpts, p: Paint): string[] {
  const by = Object.entries((d.papers?.byStatus ?? {}) as Record<string, number>)
  const lines: string[] = ['', `  ${p.accent(p.bold('✦ 卷知'))} ${p.dim('v' + d.version)}  ${p.dim(`${d.platform} ${d.arch}`)}`, '']
  const rows: string[][] = [
    ['数据目录', String(d.dataDir)],
    ['试卷', `共 ${d.papers?.total ?? 0} 份`],
    ['AI', d.ai?.configured ? `✓ 已配置${d.ai.model ? `  模型 ${d.ai.model}` : ''}` : '✗ 还没有配置（到窗口「设置 → 管理员设置 → AI 服务」填写）'],
    ['文字识别', d.ocr?.available ? '✓ 可用' : `✗ 不可用${d.ocr?.detail ? `（${d.ocr.detail}）` : ''}`]
  ]
  lines.push(...renderTable(['项目', '内容'], rows, {
    columns: o.columns, p,
    tone: (r, c) => c === 1 && r >= 2 ? (rows[r][1].startsWith('✓') ? p.ok : p.err) : undefined
  }))
  if (by.length) {
    lines.push('', ...renderTable(['试卷状态', '份数'], by.map(([k, v]) => [statusLabel(k), String(v)]), { columns: o.columns, p, right: [1] }))
  }
  lines.push('')
  return lines
}

function renderPapers(d: any, o: HumanOpts, p: Paint): string[] {
  const list: any[] = d.papers ?? []
  if (!list.length) return ['', `  ${p.dim('·')} 还没有试卷。用 juanzhi import <文件…> 导入`, '']
  const rows = list.map(x => [
    String(x.id).slice(0, 8), String(x.title || x.fileName || ''), statusLabel(x.status), String(x.questions ?? 0),
    [x.grade && `${x.grade}年级`, x.semester, x.examType].filter(Boolean).join(' ')
  ])
  return ['', `  共 ${list.length} 份试卷`, '', ...renderTable(['编号', '试卷', '状态', '题数', '年级学期'], rows, {
    columns: o.columns, p, right: [3],
    tone: (r, c) => c === 2 ? (list[r].status === 'failed' ? p.err : list[r].status === 'done' ? p.ok : list[r].status === 'reviewing' ? p.warn : undefined) : undefined
  }), '', `  ${p.dim('编号只显示前 8 位；要看某份试卷请用完整 id（加 --json 可以看到）')}`, '']
}

function renderHelp(d: any, o: HumanOpts, p: Paint): string[] {
  const cmds: Array<{ command: string; summary: string }> = d.commands ?? []
  return ['', `  ${p.accent(p.bold('✦ 卷知'))} 命令行`, '', ...renderTable(['命令', '说明'], cmds.map(c => [`juanzhi ${c.command}`, c.summary]), { columns: o.columns, p }), '',
    `  ${p.dim('在终端里只输入 juanzhi 会打开交互界面；给程序 / Agent 调用请加 --json，输出一行 JSON')}`, '']
}

const scalar = (v: unknown): string => v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v)

/** 没有专门排版的命令：对象一行一项，对象数组画成表，其余照字面显示 */
function renderGeneric(data: unknown, o: HumanOpts, p: Paint, indent = 2, depth = 0): string[] {
  const sp = ' '.repeat(indent)
  if (Array.isArray(data)) {
    if (!data.length) return [`${sp}${p.dim('（空）')}`]
    if (data.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = [...new Set(data.flatMap(x => Object.keys(x)))].filter(k => data.every(x => x[k] === undefined || x[k] === null || typeof x[k] !== 'object')).slice(0, 7)
      if (keys.length) return renderTable(keys, data.map(x => keys.map(k => scalar(x[k]))), { columns: o.columns, p, indent })
    }
    return data.map(x => `${sp}· ${typeof x === 'object' ? JSON.stringify(x) : scalar(x)}`)
  }
  if (data && typeof data === 'object') {
    const out: string[] = []
    const entries = Object.entries(data as Record<string, unknown>)
    const w = Math.max(0, ...entries.filter(([, v]) => v === null || typeof v !== 'object').map(([k]) => textWidth(k)))
    for (const [k, v] of entries) {
      if (v !== null && typeof v === 'object') {
        out.push(`${sp}${p.bold(k)}`)
        out.push(...(depth >= 2 ? [`${sp}  ${JSON.stringify(v)}`] : renderGeneric(v, o, p, indent + 2, depth + 1)))
      } else out.push(`${sp}${p.dim(padEnd(k, w))}  ${scalar(v)}`)
    }
    return out
  }
  return [`${sp}${scalar(data)}`]
}

/** 成功 / 失败结果 → 终端里的文字（含结尾换行）。command = 命令名（'status'、'papers list'……） */
export function renderHuman(r: CliOk | CliFail, command: string, o: HumanOpts): string {
  const p = paint(o.color)
  let lines: string[]
  if (r.ok) {
    const d = r.data as any
    if (command === 'status' && d?.papers) lines = renderStatus(d, o, p)
    else if (command === 'papers list' && Array.isArray(d?.papers)) lines = renderPapers(d, o, p)
    else if (Array.isArray(d?.commands)) lines = renderHelp(d, o, p)
    else {
      const body = d && typeof d === 'object' && Object.keys(d).length ? renderGeneric(d, o, p) : []
      lines = ['', `  ${p.ok('✓')} ${command ? `${command} 完成` : '完成'}`, ...(body.length ? ['', ...body] : []), '']
    }
  } else {
    lines = ['', `  ${p.err('✗')} ${p.bold(r.message)}`]
    const hint = ERROR_HINTS[r.code]
    if (hint && !r.message.includes('Cmd+Q') && !r.message.startsWith('卷知正在处理任务')) lines.push(`    ${p.dim('→ ' + hint)}`)
    const papers = (r.data as any)?.papers
    if (Array.isArray(papers) && papers.length) {
      lines.push('', ...papers.map((x: any) => `    ${x.status === 'reviewing' || x.status === 'done' ? p.ok('✓') : p.err('✗')} ${x.title || x.file || ''}${x.error ? p.dim('  ' + x.error) : ''}`))
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}
