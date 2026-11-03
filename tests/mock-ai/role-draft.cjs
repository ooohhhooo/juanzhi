// 角色草稿（kind agent-role-draft，提示词 p7_role_draft）的固定回复：故意夹带一个不存在的工具和 Skill，验证程序会过滤。
const isRoleDraft = sys => /工作助手角色/.test(sys)
const build = () => JSON.stringify({
  name: '班级跟进助手',
  description: '你在帮班主任盯学员状态：先说结论，再说依据，语气温和。',
  tools: ['list_datasets', 'run_query', 'stat_nps', 'stats_overview', 'no_such_tool'],
  suggestions: ['哪些学员最近到课变少了', '本周要跟进谁', '帮我写一段和家长沟通的话', '这个班满意度怎么样'],
  defaultPlaybook: 'no-such-skill',
  notes: '名单里只放需要的字段。'
})
module.exports = { isRoleDraft, build }
