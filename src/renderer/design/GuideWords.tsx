/**
 * 书眉 <GuideWords>：每个分析页顶部一行小字。
 * 左边是范围（四年级 · 2025–2026 学年），右边是本页第一个和最后一个词条名。
 */
import React from 'react'

export interface GuideWordsProps {
  /** 范围，如「四年级 · 2025–2026 学年」 */
  scope: string
  /** 本页第一个词条名 */
  first?: string
  /** 本页最后一个词条名 */
  last?: string
}

export default function GuideWords({ scope, first, last }: GuideWordsProps) {
  return (
    <div className="ewb-guide" role="note" aria-label="本页范围">
      <span className="ewb-guide__range">{scope}</span>
      {(first || last) && (
        <span className="ewb-guide__words" aria-label={`本页词条：${first ?? ''} 到 ${last ?? ''}`}>
          <span className="ewb-guide__first">{first}</span>
          {first && last && first !== last && <span className="ewb-guide__sep" aria-hidden>—</span>}
          {first !== last && <span className="ewb-guide__last">{last}</span>}
        </span>
      )}
    </div>
  )
}
