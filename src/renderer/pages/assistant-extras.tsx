import React, { useEffect, useState } from 'react'
import { Modal } from 'antd'
import { ShieldAlert } from 'lucide-react'
import { Btn } from '../design'
import { AnalysisBoard } from '../analysis/AnalysisBoard'

/** 同意弹窗要显示的内容：发到哪里 + 完整内容；含个人信息时 privacyWarning 非空，要醒目 */
export interface ApprovalInfo { id: string; name: string; summary: string; preview?: { target: string; content: string; privacyWarning?: string } }

export function ApprovalBox({ approval, onDecide }: { approval: ApprovalInfo; onDecide: (ok: boolean) => void }) {
  const pv = approval.preview
  const external = !!pv && approval.name !== 'text_classify' && (pv.target.includes('企业微信') || pv.target.includes('MCP') || !!pv.privacyWarning)
  return (
    <div className="ewb-as-ask" data-testid="assistant-approval" data-name={approval.name}>
      <p className="ewb-as-ask__h">需要你同意</p>
      <p className="ewb-as-ask__q">助手想做这件事：{approval.summary}</p>
      {pv && (
        <div className="ewb-as-preview" data-testid="assistant-approval-preview">
          <div className="ewb-as-preview__to" data-testid="assistant-approval-target"><b>{external ? '发到：' : '内容：'}</b>{pv.target}</div>
          {pv.privacyWarning && (
            <div className="ewb-as-preview__warn" role="alert" data-testid="assistant-approval-privacy"><ShieldAlert size={15} strokeWidth={2} aria-hidden /> <span>{pv.privacyWarning}</span></div>
          )}
          <pre className="ewb-as-pre ewb-as-preview__body" data-testid="assistant-approval-content">{pv.content}</pre>
        </div>
      )}
      <div className="ewb-as-ask__opts">
        <Btn tone="primary" data-testid="assistant-approve" onClick={() => onDecide(true)}>{external ? '发送' : '同意'}</Btn>
        <Btn tone="secondary" data-testid="assistant-reject" onClick={() => onDecide(false)}>{external ? '取消，不发送' : '不同意'}</Btn>
      </div>
    </div>
  )
}

const TABLE_MAX = 50

/** 把查询结果文本（JSON）解析成表格；解析不了返回 null */
export function parseResultTable(text: string): { columns: string[]; rows: unknown[][] } | null {
  try {
    const o = JSON.parse(text)
    if (o && Array.isArray(o.columns) && Array.isArray(o.rows)) {
      const cols = (o.columns as unknown[]).map(String)
      return { columns: cols, rows: o.rows.map((r: unknown) => (Array.isArray(r) ? r : cols.map((c: string) => (r as any)?.[c]))) }
    }
  } catch { /* 不是 JSON（被截断等） */ }
  return null
}

/** 点 [[query:N]] 打开：这次查询的 SQL 摘要和结果表 */
export function QueryRecordModal({ sessionId, n, onClose }: { sessionId: string | null; n: number | null; onClose: () => void }) {
  const [rec, setRec] = useState<AgentQueryRecord | null | undefined>(undefined)
  useEffect(() => {
    setRec(undefined)
    if (!sessionId || n == null) return
    void window.api.agent.queryRecord(sessionId, n).then(setRec, () => setRec(null))
  }, [sessionId, n])
  const table = rec ? parseResultTable(rec.text) : null
  return (
    <Modal open={n != null} title={`查询 #${n ?? ''}`} footer={null} onCancel={onClose} width={720} destroyOnClose>
      {rec === undefined ? <p>加载中……</p> : rec === null ? <p data-testid="query-missing">找不到这条查询记录。</p> : (
        <div data-testid="query-record">
          <p className="ewb-lib-sub" data-testid="query-summary">{rec.name} · {rec.ok ? rec.summary : `没成功：${rec.summary}`}</p>
          {rec.sql && <div><b>SQL</b><pre className="ewb-as-pre" data-testid="query-sql">{rec.sql.length > 600 ? rec.sql.slice(0, 600) + '…' : rec.sql}</pre></div>}
          {!rec.sql && <div><b>查询条件</b><pre className="ewb-as-pre">{JSON.stringify(rec.args, null, 2).slice(0, 800)}</pre></div>}
          <b>结果</b>
          {table ? (
            <div className="ewb-md__tablewrap">
              <table className="ewb-md__table" data-testid="query-table">
                <thead><tr>{table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{table.rows.slice(0, TABLE_MAX).map((r, i) => <tr key={i}>{table.columns.map((_, k) => <td key={k}>{String(r[k] ?? '')}</td>)}</tr>)}</tbody>
              </table>
              <div className="ewb-lib-sub">共 {table.rows.length} 行{table.rows.length > TABLE_MAX ? `，只显示前 ${TABLE_MAX} 行` : ''}{rec.truncated ? '（记录里的结果已截断）' : ''}</div>
            </div>
          ) : <pre className="ewb-as-pre" data-testid="query-text">{rec.text}</pre>}
        </div>
      )}
    </Modal>
  )
}

/** 右侧面板里的看板：渲染本会话的看板（已还原真名），随产出变化刷新 */
export function BoardPane({ sessionId, onSource }: { sessionId: string | null; onSource: (queryId: string) => void }) {
  const [spec, setSpec] = useState<any | null>(null)
  useEffect(() => {
    if (!sessionId) { setSpec(null); return }
    const load = () => { void window.api.agentOutputs.board(sessionId).then(setSpec, () => setSpec(null)) }
    load()
    return window.api.on('agent-outputs:changed', (sid: string) => { if (sid === sessionId) load() })
  }, [sessionId])
  if (!spec) return <div className="ewb-side__empty" data-testid="board-empty">看板还没有内容。</div>
  return (
    <div data-testid="assistant-boardpane">
      <AnalysisBoard spec={spec} onSource={onSource} onExport={f => { void window.api.analysisReport.export(spec, f) }} />
    </div>
  )
}
