// Skill 草稿（kind agent-skill-draft）的固定回复：故意夹带 AI 编的步骤（不存在的工具、样本里没出现的工具、没出处的步骤），验证程序会按样本重新数并去掉。
const isSkillDraft = sys => /几次相似的工作对话/.test(sys)
const build = user => {
  const update = /现有版本的正文/.test(user)
  return JSON.stringify({
    name: '学情小结', description: '给运营做一份一页的学情小结', when: '要做学情小结、阶段小结时',
    params: [{ name: '年级', hint: '要看哪个年级？' }, { name: '时间段', hint: '看哪一段时间？' }],
    steps: [
      { text: '先看整体情况', tool: 'stats_overview', samples: [1, 2, 3, 4, 5], condition: '' },
      { text: '看已有的试卷清单', tool: 'papers_list', samples: [1, 2, 3], condition: '用户问到具体试卷时' },
      { text: '查对应的课', tool: 'course_for_kp', samples: [1, 2, 3, 4, 5], condition: '' },
      { text: '发到企业微信群', tool: 'wecom_send', samples: [1, 2, 3], condition: '' },
      { text: '一个工具都不存在的步骤', tool: 'no_such_tool', samples: [1], condition: '' },
      { text: '先确认年级和时间段', tool: '', samples: [1, 2, 3], condition: '' },
      { text: '凭空编出来的步骤', tool: '', samples: [], condition: '' }
    ],
    output: update ? '## 学情小结\n【年级】本周情况：……\n结尾只写一句话，不超过 20 个字。' : '## 学情小结\n【年级】本周情况：……\n下周建议：……',
    checklist: ['数字都有出处', '不出现真名']
  })
}
module.exports = { isSkillDraft, build }
