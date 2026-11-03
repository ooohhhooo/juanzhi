// 剧本（src/main/agent/playbooks/*.md）的格式校验：frontmatter 完整、roles 合法、正文覆盖方法的各个环节，
// 提到的统计工具都真实存在，且不含任何机构 / 产品名。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlaybook } from '../../src/main/agent/playbooks/parse.ts'
import { statTools } from '../../src/main/analysis/stats/tools.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = path.join(root, 'src/main/agent/playbooks')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort()
const EXPECTED = ['attendance-lateness', 'learning-weekly', 'refund-reasons', 'renewal', 'satisfaction-nps', 'student-followup-list']
assert.deepEqual(files.map(f => f.replace(/\.md$/, '')), EXPECTED)

const toolNames = new Set([...statTools.map(t => t.name), 'text_classify', 'run_query'])
for (const f of files) {
  const md = fs.readFileSync(path.join(dir, f), 'utf8')
  const r = parsePlaybook(md)
  assert.ok(r.ok, `${f}: ${r.error}`)
  assert.equal(r.playbook.name, f.replace(/\.md$/, ''), `${f}: name 要和文件名一致`)
  assert.ok(r.playbook.description.length >= 10 && r.playbook.when.length >= 10, `${f}: description / when 太短`)
  // 方法要点
  for (const kw of ['口径', '样本', '说不清|局限', '不是因果|不等于因果|相关', '产出', '名单']) assert.match(r.playbook.body, new RegExp(kw), `${f}: 缺少「${kw}」相关内容`)
  // 提到的工具都存在
  const used = new Set([...md.matchAll(/\b((?:stat|text)_[a-z_]+)\b/g)].map(m => m[1]))
  for (const u of used) assert.ok(toolNames.has(u), `${f}: 提到了不存在的工具 ${u}`)
  // 不出现机构 / 品牌（禁用词用片段拼）
  for (const w of [['猿', '辅导'], ['卓', '越'], ['全', '能线']].map(p => p.join(''))) assert.ok(!md.includes(w), `${f}: 含禁用词`)
}

// 解析器自身
assert.equal(parsePlaybook('没有头部').ok, false)
assert.equal(parsePlaybook('---\nname: a\n---\n正文').ok, false)
assert.match(parsePlaybook('---\nname: a-b\ndescription: 描述描述\nroles: [老板]\nwhen: 某种情况\n---\n正文').error, /不认识：老板/)
assert.equal(parsePlaybook('---\nname: a-b\ndescription: 描述描述\nroles: [运营, 教研]\nwhen: 某种情况\n---\n正文').playbook.roles.length, 2)
assert.equal(parsePlaybook('---\nname: A_B\ndescription: x\nroles: [运营]\nwhen: y\n---\n正文').ok, false)

console.log(`analysis-playbooks.test ✓（${files.length} 个剧本）`)
