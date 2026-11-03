// 报告并发 / 排队：最多同时 3 份，多的排队；同样的请求不重复；取消排队的；一份结束后顶上
import assert from 'node:assert/strict'
import { createRunner, reportKey, MAX_CONCURRENT_REPORTS } from '../../src/renderer/stats/reportQueue.ts'

assert.equal(MAX_CONCURRENT_REPORTS, 3)
assert.equal(reportKey({ a: 1, b: 2 }, 'full', undefined), reportKey({ b: 2, a: 1 }, 'full', {}), '键顺序和空选项不影响')
assert.notEqual(reportKey({}, 'full', undefined), reportKey({}, 'parent', undefined))
assert.notEqual(reportKey({}, 'parent', undefined), reportKey({}, 'parent', { parentHint: true }))

const gates = new Map()
const started = []
const r = createRunner({
  max: 3,
  start: job => new Promise(res => { started.push(job.requestId); gates.set(job.requestId, res) })
})
const J = (n, key = 'k' + n) => ({ requestId: 'r' + n, key })
const tick = () => new Promise(res => setTimeout(res, 0))

assert.equal(r.submit(J(1)), 'started')
assert.equal(r.submit(J(2)), 'started')
assert.equal(r.submit(J(3)), 'started')
assert.equal(r.submit(J(4)), 'queued')
assert.equal(r.submit(J(5)), 'queued')
assert.equal(r.submit(J(6, 'k1')), 'duplicate', '正在生成的同款')
assert.equal(r.submit(J(7, 'k4')), 'duplicate', '排队中的同款')
await tick()
assert.deepEqual(started, ['r1', 'r2', 'r3'])
assert.deepEqual(r.counts(), { active: 3, queued: 2 })

assert.equal(r.cancelQueued('r5'), true)
assert.equal(r.cancelQueued('r1'), false, '生成中的不走这里')
assert.equal(r.isQueued('r4'), true)

gates.get('r2')()
await tick(); await tick()
assert.deepEqual(started, ['r1', 'r2', 'r3', 'r4'], '一份结束，排队的顶上')
assert.deepEqual(r.counts(), { active: 3, queued: 0 })
assert.equal(r.submit(J(8, 'k2')), 'queued', '结束的同款可以再来（此时满 3 份）')
gates.get('r1')(); gates.get('r3')(); gates.get('r4')()
await tick(); await tick()
assert.deepEqual(r.counts(), { active: 1, queued: 0 })

// start 抛错也要释放名额
const r2 = createRunner({ max: 1, start: () => Promise.reject(new Error('x')) })
assert.equal(r2.submit({ requestId: 'a', key: 'a' }), 'started')
await tick(); await tick()
assert.equal(r2.submit({ requestId: 'b', key: 'b' }), 'started')
console.log('report-queue ok')
