import React, { useEffect, useMemo, useState } from 'react'
import AssistantCanvas from '../canvas/AssistantCanvas'
import AssistantSidePanel from '../side/AssistantSidePanel'
import type { SideMode } from '../side/AssistantSidePanel'
import type { CanvasAction, CanvasNode } from '../types'
import { demoContent, demoNodes, demoOutputs, stressNodes } from './demoData'

/**
 * 演示页（/assistant-canvas-demo）：虚构会话树 + 画布 + 右侧面板，仅开发与端到端测试使用，侧栏不放入口。
 * 所有数据都是虚构的。
 */
export default function AssistantCanvasDemo() {
  const [nodes, setNodes] = useState<CanvasNode[]>(demoNodes)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<SideMode>('outputs')
  const [activeOut, setActiveOut] = useState<string | null>('d1')
  const [written, setWritten] = useState(1)
  const [focusSignal, setFocusSignal] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const add = (s: string) => setLog(l => [...l.slice(-19), s])

  // 虚构汇报一节一节写出来，写到第 3 节停住（仍是「正在写」）
  useEffect(() => {
    if (written >= 3) return
    const t = setTimeout(() => setWritten(w => w + 1), 900)
    return () => clearTimeout(t)
  }, [written])

  const outputs = useMemo(() => demoOutputs(written), [written])
  const content = useMemo(() => (activeOut ? demoContent(activeOut, written) : null), [activeOut, written])
  const node = nodes.find(x => x.id === selectedId) ?? null

  const select = (id: string | null) => { setSelectedId(id); setMode(id ? 'card' : 'outputs') }
  const act = (id: string, a: CanvasAction) => add(`action ${id} ${a}`)

  return (
    <div className="ewb-cvdemo" data-testid="canvas-demo" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 90px)', minHeight: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderBottom: '1px solid var(--ewb-line)' }}>
        <b>秋季满意度为什么下降（虚构示例）</b>
        <span style={{ color: 'var(--ewb-ink-2)', fontSize: 12 }} data-testid="demo-count">{nodes.length} 个节点</span>
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="demo-stress" onClick={() => { setNodes(stressNodes(200)); setSelectedId(null) }} style={{ fontSize: 12 }}>200 节点压力测试</button>
        <button type="button" data-testid="demo-reset" onClick={() => { setNodes(demoNodes()); setSelectedId(null) }} style={{ fontSize: 12 }}>还原</button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', minWidth: 0, position: 'relative' }}>
          <AssistantCanvas nodes={nodes} selectedId={selectedId} onSelect={select} focusSignal={focusSignal}
            onFollowUp={(id, text) => { add(`followup ${id} ${text}`); setNodes(ns => [...ns, { id: `u${ns.length}`, parentId: id, kind: 'followup', title: text, branchId: 'b' + id, createdAt: Date.now(), status: 'running' }]) }}
            onAction={act} />
        </div>
        <AssistantSidePanel storageKey="ewb-demo-side" mode={mode} onModeChange={setMode}
          outputs={outputs} activeOutputId={activeOut} onActiveOutputChange={setActiveOut} content={content}
          renderBoard={id => <div className="ewb-side__empty" data-testid="demo-board">看板插槽：{id}</div>}
          onExport={(id, f) => add(`export ${id} ${f}`)} onReveal={id => add(`reveal ${id}`)} onOpenRef={r => add(`ref ${r.type}:${r.id}`)}
          node={node} nodes={nodes} onAskFrom={id => { add(`askfrom ${id}`); setFocusSignal(s => s + 1) }} onAction={act} />
      </div>
      <pre data-testid="demo-log" style={{ margin: 0, padding: '4px 16px', fontSize: 11, color: 'var(--ewb-ink-2)', maxHeight: 54, overflow: 'auto' }}>{log.join('\n')}</pre>
    </div>
  )
}
