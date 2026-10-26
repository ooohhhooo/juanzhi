// 主进程每个 IPC 通道都必须分过类：要么在「写入类」（重启待定时拦截），要么在「只读类」。新增通道忘了分类 → 这里失败。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WRITE_CHANNELS, READONLY_CHANNELS, EXPORT_BLOCKED } from '../../src/main/ipc-channels.ts'

const dir = path.resolve('src/main')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : [])
const found = new Set()
for (const f of walk(dir)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) found.add(m[1])
assert.ok(found.size > 60, `扫到的通道数异常：${found.size}`)

const unclassified = [...found].filter(c => !WRITE_CHANNELS.has(c) && !READONLY_CHANNELS.has(c))
assert.deepEqual(unclassified, [], '这些 IPC 通道没分类（写入类放 WRITE_CHANNELS，只读放 READONLY_CHANNELS）：' + unclassified.join(', '))
const both = [...found].filter(c => WRITE_CHANNELS.has(c) && READONLY_CHANNELS.has(c))
assert.deepEqual(both, [], '同时出现在两个表里：' + both.join(', '))
const stale = [...WRITE_CHANNELS, ...READONLY_CHANNELS, ...EXPORT_BLOCKED].filter(c => !found.has(c))
assert.deepEqual(stale, [], '表里有不存在的通道：' + stale.join(', '))
// 复审 P2-3 点名的两个
for (const c of ['settings:set', 'data:pickPack']) assert.ok(WRITE_CHANNELS.has(c), c + ' 必须在写入类里')
for (const c of EXPORT_BLOCKED) assert.ok(WRITE_CHANNELS.has(c), c + '：导出期间拦的通道也应是写入类')
console.log('ipc-guard-audit.test ✓')
