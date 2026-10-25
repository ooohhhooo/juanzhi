// 把 docs/prompts/v1-sonnet改写.md 里的提示词正文原样抽成资源文件（docs/prompts 本身不改）。
// 用法：node scripts/extract-prompts.cjs     输出：src/main/ai/prompts/<id>.<system|user>.txt
// 提示词有改动时重新跑一次并同步更新 PROMPT_DEFAULT_VERSION（src/main/ai/prompts.ts）。
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const src = fs.readFileSync(path.join(root, 'docs/prompts/v1-sonnet改写.md'), 'utf8').replace(/\r\n/g, '\n').split('\n')
const outDir = path.join(root, 'src/main/ai/prompts')
fs.mkdirSync(outDir, { recursive: true })

const SECTION_ID = { 三: 'p1_text', 四: 'p1_vision', 五: 'p2_yoy', 六: 'p3_report' }
let cur = null
let part = null
let inFence = false
let buf = []
const written = []

for (const line of src) {
  if (!inFence) {
    const h2 = /^## ([一二三四五六七八九十]+)、/.exec(line)
    if (h2) { cur = SECTION_ID[h2[1]] ?? null; part = null; continue }
    const h3 = /^### (system|user)\s*$/.exec(line)
    if (h3 && cur) { part = h3[1]; continue }
    if (/^````text\s*$/.test(line) && cur && part) { inFence = true; buf = []; continue }
  } else if (/^````\s*$/.test(line)) {
    inFence = false
    const file = path.join(outDir, `${cur}.${part}.txt`)
    fs.writeFileSync(file, buf.join('\n') + '\n')
    written.push(`${path.relative(root, file)} (${buf.join('\n').length} 字)`)
    part = null
  } else {
    buf.push(line)
  }
}
console.log(written.join('\n'))
if (written.length !== 8) { console.error(`期望 8 个文件，实际 ${written.length}`); process.exit(1) }
