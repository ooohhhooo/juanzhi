/**
 * Skill 成长（从多次对话里长出 Skill、回答打分、版本历史、先试一次）和定制包（导出 / 导入配置）的 IPC。
 * 写文件只写用户在「另存为」里选的位置；导入的文件只读成文字，不执行任何东西。
 */
import { dialog, ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import { getDb } from '../db'
import { getMainWindow } from '../window'
import { allToolNames, customRoles, saveRole, userPlaybookDir } from '../agent/service'
import { listUserSkillFiles } from '../agent/playbooks/manage'
import { composeBody } from '../agent/skills/compose'
import { allMeta, deleteSkillMeta, dismissCreate, dismissUpdate, getMeta, listVersions, readVersionText, restoreVersion, saveSkillVersioned, setRating, turnFp, turnInfo, updateSuggestion } from '../agent/skills/store'
import { cancelSkillJob, draftFromAnswer, draftUpdate, tryRun } from '../agent/skills/runtime'
import { buildPack, applyPack, parsePack, previewPack, PACK_EXT, serializePack, MAX_PACK_BYTES } from '../agent/pack/pack'
import type { CurrentState, Pack } from '../agent/pack/pack'
import { customPromptOverrides, importPromptOverride } from '../ai/prompts'
import { exportableEntries, importPackEntry } from '../connectors/store'
import { BUILTIN_PLAYBOOK_FILES } from '../agent/playbooks/index'
import { parsePlaybook } from '../agent/playbooks/parse'

const Id = z.string().min(1).max(80)
const BUILTIN_ROLES = ['ops', 'tutor', 'research', 'teacher']

const DraftZ = z.object({
  name: z.string().trim().min(1).max(40), description: z.string().max(300), when: z.string().max(300).default(''),
  params: z.array(z.object({ name: z.string().max(12), hint: z.string().max(60) })).max(8).default([]),
  steps: z.array(z.object({ id: z.string().max(10), text: z.string().max(300), tool: z.string().max(64).default(''), optional: z.boolean().default(false), condition: z.string().max(100).default(''), hit: z.number().default(0), total: z.number().default(0), evidence: z.array(z.number()).default([]), basis: z.enum(['tool', 'claimed']).default('tool') })).max(30),
  output: z.string().max(1500).default(''), checklist: z.array(z.string().max(80)).max(8).default([]),
  warnings: z.array(z.string()).default([])
})
const SourcesZ = z.array(z.object({ sessionId: Id, answerSeq: z.number().int().min(1) })).max(20)

function userSkillList() {
  const dir = userPlaybookDir()
  return listUserSkillFiles(dir).map(f => f.playbook)
}

const pending = new Map<string, { pack: Pack; at: number }>()

function currentState(): CurrentState {
  const db = getDb()
  const mine = userSkillList()
  const builtin = new Set(Object.values(BUILTIN_PLAYBOOK_FILES).map(t => { const r = parsePlaybook(t); return r.ok ? r.playbook.name : '' }).filter(Boolean))
  return {
    roles: customRoles(),
    userSkills: mine.map(p => ({ name: p.name, description: p.description, when: p.when, body: p.body, version: getMeta(db, p.name)?.version ?? 1 })),
    builtinSkillNames: builtin,
    prompts: customPromptOverrides(),
    connectors: exportableEntries().map(e => ({ type: e.type, name: e.name })),
    knownTools: new Set(allToolNames())
  }
}

export function registerAgentSkillsIpc(): void {
  const db = () => getDb()

  // ── 回答下面的条：打分、提示 ──
  ipcMain.handle('skills:turnInfo', async (_e, sid: unknown, seq: unknown) => turnInfo(db(), Id.parse(sid), z.number().int().min(1).parse(seq)))
  ipcMain.handle('skills:rate', async (_e, sid: unknown, seq: unknown, rating: unknown) => { setRating(db(), Id.parse(sid), z.number().int().min(1).parse(seq), z.union([z.literal(1), z.literal(-1), z.null()]).parse(rating)); return true })
  ipcMain.handle('skills:dismissCreate', async (_e, sid: unknown, seq: unknown) => { dismissCreate(db(), Id.parse(sid), z.number().int().min(1).parse(seq)); return true })
  ipcMain.handle('skills:dismissUpdate', async (_e, name: unknown) => { dismissUpdate(db(), z.string().min(1).max(60).parse(name)); return true })

  // ── 起草、更新、试跑（调用 AI，可取消）──
  ipcMain.handle('skills:draft', async (_e, reqId: unknown, sid: unknown, seq: unknown) => draftFromAnswer(z.string().min(1).max(60).parse(reqId), Id.parse(sid), z.number().int().min(1).parse(seq)))
  ipcMain.handle('skills:draftUpdate', async (_e, reqId: unknown, name: unknown) => {
    const n = z.string().min(1).max(60).parse(name)
    const p = userSkillList().find(x => x.name === n)
    if (!p) throw new Error('找不到这个 Skill')
    return draftUpdate(z.string().min(1).max(60).parse(reqId), n, p.body)
  })
  ipcMain.handle('skills:cancel', async (_e, reqId: unknown) => cancelSkillJob(z.string().min(1).max(60).parse(reqId)))
  ipcMain.handle('skills:tryRun', async (_e, raw: unknown) => {
    const p = z.object({ reqId: z.string().min(1).max(60), sessionId: Id, answerSeq: z.number().int().min(1), role: z.string().max(40), draft: DraftZ }).parse(raw)
    return tryRun(p.reqId, { sessionId: p.sessionId, answerSeq: p.answerSeq, role: p.role, name: p.draft.name, description: p.draft.description, when: p.draft.when, body: composeBody(p.draft) })
  })

  // ── 保存（新建 / 更新）、版本 ──
  ipcMain.handle('skills:save', async (_e, raw: unknown) => {
    const p = z.object({ draft: DraftZ, role: z.string().max(40), sources: SourcesZ.default([]), sampleCount: z.number().int().min(0).max(99), originalName: z.string().max(60).optional() }).parse(raw)
    const body = composeBody(p.draft)
    const roles = BUILTIN_ROLES.includes(p.role) ? [p.role] : []
    const first = p.originalName ? getMeta(db(), p.originalName) : null
    return saveSkillVersioned(userPlaybookDir(), db(), { name: p.draft.name, description: p.draft.description, roles, when: p.draft.when, body }, {
      originalName: p.originalName, knownTools: allToolNames(), sources: p.originalName ? [...(first?.sources ?? []), ...p.sources].slice(-20) : p.sources,
      sampleCount: p.sampleCount, fp: p.originalName ? first?.fp ?? null : (p.sources[0] ? turnFp(db(), p.sources[0].sessionId, p.sources[0].answerSeq) : null)
    })
  })
  ipcMain.handle('skills:meta', async () => {
    const list = allMeta(db())
    return list.map(m => ({ name: m.name, version: m.version, sampleCount: m.sampleCount, thin: m.sampleCount > 0 && m.sampleCount < 3, update: (() => { const u = updateSuggestion(db(), m.name); return u ? { count: u.count, hint: u.hint } : null })() }))
  })
  ipcMain.handle('skills:versions', async (_e, name: unknown) => listVersions(userPlaybookDir(), db(), z.string().min(1).max(60).parse(name)))
  ipcMain.handle('skills:versionText', async (_e, name: unknown, v: unknown) => readVersionText(userPlaybookDir(), z.string().min(1).max(60).parse(name), z.number().int().min(1).parse(v)))
  ipcMain.handle('skills:restore', async (_e, name: unknown, v: unknown) => restoreVersion(userPlaybookDir(), db(), z.string().min(1).max(60).parse(name), z.number().int().min(1).parse(v), allToolNames()))
  ipcMain.handle('skills:forget', async (_e, name: unknown) => { deleteSkillMeta(db(), z.string().min(1).max(60).parse(name)); return true })

  // ── 定制包 ──
  ipcMain.handle('pack:list', async () => {
    const cur = currentState()
    return {
      roles: cur.roles.map(r => ({ key: r.name, title: r.name })),
      skills: cur.userSkills.map(s => ({ key: s.name, title: `${s.name}（版本 ${s.version}）` })),
      prompts: Object.keys(cur.prompts).map(k => ({ key: k, title: k })),
      connectors: exportableEntries().map(c => ({ key: `${c.type}:${c.name}`, title: c.name }))
    }
  })
  ipcMain.handle('pack:export', async (_e, raw: unknown) => {
    const sel = z.object({ roles: z.array(z.string()), skills: z.array(z.string()), prompts: z.array(z.string()), connectors: z.array(z.string()) }).parse(raw)
    const cur = currentState()
    const metaOf = (n: string) => getMeta(db(), n)
    const prompts = Object.fromEntries(Object.entries(cur.prompts).filter(([k]) => sel.prompts.includes(k)))
    const { pack, warnings } = buildPack({
      roles: cur.roles.filter(r => sel.roles.includes(r.name)),
      skills: userSkillList().filter(p => sel.skills.includes(p.name)).map(p => ({ name: p.name, description: p.description, roles: p.roles, when: p.when, body: p.body, version: metaOf(p.name)?.version ?? 1, sampleCount: metaOf(p.name)?.sampleCount ?? 0 })),
      prompts,
      connectors: exportableEntries().filter(c => sel.connectors.includes(`${c.type}:${c.name}`))
    })
    const total = pack.roles.length + pack.skills.length + Object.keys(pack.prompts).length + pack.connectors.length
    if (!total) throw new Error('还没有勾选要导出的内容')
    const win = getMainWindow()
    const opts = { title: '导出给同事用的配置包', defaultPath: `卷知配置包${PACK_EXT}`, filters: [{ name: '卷知配置包', extensions: ['json'] }] }
    const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (pick.canceled || !pick.filePath) return { saved: false, count: total, warnings }
    fs.writeFileSync(pick.filePath, serializePack(pack), 'utf8')
    return { saved: true, path: pick.filePath, count: total, warnings }
  })
  ipcMain.handle('pack:importPick', async () => {
    const win = getMainWindow()
    const opts = { title: '导入同事给的配置包', properties: ['openFile' as const], filters: [{ name: '卷知配置包', extensions: ['json'] }] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return { picked: false }
    const f = pick.filePaths[0]
    if (fs.statSync(f).size > MAX_PACK_BYTES) return { picked: true, ok: false, error: '这个文件太大，不像是配置包。' }
    return previewFile(fs.readFileSync(f, 'utf8'))
  })
  ipcMain.handle('pack:importApply', async (_e, id: unknown, keys: unknown) => {
    const p = pending.get(Id.parse(id))
    if (!p) throw new Error('这个导入已经过期，请重新选择文件')
    const selected = new Set(z.array(z.string().max(200)).max(300).parse(keys))
    const cur = currentState()
    const res = applyPack(p.pack, cur, selected, {
      saveRole: (r, existingId) => { saveRole({ ...r, id: existingId ?? undefined }) },
      saveSkill: (s, existed) => {
        const roles = s.roles.filter(r => BUILTIN_ROLES.includes(r))
        const x = saveSkillVersioned(userPlaybookDir(), db(), { name: s.name, description: s.description, roles, when: s.when, body: s.body, origin: 'imported' }, { originalName: existed ?? undefined, knownTools: allToolNames(), sampleCount: s.sampleCount, version: s.version })
        return { warnings: x.warnings }
      },
      savePrompt: (k, t) => importPromptOverride(k, t),
      saveConnector: c => importPackEntry(c)
    })
    pending.delete(id as string)
    return res
  })
}

function previewFile(text: string) {
  const r = parsePack(text)
  if (!r.ok) return { picked: true, ok: false, error: r.error }
  const id = crypto.randomUUID()
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k)
  pending.set(id, { pack: r.pack, at: Date.now() })
  return { picked: true, ok: true, id, createdAt: r.pack.createdAt, items: previewPack(r.pack, currentState()), dropped: r.dropped }
}

