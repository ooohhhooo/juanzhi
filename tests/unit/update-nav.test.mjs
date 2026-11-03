import assert from 'node:assert/strict'
import { updateNavView } from '../../src/renderer/design/updateNav.ts'
assert.equal(updateNavView(null), null)
for (const p of ['idle', 'checking', 'uptodate', 'installing', 'error']) assert.equal(updateNavView({ phase: p }), null, p)
const a = updateNavView({ phase: 'available', latestVersion: '1.4.0' })
assert.equal(a.phase, 'available'); assert.equal(a.tag, '更新'); assert.equal(a.download, true)
assert.equal(updateNavView({ phase: 'available', blocker: { code: 'x' } }).download, false, '需要手动更新时不自动下载')
const d = updateNavView({ phase: 'downloading', progress: { percent: 41.6 } })
assert.equal(d.tag, '下载中'); assert.equal(d.percent, 42)
assert.equal(updateNavView({ phase: 'downloading' }).percent, 0)
const r = updateNavView({ phase: 'ready' })
assert.equal(r.tag, '重启'); assert.equal(r.download, false)
console.log('update-nav ok')
