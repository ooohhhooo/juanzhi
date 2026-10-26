// M4 E2E 的公共部分：运行上下文、对话框桩、辅助函数。阶段分在 m4-phases-*.cjs，入口是 run-m4.cjs。
const L = require('./lib.cjs')
const { startMock } = require('../mock-ai/server.cjs')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { check, sleep, waitFor, launch, withDb, docsPrompt, root, fs, path, os } = L

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-m4-'))
const shots = path.join(root, 'docs/screenshots')
fs.mkdirSync(shots, { recursive: true })
const SECRET = 'sk-e2e-M4-SECRET-20261026'
const pageImg = path.join(root, 'samples/g4-2025-page1.png')
/** 当前打开的应用实例：ud = 它的 userData，dataDir = 数据目录（默认 <ud>/workbench-data） */
const ctx = { ud: null, app: null, page: null, mock: null, consoleErrors: [], ids: null, qids: null, bbox: null, pageSize: null }

const clean = e => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const T = id => ctx.page.locator(`[data-testid="${id}"]`)
const txt = async id => (await T(id).first().innerText()).replace(/\s+/g, ' ').trim()
const stat = async id => (await ctx.page.locator(`[data-testid="${id}"] .ant-statistic-content-value`).first().innerText()).trim()
const goto = async hash => { await ctx.page.evaluate(h => { location.hash = h }, hash) }
const shot = async name => ctx.page.screenshot({ path: path.join(shots, `m4-${name}.png`) })
const waitStat = (id, want, ms = 15000) => waitFor(async () => (await T(id).count()) > 0 && (await stat(id)) === String(want), ms)
const waitText = (id, re, ms = 15000) => waitFor(async () => (await T(id).count()) > 0 && re.test(await txt(id)), ms)
const dataDirOf = () => path.join(ctx.ud, 'workbench-data')
const cfgFor = (mock, over = {}) => ({ provider: 'custom', base_url: mock.baseUrl, model: 'mock-text-model', vision_model: 'mock-vision-model', concurrency: 2, auto_parse: true, batch_pages: 3, timeout_sec: 180, max_tokens: 8192, ...over })
const saveCfg = (cfg, key) => ctx.page.evaluate(([c, k]) => (k === undefined ? window.api.ai.saveConfig(c) : window.api.ai.saveConfig(c, k)), [cfg, key])
const setFilter = async (f, hash) => {
  await ctx.page.evaluate(v => window.api.settings.set('ui_stats_filter', v), f)
  await ctx.page.reload()
  await ctx.page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 }).catch(() => {})
  await goto(hash)
}
const api = (fn, arg) => ctx.page.evaluate(fn, arg)

/** 桩掉系统对话框（主进程里改 electron.dialog 的方法），让界面流程里弹出的对话框直接返回指定路径 */
const stubSave = p => ctx.app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, p)
const stubOpen = paths => ctx.app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ps }) }, [].concat(paths))

async function open(ud, over = {}) {
  ctx.ud = ud
  const r = await launch({ userDataDir: ud, ...over })
  ctx.app = r.app; ctx.page = r.page; ctx.consoleErrors = r.consoleErrors
  return r
}
async function closeApp() { try { await ctx.app?.close() } catch { /* 已关闭 */ } ctx.app = null }

/** 把 pdf 的文字取出来，页数也返回（pdfjs-dist 在 Node 里直接读，不需要画布） */
async function pdfInfo(file) {
  const pdfjs = await import(pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href)
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent()
    text += c.items.map(x => x.str).join('') + '\n'
  }
  const n = doc.numPages
  await doc.destroy()
  return { pages: n, text }
}

const isPng = f => { const b = fs.readFileSync(f); return b.length > 100 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }

module.exports = {
  L, startMock, check, sleep, waitFor, withDb, docsPrompt, root, fs, path, os, work, shots, SECRET, pageImg, ctx, clean, T, txt, stat, goto, shot, waitStat, waitText, dataDirOf,
  cfgFor, saveCfg, setFilter, api, stubSave, stubOpen, open, closeApp, pdfInfo, isPng, execFileSync, pathToFileURL,
  readDb: (dir) => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(path.join(dir, 'db.sqlite'), { readOnly: true }) }
}
