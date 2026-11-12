// 本机验证：模拟“扫描版”教材——把整本书的文字层去掉，每页渲染成图片后走系统文字识别（macOS Vision，和应用里同一个 ewb-ocr），再建书库。
// 用法：BOOK_INDEX_FILE=/path/某本.pdf [BOOK_INDEX_PAGES=1-30] node --experimental-strip-types --no-warnings scripts/book-index-ocr-sim.mjs
// 只在 macOS 上能跑（用 swiftc 现编一个渲染小工具，用 native/macos/bin/ewb-ocr 识别）。没有设置文件就跳过。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const file = process.env.BOOK_INDEX_FILE
if (!file || !fs.existsSync(file) || process.platform !== 'darwin') { console.log('未设置 BOOK_INDEX_FILE 或不是 macOS，跳过'); process.exit(0) }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { buildBook } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/build.ts')).href)
const { newDb } = await import(pathToFileURL(path.join(root, 'tests/unit/helpers/db.mjs')).href)
const { saveBook } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/store.ts')).href)
const { searchBooks } = await import(pathToFileURL(path.join(root, 'src/main/bookindex/search.ts')).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'book-ocr-'))
const bin = process.env.BOOK_INDEX_RENDER_BIN || path.join(tmp, 'render')
if (!fs.existsSync(bin)) execFileSync('swiftc', ['-o', bin, path.join(root, 'scripts/book-index-render.swift')])
const ocrBin = path.join(root, 'native/macos/bin/ewb-ocr')
const pdfRoot = path.dirname((await import('node:module')).createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const { getDocument } = await import(pathToFileURL(path.join(pdfRoot, 'legacy/build/pdf.mjs')).href)
const total = (await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise).numPages
const range = (process.env.BOOK_INDEX_PAGES || `1-${total}`).split('-').map(Number)
const lastPage = range[1] ?? range[0]
let ocrMs = 0, ocrCalls = 0
const rawLines = []
const t0 = Date.now()
const book = await buildBook({
  hash: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'), name: '模拟扫描版',
  // 文字层全部去掉，等于一本纯扫描书
  textLayer: async () => Array.from({ length: lastPage }, () => []),
  ocr: async page => {
    const t = Date.now()
    execFileSync(bin, [file, tmp, String(page)])
    const out = JSON.parse(execFileSync(ocrBin, [path.join(tmp, `page-${page}.png`)], { maxBuffer: 20 << 20 }).toString().replace(/^﻿/, ''))
    fs.rmSync(path.join(tmp, `page-${page}.png`), { force: true })
    ocrMs += Date.now() - t; ocrCalls++
    rawLines[page - 1] = out.lines.map(l => l.text)
    return rawLines[page - 1]
  }
})
if (process.env.BOOK_INDEX_DUMP) fs.writeFileSync(process.env.BOOK_INDEX_DUMP, JSON.stringify(rawLines))
console.log(`识别 ${ocrCalls} 页，识别用时 ${(ocrMs / 1000).toFixed(1)} 秒，总用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
console.log('摘要：', book.summary.line)
console.log('单元：', book.structure.units.map(u => `${u.title}[${u.pageStart}-${u.pageEnd}]`).join(' | '))
const { db } = newDb()
saveBook(db, book)
for (const q of (process.argv.slice(2).length ? process.argv.slice(2) : ['eraser', "What's your name?"])) {
  const r = searchBooks(db, q, { limit: 3 })
  console.log(`"${q}" →`, r.hits.map(h => `第${h.page}页(印${h.printedPage ?? '-'}) ${h.unitTitle ?? '-'} ${h.level}`).join(' ; ') || '无')
}
fs.rmSync(tmp, { recursive: true, force: true })
