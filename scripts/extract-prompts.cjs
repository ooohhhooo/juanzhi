// 把 docs/prompts 里的提示词正文原样抽成资源文件（v1 保留作历史，不再抽）。
// 依次读 v2（分读者与事实核对）、v3（老师版升级）和 v3-课程对照，后读的覆盖先读的：p3_teacher 以 v3 为准，v2 里的那份只是历史。
// 用法：node scripts/extract-prompts.cjs     输出：src/main/ai/prompts/<id>.<system|user>.txt
// 提示词有改动时重新跑一次并同步更新对应提示词的版本号（src/main/ai/prompts.ts 的 PROMPT_VERSIONS / PROMPT_DEFAULT_VERSION）。
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'src/main/ai/prompts')
fs.mkdirSync(outDir, { recursive: true })

// 语文 / 数学的提示词（v6 / v7）：同样 15 个提示词 × system + user，输出文件名 <id>.<学科>.<part>.txt
const SUBJECT_PROMPT_IDS = ['p1_text', 'p1_vision', 'p2_yoy', 'p2_kp', 'p3_report', 'p3_boss', 'p3_parent', 'p3_teacher', 'p3_tricks', 'p4_variant_gen', 'p4_variant_check', 'p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint']
const NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五']
const subjectDoc = (file, subject) => ({ file, ids: Object.fromEntries(NUMS.map((n, i) => [n, `${SUBJECT_PROMPT_IDS[i]}.${subject}`])) })

const DOCS = [
  { file: 'docs/prompts/v2-分读者与事实核对.md', ids: { 三: 'p1_text', 四: 'p1_vision', 五: 'p2_yoy', 六: 'p3_report', 七: 'p3_boss', 八: 'p3_parent', 九: 'p3_teacher', 十: 'p2_kp' } },
  { file: 'docs/prompts/v3-老师版升级.md', ids: { 一: 'p3_teacher', 二: 'p3_tricks', 三: 'p4_variant_gen', 四: 'p4_variant_check' } },
  { file: 'docs/prompts/v3-课程对照.md', ids: { 一: 'p5_course_cols', 二: 'p5_course_match', 三: 'p5_course_advice', 四: 'p5_course_hint', 五: 'p5_course_extract', 六: 'p5_course_textbook' } },
  { file: 'docs/prompts/v4-文字归类.md', ids: { 一: 'p6_classify_propose', 二: 'p6_classify_assign' } },
  { file: 'docs/prompts/v5-角色草稿.md', ids: { 一: 'p7_role_draft' } },
  subjectDoc('docs/prompts/v6-语文.md', 'chinese'),
  subjectDoc('docs/prompts/v7-数学.md', 'math')
]
// 每个提示词 system + user 两个文件；个数随文档里登记的 id 变（同名的后者覆盖前者，只算一次），不写死
const EXPECTED = new Set(DOCS.flatMap(d => Object.values(d.ids))).size * 2
const result = new Map()

for (const doc of DOCS) {
  const src = fs.readFileSync(path.join(root, doc.file), 'utf8').replace(/\r\n/g, '\n').split('\n')
  let cur = null
  let part = null
  let inFence = false
  let buf = []
  for (const line of src) {
    if (!inFence) {
      const h2 = /^## ([一二三四五六七八九十]+)、/.exec(line)
      if (h2) { cur = doc.ids[h2[1]] ?? null; part = null; continue }
      const h3 = /^### (system|user)\s*$/.exec(line)
      if (h3 && cur) { part = h3[1]; continue }
      if (/^````text\s*$/.test(line) && cur && part) { inFence = true; buf = []; continue }
    } else if (/^````\s*$/.test(line)) {
      inFence = false
      result.set(`${cur}.${part}`, buf.join('\n'))
      part = null
    } else {
      buf.push(line)
    }
  }
}
const written = []
for (const [k, text] of result) {
  const file = path.join(outDir, `${k}.txt`)
  fs.writeFileSync(file, text + '\n')
  written.push(`${path.relative(root, file)} (${text.length} 字)`)
}
console.log(written.join('\n'))
if (written.length !== EXPECTED) { console.error(`期望 ${EXPECTED} 个文件，实际 ${written.length}`); process.exit(1) }
