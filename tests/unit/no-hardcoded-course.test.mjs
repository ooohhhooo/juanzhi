// 通用性底线（M9 §0.2）：软件里不写任何机构、品牌或课程线的名字；课程数据只能来自用户上传，仓库里不放课程表文件。
// 禁用词表用片段拼出来，免得这个测试文件本身出现在扫描结果里；设计稿（讲规则的那份文档）按文件名跳过。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BANNED = [['猿', '辅导'], ['卓', '越'], ['全', '能线'], ['全', '能课'], ['卓越', '线']].map(p => p.join(''))
const BANNED_EXACT = [['卓', '越'].join('')]   // 单独的「卓越」也不要（课程线名）；「全能」是常见词，只禁“全能线 / 全能课”
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', '.claude', '.impeccable'])
const SKIP_FILES = new Set(['M9-公测版设计方案.md', 'no-hardcoded-course.test.mjs'])
const SCAN_ROOTS = ['src', 'tests', 'docs', 'skills', 'scripts', 'README.md', 'README.en.md', 'DESIGN.md', 'PRODUCT.md', 'package.json']
const TEXT_EXT = /\.(ts|tsx|mjs|cjs|js|json|md|txt|css|html|ps1|py|yml|yaml)$/i

const files = []
const walk = p => {
  const st = fs.statSync(p)
  if (st.isDirectory()) { if (SKIP_DIRS.has(path.basename(p))) return; for (const f of fs.readdirSync(p)) walk(path.join(p, f)) }
  else if (!SKIP_FILES.has(path.basename(p)) && TEXT_EXT.test(p)) files.push(p)
}
for (const r of SCAN_ROOTS) { const p = path.join(root, r); if (fs.existsSync(p)) walk(p) }
assert.ok(files.length > 100, `扫到的文件数异常：${files.length}`)

const hits = []
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8')
  for (const w of [...BANNED, ...BANNED_EXACT]) if (t.includes(w)) hits.push(`${path.relative(root, f)}（含禁用词）`)
}
assert.deepEqual([...new Set(hits)], [], '这些文件里出现了机构 / 课程线的名字，软件必须保持通用：\n' + [...new Set(hits)].join('\n'))

// 仓库里没有课程表文件（模板和示例在运行时由代码生成）
const sheets = []
const walkAll = p => {
  const st = fs.statSync(p)
  if (st.isDirectory()) { if (SKIP_DIRS.has(path.basename(p))) return; for (const f of fs.readdirSync(p)) walkAll(path.join(p, f)) }
  else if (/\.(xlsx|xls|xlsm|numbers|et)$/i.test(p)) sheets.push(path.relative(root, p))
}
walkAll(root)
assert.deepEqual(sheets, [], '仓库里不能放表格文件：' + sheets.join(', '))

// 提示词里不出现任何机构名，并且明确禁止模型写机构名
for (const id of ['p5_course_cols', 'p5_course_match', 'p5_course_advice', 'p5_course_hint']) {
  for (const part of ['system', 'user']) {
    const t = fs.readFileSync(path.join(root, 'src/main/ai/prompts', `${id}.${part}.txt`), 'utf8')
    for (const w of BANNED) assert.ok(!t.includes(w), `${id}.${part} 里有禁用词`)
  }
}
assert.match(fs.readFileSync(path.join(root, 'src/main/ai/prompts/p5_course_advice.system.txt'), 'utf8'), /任何机构、品牌/)

console.log(`no-hardcoded-course.test ✓（扫描 ${files.length} 个文本文件）`)
