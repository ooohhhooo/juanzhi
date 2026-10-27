/**
 * 状态标签 <StatusLabel> 与 AI 思考条 <ThinkingBar>，用于处理队列和试卷库。
 */
import React, { useEffect, useState } from 'react'
import { Btn } from './Basics'
import { X } from 'lucide-react'

export type StatusKind = 'working' | 'pending' | 'done' | 'failed' | 'queued'

/** 试卷状态（src/renderer/status.ts 里的 key）→ 样式。第二阶段铺页面时直接用 <StatusLabel status={paper.status}> */
export const STATUS_KIND: Record<string, StatusKind> = {
  imported: 'queued', extracting: 'working', extracted: 'queued', parsing: 'working', reviewing: 'pending', done: 'done', failed: 'failed'
}
export const STATUS_TEXT: Record<string, string> = {
  imported: '排队中', extracting: '提取中', extracted: '已提取', parsing: 'AI 解析中', reviewing: '待审核', done: '已完成', failed: '失败'
}

export interface StatusLabelProps {
  /** 直接指定样式：working 蓝 / pending 待处理 / done 完成 / queued 排队（虚线）/ failed 易错红 */
  kind?: StatusKind
  /** 或按试卷状态 key 自动取样式和文字（imported、parsing、reviewing、done、failed…） */
  status?: string
  /** 标签文字；不传则按 status 取。颜色之外一定要有字 */
  children?: React.ReactNode
  title?: string
}

/** 小号描边标签，模仿词典的词性标签 */
export function StatusLabel({ kind, status, children, title }: StatusLabelProps) {
  const k: StatusKind = kind ?? (status ? STATUS_KIND[status] ?? 'queued' : 'queued')
  const text = children ?? (status ? STATUS_TEXT[status] ?? status : '')
  return (
    <span className={`ewb-status ewb-status--${k}`} title={title}>
      {k === 'working' && <i className="ewb-status__dot" aria-hidden />}
      {text}
    </span>
  )
}

/** 用时一律写「N 秒」：和主进程、报告页的文案（waitingText：已用 N 秒）保持一致 */
const fmt = (sec: number): string => `${sec} 秒`

export interface ThinkingBarProps {
  /** 开始时间（毫秒时间戳）：传了就自己每秒计时 */
  startedAt?: number
  /** 或直接给已用秒数（受控，截图和测试用） */
  elapsedSeconds?: number
  /** 通常需要多久（秒），默认 [120, 180]，文案「通常 2–3 分钟」 */
  usual?: [number, number]
  /** 前缀文字，默认「AI 正在思考」 */
  label?: string
  /** 整句文案（传了就原样显示，不再拼「已用 N 秒」；报告页、队列页用 waitingText 的结果） */
  text?: string
  /** 传了就显示「取消」按钮 */
  onCancel?: () => void
}

/** 「AI 正在思考 · 已用 48 秒（通常 2–3 分钟）」状态条。进度条按「已用 / 通常上限」走，最多到 95%，从不假装完成 */
export function ThinkingBar({ startedAt, elapsedSeconds, usual = [120, 180], label = 'AI 正在思考', text, onCancel }: ThinkingBarProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [startedAt])
  const sec = elapsedSeconds ?? (startedAt != null ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0)
  const usualText = `${Math.round(usual[0] / 60)}–${Math.round(usual[1] / 60)} 分钟`
  const slow = sec > usual[1]
  const pct = Math.min(95, (sec / usual[1]) * 100)
  return (
    <div className="ewb-thinking" role="status" aria-live="off" data-testid="thinking-bar">
      <div className="ewb-thinking__row">
        <StatusLabel kind="working">处理中</StatusLabel>
        <span className="ewb-thinking__text">
          {text ?? <>{label} · 已用 {fmt(sec)}<span className="ewb-thinking__hint">{slow ? '（比平时久一些，仍在等待，请不要关闭窗口）' : `（通常 ${usualText}）`}</span></>}
        </span>
        {onCancel && <span className="ewb-thinking__actions"><Btn tone="secondary" icon={X} size="small" onClick={onCancel}>取消</Btn></span>}
      </div>
      <div className="ewb-thinking__rail" aria-hidden><div className="ewb-thinking__fill" style={{ transform: `scaleX(${pct / 100})` }} /></div>
    </div>
  )
}
