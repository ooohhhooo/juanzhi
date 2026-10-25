import React from 'react'
import { App } from 'antd'

/**
 * 会清掉/覆盖已有题目的操作（重新提取、从头重试、重新解析）之前的二次确认。
 * 只要这份试卷现在有题目就要问——包括「AI 解析失败但保留着旧题（含已审核的）」的试卷，
 * 不能只看状态是不是 reviewing/done。没有题目时直接放行。
 */
export function useDiscardGuard() {
  const { modal } = App.useApp()
  return async (paper: Paper, kind: 'extract' | 'reparse'): Promise<boolean> => {
    const sums = await window.api.questions.summary()
    const s = sums.find(x => x.paper_id === paper.id)
    if (!s || s.total === 0) return true
    const reviewed = s.reviewed ?? 0
    return new Promise<boolean>(resolve => {
      modal.confirm({
        title: kind === 'extract' ? '重新提取会清掉已解析的题目' : '重新解析会覆盖现有题目',
        content: (
          <div data-testid="discard-confirm">
            这份试卷现在有 <b>{s.total}</b> 道题，其中 <b>{reviewed}</b> 道已审核确认。
            {kind === 'extract'
              ? '页面会重新生成，基于旧页面的题目和你在审核页做的修改（题干、知识点、框的位置、确认状态）都会被清掉。'
              : '你在审核页做的修改（题干、知识点、框的位置、确认状态）都会被新的解析结果替换。'}
            {paper.status === 'failed' && <div style={{ marginTop: 6, color: '#cf1322' }}>这份试卷上次 AI 解析失败，但旧题目还保留着；继续就会丢掉它们。</div>}
          </div>
        ),
        okText: kind === 'extract' ? '清掉并重新提取' : '仍然重新解析',
        okButtonProps: { danger: true, 'data-testid': 'discard-ok' } as any,
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
  }
}
