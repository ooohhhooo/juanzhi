import React, { useEffect, useRef, useState } from 'react'
import { Input, Tooltip } from 'antd'
import { Check, ChevronRight, RotateCcw, Zap } from 'lucide-react'

export const EFFORT_NAME: Record<AgentEffort, string> = { auto: '自动', off: '关', low: '低', medium: '中', high: '高' }
const EFFORT_DESC: Record<AgentEffort, string> = {
  auto: '自动：由服务商决定',
  off: '关：不思考，最快、最省',
  low: '低：稍微想一下，偏快、偏省',
  medium: '中：想得适中，速度与质量平衡',
  high: '高：想得更久，更慢、用量更大'
}

/** 文字变化时旧文字淡出、新文字淡入（两层叠在同一格里，高度取较大者） */
function CrossFade({ text, testId }: { text: string; testId?: string }) {
  const [prev, setPrev] = useState<string | null>(null)
  const last = useRef(text)
  useEffect(() => {
    if (last.current === text) return
    setPrev(last.current); last.current = text
    const t = window.setTimeout(() => setPrev(null), 160)
    return () => window.clearTimeout(t)
  }, [text])
  return (
    <div className="ewb-as-fade" data-testid={testId}>
      {prev != null && <span className="ewb-as-fade__out" aria-hidden="true">{prev}</span>}
      <span key={text} className="ewb-as-fade__in">{text}</span>
    </div>
  )
}

/** 分档滑块：胶囊轨道 + 圆点 + 弹性滑块；拖动 / 点击吸附最近档位，左右键切换 */
function EffortSlider({ choices, value, onChange }: { choices: AgentEffort[]; value: AgentEffort; onChange: (e: AgentEffort) => void }) {
  const n = choices.length
  const idx = Math.max(0, choices.indexOf(value))
  const f = n > 1 ? idx / (n - 1) : 0
  const inner = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const pick = (clientX: number) => {
    const r = inner.current?.getBoundingClientRect()
    if (!r || n < 2) return
    const ratio = Math.min(1, Math.max(0, (clientX - r.left - 12) / (r.width - 24)))
    const next = choices[Math.round(ratio * (n - 1))]
    if (next && next !== value) onChange(next)
  }
  const step = (d: number) => { const next = choices[Math.min(n - 1, Math.max(0, idx + d))]; if (next && next !== value) onChange(next) }
  const bubble = drag || hover || focus
  return (
    <div
      className="ewb-as-eff" role="slider" tabIndex={0} data-testid="assistant-effort-slider" data-index={idx} data-dragging={drag || undefined}
      aria-label="思考强度" aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={idx} aria-valuetext={EFFORT_NAME[value]}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); pick(e.clientX) }}
      onPointerMove={e => { if (drag) pick(e.clientX) }}
      onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
      onFocus={e => setFocus(e.currentTarget.matches(':focus-visible'))} onBlur={() => setFocus(false)}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); step(-1) }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); step(1) }
        else if (e.key === 'Home') { e.preventDefault(); step(-n) }
        else if (e.key === 'End') { e.preventDefault(); step(n) }
      }}
    >
      <div className="ewb-as-eff__inner" ref={inner} style={{ '--f': f } as React.CSSProperties}>
        <div className="ewb-as-eff__clip"><div className="ewb-as-eff__fill" /></div>
        {choices.map((c, i) => <i key={c} className="ewb-as-eff__dot" data-passed={i <= idx || undefined} style={{ '--p': n > 1 ? i / (n - 1) : 0 } as React.CSSProperties} />)}
        <div className="ewb-as-eff__thumb">
          <span className="ewb-as-eff__tip" data-show={bubble || undefined} aria-hidden="true">{EFFORT_NAME[value]}</span>
          <span className="ewb-as-eff__knob" />
        </div>
      </div>
    </div>
  )
}

export interface EffortPopProps {
  models: AgentModelInfo[]; curModel: string; onModel: (m: string) => void
  effort: AgentEffort; onEffort: (e: AgentEffort) => void; effortChoices: AgentEffort[]; curInfo?: AgentModelInfo
  onResetModel: () => void
}

export default function EffortPop(p: EffortPopProps) {
  const [listOpen, setListOpen] = useState(false)
  const [otherModel, setOtherModel] = useState('')
  const hint = p.effort === 'off' && p.curInfo && !p.curInfo.canTurnOff ? '关：这个模型默认就会思考，无法真正关闭' : EFFORT_DESC[p.effort]
  return (
    <div className="ewb-as-pop" data-testid="assistant-modelpop">
      <div className="ewb-as-pop__head">
        <Zap size={18} strokeWidth={1.9} className="ewb-as-pop__zap" aria-hidden="true" />
        <div className="ewb-as-pop__title">
          <b key={p.effort} className="ewb-as-pop__name" data-testid="assistant-effort-name">{EFFORT_NAME[p.effort]}</b>
          <button type="button" className="ewb-as-pop__model" data-testid="assistant-model-name" title="点一下切换模型" aria-expanded={listOpen} onClick={() => setListOpen(o => !o)}>
            <span className="ewb-as-pop__modeltxt">{p.curModel}</span><ChevronRight size={12} strokeWidth={2} className="ewb-as-pop__chev" data-open={listOpen || undefined} />
          </button>
        </div>
        <Tooltip title="恢复默认" placement="top">
          <button type="button" className="ewb-as-pop__reset" aria-label="恢复默认" data-testid="assistant-model-reset" onClick={() => { p.onResetModel(); setListOpen(false) }}><RotateCcw size={15} strokeWidth={1.9} /></button>
        </Tooltip>
      </div>
      <div className="ewb-as-pop__collapse" data-open={listOpen || undefined}>
        <div className="ewb-as-pop__collapse-in">
          <div className="ewb-as-pop__list" data-testid="assistant-model-list">
            {p.models.map((m, i) => (
              <button key={m.model} type="button" className="ewb-as-pop__opt" data-testid={`assistant-model-opt-${i}`} disabled={m.toolSupport === 'no'} aria-pressed={m.model === p.curModel}
                onClick={() => { p.onModel(m.model); setListOpen(false) }}>
                <span className="ewb-as-pop__tick">{m.model === p.curModel && <Check size={14} strokeWidth={2.2} />}</span>
                <span>{m.model}{m.roles.length ? `（${m.roles.join('、')}）` : ''}{m.toolSupport === 'no' ? ' · 不支持助手' : ''}</span>
              </button>
            ))}
            <div className="ewb-as-ask__other">
              <Input size="small" placeholder="其他模型：填模型名，回车" value={otherModel} data-testid="assistant-model-other" onChange={e => setOtherModel(e.target.value)}
                onPressEnter={() => { const m = otherModel.trim(); if (m) { p.onModel(m); setOtherModel(''); setListOpen(false) } }} />
            </div>
          </div>
        </div>
      </div>
      <EffortSlider choices={p.effortChoices} value={p.effort} onChange={p.onEffort} />
      <CrossFade text={hint} testId="assistant-effort-hint" />
    </div>
  )
}
