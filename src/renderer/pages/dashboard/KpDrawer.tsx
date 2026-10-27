import React, { useState } from 'react'
import { Drawer, Segmented } from 'antd'
import { useQuery } from '@tanstack/react-query'
import AnalysisPanel from '../../stats/AnalysisPanel'
import QuestionCardView from '../../stats/QuestionCardView'
import PageViewer from '../../stats/PageViewer'
import type { ViewTarget } from '../../stats/PageViewer'
import { pct } from '../../stats/format'
import { compareText } from '../../../shared/plain-text'
import { useShowCodes } from '../../hooks/useUiPrefs'
import { Term } from '../../components/Plain'
import { categoryOfCode, EmptyState, Entry, EntrySkeleton, UsageNote } from '../../design'
import type { EntryTagSpec } from '../../design'
import '../../design/page-analysis.css'

const KIND_TAG: Record<CompareItem['kind'], EntryTagSpec> = {
  added: { label: '今年新考', kind: 'new', hint: '去年及以前的卷子里没出现过，今年第一次考。' },
  removed: { label: '今年没考', hint: '去年及以前的卷子里考过，今年没有考。注意：没出现不等于以后不考，卷子少时尤其如此。' },
  up: { label: '考得更多', hint: '两边都考了，但“考了几份卷子”的比例明显变高（差 20 个百分点以上）。' },
  down: { label: '考得更少', hint: '两边都考了，但“考了几份卷子”的比例明显变低（差 20 个百分点以上）。' }
}

/** 知识点抽屉：词条（完整尺寸）+ 数据对比 + P2 AI 分析 + 题目卡片（含原卷截图） */
export default function KpDrawer({ item, scope, cmp, onClose }: { item: CompareItem | null; scope: CompareScope; cmp: CompareResult; onClose: () => void }) {
  const [side, setSide] = useState<'target' | 'base' | null>(null)
  const [view, setView] = useState<ViewTarget | null>(null)
  const [showCodes] = useShowCodes()
  const { data: tax } = useQuery({ queryKey: ['taxonomy'], queryFn: () => window.api.taxonomy.tree(), staleTime: 60_000 })
  const node = tax?.kps.find(k => k.code === item?.code)
  const eff = side ?? (item?.kind === 'removed' ? 'base' : 'target')
  const qSide: QuestionSide = eff === 'target' ? { kind: 'year', year: scope.target } : { kind: 'base', target: scope.target, base: scope.base, align: scope.align !== false }
  const { data: qs, isLoading } = useQuery({
    queryKey: ['stats', 'kpQuestions', scope.filter, qSide, item?.code], enabled: !!item,
    queryFn: () => window.api.stats.questions(scope.filter, qSide, item!.code, 30)
  })
  const words = (node?.hint_words ?? '').split('/').map(x => x.trim()).filter(Boolean).slice(0, 4)
  return (
    <>
      <Drawer open={!!item} onClose={() => { setSide(null); onClose() }} width="min(760px, 94vw)" destroyOnHidden data-testid="kp-drawer" title="词条详情">
        {item && (
          <>
            <Entry size="full" headingLevel={3} term={item.name} examples={words.length ? words : undefined} category={categoryOfCode(item.code) ?? undefined}
              data-testid={node?.plain ? 'drawer-plain' : undefined}
              aside={showCodes ? <span className="ewb-num">{item.code}</span> : undefined}
              tags={[KIND_TAG[item.kind]]}
              plain={node?.plain || item.path}
              examplesSentences={node?.example_en ? [{ en: node.example_en, zh: node.example_zh ?? undefined }] : undefined} />
            <div className="ewb-ana-drawer-path">{item.path}</div>
            {cmp.limited.length > 0 && <UsageNote kind="caution">{cmp.insufficient.length > 0 ? '样本不足，暂不比较：卷子太少，结论只能说“这几份卷子里是这样”' : '样本有限，结论仅供参考'}</UsageNote>}
            <p data-testid="drawer-plain-compare" style={{ margin: '16px 0 0', fontSize: 'var(--ewb-fs-lg)' }}><b>{compareText(item.aB, item.nB, item.aT, item.nT)}</b></p>
            <dl className="ewb-ana-drawer-stats" data-testid="drawer-stats">
              <div><dt>{`今年（${cmp.target.label}）`}</dt>{' '}<dd>{item.aT}/{item.nT} 份卷子有 · {pct(item.rateT)}</dd></div>
              <div><dt>{`去年及以前（${cmp.base.label}）`}</dt>{' '}<dd>{item.aB}/{item.nB} 份卷子有 · {pct(item.rateB)}</dd></div>
              <div><dt>比例变化</dt>{' '}<dd>{item.deltaPP > 0 ? '+' : ''}{item.deltaPP.toFixed(1)} 个百分点</dd></div>
              <div><dt><Term term="占总分多少">今年的题数 / 占总分多少</Term></dt>{' '}<dd>{item.questionsT} 题 · {pct(item.scoreShareT)}</dd></div>
            </dl>

            <h4 className="ewb-ana-drawer-h">AI 分析</h4>
            <div><AnalysisPanel scope={scope} focusCode={item.code} onView={setView} /></div>

            <h4 className="ewb-ana-drawer-h">
              <span>题目与原卷截图</span>
              <Segmented size="small" data-testid="drawer-side" value={eff} onChange={v => setSide(v as 'target' | 'base')} options={[{ label: `今年（${cmp.target.label}）`, value: 'target' }, { label: '去年及以前', value: 'base' }]} />
            </h4>
            {isLoading ? <EntrySkeleton count={2} /> : !qs?.length ? <EmptyState inline title="这一侧没有该知识点的题目" /> : (
              <div data-testid="drawer-questions">{qs.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}</div>
            )}
          </>
        )}
      </Drawer>
      <PageViewer target={view} onClose={() => setView(null)} />
    </>
  )
}
