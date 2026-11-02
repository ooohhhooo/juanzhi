// 防睡眠开关的状态机：忙时 start 一次，闲时 stop 一次，重复通知不重复调用
import assert from 'node:assert/strict'
import { createPowerGuard } from '../../src/main/power-core.ts'

const calls = []
let next = 7
const g = createPowerGuard({ start: () => { calls.push('start'); return next++ }, stop: id => calls.push('stop' + id) })
g.update(false); assert.deepEqual(calls, []); assert.equal(g.isBlocking(), false)
g.update(true); g.update(true); assert.deepEqual(calls, ['start']); assert.equal(g.isBlocking(), true); assert.equal(g.id(), 7)
g.update(false); g.update(false); assert.deepEqual(calls, ['start', 'stop7']); assert.equal(g.isBlocking(), false)
g.update(true); assert.deepEqual(calls, ['start', 'stop7', 'start']); assert.equal(g.id(), 8)
console.log('power-core.test ✓')
