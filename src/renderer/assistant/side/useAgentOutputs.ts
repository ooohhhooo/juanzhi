import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputContent, OutputEntry } from '../../../shared/agent-outputs'

/**
 * 集成用的小钩子：取会话产出列表和当前选中产出的内容，并随主进程的 agent-outputs:changed 事件实时刷新。
 * 返回值直接对应 AssistantSidePanel 的 outputs / activeOutputId / onActiveOutputChange / content。
 */
export function useAgentOutputs(sessionId: string | null) {
  const [outputs, setOutputs] = useState<OutputEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [content, setContent] = useState<OutputContent | null>(null)
  const activeRef = useRef<string | null>(null); activeRef.current = activeId

  const refresh = useCallback(async () => {
    if (!sessionId) { setOutputs([]); setContent(null); return }
    const list = await window.api.agentOutputs.list(sessionId)
    setOutputs(list)
    const cur = activeRef.current && list.some(o => o.id === activeRef.current) ? activeRef.current : (list[list.length - 1]?.id ?? null)
    if (cur !== activeRef.current) setActiveId(cur)
    setContent(cur ? await window.api.agentOutputs.read(sessionId, cur).catch(() => null) : null)
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh, activeId])
  useEffect(() => window.api.on('agent-outputs:changed', (sid: string) => { if (sid === sessionId) void refresh() }), [sessionId, refresh])

  return {
    outputs, activeId, content,
    setActiveId: (id: string) => { setActiveId(id); setContent(null) },
    exportOutput: (id: string, format: 'docx' | 'pdf' | 'xlsx' | 'csv' | 'md') => (sessionId ? window.api.agentOutputs.export(sessionId, id, format) : Promise.resolve({ saved: false })),
    reveal: (id: string) => (sessionId ? window.api.agentOutputs.reveal(sessionId, id) : Promise.resolve(false))
  }
}
