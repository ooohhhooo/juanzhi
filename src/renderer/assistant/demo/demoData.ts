import type { CanvasNode } from '../types'
import type { OutputContent, OutputEntry } from '../../../shared/agent-outputs'

/** 演示用的虚构会话树：30 个节点，主线 + 3 条追问分支。数据全部虚构。 */
const T0 = 1_700_000_000_000
let seq = 0
const n = (id: string, parentId: string | null, kind: CanvasNode['kind'], title: string, branchId: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, parentId, kind, title, branchId, createdAt: T0 + (seq++) * 1000, status: 'done', ...extra })

export function demoNodes(): CanvasNode[] {
  seq = 0
  return [
    n('q', null, 'question', '秋季推荐分为什么下降？', 'main', { body: '帮我分析原因，出汇报和看板' }),
    n('plan', 'q', 'plan', '计划 · 5 步', 'main', { body: '看懂数据、逐层拆开、关联原因、写汇报、出看板' }),
    n('sg0', 'plan', 'step-group', '3 个查询、1 次统计', 'main'),
    n('f1', 'plan', 'finding', '各级别普遍下降', 'main', { body: '一级 −18 到四级 −33', refs: [{ type: 'query', id: '3', label: '#3', summary: '按级别分组计算春季与秋季的推荐分' }], mini: { kind: 'bar', values: [18, 28, 26, 33], highlightIndex: 3 } }),
    n('f2', 'plan', 'finding', '新生比老生低 15 分', 'main', { body: '新生 9，老生 24', refs: [{ type: 'query', id: '4', label: '#4', summary: '按「新老生」分组计算推荐分' }] }),
    n('f3', 'plan', 'finding', '3 个班明显偏低', 'main', { body: '到课率都低于 70%', refs: [{ type: 'query', id: '7', label: '#7', summary: '按班级计算推荐分并关联到课率' }, { type: 'lesson', id: 'C12', label: 'C12' }] }),
    n('a0', 'plan', 'answer', '原因：新生占比上升，叠加部分班到课率偏低', 'main', { refs: [{ type: 'query', id: '4', label: '#4', summary: '按「新老生」分组计算推荐分' }] }),
    n('o1', 'a0', 'output', '汇报.md', 'main', { body: '写到第 3 节' }),
    n('o2', 'a0', 'output', '看板', 'main', { body: '4 个章节' }),
    n('o3', 'a0', 'output', '偏低班级名单', 'main'),
    // 分支一：从 f2 追问渠道
    n('b1q', 'f2', 'followup', '哪个渠道的新生最低？', 'b1'),
    n('b1s', 'b1q', 'step-group', '2 个查询', 'b1'),
    n('b1a', 'b1q', 'answer', '渠道 A 最低：推荐分 2', 'b1', { body: '样本 412，明显低于其他渠道（p<0.01）', refs: [{ type: 'query', id: '9', label: '#9', summary: '按渠道拆开新生的推荐分并做显著性检验' }], mini: { kind: 'bar', values: [2, 11, 14, 9], highlightIndex: 0 } }),
    n('b1q2', 'b1a', 'followup', '渠道 A 的新生里哪个级别最低？', 'b1'),
    n('b1a2', 'b1q2', 'answer', '二级最低，推荐分 −6', 'b1', { refs: [{ type: 'query', id: '11', label: '#11', summary: '渠道 A 新生按级别拆开' }] }),
    n('b1f', 'b1a2', 'finding', '二级新生集中在两个班', 'b1', { body: 'C12、C27 占 70%', refs: [{ type: 'query', id: '12', label: '#12' }] }),
    // 分支二：从 f3 追问老师（进行中）
    n('b2q', 'f3', 'followup', '这 3 个班是同一个老师吗？', 'b2'),
    n('b2p', 'b2q', 'plan', '计划 · 2 步', 'b2', { status: 'running' }),
    n('b2s', 'b2p', 'step-group', '1 个查询', 'b2', { status: 'running' }),
    n('b2ask', 'b2p', 'ask', '名单里要放老师姓名吗？', 'b2', { body: '默认只放班级和到课率' }),
    n('b2f', 'b2p', 'finding', '正在核对任课老师', 'b2', { status: 'running', body: '已查到 2 个班' }),
    // 分支三：从 f1 追问二级
    n('b3q', 'f1', 'followup', '二级为什么降得最多？', 'b3'),
    n('b3s', 'b3q', 'step-group', '3 个查询、1 次统计', 'b3'),
    n('b3a', 'b3q', 'answer', '二级的选项题得分下降最多', 'b3', { refs: [{ type: 'query', id: '14', label: '#14', summary: '二级各选项题的平均分对比' }] }),
    n('b3q2', 'b3a', 'followup', '是题目顺序变了吗？', 'b3'),
    n('b3a2', 'b3q2', 'answer', '有影响，但说不清有多大', 'b3', { body: '秋季题目顺序有变化，这部分拆不开' }),
    n('b3f', 'b3a2', 'finding', '文字意见里提到「作业太多」', 'b3', { refs: [{ type: 'q', id: 'Q31', label: 'Q31' }] }),
    n('b3f2', 'b3a2', 'finding', '到课率与推荐分相关', 'b3', { body: '相关系数 0.52', refs: [{ type: 'query', id: '16', label: '#16' }] }),
    n('b3a3', 'b3q2', 'answer', '建议下期问卷固定题目顺序', 'b3'),
    n('b3o', 'b3a3', 'output', '口径说明', 'b3', { body: '已写完' })
  ]
}

/** 压力测试：生成大约 count 个节点的树（每个节点约 3 个孩子） */
export function stressNodes(count: number): CanvasNode[] {
  const out: CanvasNode[] = []
  const kinds: CanvasNode['kind'][] = ['plan', 'finding', 'answer', 'output', 'followup']
  for (let i = 0; i < count; i++) {
    out.push({ id: `s${i}`, parentId: i === 0 ? null : `s${Math.floor((i - 1) / 3)}`, kind: i === 0 ? 'question' : kinds[i % kinds.length], title: `节点 ${i}：一句话说明`, body: i % 2 ? '短文本说明' : undefined, branchId: 'main', createdAt: T0 + i * 1000, status: 'done' })
  }
  return out
}

export const DEMO_REPORT_SECTIONS = [
  '## 一、结论（三句话）\n\n1. 推荐分从 41 降到 18，**各级别普遍下降**，不是个别班的问题 [[query:3]]。\n2. **新生**比老生低 15 分，渠道 A 的新生最低 [[query:4]]。\n3. 有 3 个班明显偏低，共同点是**到课率低于 70%** [[query:7]]。',
  '## 二、各级别对比\n\n| 级别 | 春季 | 秋季 | 变化 |\n|---|---|---|---|\n| 一级 | 46 | 28 | −18 |\n| 二级 | 49 | 21 | −28 |\n| 三级 | 38 | 12 | −26 |\n| 四级 | 42 | 9 | −33 |\n\n数据来自 [[query:3]]。',
  '## 三、需要关注的班\n\nC12、C27、B05 的推荐分低于同级别 20 分以上 [[query:7]]。'
]

export function demoReportMarkdown(written: number): string {
  return ['# 秋季满意度汇报（虚构示例）', '数据：虚构问卷 8,214 份 · 每个数字可点开看出处', ...DEMO_REPORT_SECTIONS.slice(0, written)].join('\n\n')
}

export function demoOutputs(written: number, now = Date.now()): OutputEntry[] {
  return [
    { id: 'd1', type: 'md', name: '秋季满意度汇报.md', file: 'x.md', updatedAt: now, status: 'writing', total: 5, written },
    { id: 'b1', type: 'board', name: '秋季满意度看板', file: null, boardId: 'demo-board', updatedAt: now - 120_000, status: 'done' },
    { id: 't1', type: 'table', name: '偏低班级名单.xlsx', file: 'x.csv', updatedAt: now - 300_000, status: 'done' },
    { id: 'n1', type: 'note', name: '口径说明', file: 'n.md', updatedAt: now - 600_000, status: 'done' }
  ]
}

export function demoContent(id: string, written: number): OutputContent {
  if (id === 'd1') return { type: 'md', markdown: demoReportMarkdown(written), written, total: 5 }
  if (id === 'b1') return { type: 'board', boardId: 'demo-board' }
  if (id === 't1') return { type: 'table', columns: ['班级', '级别', '推荐分', '到课率'], rows: [['C12', '二级', '−6', '63%'], ['C27', '二级', '−2', '66%'], ['B05', '三级', '1', '68%']], totalRows: 3 }
  return { type: 'note', markdown: '# 口径说明\n\n- 推荐分 = 打 9–10 分的比例 − 打 0–6 分的比例（虚构口径）。\n- 秋季问卷题目顺序有变化，部分对比只能作参考。', written: 1 }
}
