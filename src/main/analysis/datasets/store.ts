/**
 * 数据集仓库：导入、目录（catalog.json）、概况、敏感列与代号、只读查询、派生列。
 * 纯 Node（node:sqlite / node:fs），不依赖 electron；数据目录由调用方传入（测试注入临时目录）。
 *
 * 存储布局（<数据目录>/datasets/）：
 *   catalog.json            所有数据集的元信息（id、名称、来源、各表行数、列信息、备注、敏感标记）
 *   <uuid>.sqlite           数据本体（每个数据表一张表，_row 为行号；多选列有「长表」视图；派生列在 <表>__derived）
 *   <uuid>.codes.json       代号映射表（只存本机，不在 sqlite 里，模型的查询碰不到）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readTable, CourseFileError } from '../../course/table-read.ts'
import type { ColumnInfo, ColumnType, DatasetMeta, ImportProgress, QueryResult, SensitiveKind, TableInfo } from '../types.ts'
import { convertCell, detectHeader, inferType, internalColumnName, internalTableName, sanitizeIdent, sqlTypeOf, splitMulti } from './infer.ts'
import { buildProfile, profileLine, tableProfileText } from './profile.ts'
import { Codebook, detectSensitive } from './sensitive.ts'
import { QUERY_LIMITS, checkSql, runReadOnly } from './query.ts'
import { scrubPII } from '../scrub.ts'

export const IMPORT_LIMITS = { rows: 500_000, bytes: 200 * 1024 * 1024, cols: 200, sheets: 30 }   // 单测会临时调小
const BATCH = 2000

/** 白话错误：message 可以直接给用户 / 模型看 */
export class DatasetError extends Error {}

const q = (id: string) => '"' + id.replace(/"/g, '""') + '"'
const tick = () => new Promise<void>(r => setImmediate(r))
const norm = (s: string) => s.trim().toLowerCase()

interface Hit { ds: string; kind: SensitiveKind }
/** map：全部敏感原值 → 归属；names：其中的人名（长度 2–12）；nameLens / nameFirst 用来在自由文本里滑窗查找 */
interface Index { map: Map<string, Hit>; names: Set<string>; nameLens: number[]; nameFirst: Set<string> }

export class DatasetStore {
  readonly dir: string
  private cache: DatasetMeta[] | null = null
  private books = new Map<string, Codebook>()
  private indexes = new Map<string, Index>()

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'datasets')
  }

  // ───────────── 目录 ─────────────

  private catalogFile() { return path.join(this.dir, 'catalog.json') }
  private dbFile(id: string) { return path.join(this.dir, `${id}.sqlite`) }
  private load(): DatasetMeta[] {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(fs.readFileSync(this.catalogFile(), 'utf8'))
      this.cache = Array.isArray(raw?.datasets) ? raw.datasets : []
    } catch { this.cache = [] }
    return this.cache!
  }
  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.catalogFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, datasets: this.load() }, null, 1))
    fs.renameSync(tmp, this.catalogFile())
  }
  private book(id: string): Codebook {
    let b = this.books.get(id)
    if (!b) { b = new Codebook(path.join(this.dir, `${id}.codes.json`)); this.books.set(id, b) }
    return b
  }

  list(): DatasetMeta[] { return this.load().slice().sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)) }
  find(id: string): DatasetMeta | undefined { return this.load().find(d => d.id === id) }
  get(id: string): DatasetMeta {
    const d = this.find(id)
    if (!d) throw new DatasetError('没有找到这个数据集，可能已被删除。')
    return d
  }
  tableOf(d: DatasetMeta, table?: string): TableInfo {
    if (!table) { if (d.tables.length === 1) return d.tables[0]; throw new DatasetError(`这个数据集有多张表（${d.tables.map(t => t.name).join('、')}），请指定表名。`) }
    const t = d.tables.find(x => x.name === table || x.sheet === table)
    if (!t) throw new DatasetError(`数据集里没有叫「${table}」的表。可用的表：${d.tables.map(x => x.name).join('、')}`)
    return t
  }
  private columnOf(t: TableInfo, col: string): ColumnInfo {
    const c = t.columns.find(x => x.name === col) ?? t.columns.find(x => x.label === col) ?? t.columns.find(x => norm(x.label) === norm(col))
    if (!c) throw new DatasetError(`表 ${t.name} 里没有叫「${col}」的列。`)
    return c
  }

  remove(id: string): boolean {
    const d = this.find(id)
    if (!d) return false
    for (const f of [this.dbFile(id), this.dbFile(id) + '-journal', path.join(this.dir, `${id}.codes.json`)]) fs.rmSync(f, { force: true })
    this.cache = this.load().filter(x => x.id !== id)
    this.books.delete(id)
    this.dropIndex(id)
    this.save()
    return true
  }
  rename(id: string, name: string): void {
    const n = name.trim().slice(0, 60)
    if (!n) throw new DatasetError('名称不能为空。')
    this.get(id).name = n
    this.save()
  }
  setNote(id: string, note: string): void { this.get(id).note = note.slice(0, 2000); this.save() }

  setSensitive(id: string, table: string, column: string, sensitive: boolean, kind?: SensitiveKind): void {
    const c = this.columnOf(this.tableOf(this.get(id), table), column)
    c.sensitive = sensitive
    c.sensitiveAuto = false
    if (sensitive) c.sensitiveKind = kind ?? c.sensitiveKind ?? 'other'
    else delete c.sensitiveKind
    this.dropIndex(id)
    this.save()
  }

  // ───────────── 导入 ─────────────

  async importFile(filePath: string, opts: { name?: string; onProgress?: (p: ImportProgress) => void } = {}): Promise<DatasetMeta> {
    let st: fs.Stats
    try { st = fs.statSync(filePath) } catch { throw new DatasetError('这个文件读不了，可能已被移动或删除。') }
    if (st.size > IMPORT_LIMITS.bytes) throw new DatasetError(`文件有 ${Math.round(st.size / 1048576)} MB，超过 200 MB 的上限。请拆成几个文件，或先删掉用不到的列和工作表。`)
    return this.importBuffer(fs.readFileSync(filePath), path.basename(filePath), opts)
  }

  async importBuffer(buf: Uint8Array, fileName: string, opts: { name?: string; onProgress?: (p: ImportProgress) => void } = {}): Promise<DatasetMeta> {
    const emit = (p: Omit<ImportProgress, 'fileName'>) => opts.onProgress?.({ fileName, ...p })
    if (buf.length > IMPORT_LIMITS.bytes) throw new DatasetError('文件超过 200 MB 的上限。请拆成几个文件，或先删掉用不到的列和工作表。')
    const ext = (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] ?? '').toLowerCase()
    if (ext === 'xls') throw new DatasetError('这是旧版 Excel 格式（.xls），请用 Excel 或 WPS 打开后「另存为」.xlsx 或 CSV 再导入。')
    if (!['xlsx', 'xlsm', 'csv', 'tsv', 'txt'].includes(ext)) throw new DatasetError('只支持 Excel（.xlsx）和 CSV 文件。')
    emit({ phase: 'read', done: 0, total: 1, message: '正在读取文件…' })
    await tick()
    let tr
    try {
      tr = await readTable(buf, fileName, {
        rows: IMPORT_LIMITS.rows + 20, cols: IMPORT_LIMITS.cols, label: '表格',
        entryBytes: IMPORT_LIMITS.bytes, totalBytes: IMPORT_LIMITS.bytes * 2, sharedStrings: 6_000_000, sharedChars: 400_000_000
      })
    } catch (e) {
      if (e instanceof CourseFileError) throw new DatasetError(e.message)
      throw e
    }
    const sheets = tr.sheets.filter(s => !s.hidden && s.rows.length).slice(0, IMPORT_LIMITS.sheets)
    if (!sheets.length) throw new DatasetError('这个文件里没有读到任何数据。')
    const id = crypto.randomUUID()
    fs.mkdirSync(this.dir, { recursive: true })
    const part = this.dbFile(id) + '.part'
    const finalFile = this.dbFile(id)
    const usedNames = new Set<string>()
    const tables: TableInfo[] = []
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(part)
      db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF')
      let sheetNo = 0
      for (const sh of sheets) {
        sheetNo++
        const built = this.buildTable(sh.name, sh.rows, sh.mergedFilled, usedNames, ext === 'csv' || ext === 'tsv' || ext === 'txt')
        if (!built) continue
        const { info, cols } = built
        await this.writeTable(db, info, cols.map(c => c.values), p => emit({ phase: 'write', sheet: sh.name, done: p, total: info.rows, message: `正在写入「${sh.name}」（${sheetNo}/${sheets.length}）：${p}/${info.rows} 行` }))
        tables.push(info)
      }
      if (!tables.length) throw new DatasetError('这个文件里没有读到任何数据行（只有表头或全是空行）。')
      db.close(); db = null
      fs.renameSync(part, finalFile)
    } catch (e) {
      try { db?.close() } catch { /* 忽略 */ }
      fs.rmSync(part, { force: true })
      throw e
    }
    const meta: DatasetMeta = {
      id, name: (opts.name ?? fileName.replace(/\.[^.]+$/, '')).trim().slice(0, 60) || '数据集', sourceFile: fileName, importedAt: new Date().toISOString(),
      note: '', sizeBytes: fs.statSync(finalFile).size, tables
    }
    this.load().push(meta)
    this.save()
    if (tr.warnings.length) for (const t of tables) t.notes.push(...tr.warnings.filter(w => w.includes(t.sheet)).slice(0, 2))
    this.save()
    emit({ phase: 'done', done: 1, total: 1, message: `已导入 ${tables.length} 张表，共 ${tables.reduce((a, t) => a + t.rows, 0)} 行` })
    return meta
  }

  /** 把一张二维文字表整理成「表信息 + 各列已转换的值」。没有数据行返回 null */
  private buildTable(sheet: string, rows: string[][], merged: boolean, used: Set<string>, isCsv: boolean): { info: TableInfo; cols: Array<{ col: ColumnInfo; values: Array<string | number | null> }> } | null {
    const hi = detectHeader(rows)
    const notes: string[] = []
    const dataRaw = rows.slice(hi + 1).filter(r => r.some(c => c !== ''))
    if (!dataRaw.length) return null
    if (dataRaw.length > IMPORT_LIMITS.rows) throw new DatasetError(`「${sheet}」有超过 50 万行，超过上限。请拆成几个文件，或先按时间 / 班级筛一部分再导入。`)
    if (hi > 0) notes.push(`前 ${hi} 行是标题或空行，已跳过`)
    if (hi < 0) notes.push('没有找到表头，列名按位置自动生成（列1、列2……）')
    if (merged) notes.push('有合并单元格，已按左上角的内容填充')
    const width = Math.max(...rows.slice(0, hi + 1 + 1).map(r => r.length), ...dataRaw.slice(0, 2000).map(r => r.length))
    const header = hi >= 0 ? rows[hi] : []
    const keep: number[] = []
    for (let j = 0; j < width; j++) {
      let any = false
      for (const r of dataRaw) if ((r[j] ?? '') !== '') { any = true; break }
      if (any) keep.push(j)
    }
    if (!keep.length) return null
    const dropped = width - keep.length
    if (dropped > 0 && header.some((h, j) => h && !keep.includes(j))) notes.push('全空的列已忽略')
    const seen = new Map<string, number>()
    const tname = internalTableName(sheet || (isCsv ? '数据' : '表'), used)
    const cols: Array<{ col: ColumnInfo; values: Array<string | number | null> }> = []
    const views: TableInfo['views'] = []
    keep.forEach((j, idx) => {
      let label = (header[j] ?? '').trim() || `列${j + 1}`
      const k = norm(label)
      const c = (seen.get(k) ?? 0) + 1
      seen.set(k, c)
      if (c > 1) label = `${label}_${c}`
      const raw = dataRaw.map(r => r[j] ?? '')
      const nonEmpty = raw.filter(v => v !== '')
      const inf = inferType(nonEmpty)
      const values = raw.map(v => convertCell(inf.type, v))
      const profile = buildProfile(label, inf.type, values, inf.multi)
      const col: ColumnInfo = { name: internalColumnName(idx, label), label, type: inf.type, sqlType: sqlTypeOf(inf.type), sensitive: false, sensitiveAuto: true, profile }
      const sample: string[] = []
      const stride = Math.max(1, Math.floor(nonEmpty.length / 3000))
      for (let i = 0; i < nonEmpty.length; i += stride) sample.push(nonEmpty[i])
      const g = detectSensitive(label, inf.type, profile, sample)
      if (g) { col.sensitive = true; col.sensitiveKind = g.kind; col.profile.examples = [] }
      if (inf.type === 'multi') views.push({ column: col.name, view: `${tname}__${sanitizeIdent(label, 16)}_选项${views.length ? views.length + 1 : ''}` })
      cols.push({ col, values })
    })
    const info: TableInfo = { name: tname, sheet, rows: dataRaw.length, headerRow: hi < 0 ? 0 : hi + 1, columns: cols.map(c => c.col), views, notes }
    return { info, cols }
  }

  private async writeTable(db: DatabaseSync, info: TableInfo, columns: Array<Array<string | number | null>>, onRows: (n: number) => void): Promise<void> {
    const colDefs = info.columns.map(c => `${q(c.name)} ${c.sqlType}`).join(', ')
    db.exec(`CREATE TABLE ${q(info.name)} (_row INTEGER PRIMARY KEY, ${colDefs})`)
    const names = ['_row', ...info.columns.map(c => q(c.name))]
    const stmt = db.prepare(`INSERT INTO ${q(info.name)} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    const n = info.rows
    for (let start = 0; start < n; start += BATCH) {
      db.exec('BEGIN')
      const end = Math.min(n, start + BATCH)
      for (let i = start; i < end; i++) {
        const params: Array<string | number | null> = [i + 1]
        for (const col of columns) params.push(col[i] ?? null)
        stmt.run(...params)
      }
      db.exec('COMMIT')
      onRows(end)
      await tick()
    }
    for (const v of info.views) {
      const c = info.columns.find(x => x.name === v.column)!
      const seps = c.profile.multi?.separators ?? []
      const lit = (s: string) => (s === '\n' ? 'char(10)' : `'${s.replace(/'/g, "''")}'`)
      const main = seps[0] ?? '┋'
      let expr = q(c.name)
      for (const s of seps.slice(1)) expr = `replace(${expr}, ${lit(s)}, ${lit(main)})`
      db.exec(`CREATE VIEW ${q(v.view)} AS WITH RECURSIVE s(_row, rest, item) AS (
        SELECT _row, ${expr} || ${lit(main)}, '' FROM ${q(info.name)} WHERE ${q(c.name)} IS NOT NULL AND ${q(c.name)} <> ''
        UNION ALL
        SELECT _row, substr(rest, instr(rest, ${lit(main)}) + 1), trim(substr(rest, 1, instr(rest, ${lit(main)}) - 1)) FROM s WHERE rest <> ''
      ) SELECT _row, item AS "选项" FROM s WHERE item <> ''`)
    }
  }

  // ───────────── 概况 / 预览 / 取值 ─────────────

  private openRead(id: string): DatabaseSync {
    this.get(id)
    return new DatabaseSync(this.dbFile(id), { readOnly: true })
  }

  /** 界面预览：前 limit 行，原值（含真名）。只给界面用，不可发给模型 */
  preview(id: string, table: string, limit = 100): { columns: Array<{ name: string; label: string; type: ColumnType; sensitive: boolean }>; rows: unknown[][]; total: number } {
    const t = this.tableOf(this.get(id), table)
    const db = this.openRead(id)
    try {
      const view = t.derivedView && t.columns.some(c => c.derived) ? t.derivedView : t.name
      const all = t.columns
      const sel = all.map(c => q(c.name)).join(',')
      const stmt = db.prepare(`SELECT ${sel} FROM ${q(view)} ORDER BY _row LIMIT ?`)
      stmt.setReturnArrays(true)
      const rows = (stmt.all(Math.min(Math.max(1, limit), 500)) as unknown as unknown[][]).map(r => r.map(v => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? '[二进制]' : v)))
      return { columns: all.map(c => ({ name: c.name, label: c.label, type: c.type, sensitive: c.sensitive })), rows, total: t.rows }
    } finally { db.close() }
  }

  /** 给模型的概况文本（每列一行，敏感列取值已代号化） */
  profileText(id: string, table?: string): string {
    const d = this.get(id)
    const tables = table ? [this.tableOf(d, table)] : d.tables
    const book = this.book(id)
    const m = this.model([id])
    const safe = (x: string) => scrubPII(m.text(x))
    const text = tables.map(t => tableProfileText(t, (c, v) => (c.sensitive ? book.code(c.sensitiveKind ?? 'other', v) : safe(v)), safe)).join('\n\n')
    book.flush(); m.flush()
    return `数据集「${safe(d.name)}」（来源 ${safe(d.sourceFile)}，${d.tables.length} 张表）\n${d.note ? '用户备注：' + safe(d.note) + '\n' : ''}${text}`
  }

  /** 单列的取值分布（已代号化）。多选列按选项统计 */
  columnValues(id: string, table: string, column: string, limit = 30): { column: string; label: string; type: ColumnType; totalNonNull: number; values: Array<{ value: string; count: number }> } {
    const d = this.get(id)
    const t = this.tableOf(d, table)
    const c = this.columnOf(t, column)
    const db = this.openRead(id)
    try {
      const lim = Math.min(Math.max(1, Math.floor(limit)), 200)
      const view = t.derivedView && c.derived ? t.derivedView : t.name
      let rows: Array<{ v: unknown; n: number | bigint }>
      if (c.type === 'multi') {
        const vw = t.views.find(x => x.column === c.name)!.view
        rows = db.prepare(`SELECT "选项" AS v, count(*) AS n FROM ${q(vw)} GROUP BY "选项" ORDER BY n DESC, v LIMIT ?`).all(lim) as never
      } else {
        rows = db.prepare(`SELECT ${q(c.name)} AS v, count(*) AS n FROM ${q(view)} WHERE ${q(c.name)} IS NOT NULL GROUP BY ${q(c.name)} ORDER BY n DESC, v LIMIT ?`).all(lim) as never
      }
      const book = this.book(id)
      const m = this.model([id])
      const values = rows.map(r => ({ value: c.sensitive ? book.code(c.sensitiveKind ?? 'other', String(r.v)) : scrubPII(m.text(String(r.v))), count: Number(r.n) }))
      m.flush()
      book.flush()
      return { column: c.name, label: c.label, type: c.type, totalNonNull: c.profile.nonNull, values }
    } finally { db.close() }
  }

  // ───────────── 代号 ─────────────

  private dropIndex(id: string) { for (const k of [...this.indexes.keys()]) if (k.startsWith(id + ':')) this.indexes.delete(k) }

  private sensIndex(d: DatasetMeta): Index {
    const sig = d.tables.map(t => t.columns.filter(c => c.sensitive).map(c => `${t.name}.${c.name}:${c.sensitiveKind}`).join(',')).join('|')
    const key = `${d.id}:${sig}`
    const hit = this.indexes.get(key)
    if (hit) return hit
    this.dropIndex(d.id)
    const map: Index['map'] = new Map()
    const sens = d.tables.flatMap(t => t.columns.filter(c => c.sensitive && !c.derived).map(c => ({ t, c })))
    if (sens.length) {
      const db = this.openRead(d.id)
      try {
        for (const { t, c } of sens) {
          for (const r of db.prepare(`SELECT DISTINCT ${q(c.name)} AS v FROM ${q(t.name)} WHERE ${q(c.name)} IS NOT NULL`).iterate() as Iterable<{ v: unknown }>) {
            const s = String(r.v)
            if (s && !map.has(s)) map.set(s, { ds: d.id, kind: c.sensitiveKind ?? 'other' })
            if (map.size > 1_500_000) break
          }
        }
      } finally { db.close() }
    }
    const names = new Set<string>(), lens = new Set<number>(), first = new Set<string>()
    for (const [v, h] of map) if (h.kind === 'person' && v.length >= 2 && v.length <= 12) { names.add(v); lens.add(v.length); first.add(v[0]) }
    const idx: Index = { map, names, nameLens: [...lens].sort((x, y) => y - x), nameFirst: first }
    this.indexes.set(key, idx)
    return idx
  }

  /**
   * 准备一次「发给模型前的代号化」：索引、列名表、查表函数只建一次，之后可对很多格子 / 很多句子反复用。
   * 规则（任一）：结果列名就是敏感列的内部名 / 显示名；整格等于某个敏感值（数字也按值查表）；整列几乎都是敏感值（别名后的编号列，
   * 数字列要求有长值，避免 sum / avg 的结果碰巧等于某个短编号）；自由文本里夹着人名（按字滑窗查人名集合）、编号 / 手机号 / 邮箱 / 身份证号（分词后查表）。
   * 只有「计数类」列名（count、人数、数量……）里的数字免于按值查表。
   */
  private model(datasetIds: string[]) {
    const metas = datasetIds.map(i => this.get(i))
    const idx = metas.map(m => ({ m, ix: this.sensIndex(m) }))
    const named = new Map<string, Hit>()
    for (const m of metas) for (const t of m.tables) for (const c of t.columns) if (c.sensitive) {
      const v: Hit = { ds: m.id, kind: c.sensitiveKind ?? 'other' as SensitiveKind }
      named.set(norm(c.name), v); named.set(norm(c.label), v)
    }
    const lookup = (s: string): Hit | undefined => { for (const { ix } of idx) { const h = ix.map.get(s); if (h) return h } return undefined }
    const memo = new Map<string, string>()
    const TOKEN = /[0-9A-Za-z_.@+\-]{4,}/g
    const isLatin = (ch: string | undefined) => !!ch && /[A-Za-z]/.test(ch)
    const scanText = (s: string): string => {
      const hit = memo.get(s)
      if (hit !== undefined) return hit
      let t = s
      for (const { m, ix } of idx) {
        const b = this.book(m.id)
        if (ix.map.size && /[0-9A-Za-z]{4}/.test(t)) {
          t = t.replace(TOKEN, tok => {
            let h = ix.map.get(tok)
            if (h) return b.code(h.kind, tok)
            const core = tok.replace(/[.\-_]+$/, '')
            h = core !== tok ? ix.map.get(core) : undefined
            return h ? b.code(h.kind, core) + tok.slice(core.length) : tok
          })
        }
        if (ix.names.size) {
          const n = t.length
          let out = '', last = 0, i = 0
          while (i < n) {
            if (!ix.nameFirst.has(t[i])) { i++; continue }
            let got = 0
            for (const len of ix.nameLens) {
              if (i + len > n) continue
              if (!ix.names.has(t.substr(i, len))) continue
              if ((isLatin(t[i]) && isLatin(t[i - 1])) || (isLatin(t[i + len - 1]) && isLatin(t[i + len]))) continue   // 英文名别从单词中间切
              got = len; break
            }
            if (got) { out += t.slice(last, i) + b.code('person', t.substr(i, got)); i += got; last = i } else i++
          }
          if (last) t = out + t.slice(last)
        }
      }
      if (memo.size < 100_000) memo.set(s, t)
      return t
    }
    /** 一段文字（名称、文件名、列标签、错误信息……）：整串查表 + 滑窗 + 分词 */
    const text = (v: string): string => {
      if (!v) return v
      const h = lookup(v)
      return h ? this.book(h.ds).code(h.kind, v) : scanText(v)
    }
    const flush = () => { for (const m of metas) this.book(m.id).flush() }
    return { metas, named, lookup, text, flush }
  }

  /** 发给模型之前必须过这一道：把查询结果里的敏感值换成稳定代号 */
  toModel(datasetIds: string[], columns: string[], rows: unknown[][]): unknown[][] {
    const { named, lookup, text, flush } = this.model(datasetIds)
    const COUNT_NAME = /^(count|cnt|n|num|nums|_{0,2}row(id)?|__rowid)$|count\s*\(|^count|人数|条数|个数|数量|行数|次数|计数|频次|记录数/i
    const isCount = columns.map(c => COUNT_NAME.test(c))
    const colMode = columns.map((name, j) => {
      const byName = named.get(norm(name))
      if (byName) return byName
      if (isCount[j]) return undefined
      let nn = 0, hit = 0, firstHit: Hit | undefined, longHit = false, allStr = true
      for (const r of rows) {
        const v = r[j]
        if (v === null || v === undefined || v === '') continue
        nn++
        const sv = String(v)
        const h = lookup(sv)
        if (h) { hit++; firstHit ??= h; if (sv.length >= 6) longHit = true; if (typeof v !== 'string') allStr = false }
      }
      return nn > 0 && hit / nn >= 0.9 && (longHit || (nn >= 3 && allStr)) ? firstHit : undefined
    })
    const out = rows.map(r => r.map((v, j) => {
      if (v === null || v === undefined || v === '') return v
      const mode = colMode[j]
      if (mode) return this.book(mode.ds).code(mode.kind, String(v))
      if (typeof v !== 'string') {
        if (isCount[j] || (typeof v !== 'number' && typeof v !== 'bigint')) return v
        const sv = String(v)
        if (sv.length < 6) return v   // 短数字（评分、小编号）不按值认，免得误伤统计结果；整列是短编号时靠列名 / 整列投票
        const h = lookup(sv)
        return h ? this.book(h.ds).code(h.kind, sv) : v
      }
      return text(v)
    }))
    flush()
    return out
  }

  /** 给模型看的任意文字（数据集名、来源文件、表名、sheet 名、列标签、错误信息）：敏感值代号化 + 去掉手机号 / 身份证号 / 邮箱等 */
  safeText(datasetIds: string[], s: string): string {
    const m = this.model(datasetIds)
    const r = scrubPII(m.text(String(s ?? '')))
    m.flush()
    return r
  }

  /** 模型回答里的代号换回真名（界面显示用） */
  fromModel(datasetIds: string[], text: string, esc?: (s: string) => string): string {
    let t = text
    for (const id of datasetIds) {
      if (!this.find(id)) continue
      const b = this.book(id)
      t = esc ? b.decode(t, esc) : b.decode(t)
    }
    return t
  }

  // ───────────── 查询 ─────────────

  /** 「可用的表和列」说明，给模型写 SQL 用。表名前带别名 d1、d2…… */
  schemaText(datasetIds: string[]): string {
    const m = this.model(datasetIds)
    const sf = (x: string) => scrubPII(m.text(x))
    const lines: string[] = ['可用的表和列（SQLite；表名、列名一律用双引号括起来，表名前带数据集别名；每张表都有行号列 _row）：']
    datasetIds.forEach((id, i) => {
      const d = this.get(id)
      const al = `d${i + 1}`
      lines.push(`\n数据集 ${al}「${sf(d.name)}」${d.note ? '（备注：' + sf(d.note) + '）' : ''}`)
      for (const t of d.tables) {
        lines.push(`表 ${al}.${q(sf(t.name))}（${t.rows} 行，来自「${sf(t.sheet)}」）`)
        for (const c of t.columns) {
          const typ = { integer: '整数', real: '小数', date: '日期(文本YYYY-MM-DD)', datetime: '日期时间(文本)', boolean: '是否(0/1)', text: '文本', select: '选项文本', multi: '多选文本' }[c.type]
          lines.push(`  ${q(sf(c.name))}  ${sf(c.label)}  ${typ}${c.sensitive ? '  敏感，取值为代号' : ''}${c.derived ? '  派生列' : ''}`)
        }
        for (const v of t.views) lines.push(`  视图 ${al}.${q(sf(v.view))}：多选列 ${sf(v.column)} 拆成一个选项一行 (_row, "选项")，用 _row 关联回原表`)
        if (t.derivedView) lines.push(`  视图 ${al}.${q(sf(t.derivedView))}：原表 + 派生列（文字归类等结果）`)
      }
    })
    m.flush()
    return lines.join('\n')
  }

  /** 执行模型写的只读 SQL：先把 SQL 里的代号还原成原值，执行，结果再代号化 */
  async runQuery(sql: string, datasetIds: string[], opts: { signal?: AbortSignal; timeoutMs?: number; maxRows?: number } = {}): Promise<QueryResult & { schema?: string; total?: number }> {
    if (!datasetIds.length) return { ok: false, columns: [], rows: [], returned: 0, totalRows: 0, truncated: false, message: '请指定要查询的数据集。', elapsedMs: 0 }
    const metas = datasetIds.map(i => this.get(i))
    const decoded = this.fromModel(datasetIds, sql, s => s.replace(/'/g, "''"))
    const chk = checkSql(decoded)
    if (!chk.ok) return { ok: false, columns: [], rows: [], returned: 0, totalRows: 0, truncated: false, message: chk.message, elapsedMs: 0 }
    const r = await runReadOnly({ files: metas.map(m => this.dbFile(m.id)), sql: chk.sql, signal: opts.signal, timeoutMs: opts.timeoutMs, maxRows: opts.maxRows })
    if (!r.ok) {
      // 给模型的只有白话错误（先代号化 + 去个人信息）和一小段处理过的原始错误；原始 rawError 不外传
      const { rawError, ...rest } = r
      const m = this.model(datasetIds)
      const safe = (x: string) => scrubPII(m.text(x))
      const detail = rawError && rawError !== 'timeout' && rawError !== 'aborted' ? safe(rawError).slice(0, 160) : undefined
      const message = safe(r.message ?? '')
      m.flush()
      return { ...rest, message, detail, schema: /没有叫|语法有误/.test(r.message ?? '') ? this.schemaText(datasetIds) : undefined }
    }
    return { ...r, total: r.totalRows, rows: this.toModel(datasetIds, r.columns, r.rows) }
  }

  // ───────────── 派生列 ─────────────

  /**
   * 把一列新值（例如文字归类的结果）写回某张表。values[i] 对应第 i+1 行（_row = i+1），长度必须等于表的行数。
   * 存进 <表>__derived，并建视图 <表>__all（原表 + 派生列）。同名再写会覆盖。返回内部列名。
   */
  /**
   * 统计模块的签名：按 rowid 给值（rowid 就是 _row，表是普通 rowid 表，SELECT rowid 可用）。缺的行为空。
   * 返回内部列名（可直接写进 SQL）和显示名。
   */
  addDerivedRows(opts: { datasetId: string; table: string; columnName: string; rows: Array<{ rowid: number; value: string | number | boolean | null }>; note?: string }): { columnName: string; label: string } {
    const t = this.tableOf(this.get(opts.datasetId), opts.table)
    const values: Array<string | number | boolean | null> = new Array(t.rows).fill(null)
    for (const r of opts.rows) {
      if (!Number.isInteger(r.rowid) || r.rowid < 1 || r.rowid > t.rows) throw new DatasetError(`行号 ${r.rowid} 超出范围（1–${t.rows}）。`)
      values[r.rowid - 1] = r.value
    }
    const columnName = this.addDerivedColumn(opts.datasetId, opts.table, opts.columnName, values)
    return { columnName, label: opts.columnName.trim().slice(0, 40) }
  }

  addDerivedColumn(datasetId: string, table: string, name: string, values: Array<string | number | boolean | null>): string {
    const d = this.get(datasetId)
    const t = this.tableOf(d, table)
    if (values.length !== t.rows) throw new DatasetError(`派生列需要 ${t.rows} 个值（每行一个），实际给了 ${values.length} 个。`)
    const label = name.trim().slice(0, 40)
    if (!label) throw new DatasetError('派生列需要一个名字。')
    const existing = t.columns.find(c => c.derived && c.label === label)
    const internal = existing?.name ?? `d${String(t.columns.filter(c => c.derived).length + 1).padStart(2, '0')}_${sanitizeIdent(label)}`
    const conv = values.map(v => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))
    const allNum = conv.every(v => v === null || typeof v === 'number')
    const type: ColumnType = allNum ? (conv.every(v => v === null || Number.isInteger(v)) ? 'integer' : 'real') : new Set(conv.filter(v => v !== null)).size <= 30 ? 'select' : 'text'
    const sqlType = sqlTypeOf(type)
    const derivedTable = `${t.name}__derived`
    const viewName = `${t.name}__all`
    const db = new DatabaseSync(this.dbFile(datasetId))
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec(`CREATE TABLE IF NOT EXISTS ${q(derivedTable)} (_row INTEGER PRIMARY KEY)`)
      if (!existing) db.exec(`ALTER TABLE ${q(derivedTable)} ADD COLUMN ${q(internal)} ${sqlType}`)
      db.exec('BEGIN')
      const stmt = db.prepare(`INSERT INTO ${q(derivedTable)} (_row, ${q(internal)}) VALUES (?, ?) ON CONFLICT(_row) DO UPDATE SET ${q(internal)} = excluded.${q(internal)}`)
      conv.forEach((v, i) => stmt.run(i + 1, v as string | number | null))
      db.exec('COMMIT')
      const dcols = [...t.columns.filter(c => c.derived).map(c => c.name), ...(existing ? [] : [internal])]
      db.exec(`DROP VIEW IF EXISTS ${q(viewName)}`)
      db.exec(`CREATE VIEW ${q(viewName)} AS SELECT m.*, ${dcols.map(c => `x.${q(c)}`).join(', ')} FROM ${q(t.name)} m LEFT JOIN ${q(derivedTable)} x ON x._row = m._row`)
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 没有事务 */ }
      throw e
    } finally { db.close() }
    const profile = buildProfile(label, type, conv as Array<string | number | null>)
    if (existing) { existing.type = type; existing.sqlType = sqlType; existing.profile = profile }
    else t.columns.push({ name: internal, label, type, sqlType, sensitive: false, sensitiveAuto: false, derived: true, profile })
    t.derivedTable = derivedTable
    t.derivedView = viewName
    d.sizeBytes = fs.statSync(this.dbFile(datasetId)).size
    this.save()
    return internal
  }
}

export { QUERY_LIMITS, profileLine, splitMulti }
