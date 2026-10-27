/**
 * 范围条 <ScopeBar>：用书眉式的范围句代替一排默认下拉框。
 * 左边是当前范围（四年级 · 2025–2026 学年 · 期末），点它（「修改范围」）在下方展开筛选面板；
 * 右边是本页第一个和最后一个词条（书眉），最右是页面的主操作（词典蓝实心按钮）。
 * 筛选面板里放什么由调用方决定（children），第二阶段把 StatsFilter 的 Select 和开关放进来即可。
 */
import React, { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from './icons'

export interface ScopeBarProps {
  /** 范围句，如「四年级 · 2024–2026 学年 · 期末」 */
  scope: string
  /** 本页第一个 / 最后一个词条名（书眉） */
  first?: string
  last?: string
  /** 右上角的操作区（通常一个主按钮「导入试卷」） */
  actions?: React.ReactNode
  /** 展开的筛选面板内容 */
  children?: React.ReactNode
  defaultOpen?: boolean
  /** 受控：由调用方保存展开状态（切页后记住） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** 面板里的一个带标签的筛选项 */
export function ScopeField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="ewb-scope__field"><span>{label}</span>{children}</label>
}

export default function ScopeBar({ scope, first, last, actions, children, defaultOpen = false, open: openProp, onOpenChange }: ScopeBarProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const setOpen = (v: boolean) => { setOpenState(v); onOpenChange?.(v) }
  const id = useId()
  return (
    <div className="ewb-scope" data-testid="scope-bar">
      <div className="ewb-scope__bar">
        <button type="button" className="ewb-scope__trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <span className="ewb-scope__range">{scope}</span>
          <span className="ewb-scope__change">{open ? '收起' : '修改范围'}<Icon as={ChevronDown} size={14} /></span>
        </button>
        {(first || last) && (
          <span className="ewb-scope__guide" aria-label="本页词条">
            <b>{first}</b>{first && last && <span aria-hidden>—</span>}<b>{last}</b>
          </span>
        )}
        {actions && <div className="ewb-scope__actions">{actions}</div>}
      </div>
      {children && (
        <div id={id} className="ewb-scope__panel" data-open={open}>
          <div><div className="ewb-scope__fields">{children}</div></div>
        </div>
      )}
    </div>
  )
}
