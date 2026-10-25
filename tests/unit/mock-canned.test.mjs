// mock 的 canned 响应自检：必须能通过生产代码的 zod 校验；用到的知识点/题型代码必须在内置树里（故意放的一个坏代码除外）。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { TextOutputSchema, VisionOutputSchema } from '../../src/main/parse/schema.ts'
import { KP_SEEDS_V1, QTYPE_SEEDS_V1 } from '../../src/main/seed/taxonomy.ts'
const require = createRequire(import.meta.url)
const { build } = require('../mock-ai/canned.cjs')

const kps = new Set(KP_SEEDS_V1.map(k => k[0]))
const qtypes = new Set(QTYPE_SEEDS_V1.map(q => q[0]))

for (const file of ['g4-2025.pdf', 'g4-2026.pdf']) {
  for (const pages of [[1, 2], [1], [2]]) {
    const out = build({ file, mode: 'text', pages, prefix: 'b1', visionFile: file.replace('.pdf', '') })
    const r = TextOutputSchema.safeParse(out)
    assert.ok(r.success, `${file} ${pages}: ${r.error?.message}`)
    for (const s of out.sections) assert.ok(qtypes.has(s.qtype), `${file} 大题题型 ${s.qtype}`)
    for (const q of out.questions) {
      assert.ok(qtypes.has(q.qtype), `${file} Q${q.no} 题型 ${q.qtype}`)
      assert.ok(pages.includes(q.page))
    }
  }
  const all = build({ file, mode: 'text', pages: [1, 2], prefix: 'b1', visionFile: file.replace('.pdf', '') })
  assert.equal(all.questions.length, 36, `${file} 应有 36 题`)
  const bad = all.questions.flatMap(q => [q.kp_main, ...q.kp_secondary]).filter(c => !kps.has(c))
  assert.deepEqual(bad, file === 'g4-2026.pdf' ? ['RD.INFER.OPINION'] : [], `${file} 不在树里的代码`)
  // 材料 id 与前缀一致，题目引用的材料都存在
  const ids = new Set(all.materials.map(m => m.id))
  for (const q of all.questions) if (q.material_id) assert.ok(ids.has(q.material_id), `${file} Q${q.no} 引用了不存在的材料 ${q.material_id}`)
}

// 视觉版：anchor 是 0–1 的四元数组
const vis = build({ file: 'g4-2025-page1.png', mode: 'vision', pages: [1], prefix: 'b1', visionFile: 'g4-2025-page1' })
assert.ok(VisionOutputSchema.safeParse(vis).success, JSON.stringify(VisionOutputSchema.safeParse(vis).error?.issues.slice(0, 2)))
assert.equal(vis.questions.length, 25, '第 1 页共 25 题')
assert.ok(vis.questions.every(q => Array.isArray(q.anchor)))

// 被页边界切开的题：第一批 25 题不完整（continues_next），第二批开头续写完整记录
const b1 = build({ file: 'g4-2026.pdf', mode: 'text', pages: [1], prefix: 'b1', splitLast: true, visionFile: 'g4-2026' })
const b2 = build({ file: 'g4-2026.pdf', mode: 'text', pages: [2], prefix: 'b2', splitLast: true, visionFile: 'g4-2026' })
assert.equal(b1.questions.at(-1).continues_next, true)
assert.equal(b2.questions[0].continued_from_prev, true)
assert.equal(b2.questions[0].no, '25')
assert.equal(b2.sections[0].continued_from_prev, true)

console.log('mock-canned.test ✓')
