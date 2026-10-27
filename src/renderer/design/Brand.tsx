/**
 * 产品徽章：卷知的应用图标（渐变圆角底上白色「卷」字，右上一点玫红），和 Dock / 任务栏里的图标是同一张图。
 * 图标自带底色，浅色、深色外观下都直接显示，不随主题变色。
 */
import React from 'react'
import logo from '../assets/logo.png'

export default function BrandMark({ size = 48, title = '卷知' }: { size?: number; title?: string }) {
  return <img src={logo} width={size} height={size} alt={title} title={title} draggable={false} style={{ display: 'block' }} />
}
