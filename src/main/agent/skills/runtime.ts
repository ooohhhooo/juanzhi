/**
 * Skill 成长的运行时接线（依赖 electron 里的 AI 配置、网络和数据库；单测不加载它）：
 * 回答完成后的记录与提示、从几次对话起草 Skill、更新草稿、「先试一次」。纯逻辑都在 skills/*.ts。
 */
import { getDb, getDataDir } from '../../db'
import { chat, AiError } from '../../ai/client'
import { loadConfig, recordUsage } from '../../ai/config'
import { getApiKey } from '../../ai/secret'
import { effectiveMaxTokens } from '../../ai/providers'
import { parseModelOf } from '../../ai/types'
import { jsonCall } from '../../course/service'
import { runAgent } from '../harness'
import { buildSystemPrompt } from '../prompt'
import { BASE_TOOLS, roleName } from '../roles'
import { buildRegistry, findRole, getScene, toolList } from '../service'
import { restoreDeep, restoreNames } from '../names'
import { makeCiteChecker, sessionSubject } from '../store'
import { net } from 'electron'
import { buildDraftUser, composeBody, DRAFT_SYSTEM, normalizeDraft } from './draft'
import type { SkillDraft } from './draft'
import { groupRefsFor, loadSample, loadSamples, getMeta, updateSuggestion } from './store'
import type { LoadedSample } from './store'
import { condense, pickBest, toolNamesOf } from './turns'

const running = new Map<string, AbortController>()
export function cancelSkillJob(reqId: string): boolean { const c = running.get(reqId); if (!c) return false; c.abort(); return true }

function aiReady(): { model: string } {
  const cfg = loadConfig()
  const model = parseModelOf(cfg)
  if (!cfg.base_url || !model || !getApiKey()) throw new Error('还没有配置 AI 服务，请先在设置里配置 AI 服务')
  return { model }
}

export interface SampleView { n: number; sessionId: string; answerSeq: number; title: string; request: string; rating: number | null; exported: boolean; revised: boolean }
export interface DraftView {
  draft: SkillDraft
  role: string
  samples: SampleView[]
  sampleCount: number
  thin: boolean
  /** 保存时要记下的来源 */
  sources: Array<{ sessionId: string; answerSeq: number }>
  oldBody?: string
  name?: string
}

const sampleViews = (list: LoadedSample[]): SampleView[] => list.map((s, i) => ({ n: i + 1, sessionId: s.sessionId, answerSeq: s.answerSeq, title: restoreNames(s.sessionId, s.title), request: restoreNames(s.sessionId, s.turn.request).slice(0, 80), rating: s.signals.rating, exported: s.signals.exported, revised: s.signals.revised }))

function roleToolSet(roleId: string): Set<string> {
  const r = findRole(roleId)
  return new Set([...(r?.tools ?? []), 'history_search', 'history_read'])
}

async function runDraft(reqId: string, samples: LoadedSample[], roleId: string, extra: { oldBody?: string; revisions?: string[] }): Promise<{ draft: SkillDraft }> {
  const { model } = aiReady()
  const role = findRole(roleId)
  if (!role) throw new Error('找不到这个角色')
  const tools = toolList()
  const roleTools = roleToolSet(roleId)
  const labelOf = Object.fromEntries(tools.map(t => [t.name, t.label]))
  const shown = tools.filter(t => roleTools.has(t.name) && !BASE_TOOLS.includes(t.name))
  const condensed = samples.map((s, i) => condense({ sessionId: s.sessionId, answerSeq: s.answerSeq, turn: s.turn, signals: s.signals, finalAnswer: s.finalAnswer, revisions: s.revisions }, i + 1))
  const ctl = new AbortController()
  running.set(reqId, ctl)
  try {
    const r = await jsonCall({ kind: 'agent-skill-draft', model, signal: ctl.signal, system: DRAFT_SYSTEM, user: buildDraftUser(condensed, { roleName: roleName(role, getScene()), tools: shown, ...extra }) })
    const draft = normalizeDraft(r.content, samples.map(s => toolNamesOf(s.turn)), { knownTools: new Set(tools.map(t => t.name)), roleTools, labels: labelOf })
    if (!draft) throw new Error('AI 的回答不是有效的 Skill 草稿，请再试一次')
    return { draft }
  } finally { running.delete(reqId) }
}

/** 从某次回答出发起草：同一类的几次对话一起用；只有这一次也可以（会标注「可能不够通用」） */
export async function draftFromAnswer(reqId: string, sessionId: string, answerSeq: number): Promise<DraftView> {
  const db = getDb()
  const members = groupRefsFor(db, sessionId, answerSeq)
  const refs: Array<{ sessionId: string; answerSeq: number }> = members.length ? members.map(m => ({ sessionId: m.sessionId, answerSeq: m.answerSeq })) : [{ sessionId, answerSeq }]
  if (!refs.some(r => r.sessionId === sessionId && r.answerSeq === answerSeq)) refs.push({ sessionId, answerSeq })
  let loaded = loadSamples(db, refs.map(r => ({ sessionId: r.sessionId, answerSeq: r.answerSeq })))
  const me = loaded.find(s => s.sessionId === sessionId && s.answerSeq === answerSeq)
  let best = pickBest(loaded.map(s => ({ ...s, signals: s.signals })), 5)
  if (me && !best.some(s => s === me || (s.sessionId === sessionId && s.answerSeq === answerSeq))) best = [me, ...best.slice(0, 4)]
  if (!best.length && me) best = [me]
  loaded = best
  const role = getSessionRole(sessionId)
  const { draft } = await runDraft(reqId, loaded, role, {})
  return { draft, role, samples: sampleViews(loaded), sampleCount: loaded.length, thin: loaded.length < 3, sources: loaded.map(s => ({ sessionId: s.sessionId, answerSeq: s.answerSeq })) }
}

function getSessionRole(sessionId: string): string {
  const r = getDb().prepare('SELECT role FROM agent_sessions WHERE id = ?').get(sessionId) as { role: string } | undefined
  return r?.role ?? 'ops'
}

/** 更新建议：用最近几次使用的对话 + 用户的修改意见，在旧版基础上重新起草 */
export async function draftUpdate(reqId: string, name: string, oldBody: string): Promise<DraftView> {
  const db = getDb()
  const u = updateSuggestion(db, name)
  const meta = getMeta(db, name)
  const rows = db.prepare('SELECT session_id, answer_seq FROM skill_use WHERE skill_name = ? AND skill_version = ? ORDER BY id DESC LIMIT 5').all(name, meta?.version ?? 1) as Array<{ session_id: string; answer_seq: number }>
  const loaded = rows.map(r => loadSample(db, r.session_id, r.answer_seq)).filter((x): x is LoadedSample => !!x)
  if (!loaded.length) throw new Error('找不到最近的使用记录')
  const roleId = getSessionRole(loaded[0].sessionId)
  const revisions = u?.revisions?.length ? u.revisions : loaded.flatMap(s => (s.signals.reviseText ? [s.signals.reviseText] : []))
  const { draft } = await runDraft(reqId, loaded, roleId, { oldBody, revisions: revisions.map(r => r.slice(0, 120)) })
  return { draft: { ...draft, name }, role: roleId, samples: sampleViews(loaded), sampleCount: loaded.length, thin: false, sources: loaded.map(s => ({ sessionId: s.sessionId, answerSeq: s.answerSeq })), oldBody, name }
}

// ───────── 先试一次 ─────────
/** 试跑只用「纯查询」工具：不能对外发送、不能写文件 / 看板 / 文档、不能连外部服务 */
const TRY_BLOCK = /^(board_|doc_|table_save|card_make|output_|wecom_|connectors_|mcp_|paper_import|report_generate|delegate_tasks|history_)/
export const isTrySafe = (name: string, level: string): boolean => level === 'read' && !TRY_BLOCK.test(name)

export interface TryResult { newAnswer: string; originalAnswer: string; request: string; toolsUsed: string[]; blocked: string[]; stop: string }

export async function tryRun(reqId: string, v: { sessionId: string; answerSeq: number; role: string; name: string; description: string; when: string; body: string }): Promise<TryResult> {
  const { model } = aiReady()
  const db = getDb()
  const sample = loadSample(db, v.sessionId, v.answerSeq)
  if (!sample) throw new Error('找不到这次对话')
  const role = findRole(v.role)
  if (!role) throw new Error('找不到这个角色')
  const cfg = loadConfig()
  const key = getApiKey()!
  const lim = effectiveMaxTokens(cfg, model)
  const { registry } = buildRegistry()
  const all = [...new Set([...role.tools, 'read_document'])].filter(n => registry.get(n))
  const toolNames = all.filter(n => ['update_plan', 'ask_user', 'load_playbook', 'session_state'].includes(n) || isTrySafe(n, registry.get(n)!.level))
  const blocked = all.filter(n => !toolNames.includes(n) && !BASE_TOOLS.includes(n))
  const ctl = new AbortController()
  running.set(reqId, ctl)
  const used: string[] = []
  const pb = { name: v.name, description: v.description, roles: [role.id], when: v.when, body: v.body, source: 'user' as const }
  try {
    const system = buildSystemPrompt({ subject: sessionSubject(db, v.sessionId), role, scene: getScene(), playbooks: [pb], today: new Date().toLocaleDateString('zh-CN'), mode: 'auto', pickedPlaybooks: [v.name] }) +
      '\n\n# 试跑\n这是在试用一份还没保存的 Skill：只能查数据，不会发送、不会生成文件；照 Skill 的步骤做，需要生成文件的步骤跳过即可。'
    const r = await runAgent({
      callModel: async req => {
        const t0 = Date.now()
        try {
          const x = await chat({ baseUrl: cfg.base_url, apiKey: key, model, messages: req.messages, tools: req.tools.length ? req.tools : undefined, toolChoice: 'auto', stream: false, temperature: 0.2, maxTokens: lim.maxTokens, timeoutMs: cfg.timeout_sec * 1000, maxRetries: 1, backoffMs: 800, signal: req.signal, fetchImpl: net.fetch as unknown as typeof fetch, escalateOnLength: { ceiling: lim.ceiling }, maxTokensFallback: lim.fallback })
          recordUsage({ paperId: null, kind: 'agent', model, usage: x.usage, ok: true, ms: Date.now() - t0, attempts: x.attempts })
          return { content: x.content, toolCalls: x.toolCalls, usage: { promptTokens: x.usage.promptTokens, completionTokens: x.usage.completionTokens }, reasoningText: x.reasoningText }
        } catch (e) {
          if (!(e instanceof AiError && e.code === 'aborted')) recordUsage({ paperId: null, kind: 'agent', model, ok: false, ms: Date.now() - t0, errCode: e instanceof AiError ? e.code : 'other' })
          throw e
        }
      },
      registry, toolNames, mode: 'auto', approvalMode: 'ask-all',
      budget: { maxRounds: 14, maxTokens: 200_000, maxMs: 4 * 60_000 },
      ctx: { db, scene: getScene(), roleId: role.id, sessionId: v.sessionId, dataDir: getDataDir(), playbook: n => (n === v.name ? { name: v.name, description: v.description, body: v.body } : null), playbookNames: () => [v.name] },
      approve: async () => false,
      askUser: async () => '你自己按最常见的理解做，并在结论里说明假设',
      emit: e => { if (e.type === 'tool_call' && !used.includes(e.name)) used.push(e.name) },
      signal: ctl.signal, cite: makeCiteChecker(db)
    }, { system, history: [], user: sample.turn.request })
    const strip = (t: string) => t.replace(/\[\[query:\d+\]\]/g, '')
    return {
      newAnswer: strip(restoreDeep(v.sessionId, r.answer)), originalAnswer: strip(restoreDeep(v.sessionId, sample.finalAnswer ?? sample.turn.answer)),
      request: restoreNames(v.sessionId, sample.turn.request), toolsUsed: used.filter(n => !['update_plan', 'ask_user', 'load_playbook', 'session_state'].includes(n)), blocked, stop: r.stop
    }
  } finally { running.delete(reqId) }
}

export { composeBody }
