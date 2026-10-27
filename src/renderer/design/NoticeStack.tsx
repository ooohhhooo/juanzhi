/**
 * 注意事项合并 <NoticeStack>：同一页上叠着好几条「注意」时，合成一个「注意事项（N）」，可以收起。
 * 只有一条时原样显示。里面放普通的 <UsageNote>（保留各自的 data-testid）；重复的句子不要重复放（调用方负责去重）。
 * 数一数里面实际渲染出几个用法框（有的子组件可能渲染成 null），所以不依赖 children 的个数。
 */
import React, { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from './icons'

export default function NoticeStack({ children, defaultOpen = true, 'data-testid': testId }: { children: React.ReactNode; defaultOpen?: boolean; 'data-testid'?: string }) {
  const body = useRef<HTMLDivElement>(null)
  const [n, setN] = useState(0)
  const [open, setOpen] = useState(defaultOpen)
  useLayoutEffect(() => {
    const c = body.current ? body.current.querySelectorAll('.ewb-note').length : 0
    if (c !== n) setN(c)
  })
  const stacked = n >= 2
  return (
    <section className={`ewb-notestack${stacked ? ' ewb-notestack--on' : ''}`} data-testid={testId}>
      {stacked && (
        <button type="button" className="ewb-notestack__head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>注意事项（{n}）</span>
          <span className="ewb-notestack__toggle">{open ? '收起' : '展开'}<Icon as={ChevronDown} size={14} /></span>
        </button>
      )}
      <div ref={body} className="ewb-notestack__body" hidden={stacked && !open}>{children}</div>
    </section>
  )
}
