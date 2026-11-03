/** 演示路由 /analysis-demo：只在开发与 e2e（VITE_EWB_DESIGN=1 构建）里存在，用虚构规格展示全部块类型。正式侧栏不放入口。 */
import React, { useMemo, useState } from 'react'
import { demoSpec } from '../../main/analysis/report/demo-spec'
import { useTheme } from '../design'
import { AnalysisBoard } from './AnalysisBoard'

export default function AnalysisDemo(): React.ReactElement {
  const spec = useMemo(() => demoSpec(), [])
  const { mode, setPref } = useTheme()
  const [msg, setMsg] = useState('')
  const [src, setSrc] = useState('')
  const doExport = async (format: 'xlsx' | 'html' | 'docx'): Promise<void> => {
    try {
      const r = await window.api.analysisReport.export(spec, format)
      setMsg(r.saved ? `已导出：${r.path}` : '已取消')
    } catch (e) { setMsg(`导出失败：${(e as Error).message}`) }
  }
  return (
    <div style={{ background: 'var(--ewb-paper)', minHeight: '100vh', padding: 16 }}>
      <div style={{ maxWidth: 1040, margin: '0 auto 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', color: 'var(--ewb-ink-2)', fontSize: 13 }}>
        <span>分析看板演示（虚构数据）</span>
        <button type="button" className="rb-btn" data-testid="demo-theme" onClick={() => setPref(mode === 'dark' ? 'light' : 'dark')}>切换为{mode === 'dark' ? '浅色' : '深色'}</button>
        <span data-testid="demo-msg">{msg}</span>
        <span data-testid="demo-source">{src}</span>
      </div>
      <AnalysisBoard spec={spec} onExport={doExport} onSource={q => setSrc(`出处：${q}`)} />
    </div>
  )
}
