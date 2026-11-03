/**
 * 敏感列识别 + 代号本（Codebook）。纯逻辑，不依赖 electron。
 * 代号本：同一个原值在同一数据集里永远映射到同一个代号（人员A017、编号0231……），映射表只存本机（<id>.codes.json，
 * 不在数据集 sqlite 里，模型的查询碰不到）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ColumnProfile, ColumnType, SensitiveKind } from '../types.ts'

// ───────────────────────── 识别 ─────────────────────────

const NAME_RULES: Array<{ kind: SensitiveKind; re: RegExp }> = [
  { kind: 'phone', re: /手机|电话|联系方式|phone|mobile|tel\b/i },
  { kind: 'idcard', re: /身份证|证件号|idcard|id_card/i },
  { kind: 'email', re: /邮箱|邮件|email|e-mail|mail\b/i },
  { kind: 'address', re: /地址|住址|家庭住址|address/i },
  { kind: 'other', re: /微信|wechat|weixin|qq号|支付宝|银行卡/i },
  { kind: 'person', re: /姓名|名字|昵称|真实名|(学员|学生|用户|人员|家长|员工|会员|联系人|客户)名称?|^name$|[_\s]name$|^name[_\s]|ldap|老师|教师|讲师|班主任|助教|顾问|辅导|负责人|教练/i },
  { kind: 'id', re: /(^|[^a-z])(id|uid|userid)([^a-z]|$)|工号|学号|(学员|学生|用户|人员|员工|会员|家长|客户)(编号|编码|号)|账号|账户/i }
]
/** 名称类弱关键词：高基数才算 */
const WEAK_NAME = /名称$|^名称/

const PHONE_RE = /^1[3-9]\d{9}$/
const IDCARD_RE = /^\d{17}[\dXx]$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CN_NAME_RE = /^[一-龥·]{2,4}$/

export interface SensitiveGuess { kind: SensitiveKind; reason: string }

/**
 * 按列名关键词和取值模式判断。values 是该列（最多几千个）非空单元格的文字。
 * 「id」类列只有不同取值够多（像用来区分个体）才标；班级 id 之类低基数不标。
 */
export function detectSensitive(label: string, type: ColumnType, profile: ColumnProfile, values: string[]): SensitiveGuess | null {
  const n = values.length
  const highCard = profile.distinct >= 30 || (n >= 10 && profile.distinct >= n * 0.5)
  for (const r of NAME_RULES) {
    if (!r.re.test(label)) continue
    if (r.kind === 'id' && !highCard) continue
    if (type === 'date' || type === 'datetime' || type === 'boolean') continue
    if ((r.kind === 'person' || r.kind === 'address' || r.kind === 'email') && (type === 'integer' || type === 'real')) continue   // 「老师满意度」之类的分数列
    return { kind: r.kind, reason: '列名' }
  }
  if (WEAK_NAME.test(label) && highCard && (type === 'text' || type === 'select')) return { kind: 'person', reason: '列名 + 取值很多' }
  if (n) {
    const share = (re: RegExp) => values.filter(v => re.test(v)).length / n
    if (share(PHONE_RE) >= 0.6) return { kind: 'phone', reason: '像手机号' }
    if (share(IDCARD_RE) >= 0.6) return { kind: 'idcard', reason: '像身份证号' }
    if (share(EMAIL_RE) >= 0.6) return { kind: 'email', reason: '像邮箱' }
    if (type === 'text' && share(CN_NAME_RE) >= 0.8 && profile.distinct >= 30 && profile.distinct >= n * 0.2) return { kind: 'person', reason: '像人名' }
  }
  return null
}

// ───────────────────────── 代号本 ─────────────────────────

const PREFIX: Record<SensitiveKind, string> = { person: '人员', id: '编号', phone: '手机', idcard: '证件', email: '邮箱', address: '地址', other: '敏感值' }
const KINDS = Object.keys(PREFIX) as SensitiveKind[]

function letters(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
/** 第 n 个（从 1 数）代号。人员：人员A001…A999、B001…；其他：编号0001… */
export function makeCode(kind: SensitiveKind, n: number): string {
  if (kind === 'person') return `${PREFIX.person}${letters(Math.floor((n - 1) / 999))}${String(((n - 1) % 999) + 1).padStart(3, '0')}`
  return `${PREFIX[kind]}${String(n).padStart(4, '0')}`
}
const CODE_RE = new RegExp(`(?:${KINDS.map(k => PREFIX[k]).join('|')})(?:[A-Z]+\\d{3}|\\d{4,})`, 'g')

interface Book { kinds: Partial<Record<SensitiveKind, { n: number; fwd: Record<string, string> }>> }

export class Codebook {
  private book: Book = { kinds: {} }
  private rev: Map<string, string> | null = null
  private dirty = false
  private file: string | null
  constructor(file: string | null) {
    this.file = file
    if (file) {
      try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (raw && typeof raw === 'object' && raw.kinds) this.book = raw } catch { /* 新的 */ }
    }
  }
  /** 取（没有就分配）一个原值的代号 */
  code(kind: SensitiveKind, value: string): string {
    const k = (this.book.kinds[kind] ??= { n: 0, fwd: Object.create(null) })
    const got = k.fwd[value]
    if (got) return got
    const c = makeCode(kind, ++k.n)
    k.fwd[value] = c
    this.rev = null
    this.dirty = true
    return c
  }
  /** 只查不分配 */
  lookup(kind: SensitiveKind, value: string): string | undefined { return this.book.kinds[kind]?.fwd[value] }
  /** 把文本里的代号换回原值（用于界面显示模型的回答）；不认识的代号原样保留 */
  decode(text: string, esc?: (s: string) => string): string {
    if (!this.rev) {
      this.rev = new Map()
      for (const k of Object.values(this.book.kinds)) if (k) for (const [orig, code] of Object.entries(k.fwd)) this.rev.set(code, orig)
    }
    const rev = this.rev
    return text.replace(CODE_RE, m => { const o = rev.get(m); return o === undefined ? m : esc ? esc(o) : o })
  }
  flush(): void {
    if (!this.file || !this.dirty) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.book))
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }
}
