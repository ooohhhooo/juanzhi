/**
 * 侧栏 <Contents>（第二版）：窄图标栏，灰底，浮在白色画布旁边。
 * 顶部是产品徽章（卷知的应用图标）；每项是线性图标（主色）加下方两字小标签（总览 / 试卷 / 队列 / 审核 / 看板 / 报告）；
 * 当前项是白色圆角底加柔和阴影；待办数是图标右上角的小角标；设置和外观切换在底部。不需要收起。
 */
import React from 'react'
import { Tooltip } from 'antd'
import type { LucideIcon } from 'lucide-react'
import BrandMark from './Brand'
import { Icon } from './icons'
import { ThemeCycle } from './ThemeSwitch'

export interface ContentsItem {
  key: string
  /** 全名（读屏、悬停提示用），如「处理队列」 */
  label: string
  /** 图标下方的两字小标签，如「队列」 */
  tag: string
  icon: LucideIcon
  /** 待办数；0 / 不传不显示 */
  count?: number
  /** 待办数的测试钩子（data-testid），保持原有 E2E 钩子 */
  countTestId?: string
}

export interface ContentsProps {
  /** 主导航：总览、试卷、队列、审核、看板、报告 */
  items: ContentsItem[]
  /** 底部导航（设置） */
  footerItems?: ContentsItem[]
  /** 当前页的 key */
  activeKey: string
  onNavigate: (key: string) => void
  /** 在底部显示外观切换，默认 true */
  showThemeSwitch?: boolean
}

function Link({ item, active, onNavigate }: { item: ContentsItem; active: boolean; onNavigate: (k: string) => void }) {
  return (
    <li>
      <Tooltip title={item.label} placement="right" mouseEnterDelay={0.4}>
        <button type="button" className="ewb-contents__link" aria-current={active ? 'page' : undefined} aria-label={item.count ? `${item.label}，${item.count} 项待办` : item.label} onClick={() => onNavigate(item.key)}>
          <span className="ewb-contents__icon">
            <Icon as={item.icon} size={22} />
            {item.count ? <span className="ewb-contents__count" data-testid={item.countTestId}>{item.count}</span> : null}
          </span>
          <span className="ewb-contents__tag">{item.tag}</span>
        </button>
      </Tooltip>
    </li>
  )
}

export default function Contents({ items, footerItems, activeKey, onNavigate, showThemeSwitch = true }: ContentsProps) {
  return (
    <nav className="ewb-contents" aria-label="目录">
      <div className="ewb-contents__brand"><BrandMark size={52} /></div>
      <ul className="ewb-contents__list">
        {items.map(it => <Link key={it.key} item={it} active={it.key === activeKey} onNavigate={onNavigate} />)}
      </ul>
      <ul className="ewb-contents__list ewb-contents__foot">
        {footerItems?.map(it => <Link key={it.key} item={it} active={it.key === activeKey} onNavigate={onNavigate} />)}
        {showThemeSwitch && <li><ThemeCycle /></li>}
      </ul>
    </nav>
  )
}
