import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { UsageNote } from '../design'
import { useSubject } from '../subject/SubjectContext'

/** 「导入到：数学」：导入前让人一眼看到卷子会进哪个学科（切换学科在侧栏顶部） */
export function ImportTarget({ className, testId = 'import-target' }: { className?: string; testId?: string }) {
  const { def } = useSubject()
  return (
    <span className={`ewb-lib-target${className ? ` ${className}` : ''}`} data-testid={testId} data-subject={def.id}>
      导入到：<b>{def.name}</b>
    </span>
  )
}

/**
 * 有没有配置能看图的模型：填了视觉模型、有可用的密钥，且读图策略不是「从不读图」。
 * 配置还没读到（或读不到）时返回 null，调用方先不提示。
 */
export function useVisionConfigured(): boolean | null {
  const { data: ai } = useQuery({ queryKey: ['aiConfig'], queryFn: () => window.api.ai.getConfig(), staleTime: 10_000 })
  if (!ai) return null
  return !!ai.vision_model?.trim() && (ai.hasVisionKey || ai.hasKey) && ai.vision_policy !== 'never'
}

/** 数学卷子没配看图模型时的提示：分数、竖式、图形光靠文字识别认不准 */
export function MathVisionHint() {
  const { subject } = useSubject()
  const nav = useNavigate()
  const ok = useVisionConfigured()
  if (subject !== 'math' || ok !== false) return null
  return (
    <UsageNote kind="caution" data-testid="math-vision-hint"
      actions={<a data-testid="math-vision-link" role="link" tabIndex={0} onClick={() => nav('/settings?tab=ai&admin=1')} onKeyDown={e => { if (e.key === 'Enter') nav('/settings?tab=ai&admin=1') }}>去 AI 设置</a>}>
      数学卷里的分数、竖式、图形要配能看图的模型才认得准。还没配置看图模型。
    </UsageNote>
  )
}
