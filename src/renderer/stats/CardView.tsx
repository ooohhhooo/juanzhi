import React from 'react'
import { parseInline, splitLatin, trickFields } from '../../shared/markdown'
import type { Block, Inline } from '../../shared/markdown'

type CardBlock = Extract<Block, { type: 'card' }>

const LETTERS = 'ABCDEFGH'

/** 例句：英文斜体，中文正体 */
const eg = (items: Inline[], inl: (items: Inline[]) => React.ReactNode[]): React.ReactNode[] =>
  items.flatMap((it, i) => (it.type === 'text' ? splitLatin(it.text).map((s, k) => (s.latin ? <i key={`${i}-${k}`}>{s.text}</i> : <React.Fragment key={`${i}-${k}`}>{s.text}</React.Fragment>)) : inl([it])))

/**
 * 报告里的卡片（口诀大招 / 答题卡）。样式来自 shared/card-style.ts 的 cardCss（和导出的 PDF、图片、Word 同一套颜色和尺寸），
 * 卡片永远是白纸（和原卷一样，深色模式里也不变）；卡片下面的说明和按钮放在 actions 里，随主题变。
 * 英文单词和例句用斜体（口诀卡的「例」整行是斜体）。
 */
export default function CardView({ block, inl, actions }: { block: CardBlock; inl: (items: Inline[]) => React.ReactNode[]; actions?: React.ReactNode }) {
  if (block.kind === 'trick') {
    const f = trickFields(block.raw)
    return (
      <div className="ewb-cardview" data-testid="card-trick">
        <div className="ewb-card ewb-card--trick">
          <div className="ewb-card__band">{block.title || '口诀大招'}</div>
          <div className="ewb-card__body">
            <p className="ewb-trick__main">{inl(parseInline(f.main))}</p>
            {f.example && <p className="ewb-trick__eg">{eg(parseInline(f.example), inl)}</p>}
            {f.rest.map((l, i) => <p key={i} className="ewb-trick__eg">{eg(parseInline(l), inl)}</p>)}
            {f.from && <p className="ewb-trick__from">出自考点：{inl(parseInline(f.from))}</p>}
          </div>
        </div>
        {actions}
      </div>
    )
  }
  return (
    <div className="ewb-cardview" data-testid="card-answer">
      <div className="ewb-card ewb-card--answer">
        <div className="ewb-card__band"><span>{block.title || '答题卡'}{block.extra ? ` · ${block.extra}` : ''}</span><span>AI 出题</span></div>
        <div className="ewb-ans__who"><span>姓名<i className="ewb-ans__line" /></span><span>日期<i className="ewb-ans__line" /></span></div>
        {block.items.map(it => (
          <div key={it.n} className="ewb-ans__item" data-testid="card-answer-item">
            <div className="ewb-ans__no">{it.n}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="ewb-ans__stem">{inl(it.stem)}</p>
              {it.answer?.type === 'choice' && <p className="ewb-ans__opts">{it.answer.options.map((x, i) => <span key={i}>○ {LETTERS[i] ?? i + 1}. {x}</span>)}</p>}
              {(it.answer?.type === 'blank' || it.answer?.type === 'lines') && Array.from({ length: it.answer.count }, (_, i) => <div key={i} className="ewb-ans__box" />)}
            </div>
          </div>
        ))}
        <div className="ewb-card__foot">本题由 AI 根据原卷考点改编，已由程序和第二次 AI 解答核对；使用前请老师先做一遍</div>
      </div>
      {actions}
    </div>
  )
}
