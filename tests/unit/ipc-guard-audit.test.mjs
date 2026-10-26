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
// M5 小项：ai:test 的分类要和事实一致——testConnection 会往 ai_usage 写用量记录（成功失败都写），所以不是只读，重启待定时必须拦
{
  const cfg = fs.readFileSync(path.resolve('src/main/ai/config.ts'), 'utf8')
  const body = cfg.slice(cfg.indexOf('export async function testConnection'))
  assert.match(body, /recordUsage\(/, '前提：testConnection 里确实会记用量（若这条前提变了，ai:test 的分类要重新核对）')
  assert.ok(WRITE_CHANNELS.has('ai:test') && !READONLY_CHANNELS.has('ai:test'), 'ai:test 会写 ai_usage，必须在写入类里')
  assert.ok(READONLY_CHANNELS.has('app:takeStartupNotice'), 'app:takeStartupNotice 只改内存状态，归只读类（重启待定时也要能取）')
}
console.log('ipc-guard-audit.test ✓')
