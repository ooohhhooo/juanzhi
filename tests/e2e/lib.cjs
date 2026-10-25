// E2E 公共函数（M2 套件使用；M1 套件 run.cjs 自带一份，保持不动）
const { _electron: electron } = require('playwright-core')
const { DatabaseSync } = require('node:sqlite')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const results = []
const procOutput = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

function check(feature, name, pass, detail = '') {
  results.push({ feature, name, pass: !!pass, detail: String(detail) })
  console.log(`${pass ? '✅' : '❌'} [${feature}] ${name}${detail ? '  — ' + detail : ''}`)
}

async function waitFor(fn, ms = 120000, step = 300) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(step)
  }
}

function readDb(ud) {
  return new DatabaseSync(path.join(ud, 'workbench-data', 'db.sqlite'), { readOnly: true })
}
/** 一次性查询：开库、跑 fn、关库 */
function withDb(ud, fn) {
  const db = readDb(ud)
  try { return fn(db) } finally { db.close() }
}

async function launch({ appDir = root, userDataDir, extraEnv = {} }) {
  const env = { ...process.env, EWB_USER_DATA_DIR: userDataDir, ...extraEnv }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k]
  const app = await electron.launch({ executablePath: require('electron'), args: [appDir], cwd: appDir, env })
  const page = await app.firstWindow()
  const consoleErrors = []
  // 主进程的 stdout/stderr 也收集起来，测试结束时扫描是否泄漏密钥
  const proc = app.process()
  proc.stdout?.on('data', d => procOutput.push(String(d)))
  proc.stderr?.on('data', d => procOutput.push(String(d)))
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(String(e)))
  await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  return { app, page, consoleErrors }
}

async function dropFiles(page, paths) {
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForSelector('[data-testid=dropzone]')
  await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 15000 }).catch(() => {})
  const box = await page.locator('[data-testid=dropzone]').boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data })
  await cdp.detach()
}

const listPapers = page => page.evaluate(() => window.api.papers.list())
const paperByFile = async (page, name) => (await listPapers(page)).find(p => p.file_name === name)
const statusOf = async (page, name) => (await paperByFile(page, name))?.status

/** 等某份试卷到达目标状态之一 */
async function waitStatus(page, name, statuses, ms = 120000) {
  const want = Array.isArray(statuses) ? statuses : [statuses]
  return waitFor(async () => { const p = await paperByFile(page, name); return p && want.includes(p.status) ? p : null }, ms)
}

/** 同样内容、不同字节的副本（避免触发「重复导入」） */
function copyWithTag(src, dest, tag) {
  fs.writeFileSync(dest, Buffer.concat([fs.readFileSync(src), Buffer.from(`\n% ${tag}\n`)]))
  return dest
}

/** 用主进程的 nativeImage 按归一化 bbox 裁出页面图的一块，存成 PNG，返回路径 */
async function cropPage(app, pngPath, bbox, outPath, pad = 0) {
  // 主进程里不能 require/import，裁好后把 PNG 以 base64 带回测试进程再落盘
  const b64 = await app.evaluate(({ nativeImage }, a) => {
    const img = nativeImage.createFromPath(a.png)
    const { width, height } = img.getSize()
    const x = Math.max(0, Math.round((a.bbox[0] - a.pad) * width))
    const y = Math.max(0, Math.round((a.bbox[1] - a.pad) * height))
    const w = Math.min(width - x, Math.round((a.bbox[2] + 2 * a.pad) * width))
    const h = Math.min(height - y, Math.round((a.bbox[3] + 2 * a.pad) * height))
    return img.crop({ x, y, width: w, height: h }).toPNG().toString('base64')
  }, { png: pngPath, bbox, pad })
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'))
  return outPath
}

/** 对一张图跑真实的 macOS Vision OCR（和应用用的是同一个可执行文件），返回拼起来的文字 */
function ocrText(png) {
  const bin = path.join(root, 'native/macos/bin/ewb-ocr')
  const out = execFileSync(bin, [png], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const j = JSON.parse(out.replace(/^\uFEFF/, ''))
  return j.lines.map(l => l.text).join(' ')
}

/** 等元素位置稳定（滚动动画结束）后再取包围盒，避免拿着过期坐标点到别的东西 */
async function stableBox(locator, tries = 20) {
  let prev = null
  for (let i = 0; i < tries; i++) {
    const b = await locator.boundingBox()
    if (b && prev && Math.abs(b.x - prev.x) < 0.5 && Math.abs(b.y - prev.y) < 0.5 && Math.abs(b.width - prev.width) < 0.5 && Math.abs(b.height - prev.height) < 0.5) return b
    prev = b
    await sleep(150)
  }
  return prev
}

/**
 * 用 M1 提交（7211fc1）里真实的 v1–v4 迁移代码建一个 v4 库，而不是把 v5 库「退化」成 v4。
 * 从 git 对象里取出当时的 db.ts，抠出 MIGRATIONS 数组原样执行。取不到时抛错（测试里会作为失败报告）。
 */
function buildRealV4Db(dbPath) {
  const src = execFileSync('git', ['show', '7211fc1:src/main/db.ts'], { cwd: root, encoding: 'utf8' })
  const m = /const MIGRATIONS: Array<\(db: any\) => void> = (\[[\s\S]*?\n\])\n\nlet db: any/.exec(src)
  if (!m) throw new Error('在 7211fc1 的 db.ts 里找不到 MIGRATIONS 数组')
  // 当时的代码里有 (c: any) 这样的 TS 标注，先用 Node 自带的类型剥离再执行
  const js = require('node:module').stripTypeScriptTypes(`const MIGRATIONS = ${m[1]}`)
  const migrations = new Function(`${js}\nreturn MIGRATIONS`)()
  if (migrations.length !== 4) throw new Error(`7211fc1 的迁移应有 4 步，实际 ${migrations.length}`)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
  migrations.forEach((fn, i) => { db.exec('BEGIN'); fn(db); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT') })
  return db
}

/** 直接从 docs/prompts/v1-sonnet改写.md 取提示词正文（不经过资源文件），用来证明应用发出的就是文档里的那份 */
function docsPrompt(id, part) {
  const IDS = { 三: 'p1_text', 四: 'p1_vision', 五: 'p2_yoy', 六: 'p3_report' }
  const lines = fs.readFileSync(path.join(root, 'docs/prompts/v1-sonnet改写.md'), 'utf8').replace(/\r\n/g, '\n').split('\n')
  let cur = null, p = null, inFence = false, buf = []
  for (const line of lines) {
    if (!inFence) {
      const h2 = /^## ([一二三四五六七八九十]+)、/.exec(line)
      if (h2) { cur = IDS[h2[1]] ?? null; p = null; continue }
      const h3 = /^### (system|user)\s*$/.exec(line)
      if (h3 && cur) { p = h3[1]; continue }
      if (/^````text\s*$/.test(line) && cur && p) { inFence = true; buf = []; continue }
    } else if (/^````\s*$/.test(line)) {
      inFence = false
      if (cur === id && p === part) return buf.join('\n').replace(/\s+$/, '')
      p = null
    } else buf.push(line)
  }
  throw new Error(`docs 里找不到 ${id}.${part}`)
}

function finish(file) {
  const failed = results.filter(r => !r.pass)
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
  return failed.length
}

module.exports = {
  root, results, sleep, check, waitFor, readDb, withDb, launch, dropFiles, listPapers, paperByFile, statusOf, waitStatus, copyWithTag, cropPage, ocrText, stableBox, buildRealV4Db, procOutput, docsPrompt, finish, os, fs, path
}
