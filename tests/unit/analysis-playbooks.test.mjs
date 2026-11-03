// 剧本（src/main/agent/playbooks/*.md）的格式校验：frontmatter 完整、roles 合法、正文覆盖方法的各个环节，
// 提到的统计工具都真实存在，且不含任何机构 / 产品名。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlaybook } from '../../src/main/agent/playbooks/parse.ts'
import { statTools } from '../../src/main/analysis/stats/tools.ts'
import { DATASET_TOOLS } from '../../src/main/analysis/datasets/tools.ts'
import { boardToolList } from '../../src/main/analysis/report/tools.ts'
import { createPlaybooks } from '../../src/main/agent/playbooks/store.ts'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = path.join(root, 'src/main/agent/playbooks')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.')).sort()
const EXPECTED = ['attendance-lateness', 'learning-weekly', 'refund-reasons', 'renewal', 'satisfaction-nps', 'share-cards', 'student-followup-list', 'weekly-report']
// weekly-report 是基于试卷数据的学情周报（用 stats_overview 等试卷工具），名字叫「学情周报」，不套用数据分析剧本的方法要点检查
const EXAM_BASED = new Set(['weekly-report.md'])
assert.deepEqual(files.map(f => f.replace(/\.md$/, '')), EXPECTED)

const toolNames = new Set([...statTools.map(t => t.name), ...DATASET_TOOLS.map(t => t.name), ...boardToolList.map(t => t.name), 'text_classify'])
for (const f of files) {
  const md = fs.readFileSync(path.join(dir, f), 'utf8')
  const r = parsePlaybook(md)
  assert.ok(r.ok, `${f}: ${r.error}`)
  if (EXAM_BASED.has(f)) { assert.equal(r.playbook.name, '学情周报'); continue }
  // share-cards 是出卡片的 Skill（card_make），不是数据分析剧本，不套用口径 / 样本等检查；这里检查它提到的工具和隐私规则
  if (f === 'share-cards.md') { assert.equal(r.playbook.name, '分享卡片'); for (const k of ['card_make', '手机号', '其他孩子', '预览']) assert.ok(r.playbook.body.includes(k), '分享卡片 Skill 缺少 ' + k); continue }
  assert.equal(r.playbook.name, f.replace(/\.md$/, ''), `${f}: name 要和文件名一致`)
  assert.ok(r.playbook.description.length >= 10 && r.playbook.when.length >= 10, `${f}: description / when 太短`)
  // 方法要点
  for (const kw of ['口径', '样本', '说不清|局限', '不是因果|不等于因果|相关', '产出', '名单']) assert.match(r.playbook.body, new RegExp(kw), `${f}: 缺少「${kw}」相关内容`)
  // 提到的工具都存在
  const used = new Set([...md.matchAll(/\b((?:stat|text|board)_[a-z_]+|list_datasets|dataset_profile|run_query|column_values)\b/g)].map(m => m[1]))
  for (const u of used) assert.ok(toolNames.has(u), `${f}: 提到了不存在的工具 ${u}`)
  assert.ok(!/数据集概况工具/.test(md), `${f}: 还在用笼统的「数据集概况工具」，应写 dataset_profile`)
  // 不出现机构 / 品牌（禁用词用片段拼）
  for (const w of [['猿', '辅导'], ['卓', '越'], ['全', '能线']].map(p => p.join(''))) assert.ok(!md.includes(w), `${f}: 含禁用词`)
}

// index.ts 的内置清单和目录一一对应
const idx = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8')
for (const f of files) assert.ok(idx.includes(`'./${f}?raw'`.replace(/^'/, '').replace(/'$/, '')) || idx.includes(`./${f}?raw`), `index.ts 没有导入 ${f}`)
assert.equal([...idx.matchAll(/\.md\?raw/g)].length, files.length, 'index.ts 导入数量和目录不一致')

// 仓库：内置 + 用户剧本（同名用户优先，._ 文件和坏文件被跳过）
const builtin = Object.fromEntries([...files.map(f => ['./' + f, fs.readFileSync(path.join(dir, f), 'utf8')]), ['./._renewal.md', 'garbage']])
const pb = createPlaybooks(builtin)
const NAMES = EXPECTED.map(e => (e === 'weekly-report' ? '学情周报' : e === 'share-cards' ? '分享卡片' : e)).sort((a, b) => a.localeCompare(b))
assert.deepEqual(pb.listPlaybooks().map(p => p.name), NAMES)
assert.equal(pb.loadPlaybook('renewal').source, 'builtin'); assert.equal(pb.loadPlaybook('nope'), null)
const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-pb-'))
fs.mkdirSync(path.join(dd, 'playbooks'))
const mine = n => `---\nname: ${n}\ndescription: 我自己的分析方法说明文字\nroles: [运营]\nwhen: 用户想做某件事的时候用它\n---\n我的正文`
fs.writeFileSync(path.join(dd, 'playbooks', 'renewal.md'), mine('renewal'))
fs.writeFileSync(path.join(dd, 'playbooks', 'extra-one.md'), mine('extra-one'))
fs.writeFileSync(path.join(dd, 'playbooks', '._extra-one.md'), 'garbage')
fs.writeFileSync(path.join(dd, 'playbooks', 'broken.md'), '没有头部')
assert.equal(pb.loadPlaybook('renewal', dd).source, 'user'); assert.equal(pb.loadPlaybook('renewal', dd).body, '我的正文')
assert.equal(pb.listPlaybooks(dd).length, EXPECTED.length + 1)
assert.equal(pb.listPlaybooks(dd).find(p => p.name === 'extra-one').source, 'user')
assert.equal(pb.playbookProblems(dd).length, 1); assert.match(pb.playbookProblems(dd)[0], /broken\.md/)
assert.equal(pb.loadPlaybook('renewal').source, 'builtin', '不传数据目录时只看内置')

// 解析器自身
assert.equal(parsePlaybook('没有头部').ok, false)
assert.equal(parsePlaybook('---\nname: a\n---\n正文').ok, false)
assert.match(parsePlaybook('---\nname: a-b\ndescription: 描述描述\nroles: [老板]\nwhen: 某种情况\n---\n正文').error, /不认识：老板/)
assert.equal(parsePlaybook('---\nname: a-b\ndescription: 描述描述\nroles: [运营, 教研]\nwhen: 某种情况\n---\n正文').playbook.roles.length, 2)
assert.equal(parsePlaybook('---\nname: A_B\ndescription: x\nroles: [运营]\nwhen: y\n---\n正文').ok, false)

console.log(`analysis-playbooks.test ✓（${files.length} 个剧本）`)
