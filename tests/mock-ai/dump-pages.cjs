// 开发辅助：把样本卷导入一个临时数据目录，打印每页的 [页-行] 文本，供编写 mock 的 canned 响应时核对 anchor。
// 用法（沙箱外）：node tests/mock-ai/dump-pages.cjs samples/g4-2026.pdf [...]
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')

async function main() {
  const files = process.argv.slice(2).map(f => path.resolve(f))
  if (!files.length) throw new Error('请给出要导入的文件')
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-dump-'))
  const env = { ...process.env, EWB_USER_DATA_DIR: ud }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k]
  const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=dropzone]', { timeout: 30000 })
  const cdp = await page.context().newCDPSession(page)
  const box = await page.locator('[data-testid=dropzone]').boundingBox()
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 50, y: box.y + 20, data: { items: [], files, dragOperationsMask: 1 } })
  }
  for (let i = 0; i < 120; i++) {
    const ps = await page.evaluate(() => window.api.papers.list())
    if (ps.length >= files.length && ps.every(p => ['extracted', 'failed'].includes(p.status))) break
    await new Promise(r => setTimeout(r, 500))
  }
  const ps = await page.evaluate(() => window.api.papers.list())
  for (const p of ps) {
    console.log(`\n===== ${p.file_name} (${p.status}) ${p.error || ''}`)
    const pages = await page.evaluate(id => window.api.papers.pages(id), p.id)
    for (const pg of pages) {
      const lines = JSON.parse(pg.lines_json)
      console.log(`--- 第 ${pg.idx} 页 ${pg.width}x${pg.height} ${pg.text_source} ${lines.length} 行`)
      lines.forEach((l, i) => {
        console.log(`[${pg.idx}-${String(i + 1).padStart(2, '0')}] (${l.x.toFixed(3)},${l.y.toFixed(3)},${l.w.toFixed(3)},${l.h.toFixed(3)}) ${l.text}`)
      })
    }
  }
  await app.close()
}
main().catch(e => { console.error(e); process.exit(1) })
