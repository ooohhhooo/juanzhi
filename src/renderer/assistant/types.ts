/**
 * 助手「画布模式」和右侧面板共用的类型。
 * 内核（会话树 agent_steps：parent_id / branch_id）把每一步转换成 CanvasNode[] 传进来即可，组件不关心数据库结构。
 */

/** 节点种类
 * - question：用户最初的问题（根）
 * - followup：用户在某张卡片上的追问（分支的起点）
 * - plan：计划（可带 5 步进度，见 body）
 * - finding：发现（一个结论 + 数字，可带 mini 小图）
 * - answer：对问题 / 追问的回答
 * - step-group：一组查询 / 统计步骤，画布上默认折叠成一个小节点
 * - output：产出文件的小卡片（汇报 .md、看板、名单）
 * - ask：Agent 向用户提问 / 等确认
 */
export type CanvasNodeKind = 'question' | 'followup' | 'plan' | 'finding' | 'answer' | 'step-group' | 'output' | 'ask'

/** 数字出处。type：query 查询、q 样本题、lesson 课、stu 学员 */
export interface CanvasRef {
  type: 'query' | 'q' | 'lesson' | 'stu'
  id: string
  /** 卡片上显示的短标签，如「#4」 */
  label: string
  /** query 类的一句话摘要（「数字从哪来」里显示），如「按新老生分组计算推荐分」 */
  summary?: string
}

export interface CanvasNode {
  id: string
  /** 父节点 id；根节点为 null。找不到父节点的节点按根处理 */
  parentId: string | null
  kind: CanvasNodeKind
  title: string
  /** 一两句话的短文本（画布上最多显示 3 行） */
  body?: string
  /** 只有进行中的节点才需要；running 会有轻微动效 */
  status?: 'running' | 'done' | 'error'
  refs?: CanvasRef[]
  /** 迷你柱状图；highlightIndex 那根用强调色 */
  mini?: { kind: 'bar'; values: number[]; highlightIndex?: number }
  /** 所属分支；主线用 'main'（或和根节点相同的 id） */
  branchId: string
  /** 毫秒时间戳；同一父节点下的兄弟按它排序 */
  createdAt: number
}

export type CanvasAction = 'add-to-report' | 'add-to-board' | 'make-list' | 'copy'

export interface CanvasProps {
  nodes: CanvasNode[]
  /** 选中的节点；null / undefined = 没有选中（追问框默认追问最后一个回答） */
  selectedId?: string | null
  /** 点击节点选中；Esc 取消选中时传 null */
  onSelect: (id: string | null) => void
  /** 在 id 对应的节点上追问（text 已去掉首尾空白，非空） */
  onFollowUp: (id: string, text: string) => void
  onAction: (id: string, action: CanvasAction) => void
  /** 是否显示底部浮动追问框，默认 true */
  showAskBar?: boolean
  /** 追问框占位提示 */
  placeholder?: string
  /** 每变一次（递增数字），追问框就获得焦点；右侧面板「从这里追问」用它 */
  focusSignal?: number
  className?: string
}

export const KIND_LABEL: Record<CanvasNodeKind, string> = {
  question: '问题', followup: '追问', plan: '计划', finding: '发现', answer: '回答', 'step-group': '查询与统计', output: '产出', ask: '待确认'
}
