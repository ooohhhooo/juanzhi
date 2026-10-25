import React, { useState } from 'react'
import { Alert, Descriptions, Drawer, Empty, Segmented, Spin, Tag } from 'antd'
import { useQuery } from '@tanstack/react-query'
import AnalysisPanel from '../../stats/AnalysisPanel'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { pct } from '../../stats/format'

const KIND_LABEL = { added: '新增', removed: '消失', up: '上升', down: '下降' } as const
const KIND_COLOR = { added: 'green', removed: 'default', up: 'volcano', down: 'blue' } as const

/** 知识点抽屉：数据对比 + P2 AI 分析 + 题目卡片（含原卷截图） */
export default function KpDrawer({ item, scope, cmp, onClose }: { item: CompareItem | null; scope: CompareScope; cmp: CompareResult; onClose: () => void }) {
  const [side, setSide] = useState<'target' | 'base' | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const eff = side ?? (item?.kind === 'removed' ? 'base' : 'target')
  const qSide: QuestionSide = eff === 'target' ? { kind: 'year', year: scope.target } : { kind: 'base', target: scope.target, base: scope.base, align: scope.align !== false }
  const { data: qs, isLoading } = useQuery({
    queryKey: ['stats', 'kpQuestions', scope.filter, qSide, item?.code], enabled: !!item,
    queryFn: () => window.api.stats.questions(scope.filter, qSide, item!.code, 30)
  })
  return (
    <>
      <Drawer open={!!item} onClose={() => { setSide(null); onClose() }} width="min(760px, 94vw)" destroyOnHidden data-testid="kp-drawer"
        title={item ? <span>{item.name} <Tag color={KIND_COLOR[item.kind]}>{KIND_LABEL[item.kind]}</Tag><span style={{ fontSize: 12, color: '#999' }}>{item.code}</span></span> : ''}>
        {item && (
          <>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>{item.path}</div>
            {cmp.limited.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="样本有限，结论仅供参考" />}
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }} data-testid="drawer-stats">
              <Descriptions.Item label={`目标 ${cmp.target.label}`}>{item.aT}/{item.nT} 份 · {pct(item.rateT)}</Descriptions.Item>
              <Descriptions.Item label={`基线 ${cmp.base.label}`}>{item.aB}/{item.nB} 份 · {pct(item.rateB)}</Descriptions.Item>
              <Descriptions.Item label="出现率变化">{item.deltaPP > 0 ? '+' : ''}{item.deltaPP.toFixed(1)} 个百分点</Descriptions.Item>
              <Descriptions.Item label="目标侧题数 / 分值占比">{item.questionsT} 题 · {pct(item.scoreShareT)}</Descriptions.Item>
            </Descriptions>

            <h4 style={{ margin: '0 0 8px' }}>AI 分析</h4>
            <div style={{ marginBottom: 20 }}><AnalysisPanel scope={scope} focusCode={item.code} onView={setView} /></div>

            <h4 style={{ margin: '0 0 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>题目与原卷截图</span>
              <Segmented size="small" data-testid="drawer-side" value={eff} onChange={v => setSide(v as any)} options={[{ label: `目标（${cmp.target.label}）`, value: 'target' }, { label: '基线', value: 'base' }]} />
            </h4>
            {isLoading ? <Spin /> : !qs?.length ? <Empty description="这一侧没有该知识点的题目" /> : (
              <div data-testid="drawer-questions">{qs.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}</div>
            )}
          </>
        )}
      </Drawer>
      <PageViewer target={view} onClose={() => setView(null)} />
    </>
  )
}
