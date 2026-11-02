// 提示词资源文件必须与 docs/prompts/v2-分读者与事实核对.md 逐字一致（E2E 只能比资源文件，防不住「docs 改了资源没重抽」，这里补上）；
// 并检查提示词示例里出现的知识点/题型代码都在内置树里（审核 P2-24）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KP_SEEDS_V1, QTYPE_SEEDS_V1 } from '../../src/main/seed/taxonomy.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const md = fs.readFileSync(path.join(root, 'docs/prompts/v2-分读者与事实核对.md'), 'utf8').replace(/\r\n/g, '\n').split('\n')
const IDS = { 三: 'p1_text', 四: 'p1_vision', 五: 'p2_yoy', 六: 'p3_report', 七: 'p3_boss', 八: 'p3_parent', 九: 'p3_teacher', 十: 'p2_kp' }

// 与 scripts/extract-prompts.cjs 同样的规则，独立再实现一遍
const blocks = {}
let cur = null, part = null, inFence = false, buf = []
for (const line of md) {
  if (!inFence) {
    const h2 = /^## ([一二三四五六七八九十]+)、/.exec(line)
    if (h2) { cur = IDS[h2[1]] ?? null; part = null; continue }
    const h3 = /^### (system|user)\s*$/.exec(line)
    if (h3 && cur) { part = h3[1]; continue }
    if (/^````text\s*$/.test(line) && cur && part) { inFence = true; buf = []; continue }
  } else if (/^````\s*$/.test(line)) { inFence = false; blocks[`${cur}.${part}`] = buf.join('\n'); part = null } else buf.push(line)
}
assert.equal(Object.keys(blocks).length, 16)
for (const [k, text] of Object.entries(blocks)) {
  const file = fs.readFileSync(path.join(root, 'src/main/ai/prompts', `${k}.txt`), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  assert.equal(file, text.replace(/\s+$/, ''), `资源文件 ${k}.txt 与 docs 不一致——改了 docs/prompts 后要重跑 node scripts/extract-prompts.cjs`)
}

// 课程对照的四个提示词（v3-课程对照.md）：资源文件逐字一致；占位符与程序登记的一致
{
  const md3 = fs.readFileSync(path.join(root, 'docs/prompts/v3-课程对照.md'), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const IDS3 = { 一: 'p5_course_cols', 二: 'p5_course_match', 三: 'p5_course_advice', 四: 'p5_course_hint' }
  const b3 = {}
  let c3 = null, p3 = null, fence = false, buf3 = []
  for (const line of md3) {
    if (!fence) {
      const h2 = /^## ([一二三四五六七八九十]+)、/.exec(line)
      if (h2) { c3 = IDS3[h2[1]] ?? null; p3 = null; continue }
      const h3 = /^### (system|user)\s*$/.exec(line)
      if (h3 && c3) { p3 = h3[1]; continue }
      if (/^````text\s*$/.test(line) && c3 && p3) { fence = true; buf3 = []; continue }
    } else if (/^````\s*$/.test(line)) { fence = false; b3[`${c3}.${p3}`] = buf3.join('\n'); p3 = null } else buf3.push(line)
  }
  assert.equal(Object.keys(b3).length, 8)
  for (const [k, text] of Object.entries(b3)) {
    const file = fs.readFileSync(path.join(root, 'src/main/ai/prompts', `${k}.txt`), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
    assert.equal(file, text.replace(/\s+$/, ''), `资源文件 ${k}.txt 与 docs/prompts/v3-课程对照.md 不一致——改了文档后要重跑 node scripts/extract-prompts.cjs`)
  }
  // 用户提示词里的占位符 == 程序登记的占位符（prompts.ts 里的 PLACEHOLDERS）
  const reg = fs.readFileSync(path.join(root, 'src/main/ai/prompts.ts'), 'utf8')
  for (const id of ['p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint']) {
    const used = [...new Set([...b3[`${id}.user`].matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))].sort()
    const line = new RegExp(`${id}: \\[([^\\]]*)\\]`).exec(reg)?.[1] ?? ''
    const registered = [...line.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(used.filter(u => registered.includes(u)), used, `${id} 的 user 提示词里用到了没登记的占位符`)
    assert.ok(registered.length >= used.length)
  }
}

// 示例里的代码
const kps = new Set(KP_SEEDS_V1.map(k => k[0]))
const qtypes = new Set(QTYPE_SEEDS_V1.map(q => q[0]))
const text = blocks['p1_text.system'] + '\n' + blocks['p1_vision.system']
const usedKp = [...text.matchAll(/"kp_(?:main|secondary)":\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])).filter(Boolean)
const usedQt = [...text.matchAll(/"qtype":"([^"]+)"/g)].map(m => m[1])
assert.ok(usedKp.length >= 3 && usedQt.length >= 3, '应能从示例里取到代码')
for (const c of usedKp) assert.ok(kps.has(c), `示例里的知识点代码 ${c} 不在内置树里`)
for (const c of usedQt) assert.ok(qtypes.has(c), `示例里的题型代码 ${c} 不在题型表里`)

console.log(`prompts-sync.test ✓（16 + 8 个提示词与资源文件一致；示例用到知识点 ${new Set(usedKp).size} 个、题型 ${new Set(usedQt).size} 个，均存在）`)
