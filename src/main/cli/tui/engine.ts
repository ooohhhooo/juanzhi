/**
 * 交互界面的「后台」：和助手服务、命令行命令之间的接线。界面（app.tsx）只调这里的方法。
 *  · 对话走窗口用的同一条路：agent/service.ts 的 startRun，事件通过 setAgentEventSink 收；
 *  · 导入 / 试卷 / 报告 / 状态复用 cli/commands.ts 的实现（由 run.ts 传进来的 runCli），不重写业务；
 *  · 学生姓名发给 AI 前的代号化、回答里还原真名，都在 service 里，和窗口一致。
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDataDir, getDb } from '../../db'
import { isAiReady, loadConfig } from '../../ai/config'
import { getPriceMap } from '../../ipc/cost'
import { getStore } from '../../analysis/datasets/index'
import {
  agentStatus, answerApproval, answerAsk, buildRegistry, findRole, getPrefs, getScene, modelsView, rolesView, sessionView,
  setAgentEventSink, startRun, stopRun
} from '../../agent/service'
import { roleName } from '../../agent/roles'
import { AGENT_MODES } from '../../agent/types'
import type { AgentMode } from '../../agent/types'
import { listSessions } from '../../agent/store'
import { listOutputs } from '../../agent/outputs/store'
import { tokensToMoney } from '../../ai/cost'
import { ChatModel, fmtMs, itemsFromSteps } from './chat-model'
import type { Banner } from './chat-model'
import { splitPaths } from './slash-defs'

export const MODE_LABEL: Record<AgentMode, string> = { direct: '直接回答', plan: '先出计划', auto: '自动完成' }
const MODE_HINT: Record<AgentMode, string> = { direct: '简单问题，最多几步就答', plan: '先给计划，你确认再做（默认）', auto: '不暂停，只在提问和写操作时停' }
const PAPER_STATUS: Record<string, string> = { reviewing: '待审核', done: '已确认', failed: '失败', parsing: '解析中', extracting: '提取中', queued: '排队中', imported: '已导入' }
const READERS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'teacher', label: '老师版', hint: '题型、知识点、讲评建议' },
  { value: 'boss', label: '老板版', hint: '一页纸结论' },
  { value: 'parent', label: '家长版', hint: '通俗易懂（生成的是草稿，发出前要人工核对）' },
  { value: 'full', label: '完整数据', hint: '全部统计' }
]

export interface Choice<T> { label: string; hint?: string; value: T }
export interface RunCliResult { ok: true; data: any }
export interface RunCliFail { ok: false; code: string; message: string; data?: any }

export interface EngineDeps {
  /** 跑一条命令行命令（和 `juanzhi <命令>` 同一份实现）；进度文字通过 log 回来 */
  runCli: (argv: string[], log: (m: string) => void) => Promise<RunCliResult | RunCliFail>
  /** 弹出一个选择（界面实现）；按 Esc 返回 null */
  choose: <T>(title: string, options: Array<Choice<T>>) => Promise<T | null>
  /** 显示 / 清除一行进度（导入、报告生成时） */
  progress: (text: string | null) => void
  exit: () => void
  clearScreen: () => void
  /** 状态栏刷新（角色 / 模式 / 模型变了） */
  changed: () => void
}

const shortHome = (p: string): string => { const h = os.homedir(); return h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p }
const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n - 1).join('') + '…' : t }
const mdCell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ')
const SUPPORTED = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.docx'])

export class Engine {
  readonly model: ChatModel
  roleId: string
  mode: AgentMode
  /** 空 = 用设置里的默认模型 */
  modelName = ''
  private labels = new Map<string, string>()
  private registry: ReturnType<typeof buildRegistry>['registry'] | null = null
  readonly deps: EngineDeps
  private busyCmd = false

  constructor(deps: EngineDeps) {
    this.deps = deps
    this.model = new ChatModel({ toolLabel: n => this.toolLabel(n) })
    const prefs = getPrefs()
    const last = listSessions(getDb(), 1)[0]
    const roles = rolesView().roles
    this.roleId = last && roles.some(r => r.id === last.role) ? last.role : roles[0]?.id ?? 'ops'
    this.mode = prefs.mode
    this.modelName = prefs.byRole[this.roleId]?.model ?? ''
    setAgentEventSink(p => { this.model.apply(p); this.deps.changed() })
  }

  dispose(): void { setAgentEventSink(null) }

  toolLabel(name: string): string {
    const hit = this.labels.get(name)
    if (hit) return hit
    try {
      this.registry ??= buildRegistry().registry
      const l = this.registry.get(name)?.label ?? name
      this.labels.set(name, l)
      return l
    } catch { return name }
  }

  // ───────── 显示用 ─────────
  get roleLabel(): string { const r = findRole(this.roleId); return r ? roleName(r, getScene()) : this.roleId }
  get effectiveModel(): string { return this.modelName || loadConfig().model || '' }
  get priced(): boolean { const p = getPriceMap()[this.effectiveModel]; return !!p && p.inPer1M !== null && p.outPer1M !== null }
  get aiReady(): boolean { return isAiReady() }
  get busy(): boolean { return this.model.live.running || this.busyCmd }

  banner(): Banner {
    const db = getDb()
    const c = (sql: string): number => (db.prepare(sql).get() as any).c as number
    let datasets = 0
    try { datasets = getStore().list().length } catch { /* 数据集目录还没有 */ }
    return {
      version: app.getVersion(), dataDir: shortHome(getDataDir()),
      model: this.aiReady ? this.effectiveModel : null,
      papers: c('SELECT COUNT(*) c FROM papers WHERE is_sample = 0'),
      parsed: c("SELECT COUNT(*) c FROM papers WHERE is_sample = 0 AND status IN ('reviewing','done')"),
      datasets, role: this.roleLabel
    }
  }

  /** ↑ 翻历史用：最近问过的问题（去重，最新在最后） */
  recentQuestions(limit = 50): string[] {
    try {
      const rows = getDb().prepare("SELECT payload_json FROM agent_steps WHERE kind = 'user' ORDER BY rowid DESC LIMIT ?").all(limit * 2) as Array<{ payload_json: string }>
      const seen = new Set<string>(); const out: string[] = []
      for (const r of rows) { try { const t = String(JSON.parse(r.payload_json).text ?? '').trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t) } } catch { /* 跳过坏行 */ } }
      return out.slice(0, limit).reverse()
    } catch { return [] }
  }

  // ───────── 对话 ─────────
  /** 把一句话交给助手 */
  send(text: string): void {
    const m = this.model
    m.beginRun(text)
    try {
      const r = startRun({ sessionId: m.sessionId, role: this.roleId, text, mode: this.mode, model: this.modelName || undefined })
      if (!m.sessionId) m.setSession(r.sessionId)
    } catch (e) { m.failRun((e as Error).message); this.deps.changed() }
  }
  stop(): void { if (this.model.sessionId) stopRun(this.model.sessionId) }
  answer(id: string, text: string): void {
    const m = this.model
    if (m.sessionId) answerAsk(m.sessionId, id, text)
    m.live.pending = null
    m.add({ kind: 'notice', text: `你选了：${text}`, tone: 'info' })
  }
  approve(id: string, ok: boolean): void {
    const m = this.model
    if (m.sessionId) answerApproval(m.sessionId, id, ok)
    m.live.pending = null
    m.add({ kind: 'notice', text: ok ? '已同意' : '已拒绝', tone: ok ? 'ok' : 'warn' })
  }

  // ───────── 斜杠命令 ─────────
  async slash(name: string, arg: string): Promise<void> {
    const m = this.model
    if (this.busy && !['help', 'exit', 'clear', 'status'].includes(name)) { m.notice('助手正在工作，等它结束或按 Esc 中断后再用这个命令', 'warn'); return }
    this.busyCmd = true
    try {
      switch (name) {
        case 'help': return this.help()
        case 'status': return await this.status()
        case 'import': return await this.importFiles(splitPaths(arg, os.homedir()))
        case 'papers': return await this.papers()
        case 'report': return await this.report()
        case 'datasets': return this.datasets()
        case 'role': return await this.pickRole(arg)
        case 'mode': return await this.pickMode(arg)
        case 'model': return await this.pickModel(arg)
        case 'new': m.resetSession(); this.deps.clearScreen(); m.notice('已开始新对话', 'ok'); return
        case 'history': return await this.history()
        case 'clear': this.deps.clearScreen(); return
        case 'exit': this.deps.exit(); return
        default: m.notice(`没有「/${name}」这个命令，输入 / 查看全部命令`, 'warn')
      }
    } catch (e) {
      m.notice((e as Error).message || '出错了', 'error')
    } finally { this.busyCmd = false; this.deps.progress(null); this.deps.changed() }
  }

  private help(): void {
    this.model.add({
      kind: 'md', md: [
        '**命令**（输入 `/` 会弹出列表，Tab 补全）',
        '',
        '| 命令 | 说明 |', '|---|---|',
        '| /import <路径…> | 导入试卷，也可以直接把文件拖进来 |',
        '| /papers | 试卷列表 |',
        '| /report | 生成报告 |',
        '| /datasets | 已导入的数据集 |',
        '| /role /mode /model | 切换角色、回答方式、模型 |',
        '| /new /history | 新对话、回到以前的对话 |',
        '| /status | 版本、数据目录、AI 状态 |',
        '| /clear /exit | 清屏、退出 |',
        '',
        '**快捷键**：Enter 发送 · `\\` + Enter 或 Ctrl+J 换行 · ↑↓ 翻历史 · Esc / Ctrl+C 中断回答 · Ctrl+D 退出'
      ].join('\n')
    })
  }

  private async status(): Promise<void> {
    const r = await this.deps.runCli(['status'], () => undefined)
    if (!r.ok) { this.model.notice(r.message, 'error'); return }
    const d = r.data
    const by = Object.entries(d.papers.byStatus as Record<string, number>).map(([k, v]) => `${PAPER_STATUS[k] ?? k} ${v}`).join('，')
    this.model.add({
      kind: 'lines', title: '状态', lines: [
        `版本    ${d.version}（${d.platform} ${d.arch}）`,
        `数据    ${shortHome(d.dataDir)}`,
        `试卷    共 ${d.papers.total} 份${by ? `（${by}）` : ''}`,
        `AI      ${d.ai.configured ? `已配置，模型 ${d.ai.model}` : '还没有配置：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写'}`,
        `识别    ${d.ocr.available ? '可用' : `不可用${d.ocr.detail ? `（${d.ocr.detail}）` : ''}`}`
      ]
    })
  }

  private async importFiles(raw: string[]): Promise<void> {
    const m = this.model
    if (!raw.length) { m.notice('用法：/import <文件路径…>（可以直接把文件拖进终端）', 'warn'); return }
    const files = raw.map(p => path.resolve(p))
    const bad = files.filter(f => { try { return !fs.statSync(f).isFile() } catch { return true } })
    if (bad.length) { m.notice(`找不到文件：${bad.map(shortHome).join('、')}`, 'error'); return }
    const unsupported = files.filter(f => !SUPPORTED.has(path.extname(f).toLowerCase()))
    if (unsupported.length) { m.notice(`不支持的文件类型：${unsupported.map(f => path.basename(f)).join('、')}（支持 PDF、图片、Word）`, 'error'); return }
    const t0 = Date.now()
    const log = (s: string): void => {
      const x = s.replace(/\b(extracting|parsing|queued|reviewing|done|failed|imported)\b/g, w => PAPER_STATUS[w] ?? w)
      this.deps.progress(`${x}  ${fmtMs(Date.now() - t0)}`)
    }
    this.deps.progress(`导入 ${files.length} 份文件……`)
    const r = await this.deps.runCli(['import', ...files], log)
    const data = r.ok ? r.data : r.data
    const papers: any[] = data?.papers ?? []
    if (papers.length) {
      m.add({
        kind: 'lines', title: '导入结果', lines: papers.map(p => {
          const name = clip(p.title || path.basename(p.file), 30)
          if (p.status === 'reviewing' || p.status === 'done') return `✓ ${name}  ${p.questions ?? 0} 题 · ${PAPER_STATUS[p.status]}`
          if (p.status === 'duplicate') return `· ${path.basename(p.file)}  重复，已跳过`
          return `✗ ${path.basename(p.file)}  ${clip(p.error ?? '失败', 60)}`
        })
      })
    }
    if (!r.ok) m.notice(r.message, 'error')
    else m.notice('解析结果是 AI 的，处于「待审核」。请到卷知窗口逐题审核后再当作结论', 'info')
  }

  private async papers(): Promise<void> {
    const r = await this.deps.runCli(['papers', 'list'], () => undefined)
    if (!r.ok) { this.model.notice(r.message, 'error'); return }
    const list: any[] = r.data.papers
    if (!list.length) { this.model.notice('还没有试卷。用 /import 导入，或把文件拖进来', 'info'); return }
    const rows = list.slice(0, 40).map(p => `| ${mdCell(clip(p.title || p.fileName || '', 28))} | ${PAPER_STATUS[p.status] ?? p.status} | ${p.questions} | ${mdCell([p.grade, p.semester, p.examType].filter(Boolean).join(' '))} |`)
    this.model.add({ kind: 'md', md: [`共 ${list.length} 份试卷${list.length > 40 ? '，只显示前 40 份' : ''}`, '', '| 试卷 | 状态 | 题数 | 年级学期 |', '|---|---|--:|---|', ...rows].join('\n') })
  }

  private async report(): Promise<void> {
    const m = this.model
    if (!this.aiReady) { m.notice('还没有配置 AI 服务：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写', 'warn'); return }
    const reader = await this.deps.choose('报告给谁看', READERS.map(x => ({ label: x.label, hint: x.hint, value: x.value })))
    if (!reader) return
    const t0 = Date.now()
    this.deps.progress('生成报告……')
    const r = await this.deps.runCli(['report', 'generate', '--reader', reader], s => this.deps.progress(`${s}  ${fmtMs(Date.now() - t0)}`))
    this.deps.progress(null)
    if (!r.ok) { m.notice(r.message, 'error'); return }
    const d = r.data
    m.add({ kind: 'md', md: `# ${d.title}\n\n${d.markdown}` })
    if (d.parentDraft) m.notice(d.warning ?? '家长版是 AI 草稿，请人工核对后再发给家长', 'warn')
    else if (d.draft) m.notice('这是 AI 草稿，请核对后再对外使用', 'info')
    if (Array.isArray(d.unverified) && d.unverified.length) m.notice(`有 ${d.unverified.length} 句话没能和数据核对上，已在报告里标出，请留意`, 'warn')
    const fmt = await this.deps.choose('导出到当前目录', [
      { label: '不导出', value: '' }, { label: 'Word（.docx）', value: 'docx' }, { label: 'Markdown（.md）', value: 'md' }, { label: 'PDF', value: 'pdf' }
    ])
    if (!fmt) return
    const stem = String(d.title || '报告').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
    const out = path.join(process.cwd(), `${stem}_${new Date().toISOString().slice(0, 10)}`)
    this.deps.progress('导出中……')
    const e = await this.deps.runCli(['report', 'export', d.id, '--format', fmt, '--out', out], () => undefined)
    if (!e.ok) m.notice(e.message, 'error')
    else m.notice(`已导出：${shortHome(e.data.path)}`, 'ok')
  }

  private datasets(): void {
    let list: Array<{ name: string; importedAt: string; tables: Array<{ rows: number }> }> = []
    try { list = getStore().list() } catch { /* 还没有 */ }
    if (!list.length) { this.model.notice('还没有数据集。在卷知窗口的「助手」里导入表格后，这里可以看到', 'info'); return }
    this.model.add({
      kind: 'md', md: ['| 数据集 | 表数 | 行数 | 导入时间 |', '|---|--:|--:|---|', ...list.map(d => `| ${mdCell(clip(d.name, 30))} | ${d.tables.length} | ${d.tables.reduce((a, t) => a + t.rows, 0)} | ${d.importedAt.slice(0, 10)} |`)].join('\n')
    })
  }

  private async pickRole(arg: string): Promise<void> {
    const v = rolesView()
    const hit = arg ? v.roles.find(r => r.id === arg || r.name === arg) : undefined
    const id = hit?.id ?? await this.deps.choose('选择助手角色', v.roles.map(r => ({ label: r.name, hint: r.id === this.roleId ? '当前' : undefined, value: r.id })))
    if (!id || id === this.roleId) return
    this.roleId = id
    this.modelName = getPrefs().byRole[id]?.model ?? ''
    // 换角色 = 换一段对话（不同角色有不同的工具和说话方式）
    this.model.resetSession()
    this.model.notice(`已切换到「${this.roleLabel}」，开始新对话`, 'ok')
  }

  private async pickMode(arg: string): Promise<void> {
    const byLabel = AGENT_MODES.find(x => x === arg || MODE_LABEL[x] === arg)
    const mode = byLabel ?? await this.deps.choose('回答方式', AGENT_MODES.map(x => ({ label: MODE_LABEL[x], hint: MODE_HINT[x] + (x === this.mode ? '（当前）' : ''), value: x })))
    if (!mode) return
    this.mode = mode
    this.model.notice(`回答方式：${MODE_LABEL[mode]}`, 'ok')
  }

  private async pickModel(arg: string): Promise<void> {
    const list = modelsView()
    if (!list.length) { this.model.notice('还没有配置模型：请打开卷知窗口，到「设置 → 管理员设置 → AI 服务」填写', 'warn'); return }
    const name = arg && list.some(x => x.model === arg) ? arg : await this.deps.choose('选择模型', list.map(x => ({
      label: x.model, hint: [x.model === this.effectiveModel ? '当前' : '', x.toolSupport === 'no' ? '不支持助手' : ''].filter(Boolean).join('，') || undefined, value: x.model
    })))
    if (!name) return
    if (agentStatus(name).toolSupport === 'no') { this.model.notice(`「${name}」不支持助手需要的工具调用，请换一个`, 'warn'); return }
    this.modelName = name === loadConfig().model ? '' : name
    this.model.notice(`模型：${name}`, 'ok')
  }

  private async history(): Promise<void> {
    const rows = listSessions(getDb(), 30)
    if (!rows.length) { this.model.notice('还没有以前的对话', 'info'); return }
    const roleNames = new Map<string, string>(rolesView().roles.map(r => [r.id as string, r.name]))
    const id = await this.deps.choose('回到以前的对话', rows.map(s => ({ label: clip(s.title || '（无标题）', 36), hint: `${roleNames.get(s.role) ?? s.role} · ${s.updatedAt.slice(5, 16)}`, value: s.id })))
    if (!id) return
    const v = sessionView(id)
    if (!v) { this.model.notice('找不到这个对话', 'error'); return }
    const role = v.session.role
    if (rolesView().roles.some(r => (r.id as string) === role)) this.roleId = role
    this.model.resetSession()
    this.deps.clearScreen()
    for (const it of itemsFromSteps(v.steps as any, n => this.toolLabel(n))) this.model.add(it)
    this.model.setSession(id, { tokensIn: v.session.tokensIn, tokensOut: v.session.tokensOut, money: tokensToMoney(v.session.tokensIn, v.session.tokensOut, getPriceMap()[this.effectiveModel]) })
    this.model.notice(`已回到「${clip(v.session.title, 30)}」，接着问就行`, 'ok')
    // 有产出文件（报告、表格）的话告诉一声在哪
    try { const outs = listOutputs({ dataDir: getDataDir(), sessionId: id }); if (outs.length) this.model.notice(`这段对话里有 ${outs.length} 份产出，可以在卷知窗口的助手里查看和导出`, 'info') } catch { /* 没有产出目录 */ }
  }
}
