// 数据包单测的环境：每个"电脑"一个临时数据目录（db.sqlite + files/），用真实迁移建库
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { addPaper, migrate, newDb } from './db.mjs'

export const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-pack-'))
export const openDb = (f, o) => (o ? new DatabaseSync(f, o) : new DatabaseSync(f))
export const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
export const LATEST = newDb().version
let n = 0

export function makeEnv(name = 'env') {
  const dir = path.join(root, `${name}-${++n}`)
  const dataDir = path.join(dir, 'data')
  const filesDir = path.join(dataDir, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const { db } = newDb(path.join(dataDir, 'db.sqlite'))
  db.exec('PRAGMA journal_mode=WAL')
  return { dir, dataDir, filesDir, db, deps: { db, dataDir, filesDir } }
}

/** 往环境里造一份有文件的卷子：original.pdf + 若干页面图（内容随机，用来比对哈希） */
export function paperWithFiles(env, p, pages = 2) {
  const id = addPaper(env.db, p)
  const dir = path.join(env.filesDir, id)
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'original.pdf'), crypto.randomBytes(200))
  const ins = env.db.prepare(`INSERT INTO pages (paper_id, idx, image_rel, width, height, text_source, lines_json, text) VALUES (?, ?, ?, 100, 100, 'ocr', '[]', 't')`)
  for (let i = 1; i <= pages; i++) {
    fs.writeFileSync(path.join(dir, `page-${i}.png`), crypto.randomBytes(300 + i))
    ins.run(id, i, `page-${i}.png`)
  }
  fs.writeFileSync(path.join(dir, 'media', '1.png'), crypto.randomBytes(50))
  env.db.prepare(`INSERT INTO paper_assets (paper_id, page_idx, seq, rel_path, mime, bytes) VALUES (?, 1, 1, 'media/1.png', 'image/png', 50)`).run(id)
  return id
}

/** 目录内容的指纹：相对路径 → 哈希（比较"文件目录有没有变化"） */
export function treeHash(dir) {
  const out = {}
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

export const count = (db, sql, ...p) => db.prepare(sql).get(...p).c
export { migrate, newDb, addPaper }
