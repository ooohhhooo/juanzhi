// 文件夹扫描：递归、只收支持的类型、跳过 ._ 与隐藏文件、层数与数量上限、不跟随链接
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkFolder, isHiddenName } from '../../src/main/pipeline/folder-walk.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-walk-'))
const touch = (rel, body = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
touch('a.pdf'); touch('b.JPG'); touch('c.png'); touch('d.heic'); touch('e.docx'); touch('f.jpeg')
touch('sub/g.pdf'); touch('sub/deep/h.png')
touch('._a.pdf'); touch('.DS_Store'); touch('.hidden/x.pdf'); touch('sub/._g.pdf'); touch('Thumbs.db'); touch('~$tmp.docx')
touch('old.doc'); touch('note.txt'); touch('noext'); touch('sub/movie.mp4')

const r = walkFolder(root)
const rel = r.files.map(f => path.relative(root, f).split(path.sep).join('/')).sort()
assert.deepEqual(rel, ['a.pdf', 'b.JPG', 'c.png', 'd.heic', 'e.docx', 'f.jpeg', 'sub/deep/h.png', 'sub/g.pdf'])
const skipped = new Map(r.skipped.map(s => [s.name, s.reason]))
assert.ok(skipped.get('._a.pdf').includes('macOS'))
assert.ok(skipped.has('.DS_Store') && skipped.has('Thumbs.db') && skipped.has('~$tmp.docx') && skipped.has('._g.pdf'))
assert.ok(!r.files.some(f => f.includes('.hidden')), '隐藏文件夹里的文件不收')
assert.ok(skipped.get('old.doc').includes('docx'))
assert.ok(skipped.get('note.txt').includes('.txt') && skipped.has('noext') && skipped.has('movie.mp4'))
assert.equal(r.truncated, false)

// 数量上限
{ const t = walkFolder(root, { maxFiles: 3 }); assert.equal(t.files.length, 3); assert.equal(t.truncated, true) }
// 层数上限：超过的文件夹整个跳过并说明
{ const t = walkFolder(root, { maxDepth: 1 }); assert.ok(!t.files.some(f => f.endsWith('h.png'))); assert.ok(t.skipped.some(s => s.name === 'deep' && s.reason.includes('太深'))) }
// 链接不跟随
try {
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link'))
  const t = walkFolder(root); assert.ok(t.skipped.some(s => s.name === 'link'))
  assert.equal(t.files.filter(f => f.endsWith('g.pdf')).length, 1, '链接指向的文件夹不重复扫描')
} catch (e) { if (e.code !== 'EPERM') throw e }
// 不存在的文件夹不抛错
assert.deepEqual(walkFolder(path.join(root, 'nope')).files, [])
assert.ok(isHiddenName('._x') && isHiddenName('.git') && !isHiddenName('卷子.pdf'))
fs.rmSync(root, { recursive: true, force: true })
console.log('folder-walk.test ✓')
