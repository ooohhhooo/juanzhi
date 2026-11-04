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
export const BASE_TOOLS = ['update_plan', 'ask_user', 'load_playbook', 'session_state', 'history_search', 'history_read', 'delegate_tasks']
/** 现有试卷数据的只读工具 */
export const EXAM_TOOLS = ['stats_overview', 'kp_questions', 'course_for_kp', 'fact_check', 'papers_list', 'course_coverage', 'reports_list', 'report_read']
/** 数据分析工具：数据集、统计、文字归类、看板、产出、连接器（运营、辅导老师用） */
export const DATA_TOOLS = [
  'list_datasets', 'dataset_profile', 'run_query', 'column_values', 'read_document',
  'stat_nps', 'stat_compare_groups', 'stat_find_low_groups', 'stat_period_compare', 'stat_crosstab', 'stat_multi_choice', 'stat_option_impact', 'stat_distribution', 'stat_ratio', 'stat_middle_segment',
  'text_classify',
  'board_start', 'board_add_finding', 'board_add_section', 'board_add_block', 'board_set_caliber', 'board_preview', 'board_export',
  'doc_create', 'doc_write_section', 'doc_read', 'table_save', 'outputs_list', 'output_export',
  'card_templates', 'card_make',
  'connectors_list', 'wecom_send'
]
/** 这些角色可以用用户配置的外部（MCP）工具；它们的名字随连接器配置变化，不写在上面的名单里 */
export const CONNECTOR_ROLES = ['ops', 'tutor']

export const ROLES: RoleDef[] = [
  {
    id: 'ops',
    names: { org: '运营', school: '教务/年级主任' },
    persona: '你在帮运营（教务）同事看整体情况：先给结论和数字，再说依据；关心整体趋势、哪些地方值得重点安排，不纠缠单个题目的细节。说话简短、直接，像同事之间汇报。',
    tools: [...BASE_TOOLS, ...EXAM_TOOLS, ...DATA_TOOLS],
    suggestions: [
      '分析这份问卷的满意度，出一份看板',
      '哪些班到课率掉得最厉害',
      '退费原因主要有哪些',
      '对比两期续费率'
    ],
    rules: ['涉及整体结论时，说明数据范围（几份卷子、几道题，或数据集多少行、哪个时间段）。', '分析导入的数据时，先看数据概况再查；每个数字都要来自查询结果，并在句末标 [[query:查询编号]]。'],
    enabled: true
  },
  {
    id: 'tutor',
    names: { org: '辅导老师', school: '班主任' },
    persona: '你在帮辅导老师（班主任）准备跟进学生：多举具体的题和易错原因，给能直接讲给家长或学生听的大白话说明，语气温和、实用。',
    tools: [...BASE_TOOLS, ...EXAM_TOOLS, ...DATA_TOOLS],
    suggestions: [
      '生成本周跟进名单',
      '哪些学员最近到课变少了',
      '这些学员课后该补什么',
      '帮我写一段和家长沟通续费的话',
      '给小雨做一张过去时的知识卡'
    ],
    rules: ['试卷数据里没有学生个人的成绩，只有试卷上常见的易错点；学员个人情况只能依据用户导入的数据集回答，没有数据就直说，不要编造。', '名单里只放任务需要的字段；发到外部之前，提醒用户检查里面的个人信息。'],
    enabled: true
  },
  // 下面两个角色先占位：教研、授课老师的工具和剧本后续再接
  { id: 'research', names: { org: '教研', school: '教研组长' }, persona: '', tools: [...BASE_TOOLS, ...EXAM_TOOLS], suggestions: [], rules: [], enabled: false },
  { id: 'teacher', names: { org: '授课老师', school: '任课老师' }, persona: '', tools: [...BASE_TOOLS, ...EXAM_TOOLS, 'card_templates', 'card_make'], suggestions: ['给学生做一张现在完成时的口诀卡'], rules: [], enabled: false }
]

export const enabledRoles = (): RoleDef[] => ROLES.filter(r => r.enabled)
export const getRole = (id: string): RoleDef | undefined => ROLES.find(r => r.id === id)
export const roleName = (r: RoleDef, scene: Scene): string => r.names[scene]
