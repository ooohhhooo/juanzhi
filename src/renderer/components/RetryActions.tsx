import React from 'react'
import { App, Button, Dropdown, Space } from 'antd'
import { DownOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useDiscardGuard } from '../hooks/useDiscardGuard'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * 失败的试卷怎么重试——试卷库和处理队列共用这一个组件，入口、文案、确认都一致（M2 复审 N10：以前试卷库里只有一个「重新提取」，
 * 队列页才有完整的重试入口）：
 *  · AI 解析失败：「重试 AI 解析」（沿用已提取的文字）+ 下拉里的「重新 AI 解析 / 仅重新定位 / 从头重试」；
 *  · 提取失败：「重试（重新提取）」。
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
      <Space.Compact size="small">
        <Button size="small" icon={<ReloadOutlined />} data-testid="retry-parse" onClick={() => start('ai', '已加入解析队列')}>重试 AI 解析</Button>
        <Dropdown trigger={['click']} menu={{
          items: [
            { key: 'ai', label: '重新 AI 解析（沿用已提取的文字）' },
            { key: 'locate', label: '仅重新定位（沿用上次 AI 结果，不再调用模型）' },
            { key: 'extract', label: '从头重试（重新提取文字再解析）' }
          ],
          onClick: ({ key }) => restart(key as 'extract' | 'ai' | 'locate')
        }}><Button size="small" data-testid="retry-menu" icon={<DownOutlined />} /></Dropdown>
      </Space.Compact>
    )
  }
  return <Button size="small" icon={<ReloadOutlined />} data-testid="retry-extract" onClick={() => start('extract', '已重新加入队列')}>重试（重新提取）</Button>
}
