import React, { useMemo, useState } from 'react'
import { ChevronRight, Copy, CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react'
import { buildTurnLogs, formatRaw } from '../../main/agent/action-log'
import type { LogItem, LogStep, TurnLog } from '../../main/agent/action-log'
import '../design/page-assistant-log.css'

/** 把当前能看到的全部步骤整理成「每条回答 → 这一轮的行动记录」；只在步骤变化时算一次 */
export function useTurnLogs(steps: LogStep[], labelOf: (name: string) => string): Map<number, TurnLog> {
  return useMemo(() => buildTurnLogs(steps, labelOf), [steps, labelOf])
}

function copy(text: string) { try { void navigator.clipboard.writeText(text) } catch { /* 没有剪贴板权限就算了 */ } }

function Raw({ item }: { item: LogItem }) {
  const raw = item.raw!
  const input = useMemo(() => formatRaw(raw.args), [raw])
  const output = useMemo(() => formatRaw(raw.output), [raw])
  const [copied, setCopied] = useState(false)
  const doCopy = () => {
    copy(`【${item.label}】\n输入：\n${formatRaw(raw.args, Infinity).text}\n\n输出：\n${formatRaw(raw.output, Infinity).text}`)
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="ewb-as-log__raw" data-testid="assistant-actionlog-raw">
      <div><div className="ewb-as-log__rawk">输入</div><pre className="ewb-as-pre" data-testid="assistant-actionlog-raw-in">{input.text}</pre></div>
      <div><div className="ewb-as-log__rawk">输出{raw.truncated && <small>（原文太长，软件只保留了前面一部分）</small>}</div><pre className="ewb-as-pre" data-testid="assistant-actionlog-raw-out">{output.text || '（没有内容）'}</pre></div>
      <div className="ewb-as-log__rawfoot">
        {raw.name && raw.name !== item.label ? <span>内部名称 <code className="ewb-as-code">{raw.name}</code></span> : <span />}
        <button type="button" className="ewb-as-chiplink" data-testid="assistant-actionlog-copy" onClick={doCopy}><Copy size={12} strokeWidth={1.9} aria-hidden /> {copied ? '已复制' : '复制这一步的原文'}</button>
      </div>
    </div>
  )
}

/** 回答下面的「它是怎么得出这个结论的」：折叠时一句话，展开是白话时间线，点某一步看原始输入输出 */
export function ActionLog({ log }: { log: TurnLog }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)
  return (
    <details className="ewb-as-log" data-testid="assistant-actionlog" onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary data-testid="assistant-actionlog-summary" title="点开看它是怎么得出这个结论的"><ChevronRight size={14} strokeWidth={2} className="ewb-as-log__chev" aria-hidden /><span>{log.summary}</span></summary>
      {open && (
        <ol className="ewb-as-log__list" data-testid="assistant-actionlog-list">
          {log.items.length === 0 && <li className="ewb-as-muted" style={{ padding: '6px 6px 6px 34px' }}>这次没有查任何数据，是直接回答的。</li>}
          {log.items.map(it => (
            <li key={it.seq} className="ewb-as-log__item" data-testid="assistant-actionlog-item" data-kind={it.kind} data-ok={String(it.ok)} data-approval={it.approval ?? ''}>
              <button type="button" className="ewb-as-log__row" disabled={!it.raw} aria-expanded={it.raw ? picked === it.seq : undefined} title={it.raw ? '点开看原始输入和输出' : undefined} onClick={() => setPicked(picked === it.seq ? null : it.seq)}>
                <span className="ewb-as-log__ic">{it.ok ? <CircleCheck size={15} strokeWidth={1.9} aria-label="完成" /> : <CircleAlert size={15} strokeWidth={1.9} aria-label="没成功" />}</span>
                <span className="ewb-as-log__label">{it.label}</span>
                {it.argText && <span className="ewb-as-log__arg">{it.argText}</span>}
                <span className="ewb-as-log__res">{it.resultText}</span>
                {it.ms >= 1000 && <span className="ewb-as-log__ms">{(it.ms / 1000).toFixed(1)} 秒</span>}
                {it.raw && <ChevronRight size={14} strokeWidth={1.9} className="ewb-as-log__more" aria-hidden />}
              </button>
              {it.approvalText && <div className="ewb-as-log__appr" data-testid="assistant-actionlog-approval"><ShieldCheck size={13} strokeWidth={1.9} aria-hidden /> {it.approvalText}</div>}
              {picked === it.seq && it.raw && <Raw item={it} />}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
