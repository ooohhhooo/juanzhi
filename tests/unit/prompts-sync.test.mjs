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

// 示例里的代码
const kps = new Set(KP_SEEDS_V1.map(k => k[0]))
const qtypes = new Set(QTYPE_SEEDS_V1.map(q => q[0]))
const text = blocks['p1_text.system'] + '\n' + blocks['p1_vision.system']
const usedKp = [...text.matchAll(/"kp_(?:main|secondary)":\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])).filter(Boolean)
const usedQt = [...text.matchAll(/"qtype":"([^"]+)"/g)].map(m => m[1])
assert.ok(usedKp.length >= 3 && usedQt.length >= 3, '应能从示例里取到代码')
for (const c of usedKp) assert.ok(kps.has(c), `示例里的知识点代码 ${c} 不在内置树里`)
for (const c of usedQt) assert.ok(qtypes.has(c), `示例里的题型代码 ${c} 不在题型表里`)

console.log(`prompts-sync.test ✓（16 个提示词与资源文件一致；示例用到知识点 ${new Set(usedKp).size} 个、题型 ${new Set(usedQt).size} 个，均存在）`)
