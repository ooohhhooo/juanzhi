import React from 'react'
import { App, Dropdown } from 'antd'
import { ChevronDown, RotateCw } from 'lucide-react'
import { Btn } from '../design'
import { useQueryClient } from '@tanstack/react-query'
import { useDiscardGuard } from '../hooks/useDiscardGuard'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * 失败的试卷怎么重试——试卷库和处理队列共用这一个组件，入口、文案、确认都一致：
 *  · AI 解析失败：一个主按钮「重试」（沿用已提取的文字，自动处理长度问题）；其它选项收进「更多」里，运营不用分辨它们的区别；
 *  · 提取失败：「重试」（重新提取）。
 * 会覆盖已有题目的选项先弹二次确认（useDiscardGuard）。
 */
export default function RetryActions({ paper }: { paper: Paper }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const guard = useDiscardGuard()
  const start = async (stage: 'extract' | 'ai' | 'locate', ok: string) => {
    try { await window.api.parse.start(paper.id, stage); message.success(ok) } catch (e) { message.error(clean(e)) }
    qc.invalidateQueries({ queryKey: ['queue'] })
    qc.invalidateQueries({ queryKey: ['papers'] })
  }
  const restart = async (stage: 'extract' | 'ai' | 'locate') => {
    // 只要现在有题目（包括解析失败但保留着旧题的）就先确认
    if (await guard(paper, stage === 'extract' ? 'extract' : 'reparse')) await start(stage, '已加入解析队列')
  }
  if (paper.status !== 'failed') return null
  if (paper.error_stage === 'parse') {
    return (
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn tone="secondary" size="small" icon={RotateCw} data-testid="retry-parse" onClick={() => start('ai', '已加入解析队列')}>重试</Btn>
        <Dropdown trigger={['click']} menu={{
          items: [
            { key: 'ai', label: '重新让 AI 读一遍（沿用已读出的文字）' },
            { key: 'locate', label: '只重新找题目位置（不再调用 AI）' },
            { key: 'extract', label: '从头来（重新读取文件，再让 AI 整理）' }
          ],
          onClick: ({ key }) => restart(key as 'extract' | 'ai' | 'locate')
        }}><Btn tone="quiet" size="small" data-testid="retry-menu" icon={ChevronDown}>更多</Btn></Dropdown>
      </span>
    )
  }
  return <Btn tone="secondary" size="small" icon={RotateCw} data-testid="retry-extract" onClick={() => start('extract', '已重新加入队列')}>重试</Btn>
}
