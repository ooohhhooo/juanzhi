/**
 * 基础件：按钮、版心、面板、小节标题、原卷纸、空状态、骨架、索引页式表格。
 */
import React from 'react'
import { Button, Table } from 'antd'
import type { ButtonProps, TableProps } from 'antd'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './icons'

// ───────────── 按钮 ─────────────

export interface BtnProps extends Omit<ButtonProps, 'type' | 'danger' | 'icon' | 'children' | 'variant' | 'color'> {
  /**
   * 样式：
   * - primary   词头蓝实心，圆角 6px，文字 15px。每个页面只放一个。
   * - secondary 1px 墨色描边（默认）
   * - danger    易错红描边，用于删除、清除等危险操作
   * - quiet     无边框的文字按钮（词头蓝），用于次要的行内操作
   */
  tone?: 'primary' | 'secondary' | 'danger' | 'quiet'
  /** lucide 图标组件（可选）。图标只是陪衬，按钮必须有文字 */
  icon?: LucideIcon
  /** 按钮文字：必填。设计规则：图标按钮必须带文字，所以这里没有「纯图标」的写法 */
  children: React.ReactNode
}

/** 统一的按钮：图标 + 文字，主 / 次 / 危险 / 安静四种 */
export const Btn = React.forwardRef<HTMLElement, BtnProps>(function Btn({ tone = 'secondary', icon, children, ...rest }, ref) {
  const type: ButtonProps['type'] = tone === 'primary' ? 'primary' : tone === 'quiet' ? 'text' : 'default'
  return (
    <Button {...rest} ref={ref as React.Ref<HTMLButtonElement>} type={type} danger={tone === 'danger'} icon={icon ? <Icon as={icon} /> : undefined} style={tone === 'quiet' ? { color: 'var(--ewb-primary)', ...rest.style } : rest.style}>
      {children}
    </Button>
  )
})

// ───────────── 版式 ─────────────

/** 版心：正文最大宽度 1240px 居中；`reading` 约 68 个汉字宽（报告、词条详情） */
export function Page({ children, reading, className, ...rest }: { children: React.ReactNode; reading?: boolean; className?: string; 'data-testid'?: string }) {
  return <div data-testid={rest['data-testid']} className={`ewb-page${reading ? ' ewb-page--reading' : ''}${className ? ' ' + className : ''}`}>{children}</div>
}

/** 面板：1px 细线，圆角 8px，不加阴影 */
export function Panel({ title, aside, children, bodyStyle, ...rest }: { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; bodyStyle?: React.CSSProperties; 'data-testid'?: string }) {
  return (
    <section className="ewb-panel" data-testid={rest['data-testid']}>
      {(title || aside) && (
        <header className="ewb-panel__head">
          <h3 className="ewb-panel__title">{title}</h3>
          {aside && <div>{aside}</div>}
        </header>
      )}
      <div className="ewb-panel__body" style={bodyStyle}>{children}</div>
    </section>
  )
}

/** 小节标题：上方空间大于下方；右侧可放说明 */
export function SectionTitle({ children, aside, level = 2, compact }: { children: React.ReactNode; aside?: React.ReactNode; level?: 2 | 3; compact?: boolean }) {
  const H = `h${level}` as 'h2' | 'h3'
  return (
    <div className={`ewb-section-title${compact ? ' ewb-section-title--compact' : ''}`}>
      <H className="ewb-section-title__text">{children}</H>
      {aside && <span className="ewb-section-title__aside">{aside}</span>}
    </div>
  )
}

/** 词条两栏：宽屏（容器 ≥ 760px）用两栏、栏间 1px 细线；`always` 强制两栏 */
export function EntryColumns({ children, always }: { children: React.ReactNode; always?: boolean }) {
  return <div className={`ewb-cols${always ? ' ewb-cols--always' : ''}`}>{children}</div>
}

/** 原卷 / 页面图片区域：深色模式下也保持白纸。用它包住 <img> 或 PageViewer */
export function PaperSheet({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return <div className={`ewb-sheet${className ? ' ' + className : ''}`} style={style}>{children}</div>
}

/** 深蓝布面：审核页中栏的底，白纸像书页放在上面 */
export function Cloth({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="ewb-cloth" style={style}>{children}</div>
}

// ───────────── 空状态 ─────────────

export interface EmptyStateProps {
  /** 标题：说清这里本该有什么，如「还没有导入试卷」 */
  title: string
  /** 一句说明 */
  description?: React.ReactNode
  /** 教用户怎么开始的步骤（空状态要教会界面，不是只写「暂无数据」） */
  steps?: string[]
  /** 操作区：通常一个主按钮 */
  action?: React.ReactNode
  /** 嵌在面板里时用 inline（不居中、不留大边距） */
  inline?: boolean
}

export function EmptyState({ title, description, steps, action, inline }: EmptyStateProps) {
  return (
    <div className={`ewb-empty${inline ? ' ewb-empty--inline' : ''}`}>
      <h3 className="ewb-empty__title">{title}</h3>
      {description && <p className="ewb-empty__desc">{description}</p>}
      {steps && steps.length > 0 && (
        <ol className="ewb-empty__steps">{steps.map((s, i) => <li key={i}><span className="ewb-empty__stepn">{i + 1}</span><span>{s}</span></li>)}</ol>
      )}
      {action && <div className="ewb-empty__action">{action}</div>}
    </div>
  )
}

// ───────────── 加载骨架 ─────────────

/** 一条灰块（骨架）；宽高自定 */
export function SkeletonBar({ width = '100%', height = 14, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <span className="ewb-skel" aria-hidden style={{ width, height, ...style }} />
}

/** 词条形状的骨架：加载列表时用，不要在内容中间转圈 */
export function EntrySkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="正在加载词条">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ewb-entry" style={{ display: 'grid', gap: 10 }}>
          <SkeletonBar width="38%" height={24} />
          <SkeletonBar width="92%" />
          <SkeletonBar width="64%" />
        </div>
      ))}
    </div>
  )
}

// ───────────── 表格：词典「索引页」 ─────────────

/**
 * 词典索引页式表格：细线分隔、标题列加宽（第一列加粗）、等宽数字、无斑马纹。
 * 直接是 AntD Table（所有 props 照用），样式来自主题 token + design.css。
 * 提示：操作列的按钮用 <Btn tone="quiet" icon={...}>带文字</Btn>。
 */
export function IndexTable<T extends object>(props: TableProps<T>) {
  return <Table<T> size="middle" pagination={false} {...props} className={`ewb-index-table${props.className ? ' ' + props.className : ''}`} />
}
