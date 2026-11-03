import { dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getDb } from '../db'
import { lessonName } from '../course/map'
import { getMainWindow } from '../window'
import {
  agentSettingsView, agentStatus, allPlaybooks, answerApproval, answerAsk, checkEffortSupport, checkToolSupport, customRoles, exportRole, getScene, importRoleText,
  modelInfo, queryRecord, sessionView, initAgent, modelsView, removeRole, resetStaleRunning, rolesView, saveAgentSettings, saveRole, setScene, startRun, stopRun, toolList, userPlaybookDir, allToolNames
} from '../agent/service'
import { deleteSkill, importSkillFile, importSkillFolder, listUserSkillFiles, saveSkill, skillText } from '../agent/playbooks/manage'
import { BUILTIN_PLAYBOOK_FILES } from '../agent/playbooks/index'
import { parsePlaybook } from '../agent/playbooks/parse'
import { deleteSession, listSessions } from '../agent/store'
import { AGENT_MODES, APPROVAL_MODES } from '../agent/types'

const IdSchema = z.string().min(1).max(80)
const ModelSchema = z.string().trim().min(1).max(120)

const RoleInput = z.object({
  id: z.string().max(40).optional(), name: z.string().trim().min(1).max(20), description: z.string().max(400).default(''),
  tools: z.array(z.string().max(64)).max(40).default([]), suggestions: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  defaultPlaybook: z.string().max(60).optional(), notes: z.string().max(1500).default('')
})

export function registerAgentIpc(): void {
  const db = () => getDb()
  initAgent()
  try { resetStaleRunning() } catch { /* 表还没建好就算了 */ }
  // ── 只读：角色、场景、状态、模型、工具、历史、引用解析、设置 ──
  ipcMain.handle('agent:roles', async () => rolesView())
  ipcMain.handle('agent:status', async (_e, model?: unknown) => agentStatus(model === undefined ? undefined : ModelSchema.parse(model)))
  ipcMain.handle('agent:models', async () => modelsView())
  ipcMain.handle('agent:modelInfo', async (_e, model: unknown) => modelInfo(ModelSchema.parse(model)))
  ipcMain.handle('agent:tools', async () => toolList())
  ipcMain.handle('agent:customRoles', async () => customRoles())
  ipcMain.handle('agent:settings', async () => agentSettingsView())
  ipcMain.handle('agent:playbooks', async () => {
    const origins = new Map(listUserSkillFiles(userPlaybookDir()).map(f => [f.playbook.name, f.origin]))
    return { dir: userPlaybookDir(), items: allPlaybooks().map(p => ({ name: p.name, description: p.description, roles: p.roles, when: p.when, source: p.source, origin: p.source === 'user' ? origins.get(p.name) : undefined })) }
  })
  ipcMain.handle('agent:playbookGet', async (_e, name: unknown) => {
    const n = z.string().min(1).max(60).parse(name)
    const p = allPlaybooks().find(x => x.name === n)
    return p ? { name: p.name, description: p.description, roles: p.roles, when: p.when, body: p.body, source: p.source } : null
  })
  // 导出 Skill：只写用户在「另存为」里选的文件
  ipcMain.handle('agent:playbookExport', async (_e, name: unknown) => {
    const p = allPlaybooks().find(x => x.name === z.string().min(1).max(60).parse(name))
    if (!p) throw new Error('找不到这个 Skill')
    const win = getMainWindow()
    const opts = { title: '导出 Skill', defaultPath: `${p.name}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }
    const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (pick.canceled || !pick.filePath) return { saved: false }
    fs.writeFileSync(pick.filePath, skillText(p), 'utf8')
    return { saved: true, path: pick.filePath }
  })
  ipcMain.handle('agent:playbookOpenDir', async () => { const d = userPlaybookDir(); fs.mkdirSync(d, { recursive: true }); await shell.openPath(d); return d })
  ipcMain.handle('agent:sessions', async () => listSessions(db()))
  ipcMain.handle('agent:session', async (_e, id: unknown) => {
    return sessionView(IdSchema.parse(id))
  })
  ipcMain.handle('agent:queryRecord', async (_e, sid: unknown, n: unknown) => queryRecord(IdSchema.parse(sid), z.number().int().min(1).max(100000).parse(n)))
  // 导出角色：只写用户在「另存为」里选的文件
  ipcMain.handle('agent:exportRole', async (_e, id: unknown) => {
    const r = exportRole(IdSchema.parse(id))
    if (!r) throw new Error('找不到这个角色')
    const win = getMainWindow()
    const opts = { title: '导出角色', defaultPath: `${r.name}.json`, filters: [{ name: '角色文件', extensions: ['json'] }] }
    const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (pick.canceled || !pick.filePath) return { saved: false }
    fs.writeFileSync(pick.filePath, r.text, 'utf8')
    return { saved: true, path: pick.filePath }
  })

  // 引用标签：把回答里的 [[q:ID]] / [[lesson:ID]] 解析成可点击跳转的信息
  ipcMain.handle('agent:cites', async (_e, raw: unknown) => {
    const refs = z.array(z.object({ kind: z.enum(['query', 'q', 'lesson', 'stu']), id: z.string().min(1).max(64) })).max(60).parse(raw)
    return refs.map(r => {
      if (r.kind === 'q') {
        const x = db().prepare('SELECT q.paper_id, q.no_label, q.no, p.title FROM questions q JOIN papers p ON p.id = q.paper_id WHERE q.id = ?').get(r.id) as any
        return x ? { ...r, ok: true, label: `${String(x.title).slice(0, 14)} 第${x.no_label ?? x.no}题`, paperId: x.paper_id as string } : { ...r, ok: false, label: '', paperId: null }
      }
      if (r.kind === 'lesson' && /^\d{1,12}$/.test(r.id)) {
        const x = db().prepare('SELECT l.seq, l.no_label, l.title, l.outline_id FROM course_lessons l WHERE l.id = ?').get(Number(r.id)) as any
        return x ? { ...r, ok: true, label: lessonName({ seq: x.seq, noLabel: x.no_label, title: x.title }), outlineId: x.outline_id as string } : { ...r, ok: false, label: '' }
      }
      if (r.kind === 'query') return { ...r, ok: /^\d{1,6}$/.test(r.id), label: `#${r.id}` }
      return { ...r, ok: false, label: '' }
    })
  })

  // ── 写入类：改设置 / 调用 AI / 写会话与角色文件 ──
  ipcMain.handle('agent:setScene', async (_e, raw: unknown) => { setScene(z.enum(['org', 'school']).parse(raw)); return getScene() })
  ipcMain.handle('agent:checkTools', async (_e, model?: unknown) => checkToolSupport(model === undefined ? undefined : ModelSchema.parse(model)))   // 发一次小请求并写 ai_usage
  ipcMain.handle('agent:checkEffort', async (_e, model: unknown) => checkEffortSupport(ModelSchema.parse(model)))
  ipcMain.handle('agent:run', async (_e, raw: unknown) => {
    const p = z.object({
      sessionId: IdSchema.optional(), role: z.string().min(1).max(40), text: z.string().trim().min(1).max(2000),
      mode: z.enum(AGENT_MODES as [string, ...string[]]).optional(), approval: z.enum(APPROVAL_MODES as [string, ...string[]]).optional(), model: z.string().max(120).optional(), effort: z.string().max(10).optional(),
      branchFrom: z.number().int().min(1).optional(), branchId: z.string().max(40).optional(), datasets: z.array(z.string().max(80)).max(20).optional(), playbooks: z.array(z.string().max(60)).max(5).optional()
    }).parse(raw)
    return startRun(p as Parameters<typeof startRun>[0])
  })
  ipcMain.handle('agent:deleteSession', async (_e, id: unknown) => deleteSession(db(), IdSchema.parse(id)))
  ipcMain.handle('agent:saveRole', async (_e, raw: unknown) => saveRole(RoleInput.parse(raw)))
  ipcMain.handle('agent:deleteRole', async (_e, id: unknown) => removeRole(IdSchema.parse(id)))
  ipcMain.handle('agent:importRole', async () => {
    const win = getMainWindow()
    const opts = { title: '导入角色', properties: ['openFile' as const], filters: [{ name: '角色文件', extensions: ['json'] }] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return { picked: false }
    const f = pick.filePaths[0]
    if (fs.statSync(f).size > 64 * 1024) return { picked: true, ok: false, error: '这个文件太大，不像是角色文件。' }
    return { picked: true, ...importRoleText(fs.readFileSync(f, 'utf8')) }
  })
  ipcMain.handle('agent:playbookSave', async (_e, raw: unknown) => {
    const p = z.object({
      name: z.string().trim().min(1).max(40), description: z.string().max(300), roles: z.array(z.enum(['ops', 'tutor', 'research', 'teacher'])).max(4).default([]),
      when: z.string().max(300).default(''), body: z.string().max(70000), originalName: z.string().max(60).optional()
    }).parse(raw)
    return saveSkill(userPlaybookDir(), p, { originalName: p.originalName, knownTools: allToolNames() })
  })
  ipcMain.handle('agent:playbookDelete', async (_e, name: unknown) => deleteSkill(userPlaybookDir(), z.string().min(1).max(60).parse(name)))
  // 导入：file = 选一个 .md；folder = 选一个含 SKILL.md 的文件夹（只读 SKILL.md，其他文件不导入也不执行）
  ipcMain.handle('agent:playbookImport', async (_e, kind: unknown) => {
    const k = z.enum(['file', 'folder']).parse(kind)
    const win = getMainWindow()
    const opts = k === 'file'
      ? { title: '导入 Skill', properties: ['openFile' as const], filters: [{ name: 'Markdown', extensions: ['md'] }] }
      : { title: '导入 Skill 文件夹（里面要有 SKILL.md）', properties: ['openDirectory' as const] }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths[0]) return { picked: false }
    try {
      const r = k === 'file' ? importSkillFile(userPlaybookDir(), pick.filePaths[0], allToolNames()) : importSkillFolder(userPlaybookDir(), pick.filePaths[0], allToolNames())
      return { picked: true, ok: true, ...r }
    } catch (e) { return { picked: true, ok: false, error: (e as Error).message } }
  })
  ipcMain.handle('agent:saveSettings', async (_e, raw: unknown) => {
    const p = z.object({ orgContext: z.string().max(20000).optional(), contextLimit: z.number().int().min(8000).max(1000000).nullable().optional() }).parse(raw)
    return saveAgentSettings(p)
  })

  // ── 只改内存：停止、回答提问、同意 / 拒绝 ──
  ipcMain.handle('agent:stop', async (_e, id: unknown) => stopRun(IdSchema.parse(id)))
  ipcMain.handle('agent:answer', async (_e, sid: unknown, askId: unknown, answer: unknown) => answerAsk(IdSchema.parse(sid), IdSchema.parse(askId), z.string().trim().min(1).max(500).parse(answer)))
  ipcMain.handle('agent:approve', async (_e, sid: unknown, id: unknown, ok: unknown) => answerApproval(IdSchema.parse(sid), IdSchema.parse(id), z.boolean().parse(ok)))
}
