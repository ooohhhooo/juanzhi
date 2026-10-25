import React from 'react'
import { Alert, Tag, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useStatsFilter } from './StatsFilter'

/** 「估计」标记：难度、易错都是 AI/老师估计，没有学生成绩支撑 */
export const Est = ({ text = '估计' }: { text?: string }) => (
  <Tooltip title="由 AI 或老师估计，不是学生成绩统计出来的，仅供参考。"><Tag data-testid="est-tag" color="gold" style={{ marginInlineEnd: 4, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>{text}</Tag></Tooltip>
)

/** 分值覆盖：有分值的题 / 全部题。不足时用醒目的颜色，让人知道分值占比是只算了有分值的那部分 */
export function CoverageNote({ c }: { c: Coverage }) {
  const full = c.scored >= c.questions
  return (
    <Tooltip title="分值为空的题不进分值统计（出现率、题数不受影响）。把缺的分值补上，分值占比才完整。">
      <Tag data-testid="coverage" color={full ? 'default' : 'orange'} style={{ marginInlineEnd: 0 }}>分值覆盖 {c.scored}/{c.questions} 题</Tag>
    </Tooltip>
  )
}
type Coverage = { scored: number; questions: number; tagged: number }

/** 范围说明：待审核没计入几份、重复导入怎么处理的、没填学年几份。总览、分布、同比、重难点四个页面都放，数字取自轻量的 stats.notes */
export function NotCounted({ filter: override, hint }: { filter?: StatsFilter; hint?: string } = {}) {
  const { filter: global } = useStatsFilter()
  const filter = override ?? global
  const { data: n } = useQuery({ queryKey: ['stats', 'notes', filter], queryFn: () => window.api.stats.notes(filter) })
  if (!n) return null
  const bits: string[] = []
  if (n.pendingReviewing > 0) bits.push(`${n.pendingReviewing} 份待审核的试卷没有计入（确认后才会计入，或打开上方「含待审核」开关预览）`)
  if (n.duplicates > 0) bits.push(n.includeDuplicates
    ? `已包含重复导入：有 ${n.duplicates} 份是同一文件的重复副本，会被重复计数（关掉「包含重复导入」则同一文件只算一份）`
    : `有 ${n.duplicates} 份内容重复的试卷（同一文件导入了多份）已合并：同一文件只算一份，没有重复计数（要重复计数请打开「包含重复导入」）`)
  if (n.noYear > 0) bits.push(`${n.noYear} 份没有填写学年（不参与同比）`)
  if (!bits.length) return null
  return <Alert data-testid="not-counted" type="info" showIcon icon={<InfoCircleOutlined />} style={{ marginBottom: 12 }} message={bits.join('；') + (hint ? `。${hint}` : '')} />
}

export const EmptyStats = ({ pending, children }: { pending?: number; children?: React.ReactNode }) => (
  <div data-testid="empty-stats" style={{ padding: '48px 24px', textAlign: 'center', color: '#888' }}>
    <div style={{ fontSize: 16, color: '#555', marginBottom: 8 }}>当前筛选下没有已确认的试卷</div>
    <div>统计只计入「审核完并点了确认整份试卷」的试卷。{pending ? `有 ${pending} 份待审核的试卷，确认后就会出现在这里；也可以打开上方「含待审核」先预览。` : '请先导入试卷并完成审核，或放宽上面的筛选条件。'}</div>
    {children}
  </div>
)
