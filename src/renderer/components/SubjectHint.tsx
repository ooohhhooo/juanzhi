import React, { useState } from 'react'
import { App, Modal, Radio } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { SUBJECT_LIST, asSubject, subjectName, type SubjectId } from '../../shared/subject'
import { UsageNote, Btn } from '../design'
import { hintOf } from '../subject/autoRoute'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type P = Pick<Paper, 'id' | 'title' | 'file_name'> & { subject?: string }

/** 刷新和学科有关的缓存（主进程也会推 data:changed，这里保证按钮点完立刻变） */
function useRefreshPapers() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['papers'] })
    qc.invalidateQueries({ queryKey: ['queue'] })
  }
}

/**
 * 学科建议提醒条：导入时软件认为卷子不是当前学科的，先不解析，等用户选。
 * 每份一条（最多列 3 条，其余折成「还有 n 份」），有两份以上时给批量按钮。
 */
export function SubjectHintBar({ papers }: { papers: P[] }) {
  const { message } = App.useApp()
  const refresh = useRefreshPapers()
  const [busy, setBusy] = useState(false)
  const hinted = papers.filter(p => hintOf(p))
  if (hinted.length === 0) return null

  const resolve = async (list: P[], pick: (p: P) => SubjectId, ok: string) => {
    setBusy(true)
    let fail = 0
    for (const p of list) {
      try { await window.api.papers.resolveSubject(p.id, pick(p)) } catch (e) { fail++; message.error(`${p.title || p.file_name}：${clean(e)}`) }
    }
    setBusy(false)
    if (fail < list.length) message.success(ok)
    refresh()
  }
  const shown = hinted.slice(0, 3)

  return (
    <div data-testid="subject-hints" style={{ display: 'grid', gap: 8, margin: '0 0 16px' }}>
      {shown.map(p => {
        const to = hintOf(p)!, cur = asSubject(p.subject)
        return (
          <div key={p.id} data-testid="subject-hint" data-paper={p.id} data-hint={to}>
            <UsageNote kind="caution" title={`这份看起来是${subjectName(to)}卷`}
              actions={<>
                <Btn tone="primary" size="small" disabled={busy} data-testid="hint-accept" onClick={() => void resolve([p], () => to, `已放到${subjectName(to)}，开始解析`)}>放到{subjectName(to)}</Btn>
                <Btn tone="secondary" size="small" disabled={busy} data-testid="hint-keep" onClick={() => void resolve([p], () => cur, `保持${subjectName(cur)}，开始解析`)}>保持{subjectName(cur)}</Btn>
              </>}>
              「{p.title || p.file_name}」导入在{subjectName(cur)}里，但内容更像{subjectName(to)}。确认学科之后才会开始解析。
            </UsageNote>
          </div>
        )
      })}
      {hinted.length > shown.length && <p className="ewb-lib-sub" data-testid="subject-hint-more">还有 {hinted.length - shown.length} 份也在等你确认学科。</p>}
      {hinted.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="subject-hint-batch">
          <Btn tone="primary" size="small" disabled={busy} data-testid="hint-accept-all" onClick={() => void resolve(hinted, p => hintOf(p)!, `已按建议放好 ${hinted.length} 份，开始解析`)}>全部放到建议的学科（{hinted.length} 份）</Btn>
          <Btn tone="secondary" size="small" disabled={busy} data-testid="hint-keep-all" onClick={() => void resolve(hinted, p => asSubject(p.subject), `${hinted.length} 份都保持原学科，开始解析`)}>全部保持原学科</Btn>
        </div>
      )}
    </div>
  )
}

/**
 * 改学科：选学科 → 确认；已审核过的题会丢失，要二次确认。
 * 用法：const cs = useChangeSubject(); cs.open(paper); 页面里放 {cs.holder}
 */
export function useChangeSubject() {
  const { message, modal } = App.useApp()
  const refresh = useRefreshPapers()
  const [paper, setPaper] = useState<P | null>(null)
  const [target, setTarget] = useState<SubjectId>('english')
  const [busy, setBusy] = useState(false)

  const open = (p: P) => {
    const cur = asSubject(p.subject)
    setPaper(p)
    setTarget(SUBJECT_LIST.find(s => s.id !== cur)!.id)
  }
  const close = () => setPaper(null)

  const submit = async (confirmLoseReview?: boolean) => {
    if (!paper) return
    setBusy(true)
    try {
      const r = await window.api.papers.setSubject(paper.id, target, confirmLoseReview ? { confirmLoseReview: true } : undefined)
      if (r && (r as { needConfirm?: boolean }).needConfirm) {
        const n = (r as { reviewed: number }).reviewed
        const name = subjectName(target)
        const p = paper
        modal.confirm({
          title: '改学科会丢掉审核结果',
          content: <span data-testid="subject-lose-review">已审核的 {n} 道题会丢失，按{name}重新识别。</span>,
          okText: `丢掉并按${name}重新识别`, cancelText: '取消',
          okButtonProps: { danger: true, 'data-testid': 'subject-lose-ok' } as never,
          onOk: async () => {
            try {
              await window.api.papers.setSubject(p.id, target, { confirmLoseReview: true })
              message.success(`已改为${name}，正在重新识别`)
              close()
            } catch (e) { message.error(clean(e)) }
            refresh()
          }
        })
      } else {
        message.success(`已改为${subjectName(target)}，正在重新识别`)
        close()
      }
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
    refresh()
  }

  const cur = paper ? asSubject(paper.subject) : null
  const holder = (
    <Modal title="改学科" open={!!paper} onCancel={close} okText="改学科" cancelText="取消" confirmLoading={busy}
      okButtonProps={{ 'data-testid': 'subject-change-ok' } as never} onOk={() => void submit()} destroyOnHidden>
      <div data-testid="subject-change-modal">
        <p>「{paper?.title || paper?.file_name}」现在是{cur ? subjectName(cur) : ''}卷。改完会删掉现有的题目，按新学科重新识别。</p>
        <Radio.Group value={target} onChange={e => setTarget(e.target.value)}>
          {SUBJECT_LIST.map(s => <Radio key={s.id} value={s.id} disabled={s.id === cur} data-testid={`subject-change-${s.id}`}>{s.name}</Radio>)}
        </Radio.Group>
      </div>
    </Modal>
  )
  return { open, holder }
}
