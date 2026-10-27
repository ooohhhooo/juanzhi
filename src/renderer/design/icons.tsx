/**
 * 图标：统一 lucide-react，1.75 描边，一套到底。
 * 规则：图标按钮必须带文字（见 Btn，它的 children 必填）；单独出现的图标只作装饰，一律 aria-hidden。
 */
import React from 'react'
import type { LucideIcon } from 'lucide-react'

export const ICON_STROKE = 1.75

export interface IconProps {
  /** lucide 图标组件，如 `import { Upload } from 'lucide-react'` */
  as: LucideIcon
  /** 像素尺寸，默认 16 */
  size?: number
  className?: string
  style?: React.CSSProperties
}

/** 统一尺寸与描边的图标（装饰用，读屏忽略） */
export function Icon({ as: Cmp, size = 16, className, style }: IconProps) {
  return <Cmp size={size} strokeWidth={ICON_STROKE} aria-hidden focusable={false} className={className} style={style} />
}

/** 目录导航「当前页」的小三角：SVG 画的实心三角，不用字符 ▸ */
export function Triangle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" width="10" height="10" aria-hidden focusable="false">
      <path d="M2.5 1.2 8 5l-5.5 3.8z" fill="currentColor" />
    </svg>
  )
}
