import React from 'react'

type PillProps = { kind?: 'plain' | 'warn' | 'info' | 'done'; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement> & { 'data-testid'?: string }

/** 审核页用的胶囊标签：plain 普通 / warn 需要核对（易错红）/ info 估计（主色描边）/ done 已确认。可放进 Tooltip（转发 ref） */
export const Pill = React.forwardRef<HTMLSpanElement, PillProps>(function Pill({ kind = 'plain', children, ...rest }, ref) {
  return <span {...rest} ref={ref} className={`ewb-rev-pill${kind === 'plain' ? '' : ' ewb-rev-pill--' + kind}`}>{children}</span>
})
