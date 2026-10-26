// 更改数据目录的校验：不能是当前目录、不能在当前目录里面、不能是当前目录的上级、必须可写、迁移目标必须是空目录、
// 已有数据目录要有 db.sqlite 和 files/；配置文件原子写、坏配置不让程序起不来。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkTargetDir, readConfig, writeConfig, configuredDataDir, defaultDataDir, isInside, isSamePath, isWritableDir, hasDataLayout, copyDirSync, dirSizeSync, CONFIG_FILE, MIGRATING_MARK } from '../../src/main/datadir.ts'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-dd-')))
const cur = path.join(tmp, 'a', 'current')
fs.mkdirSync(path.join(cur, 'files'), { recursive: true }); fs.writeFileSync(path.join(cur, 'db.sqlite'), 'x')
const reason = t => { const r = checkTargetDir(cur, t); assert.equal(r.ok, false, `应拒绝：${t}`); return r.reason }

assert.match(reason(cur), /当前正在使用/)
assert.match(reason(path.join(cur, 'files')), /里面的文件夹/)
assert.match(reason(path.join(cur, 'new-sub')), /里面的文件夹/)
assert.match(reason(path.join(tmp, 'a')), /上级文件夹/)
assert.match(reason(tmp), /上级文件夹/)
assert.match(reason('relative/dir'), /完整的目录路径/)
assert.match(reason(''), /完整的目录路径/)
// 符号链接指向当前目录内部：取真实路径比较，绕不过去
fs.symlinkSync(path.join(cur, 'files'), path.join(tmp, 'sneaky'))
assert.match(reason(path.join(tmp, 'sneaky')), /里面的文件夹/)
fs.symlinkSync(cur, path.join(tmp, 'same-as-cur'))
assert.match(reason(path.join(tmp, 'same-as-cur')), /当前正在使用/)
// 大小写不同的同一个目录（macOS / Windows 不区分大小写）
if (process.platform === 'darwin' || process.platform === 'win32') assert.match(reason(cur.toUpperCase().replace(/^\/PRIVATE/, '/private')), /当前正在使用|里面的文件夹|上级/)
// 目标是文件
fs.writeFileSync(path.join(tmp, 'afile'), 'x'); assert.match(reason(path.join(tmp, 'afile')), /是一个文件|不能写入/)
// 非空且不是数据目录
fs.mkdirSync(path.join(tmp, 'busy')); fs.writeFileSync(path.join(tmp, 'busy', 'photo.jpg'), 'x')
assert.match(reason(path.join(tmp, 'busy')), /不是空的/)
// 只有系统垃圾文件的目录算空
fs.mkdirSync(path.join(tmp, 'junk')); fs.writeFileSync(path.join(tmp, 'junk', '.DS_Store'), 'x'); fs.writeFileSync(path.join(tmp, 'junk', '._x'), 'x')
assert.deepEqual(checkTargetDir(cur, path.join(tmp, 'junk')), { ok: true, kind: 'empty' })
// 不存在的目录（会新建）
assert.deepEqual(checkTargetDir(cur, path.join(tmp, 'brand', 'new')), { ok: true, kind: 'empty' })
assert.ok(!fs.existsSync(path.join(tmp, 'brand', 'new', '.ewb-write-test')), '探测写权限用的临时文件被删掉了')
// 已有数据目录
const other = path.join(tmp, 'other-data'); fs.mkdirSync(path.join(other, 'files'), { recursive: true }); fs.writeFileSync(path.join(other, 'db.sqlite'), 'x')
assert.deepEqual(checkTargetDir(cur, other), { ok: true, kind: 'existing-data' }); assert.ok(hasDataLayout(other)); assert.ok(!hasDataLayout(path.join(tmp, 'busy')))
// 不可写（root 能写任何地方，跳过）
if (process.getuid && process.getuid() !== 0) {
  const ro = path.join(tmp, 'readonly'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o555)
  assert.match(reason(ro), /没有写入权限|不能写入/); assert.equal(isWritableDir(ro).ok, false)
  assert.match(reason(path.join(ro, 'sub')), /没有写入权限|不能写入/, '父目录只读时新建子目录也不行')
  fs.chmodSync(ro, 0o755)
}
assert.ok(isInside('/a/b/c', '/a/b') && !isInside('/a/b', '/a/b/c') && isInside('/a/b', '/a/b') && !isInside('/a/bc', '/a/b'), '前缀相同但不是同一路径的不算"里面"')
assert.ok(isSamePath(cur, cur + path.sep))

// ── 配置文件 ──
const ud = path.join(tmp, 'userData')
assert.deepEqual(readConfig(ud), {}); assert.equal(configuredDataDir(ud), null)
writeConfig(ud, { dataDir: other })
assert.equal(configuredDataDir(ud), other)
assert.deepEqual(fs.readdirSync(ud), [CONFIG_FILE], '原子写：没有留下临时文件')
writeConfig(ud, {}); assert.equal(configuredDataDir(ud), null); assert.ok(!fs.existsSync(path.join(ud, CONFIG_FILE)))
// 坏配置 / 相对路径 / 类型不对：一律当没配置（程序照常用默认位置起得来）
for (const bad of ['{not json', '{"dataDir": 123}', '{"dataDir": "relative/path"}', '[]', 'null']) { fs.writeFileSync(path.join(ud, CONFIG_FILE), bad); assert.deepEqual(readConfig(ud), {}, bad) }
assert.equal(defaultDataDir('/u'), path.join('/u', 'workbench-data'))

// ── 复制目录 ──
const src = path.join(tmp, 'srcfiles'); fs.mkdirSync(path.join(src, 'p1', 'media'), { recursive: true }); fs.writeFileSync(path.join(src, 'p1', 'page-1.png'), Buffer.alloc(100)); fs.writeFileSync(path.join(src, 'p1', 'media', '1.png'), Buffer.alloc(50))
fs.symlinkSync('/etc', path.join(src, 'evil-link'))
const dst = path.join(tmp, 'dstfiles')
const cp = copyDirSync(src, dst)
assert.deepEqual([cp.files, cp.bytes], [2, 150]); assert.ok(!fs.existsSync(path.join(dst, 'evil-link')), '符号链接不跟随、不复制')
assert.equal(dirSizeSync(dst), 150); assert.equal(dirSizeSync(path.join(tmp, 'nope')), 0)
// ── 审核 P2-12：迁移中途被杀（留下完整的 db.sqlite、不完整的 files/、还有 .migrating 标记）→ 不能当成「已有数据目录」 ──
{
  const half = path.join(tmp, 'half-migrated'); fs.mkdirSync(path.join(half, 'files'), { recursive: true })
  fs.writeFileSync(path.join(half, 'db.sqlite'), 'x'); fs.writeFileSync(path.join(half, MIGRATING_MARK), 'x')
  assert.ok(!hasDataLayout(half), '带迁移标记的目录不算数据目录')
  const r = checkTargetDir(cur, half)
  assert.equal(r.ok, false); assert.match(r.reason, /没有完成的数据迁移/)
  fs.rmSync(path.join(half, MIGRATING_MARK))
  assert.deepEqual(checkTargetDir(cur, half), { ok: true, kind: 'existing-data' }, '标记没了（迁移完成）才算数据目录')
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log('datadir.test ✓')
