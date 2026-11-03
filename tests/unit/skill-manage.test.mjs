// Skill 管理（保存 / 删除 / 导入 SKILL.md 文件夹）：生成的 frontmatter 能被现有解析器解析，同名冲突，64KB 上限，工具名提示。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt } from '../../src/main/agent/prompt.ts'
import { getRole } from '../../src/main/agent/roles.ts'
import { parsePlaybook } from '../../src/main/agent/playbooks/parse.ts'
import { readPlaybookFiles } from '../../src/main/agent/playbooks/store.ts'
import { saveSkill, deleteSkill, importSkillFolder, importSkillFile, serializeSkill, listUserSkillFiles, unknownToolMentions, MAX_BODY_BYTES } from '../../src/main/agent/playbooks/manage.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'))
const dir = path.join(tmp, 'playbooks')
const tools = ['stats_overview', 'load_playbook']
const base = { name: '我的续费', description: '一句话', roles: ['ops', 'tutor'], when: '算续费时', body: '# 步骤\n先看 `stats_overview`' }

// 保存生成的文件能被现有解析器解析
{
  const r = saveSkill(dir, base, { knownTools: tools })
  assert.equal(r.name, '我的续费'); assert.deepEqual(r.warnings, [])
  const f = fs.readdirSync(dir)
  assert.equal(f.length, 1)
  const p = parsePlaybook(fs.readFileSync(path.join(dir, f[0]), 'utf8'))
  assert.ok(p.ok); assert.deepEqual([p.playbook.name, p.playbook.description, p.playbook.roles, p.playbook.when], ['我的续费', '一句话', ['ops', 'tutor'], '算续费时'])
  assert.equal(readPlaybookFiles(dir, 'user').items.length, 1)
  // roles 为空 = 不写 roles 行
  assert.ok(!/roles:/.test(serializeSkill({ ...base, roles: [] })))
  assert.deepEqual(parsePlaybook(serializeSkill({ ...base, roles: [] })).playbook.roles, [])
}

// 同名冲突；编辑自己不算冲突；改名后旧名消失
{
  assert.throws(() => saveSkill(dir, base, { knownTools: tools }), /已经有一个叫/)
  saveSkill(dir, { ...base, description: '改过' }, { originalName: '我的续费', knownTools: tools })
  assert.equal(listUserSkillFiles(dir)[0].playbook.description, '改过')
  saveSkill(dir, { ...base, name: '新名字' }, { originalName: '我的续费', knownTools: tools })
  assert.deepEqual(listUserSkillFiles(dir).map(x => x.playbook.name), ['新名字'])
}

// 64KB 上限、frontmatter 不合法、工具名提示
{
  assert.throws(() => saveSkill(dir, { ...base, name: 'big', body: 'x'.repeat(MAX_BODY_BYTES + 1) }, { knownTools: tools }), /64KB/)
  assert.throws(() => saveSkill(dir, { ...base, name: 'Bad Name!' }, { knownTools: tools }), /name 只能用/)
  assert.throws(() => saveSkill(dir, { ...base, name: 'e', body: '   ' }, { knownTools: tools }), /正文/)
  const r = saveSkill(dir, { ...base, name: 'tool-check', body: '用 `stats_overview` 和 `no_such_tool`' }, { knownTools: tools })
  assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /no_such_tool/)
  assert.deepEqual(unknownToolMentions('`stats_overview` `abc`', tools), [])
}

// SKILL.md 文件夹导入：缺 roles = 全部角色；其他文件不导入
{
  const src = path.join(tmp, 'My_Skill'); fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: pdf_tools\ndescription: "处理 PDF: 合并和拆分"\nallowed-tools: Bash\n---\n# 用法\n读文件\n')
  fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), 'echo hi')
  const r = importSkillFolder(dir, src, tools)
  assert.equal(r.name, 'pdf-tools'); assert.match(r.note, /脚本不会执行/)
  const got = listUserSkillFiles(dir).find(x => x.playbook.name === 'pdf-tools')
  assert.deepEqual(got.playbook.roles, []); assert.equal(got.playbook.description, '处理 PDF: 合并和拆分'); assert.equal(got.origin, 'imported')
  assert.ok(!fs.readdirSync(dir).some(f => /run|scripts/.test(f)))
  assert.throws(() => importSkillFolder(dir, src, tools), /已经有一个叫/)   // 再导一次 = 同名冲突
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty)
  assert.throws(() => importSkillFolder(dir, empty, tools), /没有 SKILL.md/)
  fs.writeFileSync(path.join(src, 'SKILL.md'), '没有头部')
  assert.throws(() => importSkillFolder(dir, src, tools), /frontmatter/)
  // 单个 .md
  const f = path.join(tmp, 'one.md'); fs.writeFileSync(f, serializeSkill({ ...base, name: 'one-md' }))
  assert.equal(importSkillFile(dir, f, tools).name, 'one-md')
}

// 删除
{
  assert.equal(deleteSkill(dir, 'one-md'), true); assert.equal(deleteSkill(dir, 'one-md'), false)
  assert.ok(!listUserSkillFiles(dir).some(x => x.playbook.name === 'one-md'))
}
// 用户指定的 Skill 会写进 system
{
  const sp = buildSystemPrompt({ role: getRole('ops'), scene: 'org', playbooks: [], today: 'x', pickedPlaybooks: ['续费分析'] })
  assert.match(sp, /用户指定了 Skill 《续费分析》.*load_playbook/)
  assert.ok(!/用户指定了/.test(buildSystemPrompt({ role: getRole('ops'), scene: 'org', playbooks: [], today: 'x' })))
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log('skill-manage ok')
