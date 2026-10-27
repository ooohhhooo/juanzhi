/**
 * 产品徽章：盾形徽章里一本翻开的书（词典意象），线性、主色、1.75 描边，和图标库同一风格。
 * 用 currentColor，颜色由外层（CSS 里设为主色）决定。
 */
import React from 'react'

export default function BrandMark({ size = 48, title = '卷知' }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} role="img" aria-label={title} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <title>{title}</title>
      {/* 盾形 */}
      <path d="M24 4.5 39.5 9.5v13.2c0 8.6-6.4 15.2-15.5 20.3C14.9 37.900 8.500 31.300 8.500 22.700V9.500z" fill="var(--ewb-primary-soft)" />
      {/* 翻开的书 */}
      <path d="M13.500 16.500c3.500-.9 7.200-.2 10.500 2.200 3.300-2.400 7-3.100 10.500-2.200v14.200c-3.500-.9-7.200-.2-10.500 2.200-3.300-2.400-7-3.100-10.500-2.200z" fill="var(--ewb-page)" />
      <path d="M24 18.700v14.200" />
      {/* 书页上的字行 */}
      <path d="M16.800 21.200h4M16.800 24.600h4M27.200 21.200h4M27.200 24.600h4" strokeWidth={1.4} />
    </svg>
  )
}
