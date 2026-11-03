/**
 * 助手的角色配置。加一个新角色（或给现有角色接新工具）只改这一个文件：
 *  - tools：这个角色能用的工具名（工具本身在 tools/ 里注册）；
 *  - suggestions：界面上的推荐问题；
 *  - rules：只对这个角色生效的额外规矩；
 *  - enabled：false = 先占位，界面不显示。
 * 名称有「培训机构 / 学校」两套叫法，按设置里的场景显示。
 */
import type { Scene } from './types.ts'

export type RoleId = 'ops' | 'tutor' | 'research' | 'teacher'

export interface RoleDef {
  id: RoleId
  names: Record<Scene, string>
  /** 说话方式 / 这个角色关心什么（写进给模型的规矩里） */
  persona: string
  tools: string[]
  suggestions: string[]
  rules: string[]
  enabled: boolean
  /** 用户自建的角色（存在数据目录 agent-roles/） */
  custom?: boolean
  /** 默认先用的剧本名 */
  defaultPlaybook?: string
}

/** 所有角色都有的基础工具（计划、提问、剧本） */
export const BASE_TOOLS = ['update_plan', 'ask_user', 'load_playbook', 'session_state']
/** 现有试卷数据的只读工具 */
export const EXAM_TOOLS = ['stats_overview', 'kp_questions', 'course_for_kp', 'fact_check']

export const ROLES: RoleDef[] = [
  {
    id: 'ops',
    names: { org: '运营', school: '教务/年级主任' },
    persona: '你在帮运营（教务）同事看整体情况：先给结论和数字，再说依据；关心整体趋势、哪些地方值得重点安排，不纠缠单个题目的细节。说话简短、直接，像同事之间汇报。',
    tools: [...BASE_TOOLS, ...EXAM_TOOLS],
    suggestions: [
      '帮我做一份学情周报',
      '最近这批试卷里，最常考、最容易出错的知识点有哪些？',
      '哪些常考的知识点，课程里还没有对应的课？',
      '哪几个易错点最值得在下周的课上重点安排？'
    ],
    rules: ['涉及整体结论时，说明数据范围（几份卷子、几道题）。'],
    enabled: true
  },
  {
    id: 'tutor',
    names: { org: '辅导老师', school: '班主任' },
    persona: '你在帮辅导老师（班主任）准备跟进学生：多举具体的题和易错原因，给能直接讲给家长或学生听的大白话说明，语气温和、实用。',
    tools: [...BASE_TOOLS, ...EXAM_TOOLS],
    suggestions: [
      '一般过去时考过哪些题？孩子容易错在哪里？',
      '帮我整理几个最常见的易错点，我想讲给家长听',
      '这些易错点分别对应课程里的哪几课？',
      '帮我核对这段话里的语法说法有没有错：'
    ],
    rules: ['软件里没有学生个人的成绩，只有试卷上常见的易错点；不要说某个学生丢了几分，要说「这类题常见的错误」。'],
    enabled: true
  },
  // 下面两个角色先占位：教研、授课老师的工具和剧本后续再接
  { id: 'research', names: { org: '教研', school: '教研组长' }, persona: '', tools: [...BASE_TOOLS, ...EXAM_TOOLS], suggestions: [], rules: [], enabled: false },
  { id: 'teacher', names: { org: '授课老师', school: '任课老师' }, persona: '', tools: [...BASE_TOOLS, ...EXAM_TOOLS], suggestions: [], rules: [], enabled: false }
]

export const enabledRoles = (): RoleDef[] => ROLES.filter(r => r.enabled)
export const getRole = (id: string): RoleDef | undefined => ROLES.find(r => r.id === id)
export const roleName = (r: RoleDef, scene: Scene): string => r.names[scene]
