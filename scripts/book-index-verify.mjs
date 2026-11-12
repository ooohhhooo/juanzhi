// 本机验证脚本：用真实教材 PDF 跑一遍书库引擎（不进 CI；没有设置教材目录就直接跳过）。
// 用法：BOOK_INDEX_DIR=/path/to/教材目录 node --experimental-strip-types --no-warnings scripts/book-index-verify.mjs [关键词...]
// 只用 Node 里的 pdfjs-dist 取文字层，不需要 Electron；扫描页的文字识别路径用 BOOK_INDEX_OCR=1 另测（见 book-index-ocr-sim.mjs）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const dir = process.env.BOOK_INDEX_DIR
if (!dir || !fs.existsSync(dir)) { console.log('未设置 BOOK_INDEX_DIR（教材目录），跳过'); process.exit(0) }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { buildBook } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/build.ts')).href)
const { newDb } = await import(pathToFileURL(path.join(root, 'tests/unit/helpers/db.mjs')).href)
const { saveBook, listBooks } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/store.ts')).href)
const { searchBooks } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/search.ts')).href)
const require = createRequire(import.meta.url)
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
const { getDocument } = await import(pathToFileURL(path.join(pdfRoot, 'legacy/build/pdf.mjs')).href)

export async function textLayerOf(file) {
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: false,
    standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + '/', cMapUrl: path.join(pdfRoot, 'cmaps') + '/', cMapPacked: true, verbosity: 0
  }).promise
  const out = []
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i)
    const tc = await p.getTextContent()
    out.push(tc.items.map(it => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('').split('\n'))
    p.cleanup()
  }
  await doc.destroy()
  return out
}

const { db } = newDb()   // 真实迁移建出来的内存库
const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')).sort()
for (const f of files) {
  const file = path.join(dir, f)
  const t0 = Date.now()
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  const book = await buildBook({ hash, name: f.replace(/\.pdf$/i, ''), textLayer: () => textLayerOf(file) })
  saveBook(db, book)
  const ms = Date.now() - t0
  console.log(`\n=== ${f} (${ms} ms) ===`)
  console.log('摘要：', book.summary.line)
  console.log('单元：', book.structure.units.map(u => `${u.title}[${u.pageStart}-${u.pageEnd}]`).join(' | '))
  if (book.structure.notes.length) console.log('说明：', book.structure.notes.join('；'))
}
const queries = process.argv.slice(2).length ? process.argv.slice(2) : ["Who's your art teacher?", 'eraser', '分数的初步认识', '周长', '有新鲜感的词语']
console.log('\n===== 搜索 =====')
for (const q of queries) {
  const t0 = Date.now()
  const r = searchBooks(db, q, { limit: 5 })
  console.log(`\n"${q}"  (${Date.now() - t0} ms)`)
  for (const h of r.hits) console.log(`  ${h.bookName.slice(-14)} | ${h.unitTitle ?? '-'} | PDF第${h.page}页 印${h.printedPage ?? '-'} | ${h.level} ${h.score.toFixed(0)} [${h.sources}] ${h.snippet.slice(0, 60)}`)
  if (r.units.length) console.log('  单元投票：', r.units.map(u => `${u.unitTitle}(${u.score})`).join('、'))
}
console.log('\n书库：', listBooks(db).map(b => b.name.slice(-12)).join(' / '))
