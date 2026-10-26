// 数据包解包的恶意输入：路径穿越、绝对路径、反斜杠、符号链接、重复条目、加密、非常规压缩、超大（头部诚实 / 头部撒谎）、
// 条目过多、总量过大、manifest 缺失 / 损坏、数据库缺失、根本不是 zip。每一种都必须被拒绝，且不留下任何解出来的文件。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { makeZip } from './helpers/zip.mjs'
import { Readable } from 'node:stream'
import yauzl from 'yauzl'
import { extractPack, ioProblem, ensureFreeSpace, declaredTotalBytes, SPACE_MARGIN_BYTES } from '../../src/main/pack/reader.ts'
import { PackError } from '../../src/main/pack/errors.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-reader-'))
const ID = '123e4567-e89b-42d3-a456-426614174000'
const MANIFEST = JSON.stringify({ format: 'ewb-pack', formatVersion: 1, schemaVersion: 9, appVersion: '0.4.0', exportedAt: '2026-10-26T00:00:00Z', paperCount: 1, questionCount: 2 })
const base = () => [{ name: 'manifest.json', data: MANIFEST }, { name: 'db.sqlite', data: 'SQLite format 3\0' }, { name: `files/${ID}/page-1.png`, data: Buffer.from('png-bytes') }]
let n = 0
const write = (entries, raw) => { const f = path.join(tmp, `p${++n}.zip`); fs.writeFileSync(f, raw ?? makeZip(entries)); return f }
const stage = () => path.join(tmp, `stage${n}`)

async function rejects(entries, code, re, limits, raw) {
  const f = write(entries, raw)
  const dir = stage()
  await assert.rejects(() => extractPack(f, dir, { limits }), e => {
    assert.ok(e instanceof PackError, `应是 PackError：${e}`)
    assert.ok([].concat(code).includes(e.code), `期望 ${code}，实际 ${e.code}：${e.message}`)
    if (re) assert.match(e.message, re)
    return true
  })
  assert.ok(!fs.existsSync(dir), '失败后暂存目录必须被清掉（不留任何已解出的文件）')
}

// 正常的包
{
  const dir = stage() + 'ok'
  const r = await extractPack(write(base()), dir)
  assert.equal(r.manifest.paperCount, 1)
  assert.deepEqual(r.paperDirs, [ID])
  assert.equal(fs.readFileSync(path.join(dir, 'files', ID, 'page-1.png')).toString(), 'png-bytes')
  assert.ok(fs.existsSync(r.dbPath))
  // 用 deflate 压缩的条目也能正常解
  const r2 = await extractPack(write([{ name: 'manifest.json', data: MANIFEST, method: 8 }, { name: 'db.sqlite', data: Buffer.alloc(5000, 7), method: 8 }]), stage() + 'ok2')
  assert.equal(fs.statSync(r2.dbPath).size, 5000)
}

// ── 条目名 ──
for (const name of ['../evil.txt', `files/${ID}/../../evil.txt`, '/etc/passwd', 'C:\\Windows\\evil.dll', `files\\${ID}\\page-1.png`, 'readme.txt', '__MACOSX/._db.sqlite', `files/${ID}/original.exe`, 'a/../../b']) {
  await rejects([...base(), { name, data: 'x' }], 'bad_entry', /不允许的文件(名|路径)/)
}
// 穿越的目标文件不能真的被写出去
assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')) && !fs.existsSync(path.join(os.tmpdir(), 'evil.txt')))
// 重复条目（含大小写不同的）
await rejects([...base(), { name: 'db.sqlite', data: 'again' }], 'bad_entry', /重复/)
await rejects([...base(), { name: `files/${ID}/PAGE-1.png`.toLowerCase(), data: 'x' }, { name: `files/${ID}/page-1.png`, data: 'y' }], 'bad_entry', /重复/)

// ── 符号链接 / 加密 / 压缩方式 ──
await rejects([...base(), { name: `files/${ID}/page-2.png`, data: '../../../../etc/passwd', mode: 0o120777 }], 'bad_entry', /符号链接/)
await rejects([...base(), { name: `files/${ID}/page-3.png`, data: 'x', flags: 0x1 }], ['bad_entry', 'bad_zip'])   // 加密位：我们自己拒绝，或者 yauzl 在核对大小时先拒绝，都是拒绝
await rejects([...base(), { name: `files/${ID}/page-4.png`, data: 'x', method: 9 }], ['bad_entry', 'bad_zip'])
// 普通文件（带 Unix 模式但不是链接）不误伤
await extractPack(write([...base(), { name: `files/${ID}/page-2.png`, data: 'ok', mode: 0o100644 }]), stage() + 'reg')

// ── 大小：条目数 / 单个文件 / 总量 ──
await rejects(Array.from({ length: 12 }, (_, i) => ({ name: `files/${ID}/page-${i + 1}.png`, data: 'x' })).concat(base().slice(0, 2)), 'too_many', /文件太多/, { maxEntries: 10 })
await rejects([...base(), { name: `files/${ID}/page-9.png`, data: Buffer.alloc(3000, 1) }], 'too_big', /太大/, { maxFileBytes: 2000 })
// 总量超限：每个文件都没超单个上限，加起来超
await rejects([...base().slice(0, 2), ...Array.from({ length: 8 }, (_, i) => ({ name: `files/${ID}/page-${i + 1}.png`, data: Buffer.alloc(1000, 2) }))], 'too_big', /解压后超过/, { maxTotalBytes: 5000, maxFileBytes: 2000 })
// zip 炸弹：很小的压缩包，解出来很大（头部诚实地写了大小——被头部检查拦下）；头部撒谎写得很小（yauzl 按实际字节数核对，我们也按实际解出的字节计）——都必须拒绝
const zeros = Buffer.alloc(8 * 1024 * 1024)
assert.ok(zlib.deflateRawSync(zeros).length < 20_000, '炸弹样本压缩后应该很小')
await rejects([...base().slice(0, 2), { name: `files/${ID}/page-1.png`, data: zeros, method: 8 }], 'too_big', /太大/, { maxFileBytes: 1024 * 1024 })
await rejects([...base().slice(0, 2), { name: `files/${ID}/page-1.png`, data: zeros, method: 8, declaredSize: 100 }], ['bad_zip', 'too_big'])   // 头部撒谎：被 yauzl 的大小核对或我们按实际字节数的限制拦下
// 总量炸弹：很多个各自不大的条目，实际解压总量超限
{
  const chunk = Buffer.alloc(400_000)
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `files/${ID}/page-${i + 1}.png`, data: chunk, method: 8 }))
  await rejects([...base().slice(0, 2), ...many], 'too_big', /解压后超过/, { maxTotalBytes: 3_000_000 })
}

// ── manifest / 数据库 / 不是 zip ──
await rejects([{ name: 'db.sqlite', data: 'x' }], 'manifest', /没有 manifest/)
await rejects([{ name: 'manifest.json', data: MANIFEST }], 'manifest', /没有数据库/)
await rejects([{ name: 'manifest.json', data: '{not json' }, { name: 'db.sqlite', data: 'x' }], 'manifest', /内容不正确/)
await rejects([{ name: 'manifest.json', data: JSON.stringify({ format: 'something-else' }) }, { name: 'db.sqlite', data: 'x' }], 'manifest')
await rejects([{ name: 'manifest.json', data: JSON.stringify({ format: 'ewb-pack', formatVersion: 1, schemaVersion: -3, appVersion: 'x', exportedAt: 'x', paperCount: 1, questionCount: 1 }) }, { name: 'db.sqlite', data: 'x' }], 'manifest')
await rejects([], 'bad_zip', /不是一个有效的数据包/, undefined, Buffer.from('this is definitely not a zip file at all, just text'))
await rejects([], 'bad_zip', undefined, undefined, makeZip(base()).subarray(0, 60))   // 被截断的 zip

// ── 复审 P2-7：磁盘 / 权限类错误不能说成「数据包已损坏」 ──
{
  const realWs = fs.createWriteStream
  const realMk = fs.mkdirSync
  const injectWrite = code => { fs.createWriteStream = (f, o) => { const ws = realWs.call(fs, f, o); if (String(f).endsWith('db.sqlite')) { ws.write = () => { const e = new Error(`${code}: simulated`); e.code = code; setImmediate(() => ws.destroy(e)); return false } } return ws } }
  try {
    for (const [code, re] of [['ENOSPC', /磁盘空间不足/], ['EACCES', /没有权限写入/], ['EPERM', /没有权限写入/], ['EBUSY', /占用/], ['EIO', /写入磁盘时出错/]]) {   // 写端的 EIO：说「写入」
      injectWrite(code)
      await rejects(base(), 'io', re)
      assert.doesNotMatch(String(re), /损坏/)
    }
    fs.createWriteStream = realWs
    // M5 小项：读数据包文件时出 EIO（移动硬盘断开）不能说成「写入磁盘出错」——方向要对
    const realOpen = yauzl.ZipFile.prototype.openReadStream
    yauzl.ZipFile.prototype.openReadStream = function (entry, opts, cb) {
      const callback = typeof opts === 'function' ? opts : cb
      return realOpen.call(this, entry, typeof opts === 'function' ? {} : opts, (err, rs) => {
        if (err || !rs || entry.fileName !== 'db.sqlite') return callback(err, rs)
        const bad = new Readable({ read() {} })
        setImmediate(() => { const e = new Error('EIO: simulated'); e.code = 'EIO'; bad.destroy(e) })
        rs.destroy()
        callback(null, bad)
      })
    }
    try {
      await rejects(base(), 'io', /读取数据包文件时磁盘出错/)
      assert.doesNotMatch((await extractPack(write(base()), stage()).then(() => '', e => e.message)), /写入磁盘/, '读端出错的提示里不能出现「写入磁盘」')
    } finally { yauzl.ZipFile.prototype.openReadStream = realOpen }
    assert.equal(ioProblem(Object.assign(new Error('x'), { code: 'EIO' }))?.message.includes('读写磁盘'), true, '不知道方向时用中性的「读写磁盘」')
    // 创建暂存目录就失败（磁盘满 / 只读）
    fs.mkdirSync = (p, o) => { if (String(p).includes('stage')) { const e = new Error('ENOSPC: simulated'); e.code = 'ENOSPC'; throw e } return realMk.call(fs, p, o) }
    await rejects(base(), 'io', /磁盘空间不足/)
  } finally { fs.createWriteStream = realWs; fs.mkdirSync = realMk }
  // 真正损坏的数据（zlib 解压出错）仍然是「已损坏」，不被当成磁盘问题
  const bad = makeZip([{ name: 'manifest.json', data: MANIFEST, method: 8 }, { name: 'db.sqlite', data: 'x'.repeat(2000), method: 8 }])
  const at = bad.indexOf(Buffer.from('db.sqlite')) + 9
  for (let i = at; i < at + 6; i++) bad[i] = bad[i] ^ 0xff
  await rejects([], 'bad_zip', /损坏/, undefined, bad)
}

// ── M5 小项（M4 审核 P2-7）：解包前检查磁盘剩余空间 ──
{
  const entries = [...base().slice(0, 2), { name: `files/${ID}/page-1.png`, data: Buffer.alloc(3_000_000, 7), method: 8 }]
  const f = write(entries)
  assert.ok((await declaredTotalBytes(f)) >= 3_000_000, '先读中央目录，把声明的解压后大小加起来')
  // 剩余空间不够 → 一个字节都不解，给出中文原因（含需要多少、还剩多少），暂存目录不留
  const dir = stage()
  const tiny = () => ({ bavail: 1000, bsize: 4096 })   // ≈ 4 MB，远小于 余量 256 MB
  await assert.rejects(() => extractPack(f, dir, { statfs: tiny }), e => e instanceof PackError && e.code === 'io' && /磁盘剩余空间不足/.test(e.message) && /只剩/.test(e.message))
  assert.ok(!fs.existsSync(dir), '空间不够：暂存目录不留')
  // 恰好够（需要 + 余量）→ 放行；差一点 → 拒绝
  const need = await declaredTotalBytes(f)
  assert.doesNotThrow(() => ensureFreeSpace(tmp, need, () => ({ bavail: need + SPACE_MARGIN_BYTES, bsize: 1 })))
  assert.throws(() => ensureFreeSpace(tmp, need, () => ({ bavail: need + SPACE_MARGIN_BYTES - 1, bsize: 1 })), /磁盘剩余空间不足/)
  // 读不到剩余空间（statfs 抛错）→ 放行，不能因为检查本身失败拦住用户
  assert.doesNotThrow(() => ensureFreeSpace(tmp, 1e15, () => { throw new Error('no statfs') }))
  // 空间足够时正常解开
  const ok = await extractPack(write(entries), stage(), { statfs: () => ({ bavail: 1e9, bsize: 4096 }) })
  assert.ok(fs.existsSync(ok.dbPath))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('pack-reader.test ✓')
