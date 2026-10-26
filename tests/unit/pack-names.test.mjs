// 数据包条目名白名单：合法的几种放行，其余（路径穿越、绝对路径、盘符、反斜杠、控制字符、未知文件……）一律拒绝
import assert from 'node:assert/strict'
import { classifyEntry, dedupeKey, UUID_RE } from '../../src/main/pack/names.ts'

const ID = '123e4567-e89b-42d3-a456-426614174000'
const ok = (n, kind) => { const c = classifyEntry(n); assert.ok(c, `应放行：${n}`); assert.equal(c.kind, kind, n) }
const no = n => assert.equal(classifyEntry(n), null, `应拒绝：${JSON.stringify(n)}`)

ok('manifest.json', 'manifest'); ok('db.sqlite', 'db')
ok(`files/${ID}/original.pdf`, 'file'); ok(`files/${ID}/original.docx`, 'file'); ok(`files/${ID}/original.heic`, 'file'); ok(`files/${ID}/original.jpeg`, 'file')
ok(`files/${ID}/page-1.png`, 'file'); ok(`files/${ID}/page-12.png`, 'file'); ok(`files/${ID}/media/3.png`, 'file'); ok(`files/${ID}/media/3.jpg`, 'file'); ok(`files/${ID}/media/3.gif`, 'file')
ok('files/', 'dir'); ok(`files/${ID}/`, 'dir'); ok(`files/${ID}/media/`, 'dir')
const f = classifyEntry(`files/${ID}/media/3.png`)
assert.deepEqual([f.paperId, f.rel], [ID, 'media/3.png'])

for (const bad of [
  '../evil.txt', 'files/../../evil', `files/${ID}/../../evil`, `files/${ID}/../x/page-1.png`, '/etc/passwd', '/db.sqlite', 'C:\\Windows\\x', 'C:/x', 'c:db.sqlite',
  'files\\' + ID + '\\page-1.png', `files/${ID}/page-1.png\u0000.exe`, 'db.sqlite\n', `files//${ID}/page-1.png`, './db.sqlite', `files/${ID}/./page-1.png`,
  'readme.txt', '__MACOSX/', '__MACOSX/._db.sqlite', '.DS_Store', 'files/.DS_Store', `files/${ID}/.DS_Store`, `files/${ID}/._page-1.png`,
  `files/${ID}/original.exe`, `files/${ID}/original.pdf.exe`, `files/${ID}/page-1.png/`, `files/${ID}/page-1.PNG`, `files/${ID}/page-x.png`, `files/${ID}/page-99999.png`,
  `files/${ID}/media/../page-1.png`, `files/${ID}/media/1.svg`, `files/${ID}/media/a/1.png`, 'files/not-a-uuid/page-1.png', `files/${ID.toUpperCase()}/page-1.png`,
  `files/${ID}x/page-1.png`, 'db.sqlite-wal', 'db.sqlite-journal', 'manifest.json/', 'MANIFEST.json', '', 'a'.repeat(300), 'files/' + 'a'.repeat(50) + '/x'
]) no(bad)
no(undefined); no(null); no(123)

assert.ok(UUID_RE.test(ID)); assert.ok(!UUID_RE.test(ID.toUpperCase()))
assert.equal(dedupeKey('Files/A.png'), dedupeKey('files/a.PNG'), '大小写不同的重名要被查出来')
console.log('pack-names.test ✓')
