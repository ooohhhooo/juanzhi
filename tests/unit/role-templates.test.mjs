// 角色模板库与 AI 角色草稿：模板里的工具名 / Skill 名都真实存在；草稿会过滤不存在的；学校场景隐藏续费顾问、课程顾问。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeTools } from '../../src/main/agent/all-tools-core.ts'
import { ROLE_TEMPLATES, templatesFor, popularTemplates, toolCategory, TOOL_CATEGORIES } from '../../src/main/agent/role-templates.ts'
import { normalizeRoleDraft, draftVars, fillTemplate } from '../../src/main/agent/role-draft.ts'
import { CustomRoleSchema } from '../../src/main/agent/custom-roles.ts'
import { BASE_TOOLS, EXAM_TOOLS } from '../../src/main/agent/roles.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const connectors = ['connectors_list', 'wecom_send'].map(name => ({ name, description: 'x', params: { parse: v => v }, level: 'external', preview: async () => ({ target: '', content: '' }), run: async () => ({}) }))
const realTools = new Set([...composeTools(connectors).map(t => t.name), ...EXAM_TOOLS])
// 试卷工具在 tools/data.ts 里注册：名字必须真的写在那里
const dataSrc = fs.readFileSync(path.join(root, 'src/main/agent/tools/data.ts'), 'utf8')
for (const n of EXAM_TOOLS) assert.ok(dataSrc.includes(`name: '${n}'`), `试卷工具 ${n} 不存在`)

const pbDir = path.join(root, 'src/main/agent/playbooks')
const skills = new Set(fs.readdirSync(pbDir).filter(f => f.endsWith('.md')).map(f => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(pbDir, f), 'utf8'))?.[1]?.trim()).filter(Boolean))
assert.ok(skills.size >= 7)

// 1. 模板数据：数量、工具、Skill、字段长度都合格
assert.ok(ROLE_TEMPLATES.length >= 12)
assert.equal(new Set(ROLE_TEMPLATES.map(t => t.id)).size, ROLE_TEMPLATES.length, 'id 不重复')
for (const t of ROLE_TEMPLATES) {
  for (const tool of t.tools) assert.ok(realTools.has(tool), `${t.id} 的工具 ${tool} 不存在`)
  assert.equal(new Set(t.tools).size, t.tools.length, `${t.id} 工具重复`)
  assert.ok(t.tools.every(x => !BASE_TOOLS.includes(x)), `${t.id} 不该列基础工具`)
  if (t.defaultPlaybook) assert.ok(skills.has(t.defaultPlaybook), `${t.id} 的 Skill ${t.defaultPlaybook} 不存在`)
  assert.equal(t.suggestions.length, 4, `${t.id} 要 4 个推荐问题`)
  for (const scene of ['org', 'school']) {
    assert.ok(t.names[scene] && t.who[scene])
    // 能直接通过角色文件的校验
    CustomRoleSchema.parse({ id: 'c-abcdef', name: t.names[scene], description: t.description, tools: t.tools, suggestions: t.suggestions, defaultPlaybook: t.defaultPlaybook, notes: t.notes })
  }
  assert.ok(t.who.org.length <= 30 && t.who.school.length <= 30, `${t.id} 一句话太长`)
}

// 2. 学校场景隐藏续费顾问、课程顾问；机构场景都有
const ids = s => templatesFor(s).map(t => t.id)
assert.ok(ids('org').includes('renewal') && ids('org').includes('advisor'))
assert.ok(!ids('school').includes('renewal') && !ids('school').includes('advisor'))
assert.ok(ids('school').length >= 10)
assert.equal(popularTemplates('org').length, 4)
assert.equal(popularTemplates('school').length, 4)
assert.ok(popularTemplates('school').every(t => !t.hiddenIn?.includes('school')))

// 3. 工具分类：每个模板里的工具都能归类，类别齐全
for (const t of ROLE_TEMPLATES) for (const n of t.tools) assert.ok(TOOL_CATEGORIES.some(c => c.id === toolCategory(n)))
assert.equal(toolCategory('stat_nps'), 'stats'); assert.equal(toolCategory('board_start'), 'output'); assert.equal(toolCategory('stats_overview'), 'exam')
assert.equal(toolCategory('run_query'), 'data'); assert.equal(toolCategory('wecom_send'), 'connector'); assert.equal(toolCategory('mcp_x_y'), 'connector')

// 4. AI 草稿：过滤不存在的工具和 Skill，问题最多 4 个，坏回答返回 null
const knownTools = new Set(['run_query', 'stat_nps', 'board_start', 'stats_overview'])
const knownSkills = new Set(['renewal', '学情周报'])
const good = normalizeRoleDraft('```json\n' + JSON.stringify({
  name: '班主任助手', description: '你在帮班主任……', tools: ['run_query', 'no_such_tool', 'stat_nps', 'update_plan', 'run_query'],
  suggestions: ['a', 'b', 'c', 'd', 'e', ''], defaultPlaybook: 'renewal', notes: '注意口径'
}) + '\n```', knownTools, knownSkills)
assert.deepEqual(good.tools, ['run_query', 'stat_nps'])
assert.deepEqual(good.suggestions, ['a', 'b', 'c', 'd'])
assert.equal(good.defaultPlaybook, 'renewal')
assert.equal(normalizeRoleDraft(JSON.stringify({ name: 'x', defaultPlaybook: '瞎编的' }), knownTools, knownSkills).defaultPlaybook, undefined)
assert.equal(normalizeRoleDraft('不是 JSON', knownTools, knownSkills), null)
assert.equal(normalizeRoleDraft(JSON.stringify({ description: '没名字' }), knownTools, knownSkills), null)
assert.equal(normalizeRoleDraft(JSON.stringify({ name: 'n'.repeat(50), description: 'd'.repeat(900) }), knownTools, knownSkills).name.length, 20)
CustomRoleSchema.parse({ id: 'c-abcdef', ...good })

// 5. 提示词输入：基础工具不进清单；占位符都被填满
const vars = draftVars({ job: '班主任', tasks: ['看数据'], reportTo: '主管', style: '简洁直接', extra: '' }, 'school', [{ name: 'update_plan', label: '计划' }, { name: 'run_query', label: '查数据' }], [{ name: 'renewal', description: '续费' }])
assert.ok(!vars.TOOL_LIST.includes('update_plan') && vars.TOOL_LIST.includes('run_query：查数据'))
assert.equal(vars.SCENE, '学校')
const user = fs.readFileSync(path.join(root, 'src/main/ai/prompts/p7_role_draft.user.txt'), 'utf8')
assert.ok(!/\{\{/.test(fillTemplate(user, vars)))
console.log('role-templates ok')
