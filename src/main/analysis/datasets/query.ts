/**
 * 只读查询执行器。纯逻辑（node:sqlite + worker_threads），不依赖 electron。
 *
 * 防护分三层：
 *  1. checkSql：只放行单条 SELECT / WITH；拒绝 PRAGMA / ATTACH / 写语句 / 多语句（先去掉注释，再忽略引号里的内容检查关键字）。
 *  2. 数据集文件用 readOnly 打开；多个数据集用 ATTACH（由我们自己挂，别名 d1、d2……）。被挂载的库继承只读标志。
 *  3. 在 worker 线程里执行，超时就 terminate（node:sqlite 没有 progress handler / interrupt，做不到中途打断原生执行；
 *     超时后调用方立刻拿到「超时」结果，但个别病态查询的线程可能还会在后台把当前这一步算完）。结果最多返回 maxRows 行，
 *     另外继续数到 countCap 行再停，并注明是「至少」。
 */
import { Worker } from 'node:worker_threads'
import type { QueryResult } from '../types.ts'

export const QUERY_LIMITS = { rows: 500, countCap: 200_000, timeoutMs: 10_000, cellChars: 200 } as const

// ───────────────────────── SQL 检查 ─────────────────────────

export interface SqlCheck { ok: boolean; sql: string; message?: string }

const FORBIDDEN = ['pragma', 'attach', 'detach', 'insert', 'update', 'delete', 'drop', 'create', 'alter', 'vacuum', 'reindex', 'analyze', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'load_extension', 'truncate', 'upsert']

/** 扫一遍：去掉注释；把引号里的内容换成占位（用于检查关键字）。返回 [去注释后的原文, 占位版] */
function scan(sql: string): { clean: string; bare: string; unterminated: boolean } {
  let clean = '', bare = ''
  let i = 0
  const n = sql.length
  let unterminated = false
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; clean += ' '; bare += ' '; continue }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) { unterminated = true; i = n } else i = end + 2
      clean += ' '; bare += ' '; continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      let j = i + 1
      for (;;) {
        if (j >= n) { unterminated = true; break }
        if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue } break }
        j++
      }
      clean += sql.slice(i, Math.min(n, j + 1))
      bare += ch === "'" ? "''" : '"x"'
      i = j + 1
      continue
    }
    clean += ch; bare += ch; i++
  }
  return { clean, bare, unterminated }
}

export function checkSql(raw: string): SqlCheck {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, sql: '', message: 'SQL 是空的。' }
  if (text.length > 20000) return { ok: false, sql: '', message: 'SQL 太长了（超过 2 万字），请精简。' }
  const { clean, bare, unterminated } = scan(text)
  if (unterminated) return { ok: false, sql: '', message: 'SQL 里有没闭合的引号或注释，请检查。' }
  const b = bare.replace(/[\s;]+$/g, '').trim()
  const c = clean.replace(/[\s;]+$/g, '').trim()
  if (!b) return { ok: false, sql: '', message: 'SQL 是空的。' }
  if (b.includes(';')) return { ok: false, sql: '', message: '一次只能执行一条查询，请去掉多余的分号和语句。' }
  const first = /^[a-zA-Z]+/.exec(b)?.[0].toLowerCase()
  if (first !== 'select' && first !== 'with') return { ok: false, sql: '', message: '只能执行 SELECT（或 WITH … SELECT）查询，不能修改数据。' }
  const words = b.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []
  for (const w of words) {
    if (FORBIDDEN.includes(w)) return { ok: false, sql: '', message: `查询里不能出现 ${w.toUpperCase()}：这里只允许只读的 SELECT 查询。` }
  }
  // REPLACE 只能是函数 replace(...)，不能是 REPLACE INTO
  if (/\breplace\b(?!\s*\()/i.test(b)) return { ok: false, sql: '', message: '查询里不能出现 REPLACE 语句（replace() 函数可以用）。' }
  return { ok: true, sql: c }
}

// ───────────────────────── 白话错误 ─────────────────────────

export function plainSqlError(err: string): string {
  let m: RegExpExecArray | null
  if ((m = /no such table: (.+)/i.exec(err))) return `没有叫 ${m[1]} 的表。请对照「可用的表和列」，表名前要带数据集别名（如 d1.表名），名字用双引号括起来。`
  if ((m = /no such column: (.+)/i.exec(err))) return `没有叫 ${m[1]} 的列。请用内部列名（如 c03_年级），并确认这一列在查询用到的表里。`
  if (/ambiguous column name: (.+)/i.test(err)) return `列名有歧义：${/ambiguous column name: (.+)/i.exec(err)![1]}，请在列名前加表别名。`
  if (/syntax error|incomplete input/i.test(err)) return 'SQL 语法有误，请检查括号、逗号、引号和关键字。'
  if (/no such function/i.test(err)) return `用了不支持的函数：${err.replace(/^.*no such function: /i, '')}。SQLite 常用函数有 count/sum/avg/min/max/round/substr/instr/replace/strftime/date/group_concat。`
  if (/misuse of aggregate/i.test(err)) return '聚合函数（count/sum 等）用错了位置，筛选聚合结果要用 HAVING。'
  if (/readonly|read-only|attempt to write/i.test(err)) return '数据是只读的，不能修改。'
  if (/not authorized/i.test(err)) return '这条查询没有被允许。'
  if (/too many (columns|terms)/i.test(err)) return '查询太复杂了，请拆成几步。'
  return 'SQL 执行出错了，请根据原始错误信息改写。'
}

// ───────────────────────── 执行（worker） ─────────────────────────

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { files, sql, maxRows, countCap, cellChars } = workerData
const out = { ok: false, columns: [], rows: [], totalRows: 0, countCapped: false }
try {
  const db = new DatabaseSync(files[0], { readOnly: true })
  files.forEach((f, i) => { db.prepare('ATTACH DATABASE ? AS d' + (i + 1)).run(f) })
  db.exec('PRAGMA query_only = ON')
  const stmt = db.prepare(sql)
  stmt.setReturnArrays(true)
  stmt.setReadBigInts(true)
  out.columns = stmt.columns().map(c => c.name)
  const cell = v => {
    if (typeof v === 'bigint') { const n = Number(v); return Number.isSafeInteger(n) ? n : v.toString() }
    if (typeof v === 'string') return v.length > cellChars ? v.slice(0, cellChars) + '…' : v
    if (v instanceof Uint8Array) return '[二进制数据]'
    return v
  }
  let n = 0
  for (const row of stmt.iterate()) {
    n++
    if (n <= maxRows) out.rows.push(row.map(cell))
    else if (n >= countCap) { out.countCapped = true; break }
  }
  out.totalRows = n
  out.ok = true
  db.close()
} catch (e) {
  out.error = String(e && e.message ? e.message : e)
}
parentPort.postMessage(out)
`

export interface RunQueryOptions {
  /** 数据集 sqlite 文件，依次挂成 d1、d2……（第一个同时是 main） */
  files: string[]
  sql: string
  timeoutMs?: number
  maxRows?: number
  signal?: AbortSignal
}

/** 执行一条已通过 checkSql 的查询（这里会再检查一遍，直接调用也安全）。返回未经代号化的结果——调用方必须再过 toModel */
export async function runReadOnly(opts: RunQueryOptions): Promise<QueryResult> {
  const t0 = Date.now()
  const fail = (message: string, rawError?: string): QueryResult => ({ ok: false, columns: [], rows: [], returned: 0, totalRows: 0, truncated: false, message, rawError, elapsedMs: Date.now() - t0 })
  const chk = checkSql(opts.sql)
  if (!chk.ok) return fail(chk.message ?? 'SQL 不被允许。')
  if (!opts.files.length) return fail('没有选择数据集。')
  const timeoutMs = opts.timeoutMs ?? QUERY_LIMITS.timeoutMs
  const maxRows = opts.maxRows ?? QUERY_LIMITS.rows
  return new Promise<QueryResult>(resolve => {
    let done = false
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { files: opts.files, sql: chk.sql, maxRows, countCap: QUERY_LIMITS.countCap, cellChars: QUERY_LIMITS.cellChars } })
    const finish = (r: QueryResult) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); void worker.terminate(); resolve(r) }
    const timer = setTimeout(() => finish(fail(`查询超过 ${Math.round(timeoutMs / 1000)} 秒还没算完，已放弃。请加筛选条件、减少关联的表，或先分组汇总再查。`, 'timeout')), timeoutMs)
    const onAbort = () => finish(fail('查询已取消。', 'aborted'))
    opts.signal?.addEventListener('abort', onAbort)
    worker.on('message', (m: { ok: boolean; columns: string[]; rows: unknown[][]; totalRows: number; countCapped: boolean; error?: string }) => {
      if (!m.ok) return finish(fail(plainSqlError(m.error ?? ''), m.error))
      const truncated = m.totalRows > m.rows.length
      finish({
        ok: true, columns: m.columns, rows: m.rows, returned: m.rows.length, totalRows: m.totalRows, countCapped: m.countCapped || undefined, truncated, elapsedMs: Date.now() - t0,
        message: truncated ? `共 ${m.countCapped ? '至少 ' : ''}${m.totalRows} 行，只返回前 ${m.rows.length} 行；需要全部请加汇总或筛选。` : undefined
      })
    })
    worker.on('error', e => finish(fail('查询执行失败。', String(e && e.message ? e.message : e))))
    worker.on('exit', () => { if (!done) finish(fail('查询意外中断。', 'worker exit')) })
  })
}
