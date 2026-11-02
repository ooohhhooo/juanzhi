/**
 * 导出诊断信息（设置 → 关于；命令行 `diagnostics --out`）。内容由 diagnostics-core.ts 里的规则决定：默认不含学生数据和密钥。
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import { getDb, getDataDir, LATEST_SCHEMA } from './db'
import { loadConfig } from './ai/config'
import { hasStoredKey, keyStorage } from './ai/secret'
import { getOcrStatus } from './pipeline/ocr'
import { extractQueueState } from './pipeline/queue'
import { parseQueueState, throttleState } from './parse/queue'
import { isQueuePaused } from './pipeline/control'
import { isPowerBlocking } from './power'
import { logFiles } from './log'
import { sanitize } from './log-core'
import { getApiKey } from './ai/secret'
import { buildReadme, scrubConfig, shortPaperId, toCsv, shortDiagnosis, feedbackUrl } from './diagnostics-core'
import type { DiagEntryMeta } from './diagnostics-core'

export interface DiagEntry extends DiagEntryMeta { data: Buffer }

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8')
const text = (s: string): Buffer => Buffer.from(s, 'utf8')

/** 允许进诊断包的界面设置（名字固定的白名单，其余设置一概不带） */
const SETTING_KEYS = ['ui_theme', 'ui_language', 'show_internal_codes', 'admin_open', 'onboarding_done', 'default_textbook', 'beta_welcome_seen', 'role_guide_dismissed']

export async function collectDiagnostics(): Promise<DiagEntry[]> {
  const db = getDb()
  const entries: DiagEntry[] = []
  const add = (name: string, desc: string, data: Buffer) => entries.push({ name, desc, data, bytes: data.length })
  const secrets = (() => { try { const k = getApiKey(); return k ? [k] : [] } catch { return [] } })()
  const dataDir = getDataDir()
  const now = new Date()

  // 汇总
  let disk: { freeGB: number; totalGB: number } | null = null
  try { const st = fs.statfsSync(dataDir); disk = { freeGB: Math.round((st.bavail * st.bsize) / 1e8) / 10, totalGB: Math.round((st.blocks * st.bsize) / 1e8) / 10 } } catch { /* 取不到就算了 */ }
  const byStatus: Record<string, number> = {}
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM papers WHERE is_sample = 0 GROUP BY status').all() as Array<{ status: string; c: number }>) byStatus[r.status] = r.c
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  const ocr = await getOcrStatus().catch(e => ({ available: false, detail: String((e as Error).message) }))
  add('summary.json', '软件版本、系统、内存、磁盘、数据库版本、各状态试卷数量', json({
    generatedAt: now.toISOString(),
    app: { version: app.getVersion(), packaged: app.isPackaged, locale: app.getLocale() },
    system: { platform: process.platform, arch: process.arch, osRelease: os.release(), totalMemGB: Math.round(os.totalmem() / 1e8) / 10, freeMemGB: Math.round(os.freemem() / 1e8) / 10, cpus: os.cpus().length },
    runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    proxyEnvDetected: ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'].some(k => !!process.env[k]),
    database: { schemaVersion: LATEST_SCHEMA },
    dataDir: { customLocation: dataDir !== path.join(app.getPath('appData'), 'english-exam-workbench'), disk },
    counts: {
      papersByStatus: byStatus,
      samplePapers: count('SELECT COUNT(*) c FROM papers WHERE is_sample = 1'),
      pages: count('SELECT COUNT(*) c FROM pages'),
      questions: count('SELECT COUNT(*) c FROM questions'),
      aiCalls: count('SELECT COUNT(*) c FROM ai_usage'),
      // 课程对照：只给个数，不含任何课程内容
      courseOutlines: count('SELECT COUNT(*) c FROM course_outlines'),
      courseLessons: count('SELECT COUNT(*) c FROM course_lessons'),
      courseMaps: count('SELECT COUNT(*) c FROM course_kp_map')
    }
  }))

  // AI 配置（脱敏）
  add('config.json', 'AI 服务商和模型名、并发数等（API Key 只写已设置 / 未设置，服务地址只留主机名）', json({
    ...scrubConfig(loadConfig() as unknown as Record<string, unknown>, hasStoredKey()),
    keyStorage: keyStorage()
  }))
  add('ocr.json', '文字识别组件是否可用', json({ available: !!ocr.available, detail: sanitize(String(ocr.detail ?? ''), secrets) }))

  // 每份试卷一行：只用 8 位短编号
  const papers = db.prepare(`
    SELECT p.id, p.status, p.page_count, p.error_stage, p.ai_model, p.prompt_version, p.similar_state, p.is_sample, p.created_at, p.extracted_at, p.parsed_at,
      (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS questions,
      (SELECT group_concat(ts || ':' || c) FROM (SELECT text_source AS ts, COUNT(*) AS c FROM pages g WHERE g.paper_id = p.id GROUP BY text_source)) AS sources
    FROM papers p ORDER BY p.created_at DESC LIMIT 2000`).all() as any[]
  add('papers.csv', '每份试卷一行：8 位编号、状态、页数、题数、各页文字来源、出错阶段（不含标题和文件名）', text(toCsv(
    ['paper', 'status', 'pages', 'questions', 'text_sources', 'error_stage', 'ai_model', 'prompt_version', 'similar_state', 'sample', 'created_at', 'extracted_at', 'parsed_at'],
    papers.map(r => [shortPaperId(r.id), r.status, r.page_count, r.questions, r.sources ?? '', r.error_stage ?? '', r.ai_model ?? '', r.prompt_version ?? '', r.similar_state ?? '', r.is_sample ? 1 : 0, r.created_at, r.extracted_at ?? '', r.parsed_at ?? ''])
  )))
  const usage = db.prepare(`SELECT kind, model, COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed, SUM(prompt_tokens) prompt, SUM(completion_tokens) completion, SUM(cached_tokens) cached
    FROM ai_usage GROUP BY kind, model ORDER BY calls DESC`).all() as any[]
  add('ai-usage.csv', '各模型各类调用的次数、失败次数和 token 用量', text(toCsv(['kind', 'model', 'calls', 'failed', 'prompt_tokens', 'completion_tokens', 'cached_tokens'], usage.map(r => [r.kind, r.model ?? '', r.calls, r.failed, r.prompt, r.completion, r.cached]))))

  // 队列状态
  const ex = extractQueueState(), ps = parseQueueState()
  add('queue.json', '处理队列状态：排队数、运行数、并发、是否被服务商限速、是否防止睡眠', json({
    paused: isQueuePaused(), extract: { waiting: ex.waiting.length, running: ex.running ? 1 : 0 },
    parse: { waiting: ps.waiting.length, running: ps.running.length }, throttle: throttleState(), preventingSleep: isPowerBlocking()
  }))

  // 界面设置（白名单）
  const settings: Record<string, unknown> = {}
  for (const k of SETTING_KEYS) {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(k) as { value_json: string } | undefined
    if (row) { try { settings[k] = JSON.parse(row.value_json) } catch { /* 损坏的值不带 */ } }
  }
  add('settings.json', '界面设置（不含密钥和任何内容）', json(settings))

  add('README.txt', '这个压缩包是什么、里面有什么、怎么发给开发者', text(buildReadme(app.getVersion(), now.toLocaleString())))

  // 日志：再脱敏一遍（写入时已脱敏，这里是第二道）
  for (const f of logFiles()) {
    try {
      const raw = fs.readFileSync(f, 'utf8')
      const cleaned = raw.split('\n').map(l => (l ? sanitize(l, secrets) : l)).join('\n')
      add(`logs/${path.basename(f)}`, '运行日志（只记事件、耗时、状态码）', text(cleaned))
    } catch { /* 读不了就跳过 */ }
  }
  return entries
}

/** 写 zip：先写 .part 再改名，失败不留半截文件 */
export async function writeDiagnosticsZip(entries: DiagEntry[], outPath: string): Promise<number> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const tmp = `${outPath}.part`
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const ws = fs.createWriteStream(tmp)
    ws.on('close', () => resolve())
    ws.on('error', reject)
    zip.outputStream.on('error', reject).pipe(ws)
    for (const e of entries) zip.addBuffer(e.data, e.name, { mtime: new Date() })
    zip.end()
  }).catch(err => { try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ } throw err })
  fs.renameSync(tmp, outPath)
  return fs.statSync(outPath).size
}

export async function shortDiagnosisText(): Promise<string> {
  const cfg = loadConfig()
  const ocr = await getOcrStatus().catch(() => ({ available: false, detail: '检测失败' }))
  return shortDiagnosis({
    version: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: os.release(),
    model: cfg.model, visionModel: cfg.vision_model, ocr: `${ocr.available ? '可用' : '不可用'}（${ocr.detail}）`
  })
}

export const feedbackLink = (): string => feedbackUrl({ version: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: os.release() })
