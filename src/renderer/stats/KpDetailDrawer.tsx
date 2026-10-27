import React, { useState } from 'react'
import { Drawer } from 'antd'
import { useQuery } from '@tanstack/react-query'
import QuestionCardView from './QuestionCardView'
import PageViewer from './PageViewer'
import AnalysisPanel from './AnalysisPanel'
import type { ViewTarget } from './PageViewer'
import { pct } from './format'
import { appearText } from '../../shared/plain-text'
import { useShowCodes } from '../hooks/useUiPrefs'
import { categoryOfCode, EmptyState, Entry, EntrySkeleton, UsageNote } from '../design'
import type { EntryTagSpec } from '../design'
import '../design/page-analysis.css'

/**
 * 词条详情抽屉（总览、重难点、分布里点考点名打开）：词条（完整尺寸）+ 在当前范围里的数据 + 题目与原卷截图 + AI 分析入口。
 * 和同比页里的 KpDrawer 不同：这里没有「今年 / 去年及以前」的对比，只看当前筛选范围。
 * AI 分析：「单个知识点」模式——只讲这一个考点（ai.kpAnalysis 读状态、ai.analyzeKp 生成），和同比页共用 AnalysisPanel / analysisStore。
 */
export default function KpDetailDrawer({ code, filter, onClose }: { code: string | null; filter: StatsFilter; onClose: () => void }) {
  const [view, setView] = useState<ViewTarget | null>(null)
  const [showCodes] = useShowCodes()
  const level = code ? code.split('.').length : 2
  const { data: tax } = useQuery({ queryKey: ['taxonomy'], queryFn: () => window.api.taxonomy.tree(), staleTime: 60_000, enabled: !!code })
  const { data: dist } = useQuery({ queryKey: ['stats', 'distribution', filter], queryFn: () => window.api.stats.distribution(filter), staleTime: 30_000, enabled: !!code })
  const { data: hot } = useQuery({ queryKey: ['stats', 'hot', filter, Math.min(3, Math.max(2, level))], queryFn: () => window.api.stats.hot(filter, Math.min(3, Math.max(2, level))), staleTime: 30_000, enabled: !!code && level >= 2 })
  const { data: qs, isLoading } = useQuery({ queryKey: ['stats', 'kpQuestions', filter, { kind: 'filter' }, code, 30], queryFn: () => window.api.stats.questions(filter, { kind: 'filter' }, code!, 30), enabled: !!code })
  const node = tax?.kps.find(k => k.code === code)
  const stat = dist?.nodes.find(n => n.code === code)
  const row = hot?.rows.find(r => r.code === code)
  // 路径：从一级到本级的中文名（不显示内部代码）
  const kpPath = (() => { const out: string[] = []; let c = node; const byCode = new Map((tax?.kps ?? []).map(k => [k.code, k])); while (c) { out.unshift(c.name); c = c.parent_code ? byCode.get(c.parent_code) : undefined } return out.join(' / ') })()
  const words = (node?.hint_words ?? '').split('/').map(x => x.trim()).filter(Boolean).slice(0, 4)
  const tags: EntryTagSpec[] = []
  if (stat && dist) tags.push({ label: appearText(stat.papers, dist.papers), hint: `${stat.papers}/${dist.papers} 份卷子里出现过，占 ${pct(stat.rate)}` })
  if (row && row.errorCount > 0) tags.push({ label: '易错', kind: 'mistake', hint: `AI 估计其中 ${row.errorCount} 道题学生容易做错（估计，不是学生成绩）` })
  const name = node?.name ?? stat?.name ?? code ?? ''
  return (
    <>
      <Drawer open={!!code} onClose={onClose} width="min(760px, 94vw)" destroyOnHidden data-testid="kp-detail-drawer" title="词条详情">
        {code && (
          <>
            <Entry size="full" headingLevel={3} term={name} examples={words.length ? words : undefined} category={categoryOfCode(code) ?? undefined}
              aside={showCodes ? <span className="ewb-num">{code}</span> : undefined}
              tags={tags} plain={node?.plain || kpPath}
              examplesSentences={node?.example_en ? [{ en: node.example_en, zh: node.example_zh ?? undefined }] : undefined} />
            {kpPath && <div className="ewb-ana-drawer-path">{kpPath}</div>}
            {stat && dist && (
              <dl className="ewb-ana-drawer-stats" data-testid="kp-detail-stats">
                <div><dt>考了几份卷子</dt>{' '}<dd>{stat.papers}/{dist.papers} 份 · {pct(stat.rate)}</dd></div>
                <div><dt>题数</dt>{' '}<dd>{stat.questions} 道</dd></div>
                {row && <div><dt>估计容易错</dt>{' '}<dd>{row.questions} 道里约 {row.errorCount} 道（AI 估计）</dd></div>}
              </dl>
            )}
            {row && row.reasons.length > 0 && <UsageNote kind="mistake" title="为什么容易错（AI 估计）">{row.reasons.map(r => `${r.reason}（${r.count} 次）`).join('；')}</UsageNote>}

            <h4 className="ewb-ana-drawer-h">AI 分析</h4>
            <div data-testid="kp-detail-ai">
              <AnalysisPanel scope={{ filter, code }} onView={setView} />
            </div>

            <h4 className="ewb-ana-drawer-h"><span>题目与原卷截图</span></h4>
            {isLoading ? <EntrySkeleton count={2} /> : !qs?.length ? <EmptyState inline title="当前范围里没有这个考点的题目" /> : (
              <div data-testid="kp-detail-questions">{qs.map(q => <QuestionCardView key={q.id} q={q} onView={setView} />)}</div>
            )}
          </>
        )}
      </Drawer>
      <PageViewer target={view} onClose={() => setView(null)} />
    </>
  )
}
