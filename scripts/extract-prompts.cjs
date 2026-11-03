// 把 docs/prompts/v2-分读者与事实核对.md 和 v3-课程对照.md 里的提示词正文原样抽成资源文件（v1 保留作历史，不再抽）。
// 用法：node scripts/extract-prompts.cjs     输出：src/main/ai/prompts/<id>.<system|user>.txt
// 提示词有改动时重新跑一次并同步更新 PROMPT_DEFAULT_VERSION（src/main/ai/prompts.ts）。
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'src/main/ai/prompts')
fs.mkdirSync(outDir, { recursive: true })

// 两份文档：v2（16 个）和 v3-课程对照（4 个新提示词，8 个文件）。每份文档的章节编号到提示词 id 的对照不同
const DOCS = [
  { file: 'docs/prompts/v2-分读者与事实核对.md', ids: { 三: 'p1_text', 四: 'p1_vision', 五: 'p2_yoy', 六: 'p3_report', 七: 'p3_boss', 八: 'p3_parent', 九: 'p3_teacher', 十: 'p2_kp' } },
  { file: 'docs/prompts/v3-课程对照.md', ids: { 一: 'p5_course_cols', 二: 'p5_course_match', 三: 'p5_course_advice', 四: 'p5_course_hint' } }
]
const written = []
for (const doc of DOCS) extract(doc)

function extract(doc) {
const src = fs.readFileSync(path.join(root, doc.file), 'utf8').replace(/\r\n/g, '\n').split('\n')
const SECTION_ID = doc.ids
let cur = null
let part = null
let inFence = false
let buf = []

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
}
console.log(written.join('\n'))
const expected = DOCS.reduce((n, d) => n + Object.keys(d.ids).length * 2, 0)   // 每个提示词 system + user 两个文件；随文档里登记的 id 变，不写死个数
if (written.length !== expected) { console.error(`期望 ${expected} 个文件，实际 ${written.length}`); process.exit(1) }
