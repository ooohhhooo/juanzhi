// OCR helper 的执行位兜底（M5 审核 P1-1）：运行时发现不可执行 → 尝试 chmod 755；仍不行 → 中文原因（含路径和修复命令）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureExecutable } from '../../src/main/pipeline/exec-bit.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-exec-'))
const mk = (name, mode) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/sh\necho hi\n'); fs.chmodSync(f, mode); return f }
if (process.platform === 'win32') { console.log('exec-bit.test 跳过（Windows 没有执行位）'); process.exit(0) }
{
  const f = mk('ok', 0o755)
  assert.deepEqual(ensureExecutable(f), { ok: true, fixed: false }, '本来就可执行：什么都不动')
}
{
  const f = mk('noexec', 0o644)
  assert.equal(fs.statSync(f).mode & 0o111, 0, '前提：这个临时目录保存权限位（不是 exFAT）')
  const r = ensureExecutable(f)
  assert.deepEqual(r, { ok: true, fixed: true }, '不可执行 → 自动 chmod 修好')
  assert.ok(fs.statSync(f).mode & 0o100, '修完之后属主有执行位')
}
{
  // chmod 失败（只读文件系统 / 没有权限）：给中文原因，含路径和修复办法，调用方据此降级
  const f = mk('stuck', 0o644)
  const real = fs.chmodSync
  fs.chmodSync = () => { const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e }
  let r
  try { r = ensureExecutable(f) } finally { fs.chmodSync = real }
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有执行权限/); assert.match(r.reason, /EPERM/); assert.match(r.reason, /chmod \+x/); assert.ok(r.reason.includes(f))
}
{
  const r = ensureExecutable(path.join(dir, 'missing'))
  assert.equal(r.ok, false); assert.match(r.reason, /ENOENT/)
}
fs.rmSync(dir, { recursive: true, force: true })
console.log('exec-bit.test ✓')
