// mapLimit：并发上限、结果顺序、失败行为；job-queue 的 progress 更新
import assert from 'node:assert/strict'
import { mapLimit, createGate } from '../../src/main/course/map-limit.ts'
import { createJobQueue } from '../../src/main/course/job-queue.ts'

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

{ // 上限 + 顺序：后面的项先完成，结果仍按输入顺序
  let cur = 0, peak = 0
  const out = await mapLimit([30, 5, 20, 1, 10, 2, 8], 3, async (ms, i) => {
    cur++; peak = Math.max(peak, cur)
    await tick(ms); cur--
    return i * 10
  })
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50, 60])
  assert.equal(peak, 3)
}
{ // 空数组 / limit 大于项数 / limit 非法
  assert.deepEqual(await mapLimit([], 4, async x => x), [])
  assert.deepEqual(await mapLimit([1, 2], 10, async x => x * 2), [2, 4])
  assert.deepEqual(await mapLimit([1, 2, 3], 0, async x => x), [1, 2, 3])
}
{ // 失败：抛第一个错误，且不再启动新项
  const started = []
  await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6], 2, async x => {
    started.push(x); await tick(2)
    if (x === 2) throw new Error('boom')
    return x
  }), /boom/)
  assert.ok(!started.includes(6))
}
{ // 取消：signal 中止后所有在途项都停下
  const ctl = new AbortController()
  const wait = () => new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const p = mapLimit([1, 2, 3, 4, 5], 4, () => wait())
  await tick(); ctl.abort()
  await assert.rejects(p, /aborted/)
}
{ // job-queue progress：运行中更新，完成 / 失败 / 重试清空，已移除的任务忽略
  const gates = new Map()
  let changes = 0
  const q = createJobQueue({ concurrency: 2, onChange: () => { changes++ }, run: (j, _s, report) => new Promise((res, rej) => gates.set(j.sessionId, { res, rej, report })) })
  const a = q.add({ sessionId: 'a', fileName: 'a', mode: 'ai', name: 'a', scene: 'org', termNote: '' })
  assert.equal(a.progress, undefined)
  const before = changes
  gates.get('a').report(3, 7, '张表')
  assert.deepEqual(q.get(a.id).progress, { done: 3, total: 7, unit: '张表' })
  assert.equal(changes, before + 1, '进度更新要通知')
  gates.get('a').res({}); await tick()
  assert.equal(q.get(a.id).status, 'ready'); assert.equal(q.get(a.id).progress, undefined)
  const b = q.add({ sessionId: 'b', fileName: 'b', mode: 'ai', name: 'b', scene: 'org', termNote: '' })
  gates.get('b').report(1, 4, '段'); q.remove(b.id)
  gates.get('b').report(2, 4, '段')   // 移除后不应报错
  assert.equal(q.get(b.id), undefined)
}
console.log('course-map-limit OK')

{ // createGate：在途数始终不超上限（release 直接把名额交给等待者）
  const gate = createGate(2)
  let cur = 0, peak = 0
  await Promise.all(Array.from({ length: 8 }, (_, i) => gate(async () => {
    cur++; peak = Math.max(peak, cur)
    await tick(3 + (i % 3) * 4); cur--
  })))
  assert.equal(peak, 2)
  assert.equal(cur, 0)
  const g2 = createGate(1)
  await assert.rejects(g2(async () => { throw new Error('x') }))
  assert.equal(await g2(async () => 7), 7)
}
