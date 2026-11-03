// 课程大纲后台整理队列：并发上限、排队、完成 / 失败、取消、重试、移除
import assert from 'node:assert/strict'
import { createJobQueue } from '../../src/main/course/job-queue.ts'

const tick = () => new Promise(r => setTimeout(r, 5))
const input = n => ({ sessionId: 's' + n, fileName: `f${n}`, mode: 'ai', name: `f${n}`, scene: 'org', termNote: '' })

// 并发上限 2：3 个任务，第三个排队；一个完成后第三个才开始
{
  const gates = new Map()
  let changes = 0
  const removed = []
  const q = createJobQueue({
    concurrency: 2,
    onChange: () => { changes++ },
    onRemoved: j => removed.push(j.sessionId),
    run: j => new Promise((res, rej) => gates.set(j.sessionId, { res, rej }))
  })
  const a = q.add(input(1)), b = q.add(input(2)), c = q.add(input(3))
  assert.equal(a.status, 'running'); assert.equal(b.status, 'running'); assert.equal(c.status, 'queued')
  gates.get('s1').res({ ok: 1 }); await tick()
  assert.equal(q.get(a.id).status, 'ready'); assert.deepEqual(q.get(a.id).result, { ok: 1 })
  assert.equal(q.get(c.id).status, 'running', '空出一个名额后排队的任务开始')
  gates.get('s2').rej(new Error('网络不通')); await tick()
  assert.equal(q.get(b.id).status, 'failed'); assert.equal(q.get(b.id).error, '网络不通')
  assert.ok(changes >= 3)

  // 重试：失败的回到队列并重新执行；非失败的不能重试
  assert.equal(q.retry(a.id), false)
  assert.equal(q.retry(b.id), true)
  assert.equal(q.get(b.id).status, 'running')
  gates.get('s2').res({ ok: 2 }); await tick()
  assert.equal(q.get(b.id).status, 'ready')

  // 取消正在整理的：任务消失，晚到的结果被忽略，会话被释放
  assert.equal(q.get(c.id).status, 'running')
  assert.equal(q.remove(c.id), true)
  assert.deepEqual(removed, ['s3'])
  gates.get('s3').res({ late: true }); await tick()
  assert.equal(q.get(c.id), undefined)
  assert.equal(q.remove(c.id), false)
  assert.equal(q.list().length, 2)
  assert.equal(q.count('ready'), 2)
}

// 取消排队中的任务：不会被执行；运行时收到取消信号
{
  const started = []
  const signals = []
  const q = createJobQueue({ concurrency: 1, run: (j, sig) => { started.push(j.sessionId); signals.push(sig); return new Promise(() => {}) } })
  const a = q.add(input(1)), b = q.add(input(2))
  assert.equal(b.status, 'queued')
  q.remove(b.id)
  q.remove(a.id)
  assert.equal(signals[0].aborted, true)
  await tick()
  assert.deepEqual(started, ['s1'], '被取消的排队任务从不开始')
}

// 取消后马上重新添加同名文件，旧任务的晚到失败不会污染新任务
{
  const gates = []
  const q = createJobQueue({ run: () => new Promise((res, rej) => gates.push({ res, rej })) })
  const a = q.add(input(1))
  q.remove(a.id)
  const b = q.add(input(1))
  gates[0].rej(new Error('已取消')); await tick()
  assert.equal(q.get(b.id).status, 'running')
  assert.equal(q.get(a.id), undefined)
}

console.log('course-job-queue ok')
