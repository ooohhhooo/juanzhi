/**
 * 数据包里的「额外内容」（extras/）：数据页的表格和文档、助手的 Skill 和角色。这些东西不在主库里，是数据目录下的文件。
 * 隐私规矩：
 *  · 表格：敏感列（姓名、手机号、编号……）的值在副本里换成代号，文字列里夹着的真名也换掉；代号对照表（<id>.codes.json）永远不进包；
 *  · 文档、Skill、角色：正文过一遍代号化（按本机数据页表格里出现过的姓名换成代号）并去掉手机号、身份证号、邮箱等。
 *    文档里出现、但数据页表格里没有的姓名无法识别——所以文档默认不勾选，界面上会提醒。
 * 导入端把包里的东西当不可信输入逐项校验；同 id / 同名的保持本机的（合并方式），覆盖导入对这几类也是合并方式。
 * 纯 Node（不依赖 electron），单测直接加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatasetStore } from '../analysis/datasets/store.ts'
import { DocumentStore, DOC_MAX_CHARS } from '../analysis/documents.ts'
import type { DocEntry, DocKind } from '../analysis/documents.ts'
import { readPlaybookFiles, userPlaybookDir } from '../agent/playbooks/store.ts'
import { parsePlaybook } from '../agent/playbooks/parse.ts'
import { CustomRoleSchema, ROLE_FILE_FORMAT, readCustomRoles, saveCustomRole } from '../agent/custom-roles.ts'
import { asContentSubject } from '../../shared/classify.ts'
import { UUID_RE } from './names.ts'

export interface ExtrasDeps { dataDir: string; datasets: DatasetStore; documents: DocumentStore }
export interface ExtrasCounts { datasets: number; documents: number; skills: number; roles: number }
export interface ExtraItem { abs: string; name: string; size: number }

const rolesDir = (dataDir: string) => path.join(dataDir, 'agent-roles')
const inSubject = (subject: string, s: unknown) => subject === 'all' || asContentSubject(s) === 'general' || asContentSubject(s) === subject

/** 按学科数一数能导出多少（界面显示数量用；不改任何东西） */
export function countExtras(d: ExtrasDeps, subject: string): ExtrasCounts {
  return {
    datasets: d.datasets.list().filter(x => inSubject(subject, x.subject)).length,
    documents: d.documents.list().filter(x => inSubject(subject, x.subject)).length,
    skills: readPlaybookFiles(userPlaybookDir(d.dataDir), 'user').items.length,
    roles: readCustomRoles(rolesDir(d.dataDir)).length
  }
}

const deepStrings = (v: unknown, f: (s: string) => string): unknown =>
  typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map(x => deepStrings(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepStrings(x, f)])) : v

/** 把选中的额外内容整理成临时文件（放在 tmpDir/extras 下），返回要打进 zip 的条目和数量 */
export function buildExtras(d: ExtrasDeps, o: { tmpDir: string; subject: string; datasets: boolean; documents: boolean; assets: boolean }): { items: ExtraItem[]; counts: ExtrasCounts } {
  const base = path.join(o.tmpDir, 'extras')
  fs.rmSync(base, { recursive: true, force: true })
  const items: ExtraItem[] = []
  const counts: ExtrasCounts = { datasets: 0, documents: 0, skills: 0, roles: 0 }
  const reg = (rel: string) => { const abs = path.join(base, ...rel.split('/')); items.push({ abs, name: `extras/${rel}`, size: fs.statSync(abs).size }) }
  const put = (rel: string, data: string) => {
    const abs = path.join(base, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data, 'utf8')
    reg(rel)
  }
  // 文字过滤器用「本机全部数据页表格」里出现过的姓名 / 编号 / 手机号，不只是这次要导出的那几个
  const sc = d.datasets.scrubber(d.datasets.list().map(x => x.id))
  const scrub = (s: string) => sc.text(s)
  try {
    if (o.datasets) {
      const metas = []
      for (const m of d.datasets.list().filter(x => inSubject(o.subject, x.subject))) {
        metas.push(d.datasets.exportCopy(m.id, path.join(base, 'datasets', `${m.id}.sqlite`)))
        reg(`datasets/${m.id}.sqlite`)
      }
      if (metas.length) { put('datasets/catalog.json', JSON.stringify({ version: 1, datasets: metas })); counts.datasets = metas.length }
    }
    if (o.documents) {
      const entries: DocEntry[] = []
      for (const e of d.documents.list().filter(x => inSubject(o.subject, x.subject))) {
        let text: string
        try { text = scrub(d.documents.text(e.id)) } catch { continue }
        put(`documents/${e.id}.txt`, text)
        entries.push({ ...e, name: scrub(e.name), chars: text.length, note: scrub(e.note ?? '') })
      }
      if (entries.length) { put('documents/catalog.json', JSON.stringify({ version: 1, items: entries })); counts.documents = entries.length }
    }
    if (o.assets) {
      const dir = userPlaybookDir(d.dataDir)
      let files: string[] = []
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort() } catch { /* 没有 */ }
      for (const f of files) {
        try {
          const abs = path.join(dir, f)
          if (fs.statSync(abs).size > 64 * 1024) continue
          const text = scrub(fs.readFileSync(abs, 'utf8'))
          if (!parsePlaybook(text).ok) continue
          put(`skills/skill-${++counts.skills}.md`, text)
        } catch { /* 坏文件跳过 */ }
      }
      for (const r of readCustomRoles(rolesDir(d.dataDir))) {
        put(`roles/${r.id}.json`, JSON.stringify({ format: ROLE_FILE_FORMAT, role: deepStrings(r, scrub) }, null, 2))
        counts.roles++
      }
    }
  } finally { sc.done() }
  return { items, counts }
}

// ───────────────────────── 导入 ─────────────────────────

export interface ExtrasReport { datasetsAdded: number; datasetsSkipped: number; documentsAdded: number; documentsSkipped: number; skillsAdded: number; skillsSkipped: number; rolesAdded: number; rolesSkipped: number; warnings: string[] }
export const emptyExtrasReport = (): ExtrasReport => ({ datasetsAdded: 0, datasetsSkipped: 0, documentsAdded: 0, documentsSkipped: 0, skillsAdded: 0, skillsSkipped: 0, rolesAdded: 0, rolesSkipped: 0, warnings: [] })

const clipS = (v: unknown, n: number): string => String(v ?? '').slice(0, n)
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const writeJsonAtomic = (f: string, data: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 1)); fs.renameSync(tmp, f) }
const COL_TYPES = ['integer', 'real', 'date', 'datetime', 'boolean', 'text', 'select', 'multi']

const ident = (v: unknown, n = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f]/.test(v)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const strs = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.slice(0, max).map(x => clipS(x, len)) : [])

/** 列概况：按字段白名单重建，字符串限长 */
function cleanProfile(p: any): any {
  const o: any = { nonNull: num(p?.nonNull), nullRate: num(p?.nullRate), distinct: num(p?.distinct), examples: strs(p?.examples, 10, 200), hints: strs(p?.hints, 10, 100) }
  for (const k of ['min', 'max']) if (typeof p?.[k] === 'number' || typeof p?.[k] === 'string') o[k] = typeof p[k] === 'string' ? p[k].slice(0, 100) : p[k]
  for (const k of ['mean', 'p25', 'p50', 'p75', 'avgLen']) if (typeof p?.[k] === 'number' && Number.isFinite(p[k])) o[k] = p[k]
  if (Array.isArray(p?.top)) o.top = p.top.slice(0, 10).map((t: any) => ({ value: clipS(t?.value, 200), count: num(t?.count), share: num(t?.share) }))
  if (p?.multi && typeof p.multi === 'object') o.multi = { separators: strs(p.multi.separators, 8, 10), optionCount: num(p.multi.optionCount) }
  return o
}

/**
 * 目录条目：按字段白名单重建（不透传包里多出来的东西），字符串限长；多选 / 派生视图只保留数据库里真实存在的。
 * 不合格返回 null（整个数据集不导入）。objs = 数据库里真实存在的 { 表和视图名 }。
 */
function checkDatasetMeta(m: any, tableNames: Set<string>, viewNames: Set<string>): any | null {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !UUID_RE.test(m.id)) return null
  if (!Array.isArray(m.tables) || m.tables.length === 0 || m.tables.length > 60) return null
  const tables: any[] = []
  for (const t of m.tables) {
    if (!t || !ident(t.name) || !tableNames.has(t.name) || typeof t.sheet !== 'string' || !Number.isInteger(t.rows) || t.rows < 0) return null
    if (!Array.isArray(t.columns) || t.columns.length > 400) return null
    const columns: any[] = []
    for (const c of t.columns) {
      if (!c || !ident(c.name) || typeof c.label !== 'string' || !COL_TYPES.includes(c.type) || !['INTEGER', 'REAL', 'TEXT'].includes(c.sqlType) || !c.profile || typeof c.profile !== 'object') return null
      const col: any = { name: c.name, label: clipS(c.label, 100), type: c.type, sqlType: c.sqlType, sensitive: !!c.sensitive, sensitiveAuto: !!c.sensitiveAuto, profile: cleanProfile(c.profile) }
      if (c.sensitive) col.sensitiveKind = ['person', 'id', 'phone', 'idcard', 'email', 'address', 'other'].includes(c.sensitiveKind) ? c.sensitiveKind : 'other'
      if (c.derived) col.derived = true
      columns.push(col)
    }
    const out: any = {
      name: t.name, sheet: clipS(t.sheet, 100), rows: t.rows, headerRow: Number.isInteger(t.headerRow) && t.headerRow >= 0 ? t.headerRow : 0, columns,
      views: (Array.isArray(t.views) ? t.views : []).filter((v: any) => v && ident(v.column) && ident(v.view) && viewNames.has(v.view) && columns.some(c => c.name === v.column)).map((v: any) => ({ column: v.column, view: v.view })),
      notes: strs(t.notes, 20, 300)
    }
    if (ident(t.derivedTable) && tableNames.has(t.derivedTable)) out.derivedTable = t.derivedTable
    if (ident(t.derivedView) && viewNames.has(t.derivedView)) out.derivedView = t.derivedView
    tables.push(out)
  }
  return {
    id: m.id, name: clipS(m.name, 60) || '数据集', sourceFile: clipS(m.sourceFile, 200), importedAt: clipS(m.importedAt, 40) || new Date().toISOString(),
    note: clipS(m.note, 2000), sizeBytes: 0, tables, subject: asContentSubject(m.subject)
  }
}

function importDatasets(dataDir: string, extrasDir: string, r: ExtrasReport): void {
  const cat = readJson(path.join(extrasDir, 'datasets', 'catalog.json'))
  if (!cat || !Array.isArray(cat.datasets)) return
  const dir = path.join(dataDir, 'datasets')
  const catFile = path.join(dir, 'catalog.json')
  const local = readJson(catFile)
  const list: any[] = Array.isArray(local?.datasets) ? local.datasets : []
  const have = new Set(list.map(x => x?.id))
  for (const raw of cat.datasets.slice(0, 2000)) {
    const id = raw?.id
    if (typeof id !== 'string' || !UUID_RE.test(id)) { r.warnings.push('数据包里有一个数据页表格的编号不对，已跳过'); continue }
    if (have.has(id)) { r.datasetsSkipped++; continue }
    const src = path.join(extrasDir, 'datasets', `${id}.sqlite`)
    if (!fs.existsSync(src)) { r.warnings.push('数据包里有一个数据页表格缺少数据文件，已跳过'); continue }
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, `${id}.sqlite`)
    const part = dst + '.part'
    try {
      fs.copyFileSync(src, part)
      const db = new DatabaseSync(part)
      let names: Set<string>
      let views: Set<string>
      try {
        db.exec('PRAGMA trusted_schema = OFF')
        const ic = db.prepare('PRAGMA integrity_check').all() as any[]
        if (ic.length !== 1 || String(Object.values(ic[0])[0]) !== 'ok') throw new Error('数据库没有通过完整性检查')
        const wantViews = new Set<string>()
        for (const t of Array.isArray(raw.tables) ? raw.tables : []) { for (const v of Array.isArray(t?.views) ? t.views : []) if (typeof v?.view === 'string') wantViews.add(v.view); if (typeof t?.derivedView === 'string') wantViews.add(t.derivedView) }
        // 触发器一律删；视图只留目录里登记的（多选拆分、派生列合并），其余一律删
        for (const o of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')").all() as any[]) {
          if (o.type === 'view' && wantViews.has(String(o.name))) continue
          db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS "${String(o.name).replace(/"/g, '""')}"`)
        }
        names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map(x => String(x.name)))
        views = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as any[]).map(x => String(x.name)))
        db.exec('PRAGMA journal_mode = DELETE')
      } finally { db.close() }
      const meta = checkDatasetMeta(raw, names, views)
      if (!meta) throw new Error('目录信息不完整')
      fs.renameSync(part, dst)
      meta.sizeBytes = fs.statSync(dst).size
      meta.note = `${meta.note ? meta.note + '\n' : ''}来自数据包：学员姓名、手机号等已换成代号，没有对应的真名。`.slice(0, 2000)
      list.push(meta); have.add(id)
      r.datasetsAdded++
    } catch (e) {
      try { fs.rmSync(part, { force: true }) } catch { /* 忽略 */ }
      r.warnings.push(`有一个数据页表格没能导入（${(e as Error).message.slice(0, 80)}）`)
    }
  }
  if (r.datasetsAdded) writeJsonAtomic(catFile, { version: 1, datasets: list })
}

const DOC_KINDS: DocKind[] = ['image', 'pdf', 'docx', 'text']
function importDocuments(dataDir: string, extrasDir: string, r: ExtrasReport): void {
  const cat = readJson(path.join(extrasDir, 'documents', 'catalog.json'))
  if (!cat || !Array.isArray(cat.items)) return
  const store = new DocumentStore(dataDir)
  const have = new Set(store.list().map(x => x.id))
  const added: DocEntry[] = []
  for (const e of cat.items.slice(0, 5000)) {
    const id = e?.id
    if (typeof id !== 'string' || !/^doc-[0-9a-f-]{1,40}$/.test(id) || !DOC_KINDS.includes(e.kind)) { r.warnings.push('数据包里有一份文档的信息不对，已跳过'); continue }
    if (have.has(id)) { r.documentsSkipped++; continue }
    let text: string
    try { text = fs.readFileSync(path.join(extrasDir, 'documents', `${id}.txt`), 'utf8').slice(0, DOC_MAX_CHARS) } catch { r.warnings.push('数据包里有一份文档缺少正文，已跳过'); continue }
    fs.mkdirSync(store.dir, { recursive: true })
    fs.writeFileSync(path.join(store.dir, `${id}.txt`), text)
    added.push({ id, name: clipS(e.name, 160) || '导入的文档', kind: e.kind, chars: text.length, importedAt: clipS(e.importedAt, 40) || new Date().toISOString(), note: clipS(e.note, 200), subject: asContentSubject(e.subject) })
    have.add(id)
  }
  if (added.length) {
    writeJsonAtomic(path.join(store.dir, 'catalog.json'), { version: 1, items: [...store.list(), ...added] })
    r.documentsAdded = added.length
  }
}

function importSkillsAndRoles(dataDir: string, extrasDir: string, r: ExtrasReport): void {
  const sdir = path.join(extrasDir, 'skills')
  let files: string[] = []
  try { files = fs.readdirSync(sdir).filter(f => /^skill-\d{1,4}\.md$/.test(f)).sort() } catch { /* 没有 */ }
  const dir = userPlaybookDir(dataDir)
  const names = new Set(readPlaybookFiles(dir, 'user').items.map(p => p.name))
  for (const f of files) {
    try {
      if (fs.statSync(path.join(sdir, f)).size > 64 * 1024) continue
      const text = fs.readFileSync(path.join(sdir, f), 'utf8')
      const p = parsePlaybook(text)
      if (!p.ok) { r.warnings.push(`有一个 Skill 的格式不对，已跳过（${p.error.slice(0, 40)}）`); continue }
      if (names.has(p.playbook.name)) { r.skillsSkipped++; continue }
      fs.mkdirSync(dir, { recursive: true })
      const taken = new Set(fs.readdirSync(dir))
      const base = p.playbook.name.replace(/[\\/:*?"<>|\s.]+/g, '-').slice(0, 60) || 'skill'
      let fn = `${base}.md`
      for (let n = 2; taken.has(fn); n++) fn = `${base}-${n}.md`
      fs.writeFileSync(path.join(dir, fn), text, 'utf8')
      names.add(p.playbook.name)
      r.skillsAdded++
    } catch { /* 跳过 */ }
  }
  const rdir = path.join(extrasDir, 'roles')
  let rfiles: string[] = []
  try { rfiles = fs.readdirSync(rdir).filter(f => /^c-[a-z0-9]{3,24}\.json$/.test(f)).sort() } catch { /* 没有 */ }
  const haveRoles = new Set(readCustomRoles(rolesDir(dataDir)).map(x => x.id))
  for (const f of rfiles) {
    const raw = readJson(path.join(rdir, f))
    const parsed = CustomRoleSchema.safeParse(raw?.role ?? raw)
    if (!parsed.success || `${parsed.data.id}.json` !== f) { r.warnings.push('有一个角色的内容不完整，已跳过'); continue }
    if (haveRoles.has(parsed.data.id)) { r.rolesSkipped++; continue }
    saveCustomRole(rolesDir(dataDir), parsed.data)
    haveRoles.add(parsed.data.id)
    r.rolesAdded++
  }
}

/** 把暂存目录里的 extras/ 并进本机的数据目录（逐项兜住错误：一项失败只记提示，不影响别的） */
export function importExtras(dataDir: string, extrasDir: string): ExtrasReport {
  const r = emptyExtrasReport()
  if (!fs.existsSync(extrasDir)) return r
  for (const [label, fn] of [['表格', importDatasets], ['文档', importDocuments], ['Skill 和角色', importSkillsAndRoles]] as const) {
    try { fn(dataDir, extrasDir, r) } catch (e) { r.warnings.push(`导入${label}时出错：${(e as Error).message.slice(0, 80)}`) }
  }
  return r
}
