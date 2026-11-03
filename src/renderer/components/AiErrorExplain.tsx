import React from 'react'
import { App } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { Btn } from '../design'

/**
 * AI 出错时的原因说明：首行主因，下面列出可能的原因和怎么办，最后可展开服务商原话、复制错误信息（不含密钥）。
 * 原因由主进程根据最近一次失败的调用诊断（含自动查余额）；诊断不可用时只显示传入的 message。
 * nonce 变化时重新诊断（同一个组件多次失败）。
 */
export default function AiErrorExplain({ message, task, nonce }: { message?: string; task?: string; nonce?: string | number }) {
  const { message: toast } = App.useApp()
  const { data: g } = useQuery({ queryKey: ['aiDiagnose', message ?? '', task ?? '', nonce ?? ''], queryFn: () => window.api.ai.diagnose({ message: message ?? '', task }), staleTime: Infinity, retry: false })
  if (!g) return null
  const copy = () => {
    const text = [g.cause, ...g.reasons.map((r, i) => `${i + 1}. ${r.text} → ${r.fix}`), g.raw].join('\n')
    navigator.clipboard?.writeText(text).then(() => toast.success('已复制错误信息'), () => toast.error('复制失败'))
  }
  return (
    <div data-testid="ai-error-explain" style={{ marginTop: 4 }}>
      <div><b data-testid="ai-error-cause">{g.cause}</b></div>
      {g.reasons.length > 0 && (
        <>
          <div className="ewb-rep-note" style={{ marginTop: 4 }}>可能的原因：</div>
          <ol className="ewb-set-steps" data-testid="ai-error-reasons" style={{ margin: '2px 0 4px' }}>
            {g.reasons.map((r, i) => <li key={i}>{r.text}。<span className="ewb-rep-note">怎么办：{r.fix}</span></li>)}
          </ol>
        </>
      )}
      <details><summary style={{ cursor: 'pointer' }}>查看服务商原话</summary><div className="ewb-set-mono" style={{ wordBreak: 'break-all' }} data-testid="ai-error-raw">{g.raw}</div></details>
      <Btn tone="quiet" size="small" data-testid="ai-error-copy" onClick={copy}>复制错误信息</Btn>
    </div>
  )
}
