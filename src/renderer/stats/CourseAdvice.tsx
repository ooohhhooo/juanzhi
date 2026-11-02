import React, { useState } from 'react'
import { App, Checkbox, Collapse, Modal, Popconfirm } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cancelAnalysis, dismissAnalysis, startAnalysis, useAnalysisEntry } from './analysisStore'
import { AiDraftBadge } from '../components/Plain'
import { clean } from '../components/CourseMatch'
import { useElapsedSeconds } from '../hooks/useElapsed'
import { Btn, ThinkingBar, UsageNote } from '../design'
import '../design/page-course.css'

const MARK_RE = /〔(?:未核实|与题目解释矛盾，请核对)〕/g

/**
 * 看板「课程对照」块 4：家长沟通建议（AI 草稿）。沿用同比 / 单考点分析的状态机：未生成 → 生成中（流式，可取消）→ 完成 → 失败（保留未完成草稿）。
 * 复制门槛：必须先点“我已核对”（未核实的句子要逐句确认，矛盾的要重新生成）才能复制；数据或课程变了只标“已过期”，不自动重新生成。
 */
export default function CourseAdvice({ scope }: { scope: CourseAdviceScope }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const key = ['stats', 'analysis', 'course', scope.filter, [...scope.outlineIds].sort()]
  const { data: st } = useQuery({ queryKey: key, queryFn: () => window.api.course.adviceState({ filter: scope.filter, outlineIds: scope.outlineIds }), staleTime: 5_000, enabled: scope.outlineIds.length > 0 })
  const entry = useAnalysisEntry(scope)
  const elapsed = useElapsedSeconds(entry?.startedAt, entry?.status === 'running')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [ack, setAck] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const plainScope = { filter: scope.filter, outlineIds: scope.outlineIds }
  if (!st) return <div className="ewb-ana-muted">加载中…</div>

  const gen = (label: string, ask = false) => st.blocked ? null : (
    <Popconfirm title="重新生成会再调用一次模型（产生 token 费用），生成后需要重新核对。确定吗？" okText="重新生成" cancelText="取消" disabled={!ask} onConfirm={() => startAnalysis(scope)}>
      <Btn size="small" tone={ask ? 'secondary' : 'primary'} data-testid="advice-run" onClick={ask ? undefined : () => startAnalysis(scope)}>{label}</Btn>
    </Popconfirm>
  )
  const confirm = async () => {
    setBusy(true)
    try {
      const r = await window.api.course.adviceConfirm(plainScope, ack)
      if (!r.ok) { message.error(r.message ?? '核对没有通过'); return }
      message.success('已核对，可以复制了')
      setConfirmOpen(false)
      qc.invalidateQueries({ queryKey: ['stats', 'analysis'] })
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }
  const copy = async () => {
    try { const r = await window.api.course.adviceCopy(plainScope); message.success(`已复制（${r.chars} 字），可以粘贴到微信`) } catch (e) { message.error(clean(e)) }
  }
  const conflicts = st.unverified.filter(u => u.kind === 'conflict')
  const text = (s: string) => s.replace(MARK_RE, m => (m.includes('矛盾') ? ' ⚠矛盾 ' : ' ⚠未核实 '))

  return (
    <div className="ewb-crs-advice" data-testid="advice-panel" data-status={entry?.status ?? st.status}>
      {entry?.status === 'running' ? (
        <>
          <div className="ewb-ana-ai__actions">
            <span style={{ flex: 1, minWidth: 260 }} data-testid="advice-running"><ThinkingBar elapsedSeconds={elapsed} label={entry.text ? 'AI 正在写' : entry.thinking ? 'AI 正在思考' : 'AI 正在准备'} /></span>
            <Btn size="small" tone="secondary" data-testid="advice-cancel" onClick={() => cancelAnalysis(scope)}>取消生成</Btn>
          </div>
          <div className="ewb-crs-advice__text" data-testid="advice-text">{entry.text.replace(/\[课#(\d+)\]/g, '「课」') || 'AI 在认真写，请稍等，不需要操作。'}</div>
        </>
      ) : entry?.status === 'error' ? (
        <>
          <UsageNote kind="mistake" title={entry.message} data-testid="advice-error">
            {entry.detail && <Collapse ghost size="small" items={[{ key: 'd', label: <span className="ewb-ana-meta">查看详情（给管理员看）</span>, children: <div className="ewb-ana-meta" style={{ wordBreak: 'break-all' }}>{entry.detail}</div> }]} />}
          </UsageNote>
          {entry.text && <div className="ewb-crs-advice__text" data-testid="advice-partial">{entry.text}</div>}
          <div className="ewb-ana-ai__actions">{gen('重试', st.status !== 'none')}<Btn size="small" tone="secondary" onClick={() => dismissAnalysis(scope)}>关闭提示</Btn></div>
        </>
      ) : entry?.status === 'cancelled' ? (
        <>
          <UsageNote kind="caution" data-testid="advice-cancelled">已取消生成，没有保存结果</UsageNote>
          <div className="ewb-ana-ai__actions">{gen('重新生成', st.status !== 'none')}<Btn size="small" tone="secondary" onClick={() => dismissAnalysis(scope)}>关闭提示</Btn></div>
        </>
      ) : st.status === 'none' ? (
        <div className="ewb-ana-stack">
          {st.blocked
            ? <UsageNote kind="tip" data-testid="advice-blocked">{st.blocked}</UsageNote>
            : <span className="ewb-ana-ai__hint">根据上面“容易出错、又有对应课”的几个考点，AI 写一段 150–200 字、可以发给家长的话。不夸大、不提价格，只说“这类试卷里常见的易错点”和可以复习哪几课。写好后需要老师核对。</span>}
          {!st.blocked && <div>{gen('生成家长沟通建议')}</div>}
        </div>
      ) : (
        <>
          <div className="ewb-ana-ai__actions">
            <AiDraftBadge confirmedAt={st.confirmedAt} />
            <span className="ewb-ana-pill ewb-ana-pill--quiet">{st.createdAt} · {st.model ?? ''}</span>
            {st.blocked && st.status === 'fresh' ? null : st.blocked ? <span className="ewb-ana-ai__hint">{st.aiReady ? st.blocked : '未配置 AI，无法重新生成'}</span> : gen('重新生成', true)}
          </div>
          {st.status === 'stale' && <UsageNote kind="caution" data-testid="advice-stale"><b>已过期，可重新生成</b>（{st.staleReasons.map(r => r === 'data' ? '统计数据或课程对应有变化' : r === 'prompt' ? 'AI 的写作要求有更新' : '换了 AI 模型').join('；')}）。过期的建议不能复制。</UsageNote>}
          {st.warnings.map((w, i) => <UsageNote key={i} kind="caution">{w}</UsageNote>)}
          {st.unverified.length > 0 && !st.confirmedAt && <UsageNote kind="caution" data-testid="advice-unverified">{`有 ${st.unverified.length} 句讲英语规则的话没能对上老师审核过的题目解释（正文里已标“未核实”）：核对时请逐句确认${conflicts.length ? '；其中有与题目解释矛盾的句子，需要重新生成' : ''}。`}</UsageNote>}
          <div className="ewb-crs-advice__text" data-testid="advice-text">{text(st.markdown)}</div>
          <div className="ewb-ana-ai__actions" style={{ marginTop: 8 }}>
            {!st.confirmedAt
              ? <Btn size="small" tone="primary" disabled={st.status !== 'fresh' || conflicts.length > 0} data-testid="advice-confirm" onClick={() => { setAck([]); setConfirmOpen(true) }}>我已核对</Btn>
              : null}
            <Btn size="small" tone="secondary" disabled={!st.confirmedAt || st.status !== 'fresh'} data-testid="advice-copy" onClick={copy}>复制给家长</Btn>
            {!st.confirmedAt && <span className="ewb-ana-ai__hint" data-testid="advice-copy-hint">先读一遍，没问题再点“我已核对”，之后才能复制。</span>}
          </div>
        </>
      )}
      {!entry && st.draft && st.status === 'none' && (
        <Collapse ghost size="small" style={{ marginTop: 8 }} items={[{ key: 'd', label: <span className="ewb-ana-meta">上次没写完，留下了一份未完成草稿（{st.draft.createdAt}）：它不算有效结果。</span>, children: <div><div className="ewb-ana-draftmsg">{st.draft.message}</div><div className="ewb-crs-advice__text">{st.draft.markdown}</div></div> }]} />
      )}
      <Modal open={confirmOpen} onCancel={() => setConfirmOpen(false)} title="核对这段话" destroyOnHidden okText="我已核对" cancelText="再看看" confirmLoading={busy}
        okButtonProps={{ 'data-testid': 'advice-confirm-ok', disabled: st.unverified.some(u => !ack.includes(u.sentence)) } as never} onOk={confirm}>
        <div data-testid="advice-confirm-modal">
        <p>请确认：这段话里没有价格或夸大的承诺，讲英语规则的地方都是对的，提到的课确实有这些内容。</p>
        {st.unverified.length > 0 && (
          <>
            <p className="ewb-rep-note">下面这些句子没能对上题目解释，需要你逐句确认“无误”；不确定的就取消，重新生成。</p>
            {st.unverified.map(u => (
              <div key={u.sentence} style={{ marginBottom: 6 }}>
                <Checkbox checked={ack.includes(u.sentence)} onChange={e => setAck(a => (e.target.checked ? [...a, u.sentence] : a.filter(x => x !== u.sentence)))} data-testid="advice-ack">
                  {u.sentence.replace(MARK_RE, '')}
                </Checkbox>
              </div>
            ))}
          </>
        )}
        </div>
      </Modal>
    </div>
  )
}
