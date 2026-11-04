/**
 * 助手服务（接 electron 的一层）：配置检查、工具支持 / 思考强度检测、跑一次提问、把事件落库并推给界面、审批 / 提问 / 停止、
 * 自定义角色、机构说明、偏好（运行模式 / 模型 / 思考强度）。循环本身在 harness.ts（纯函数，已单测）；这里只负责「接线」。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import { getDb, getDataDir } from '../db'
import { chat, AiError } from '../ai/client'
import type { ChatMessage } from '../ai/client'
import { loadConfig, recordUsage } from '../ai/config'
import { getApiKey } from '../ai/secret'
import { effectiveMaxTokens } from '../ai/providers'
import { configModels, tokensToMoney } from '../ai/cost'
import { getPriceMap } from '../ipc/cost'
import { notifyDataChanged } from '../events'
import { getMainWindow } from '../window'
import { runAgent } from './harness'
import { playbooksForRole } from './playbooks'
import type { Playbook } from './playbooks'
import { allPlaybooks as loadAllPlaybooks } from './playbooks/index'
import { buildSystemPrompt } from './prompt'
import { probeKey, probeToolSupport } from './probe'
import { availableEfforts, canTurnOff, effortBody, effortProbeKey, isEffort, probeEffort } from './reasoning'
import type { Effort } from './reasoning'
import { BASE_TOOLS, CONNECTOR_ROLES, DATA_TOOLS as DATA_TOOL_NAMES, enabledRoles, getRole, roleName } from './roles'
import type { RoleDef } from './roles'
import { CustomRoleSchema, deleteCustomRole, exportRoleText, newRoleId, parseRoleFile, readCustomRoles, saveCustomRole, toRoleDef } from './custom-roles'
import type { CustomRole } from './custom-roles'
import { takeAttachments } from './attachments'
import type { AttachInfo } from './attachments'
import { clipOrgContext, contextLimitFor, DEFAULT_CONTEXT_LIMIT, ORG_CONTEXT_MAX } from './limits'
import { scrubPII } from '../analysis/scrub'
import { appendStep, listSessions, createSession, currentDataRev, deriveState, eventToStep, getSession, historyMessages, leafOf, makeCiteChecker, newBranchId, pathTo, updateSession, updateStepPayload } from './store'
import type { StepKind } from './store'
import { createRegistry } from './tools'
import { adaptAgentTools } from './tools/bridge'
import { allTools } from './all-tools'
import { createRuntimeToolContext } from '../analysis/tools-runtime'
import { initNames, noteArgs, noteDatasets, restoreDeep, restoreNames, sessionDatasetIds } from './names'
import { setOutputRestorer } from './outputs/export'
import { getStore } from '../analysis/datasets/index'
import type { ToolRegistry } from './registry'
import { AGENT_MODES, APPROVAL_MODES, DEFAULT_BUDGET } from './types'
import type { AgentEvent, AgentMode, ApprovalMode, ModelReply, Scene } from './types'

const SCENE_KEY = 'agent_scene'
const PREFS_KEY = 'agent_prefs'
const SETTINGS_KEY = 'agent_settings'

const readSetting = (key: string): any => {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
  try { return row ? JSON.parse(row.value_json) : null } catch { return null }
}
const writeSetting = (key: string, v: unknown) => { getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(v)) }

// ───────── 场景（培训机构 / 学校）─────────
/** 沿用课程大纲里的「场景」：没有单独设置过，就看已启用的课程大纲里有没有学校；都没有按培训机构 */
export function getScene(): Scene {
  const v = readSetting(SCENE_KEY)
  if (v === 'org' || v === 'school') return v
  const rows = getDb().prepare("SELECT DISTINCT scene FROM course_outlines WHERE active = 1 AND status = 'active'").all() as Array<{ scene: string }>
  return rows.length > 0 && rows.every(r => r.scene === 'school') ? 'school' : 'org'
}
export function setScene(s: Scene): Scene { writeSetting(SCENE_KEY, s); return s }

// ───────── 目录与文件 ─────────
export const userPlaybookDir = (): string => path.join(getDataDir(), 'playbooks')
export const customRolesDir = (): string => path.join(getDataDir(), 'agent-roles')
export const orgContextFile = (): string => path.join(getDataDir(), 'agent-context.md')
/** 内置 + 用户剧本（同名用户优先，._ 文件忽略）：一套加载器，load_playbook、设置页、系统提示都用它 */
export function allPlaybooks(): Playbook[] { return loadAllPlaybooks(getDataDir()) }

/** 启动时接线：代号还原（界面显示、导出到本机、发往外部）要用到数据目录 */
export function initAgent(): void {
  initNames(() => getDataDir())
  setOutputRestorer(restoreNames)
}

/** 本轮可用的工具注册表：内核内置 + 试卷数据工具 + 分析 / 产出 / 连接器工具（连接器每轮按当前配置重新取）。同时返回连接器动态工具名 */
export function buildRegistry(): { registry: ToolRegistry; dynamic: string[] } {
  const list = allTools()
  const adapted = adaptAgentTools(list, {
    makeCtx: ctx => createRuntimeToolContext({ sessionId: ctx.sessionId, dataDir: ctx.dataDir || getDataDir(), signal: ctx.signal, onProgress: ctx.progress }),
    restore: (sid, v) => restoreDeep(sid, v),
    noteArgs
  })
  const fixed = new Set(DATA_TOOL_NAMES)
  return { registry: createRegistry(adapted), dynamic: adapted.map(t => t.name).filter(n => !fixed.has(n)) }
}

// ───────── 偏好 ─────────
interface Prefs { mode: AgentMode; approval: ApprovalMode; byRole: Record<string, { model: string; effort: Effort }> }
export function getPrefs(): Prefs {
  const v = readSetting(PREFS_KEY) ?? {}
  const byRole: Prefs['byRole'] = {}
  for (const [k, x] of Object.entries((v.byRole ?? {}) as Record<string, any>)) if (x && typeof x.model === 'string') byRole[k] = { model: x.model.slice(0, 120), effort: isEffort(x.effort) ? x.effort : 'auto' }
  return { mode: AGENT_MODES.includes(v.mode) ? v.mode : 'plan', approval: APPROVAL_MODES.includes(v.approval) ? v.approval : 'ask-external', byRole }
}

// ───────── 角色 ─────────
export const customRoles = (): CustomRole[] => readCustomRoles(customRolesDir())
export function allRoles(): RoleDef[] { return [...enabledRoles(), ...customRoles().map(toRoleDef)] }
export const findRole = (id: string): RoleDef | undefined => getRole(id) ?? allRoles().find(r => r.id === id)

export function rolesView() {
  const scene = getScene()
  return {
    scene, prefs: getPrefs(),
    roles: allRoles().map(r => ({ id: r.id, name: roleName(r, scene), suggestions: r.suggestions, custom: !!r.custom }))
  }
}

/** 可以勾选的工具（不含每个角色都有的基础工具） */
export const allToolNames = (): string[] => buildRegistry().registry.names()

export function toolList(): Array<{ name: string; label: string; level: 'read' | 'write' }> {
  const reg = buildRegistry().registry
  return reg.names().filter(n => !BASE_TOOLS.includes(n)).map(n => { const t = reg.get(n)!; return { name: n, label: t.label ?? n, level: t.level } })
}

export function saveRole(input: Partial<CustomRole> & { name: string }): CustomRole {
  const known = new Set(toolList().map(t => t.name))
  const existing = customRoles()
  const id = input.id && existing.some(r => r.id === input.id) ? input.id : newRoleId(new Set(existing.map(r => r.id)))
  const role = CustomRoleSchema.parse({ ...input, id, tools: (input.tools ?? []).filter(t => known.has(t)) })
  return saveCustomRole(customRolesDir(), role)
}
export const removeRole = (id: string): boolean => deleteCustomRole(customRolesDir(), id)
export function importRoleText(text: string) {
  const r = parseRoleFile(text, new Set(toolList().map(t => t.name)), new Set(customRoles().map(x => x.id)))
  if (!r.ok) return r
  return { ok: true as const, role: saveCustomRole(customRolesDir(), r.role), droppedTools: r.droppedTools }
}
export const exportRole = (id: string): { name: string; text: string } | null => { const r = customRoles().find(x => x.id === id); return r ? { name: r.name, text: exportRoleText(r) } : null }

// ───────── 机构说明与设置 ─────────
export function readOrgContext(): string { try { return fs.readFileSync(orgContextFile(), 'utf8') } catch { return '' } }
export function agentSettingsView() {
  const raw = readOrgContext()
  const cfg = loadConfig()
  const s = readSetting(SETTINGS_KEY) ?? {}
  const override = typeof s.contextLimit === 'number' ? s.contextLimit : null
  return { orgContext: raw, orgContextMax: ORG_CONTEXT_MAX, clipped: clipOrgContext(raw).clipped, contextLimit: override, contextLimitEffective: contextLimitFor(cfg.model, override), contextLimitDefault: DEFAULT_CONTEXT_LIMIT }
}
export function saveAgentSettings(p: { orgContext?: string; contextLimit?: number | null }) {
  if (typeof p.orgContext === 'string') {
    fs.mkdirSync(getDataDir(), { recursive: true })
    fs.writeFileSync(orgContextFile(), p.orgContext.slice(0, ORG_CONTEXT_MAX * 3), 'utf8')
  }
  if (p.contextLimit !== undefined) writeSetting(SETTINGS_KEY, { ...(readSetting(SETTINGS_KEY) ?? {}), contextLimit: p.contextLimit })
  return agentSettingsView()
}

// ───────── 状态、模型、检测 ─────────
type ToolSupportCache = { supported: boolean; reason: string; at: string }
export interface AgentStatus {
  configured: boolean
  model: string
  /** unknown = 还没检测过 */
  toolSupport: 'yes' | 'no' | 'unknown'
  reason: string
}

const toolCache = (model: string): ToolSupportCache | null => readSetting(probeKey(loadConfig().base_url, model))
export function agentStatus(model?: string): AgentStatus {
  const cfg = loadConfig()
  const m = (model ?? cfg.model).trim() || cfg.model
  const configured = !!(cfg.base_url.trim() && cfg.model.trim() && getApiKey())
  const c = toolCache(m)
  return { configured, model: m, toolSupport: c ? (c.supported ? 'yes' : 'no') : 'unknown', reason: c?.reason ?? '' }
}

const effortCache = (model: string): boolean | null => { const v = readSetting(effortProbeKey(loadConfig().base_url, model)); return v && typeof v.supported === 'boolean' ? v.supported : null }

export function modelInfo(model: string, roles: string[] = []) {
  const eff = effortCache(model)
  return { model, roles, toolSupport: agentStatus(model).toolSupport, efforts: availableEfforts(eff), effortSupport: eff === null ? 'unknown' : eff ? 'yes' : 'no', canTurnOff: canTurnOff(model) }
}
/** 设置里配置的模型（主模型 / 拆题 / 视觉，去重）+ 各自的检测结果；界面据此显示「不支持助手」并禁用 */
export const modelsView = () => configModels(loadConfig()).map(m => modelInfo(m.model, m.roles))

const fetchImpl = net.fetch as unknown as typeof fetch

/** 现在就检测一次（发一个很小的请求），结果按「服务地址 + 模型」缓存；密钥无效 / 没网等和工具无关的错误会抛出去 */
export async function checkToolSupport(model?: string): Promise<AgentStatus> {
  const cfg = loadConfig()
  const key = getApiKey()
  const m = (model ?? cfg.model).trim() || cfg.model
  if (!cfg.base_url.trim() || !m || !key) return agentStatus(m)
  const t0 = Date.now()
  try {
    const r = await probeToolSupport({ baseUrl: cfg.base_url, apiKey: key, model: m, timeoutMs: Math.min(cfg.timeout_sec, 60) * 1000, fetchImpl })
    recordUsage({ paperId: null, kind: 'agent', model: m, ok: true, ms: Date.now() - t0 })
    writeSetting(probeKey(cfg.base_url, m), { supported: r.supported, reason: r.reason, at: new Date().toISOString() } satisfies ToolSupportCache)
  } catch (e) {
    recordUsage({ paperId: null, kind: 'agent', model: m, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
    throw e
  } finally { notifyDataChanged('usage') }
  return agentStatus(m)
}

/** 试探这个模型认不认推理参数（reasoning_effort）：被 400 拒绝就记为不支持，界面隐藏低 / 中 / 高。unknown 不缓存 */
export async function checkEffortSupport(model: string) {
  const cfg = loadConfig()
  const key = getApiKey()
  if (!cfg.base_url.trim() || !key) return modelInfo(model)
  const t0 = Date.now()
  const r = await probeEffort({ baseUrl: cfg.base_url, apiKey: key, model, timeoutMs: Math.min(cfg.timeout_sec, 60) * 1000, fetchImpl })
  recordUsage({ paperId: null, kind: 'agent', model, ok: r !== 'unknown', ms: Date.now() - t0 })
  if (r !== 'unknown') writeSetting(effortProbeKey(cfg.base_url, model), { supported: r === 'supported', at: new Date().toISOString() })
  notifyDataChanged('usage')
  return modelInfo(model)
}

// ───────── 本会话选好的数据集 ─────────
/** 用户在输入框选的数据集（编号 + 名字），给系统提示用；已删除的跳过 */
function selectedDatasets(sid: string): Array<{ id: string; name: string }> {
  try { const st = getStore(); return sessionDatasetIds(sid).map(id => st.find(id)).filter((d): d is NonNullable<typeof d> => !!d).slice(0, 10).map(d => ({ id: d.id, name: d.name })) } catch { return [] }
}

// ───────── 一次提问 ─────────
interface Run {
  ctl: AbortController
  asks: Map<string, (a: string) => void>
  approvals: Map<string, (ok: boolean) => void>
}
const runs = new Map<string, Run>()
export const agentBusy = (): boolean => runs.size > 0
export const isRunning = (sessionId: string): boolean => runs.has(sessionId)
/** 启动时：上次没跑完就退出的对话（状态还是「进行中」）改回空闲 */
export function resetStaleRunning(): void { getDb().prepare("UPDATE agent_sessions SET status = 'idle' WHERE status = 'running'").run() }

/** 给界面看的步骤内容：代号还原成真名（数据库里和发给 AI 的始终是代号） */
export function showPayload(sid: string, kind: string, payload: unknown): unknown { return kind === 'user' ? payload : restoreDeep(sid, payload) }

/** 事件出口：窗口照旧收 agent:event；命令行的交互界面（cli/tui）没有窗口，注册一个 sink 来收同样的事件。sink 抛错不影响运行 */
export type AgentEventSink = (payload: Record<string, unknown>) => void
let eventSink: AgentEventSink | null = null
export function setAgentEventSink(fn: AgentEventSink | null): void { eventSink = fn }

function send(payload: Record<string, unknown>): void {
  getMainWindow()?.webContents.send('agent:event', payload)
  if (eventSink) { try { eventSink(payload) } catch (e) { console.warn('[agent] 事件接收端出错:', (e as Error).message) } }
}

export interface RunArgs {
  sessionId?: string; role: string; text: string
  mode?: AgentMode; approval?: string; model?: string; effort?: string
  /** 在已有对话里从某一步「从这里追问」：新问题挂在这一步（seq）下面，形成新分支 */
  branchFrom?: number
  /** 接着某个分支追问（不写 = 主线） */
  branchId?: string
  /** 用户选的数据集编号：记在这个会话上，导出 / 显示时用它们还原真名 */
  datasets?: string[]
  /** 用户在输入框里指定的 Skill 名：system 里提示先 load_playbook */
  playbooks?: string[]
  /** 附件编号（agent:readAttachment 返回的）：文字附在问题后面发给 AI */
  attachments?: string[]
}

/** 开始一次提问；很快返回 sessionId，过程通过 agent:event 推给界面，结束时发 done */
export function startRun(a: RunArgs): { sessionId: string; branchId: string } {
  const role = findRole(a.role)
  if (!role || !role.enabled) throw new Error('这个角色暂时还不能用')
  const db = getDb()
  const scene = getScene()
  let sessionId = a.sessionId
  let branchId = a.branchId || 'main'
  if (sessionId) {
    if (runs.has(sessionId)) throw new Error('这个对话正在进行中，请先等它结束或点停止')
    const ex = getSession(db, sessionId)
    if (!ex) throw new Error('找不到这个对话')
    if (a.branchFrom !== undefined) {
      if (!ex.steps.some(s => s.seq === a.branchFrom)) throw new Error('找不到要追问的那一步')
      branchId = newBranchId()
    } else if (!ex.steps.some(s => s.branchId === branchId)) branchId = 'main'
  } else {
    sessionId = crypto.randomUUID()
    branchId = 'main'
    createSession(db, { id: sessionId, role: role.id, scene, title: a.text.replace(/\s+/g, ' ').trim() })
  }
  const sid = sessionId
  if (a.datasets?.length) noteDatasets(sid, a.datasets.slice(0, 20))
  // 第一次选运营 / 辅导老师来用助手：下次打开卷知默认进入助手（没手动选过启动页才生效；本次不跳转）
  if (CONNECTOR_ROLES.includes(role.id) && readSetting('start_page') == null) writeSetting('start_page', 'assistant')
  const mode: AgentMode = a.mode && AGENT_MODES.includes(a.mode) ? a.mode : getPrefs().mode
  const cfg0 = loadConfig()
  const model = (a.model ?? '').trim().slice(0, 120) || cfg0.model
  const effort: Effort = isEffort(a.effort) ? a.effort : 'auto'
  const approval: ApprovalMode = APPROVAL_MODES.includes(a.approval as ApprovalMode) ? (a.approval as ApprovalMode) : getPrefs().approval
  // 记住这次的选择：模式全局，模型和思考强度按角色
  const prefs = getPrefs()
  writeSetting(PREFS_KEY, { mode, approval, byRole: { ...prefs.byRole, [role.id]: { model: model === cfg0.model ? '' : model, effort } } })

  const run: Run = { ctl: new AbortController(), asks: new Map(), approvals: new Map() }
  runs.set(sid, run)
  const att = takeAttachments(a.attachments ?? [], sid)
  void execute({ sid, text: a.text, attach: att.infos.length ? { infos: att.infos, block: att.block } : undefined, role, scene, run, mode, approval, model, effort, branchId, branchFrom: a.branchFrom, playbooks: a.playbooks }).catch(e => {
    console.warn('[agent] 运行出错:', (e as Error).message)
    send({ sessionId: sid, type: 'done', status: 'error' })
  }).finally(() => { runs.delete(sid); notifyDataChanged('agent') })
  return { sessionId: sid, branchId }
}

interface ExecArgs { sid: string; text: string; attach?: { infos: AttachInfo[]; block: string }; role: RoleDef; scene: Scene; run: Run; mode: AgentMode; approval: ApprovalMode; model: string; effort: Effort; branchId: string; branchFrom?: number; playbooks?: string[] }

async function execute(x: ExecArgs): Promise<void> {
  const { sid, text, role, scene, run, mode, branchId } = x
  const db = getDb()
  const prior = getSession(db, sid)!
  // 分支：上下文 = 从根到挂载点这条路径上的内容；兄弟分支的对话不进来，但查询记录 / 选择是整个会话共享的
  const anchor = x.branchFrom !== undefined ? prior.steps.find(s => s.seq === x.branchFrom) ?? null : leafOf(prior.steps, branchId)
  const path = anchor ? pathTo(prior.steps, anchor.seq) : []
  const history: ChatMessage[] = historyMessages(path)
  const initialState = deriveState(prior.steps, path)
  let firstParent: number | null | undefined = x.branchFrom !== undefined ? x.branchFrom : undefined
  // 附件：界面只显示文件名，文字（attachText）跟问题一起发给 AI，追问时也随历史带上
  const attachPayload = x.attach ? { attachments: x.attach.infos.map(({ name, kind, chars, truncated }) => ({ name, kind, chars, truncated })), attachText: x.attach.block } : {}

  const pushStep = (s: { kind: StepKind; payload: unknown; tokens?: number; ms?: number }): number => {
    const parentId = firstParent
    firstParent = undefined
    const seq = appendStep(db, sid, { ...s, branchId, ...(parentId !== undefined ? { parentId } : {}) })
    const row = getSession(db, sid)?.steps.find(r => r.seq === seq)
    send({ sessionId: sid, type: 'step', seq, parentId: row?.parentId ?? null, branchId, kind: s.kind, payload: showPayload(sid, s.kind, s.payload), tokens: s.tokens ?? 0, ms: s.ms ?? 0 })
    return seq
  }
  const finishNoRun = (code: string, message: string) => {
    pushStep({ kind: 'user', payload: { text, ...attachPayload, model: x.model, effort: x.effort, mode } })
    pushStep({ kind: 'error', payload: { code, message } })
    updateSession(db, sid, { status: 'idle' })
    send({ sessionId: sid, type: 'done', status: 'error' })
  }

  const cfg = loadConfig()
  const key = getApiKey()
  const model = x.model
  if (!agentStatus(model).configured || !key) return finishNoRun('no_config', '还没有设置 AI 服务。请先到「设置 → AI 服务」填写服务地址、模型和密钥。')
  if (agentStatus(model).toolSupport === 'unknown') {
    send({ sessionId: sid, type: 'status', text: `正在检查「${model}」能不能用于助手……` })
    try { await checkToolSupport(model) } catch (e) {
      const ae = e as AiError
      return finishNoRun(ae.code ?? 'network', ae.message)
    }
  }
  if (agentStatus(model).toolSupport === 'no') {
    return finishNoRun('no_tools', `当前模型（${model}）不支持助手需要的「工具调用」功能。请到「设置 → AI 服务」换一个支持的模型（比如新一些的对话模型），保存后再来。`)
  }
  // 思考强度：低 / 中 / 高要先确认这个服务认这个参数；被拒绝就不带，并如实记下这次实际用的强度
  let effort = x.effort
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    if (effortCache(model) === null) { try { await checkEffortSupport(model) } catch { /* 试探失败就按支持处理，让请求自己说话 */ } }
    if (effortCache(model) === false) effort = 'auto'
  }
  const extraBody = effortBody(effort, cfg.base_url, model)

  pushStep({ kind: 'user', payload: { text, ...attachPayload, model, effort, mode } })
  updateSession(db, sid, { status: 'running' })
  send({ sessionId: sid, type: 'status', text: '' })

  const playbooks = playbooksForRole(allPlaybooks(), role.id)
  const org = clipOrgContext(readOrgContext())
  const chosen = selectedDatasets(sid)
  const system = buildSystemPrompt({ role, scene, playbooks, today: new Date().toLocaleDateString('zh-CN'), mode, orgContext: org.text, datasets: chosen, recent: listSessions(db, 9).filter(r => r.id !== sid && r.title).slice(0, 8).map(r => ({ title: scrubPII(r.title).replace(/\s+/g, ' ').slice(0, 40), date: String(r.updatedAt).slice(5, 10) })), pickedPlaybooks: (x.playbooks ?? []).filter(n => playbooks.some(p => p.name === n)).slice(0, 5) })
  const { registry, dynamic } = buildRegistry()
  // 老角色文件（自建 / 导入）里没有后来加的查询：翻以前的对话所有角色都有；能查数据集的也能读文档；能看试卷统计的也能看试卷清单、课程覆盖、报告
  const extraTools = ['history_search', 'history_read', ...(role.tools.includes('list_datasets') ? ['read_document'] : []), ...(role.tools.includes('stats_overview') ? ['papers_list', 'course_coverage', 'reports_list', 'report_read', 'report_generate', 'paper_import'] : [])]
  const toolNames = [...new Set([...role.tools, ...extraTools, ...(CONNECTOR_ROLES.includes(role.id) ? dynamic : [])])]
  const prices = getPriceMap()
  const lim = effectiveMaxTokens(cfg, model)
  const st = readSetting(SETTINGS_KEY) ?? {}
  const ctxLimit = contextLimitFor(model, typeof st.contextLimit === 'number' ? st.contextLimit : null)
  let sumIn = 0, sumOut = 0, sumCached = 0, lastRounds = 0
  const askSeq = new Map<string, number>()

  const callModel = async (req: Parameters<Parameters<typeof runAgent>[0]['callModel']>[0]): Promise<ModelReply> => {
    const t0 = Date.now()
    try {
      const r = await chat({
        baseUrl: cfg.base_url, apiKey: key, model, messages: req.messages, tools: req.tools.length ? req.tools : undefined, toolChoice: 'auto', extraBody,
        stream: true, temperature: 0.2, maxTokens: lim.maxTokens, timeoutMs: cfg.timeout_sec * 1000, maxRetries: 2, backoffMs: 1000,
        signal: req.signal, fetchImpl, escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback,
        onDelta: req.onDelta,
        onAttempt: a => { if (!a.ok && a.error?.code !== 'aborted') send({ sessionId: sid, type: 'reset' }) }
      })
      recordUsage({ paperId: null, kind: 'agent', model, usage: r.usage, ok: true, ms: Date.now() - t0, attempts: r.attempts })
      sumCached += r.usage.cachedTokens
      notifyDataChanged('usage')
      return { content: r.content, toolCalls: r.toolCalls, usage: { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens }, reasoningText: r.reasoningText }
    } catch (e) {
      if (!(e instanceof AiError && e.code === 'aborted')) recordUsage({ paperId: null, kind: 'agent', model, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
      throw e
    }
  }

  /** 对话快满了：让同一个模型把较早的内容整理成一段进展摘要；失败时 harness 会改用程序生成的摘要 */
  const summarize = async (older: string): Promise<string> => {
    const t0 = Date.now()
    try {
      const r = await chat({
        baseUrl: cfg.base_url, apiKey: key, model, stream: false, temperature: 0, maxTokens: 900, timeoutMs: Math.min(cfg.timeout_sec, 90) * 1000, maxRetries: 1, backoffMs: 800,
        signal: run.ctl.signal, fetchImpl,
        messages: [
          { role: 'system', content: '把下面这段「助手工作记录」整理成一段简短的进展摘要（不超过 600 字，中文）。要写清：已确认的事实和数字、跑过的查询（带「查询 #编号」）及其结论、用户做过的选择和表达过的偏好、还没做完的事。不要编造记录里没有的内容。' },
          { role: 'user', content: older }
        ]
      })
      recordUsage({ paperId: null, kind: 'agent', model, usage: r.usage, ok: true, ms: Date.now() - t0, attempts: r.attempts })
      return r.content
    } catch (e) {
      if (!(e instanceof AiError && e.code === 'aborted')) recordUsage({ paperId: null, kind: 'agent', model, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
      throw e
    }
  }

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case 'delta': send({ sessionId: sid, type: 'delta', text: e.text }); return
      case 'progress': {
        sumIn = e.tokensIn; sumOut = e.tokensOut; lastRounds = e.rounds
        const money = tokensToMoney(sumIn, sumOut, prices[model], sumCached)
        send({ sessionId: sid, type: 'progress', rounds: e.rounds, tokensIn: sumIn, tokensOut: sumOut, money, limitTokens: DEFAULT_BUDGET.maxTokens, model, effort })
        return
      }
      case 'approval': send({ sessionId: sid, type: 'approval', id: e.id, name: e.name, args: e.args, summary: e.summary, ...(e.preview ? { preview: e.preview } : {}) }); return
      case 'tool_progress': send({ sessionId: sid, type: 'tool-progress', id: e.id, done: e.done, total: e.total }); return
      case 'asked': {
        const seq = askSeq.get(e.id)
        if (seq) { updateStepPayload(db, sid, seq, { answer: e.answer }); send({ sessionId: sid, type: 'step-update', seq, payload: { answer: e.answer } }) }
        return
      }
      case 'approved': return
      default: {
        const s = eventToStep(e)
        if (!s) return
        if (e.type === 'answer') Object.assign(s.payload as object, { dataRev: currentDataRev(db), model, effort })
        const seq = pushStep(s)
        if (e.type === 'ask') askSeq.set(e.id, seq)
      }
    }
  }

  try {
    const result = await runAgent({
      callModel, registry, toolNames, mode, approvalMode: x.approval, initialState,
      compact: { limitTokens: ctxLimit, summarize },
      ctx: {
        db, scene, roleId: role.id, sessionId: sid, dataDir: getDataDir(),
        playbook: name => { const p = playbooks.find(y => y.name === name); return p ? { name: p.name, description: p.description, body: p.body } : null },
        playbookNames: () => playbooks.map(p => p.name)
      },
      approve: req => new Promise<boolean>(resolve => { run.approvals.set(req.id, resolve) }),
      askUser: req => new Promise<string>(resolve => { run.asks.set(req.id, resolve) }),
      emit: onEvent, signal: run.ctl.signal, cite: makeCiteChecker(db)
    }, { system, history, user: text + (x.attach?.block ?? '') })
    updateSession(db, sid, { status: 'idle', dataRev: currentDataRev(db), addIn: result.tokensIn, addOut: result.tokensOut })
    send({ sessionId: sid, type: 'done', status: result.stop, rounds: lastRounds || result.rounds, error: result.error ?? null })
  } finally {
    run.asks.clear(); run.approvals.clear()
  }
}

// ───────── 界面的回应 ─────────
export function stopRun(sessionId: string): boolean { const r = runs.get(sessionId); if (!r) return false; r.ctl.abort(); return true }
export function answerAsk(sessionId: string, id: string, answer: string): boolean {
  const r = runs.get(sessionId); const f = r?.asks.get(id)
  if (!r || !f) return false
  r.asks.delete(id); f(answer); return true
}
export function answerApproval(sessionId: string, id: string, ok: boolean): boolean {
  const r = runs.get(sessionId); const f = r?.approvals.get(id)
  if (!r || !f) return false
  r.approvals.delete(id); f(ok); return true
}

// ───────── 给界面的会话内容（代号还原成真名）与查询记录 ─────────
export function sessionView(id: string) {
  const r = getSession(getDb(), id)
  if (!r) return null
  return { ...r, steps: r.steps.map(x => ({ ...x, payload: showPayload(id, x.kind, x.payload) })), running: isRunning(id) }
}

/** [[query:N]] 点开后看的内容：这次查询的工具、参数（SQL）和结果摘要；代号已还原 */
export function queryRecord(sessionId: string, n: number) {
  const r = getSession(getDb(), sessionId)
  if (!r) return null
  const call = r.steps.find(x => x.kind === 'tool_result' && x.payload?.n === n)
  const callStep = call ? r.steps.find(x => x.kind === 'tool_call' && x.payload?.id === call.payload.id) : undefined
  if (!call) return null
  const args = (callStep?.payload?.args ?? {}) as Record<string, unknown>
  const show = <T,>(v: T): T => restoreDeep(sessionId, v)
  return show({ n, name: String(call.payload.name), ok: call.payload.ok !== false, sql: typeof args.sql === 'string' ? args.sql : null, args, summary: String(call.payload.summary ?? ''), text: String(call.payload.text ?? ''), truncated: !!call.payload.truncated })
}
