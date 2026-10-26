import React from 'react'
import { Button } from 'antd'
import { useNavigate } from 'react-router-dom'
// 正文和随安装包发布的 docs/安装指南.md 是同一份文件（构建时内联进来），两处不会不一致
import guideMd from '../../../docs/安装指南.md?raw'
import MarkdownView from '../stats/MarkdownView'

/** 去掉文件开头的「# 安装指南」一级标题（页面自己有标题） */
const body = guideMd.replace(/^﻿?# [^\n]*\n/, '')

/** 安装指南页：Mac 打开未签名应用、Windows 的 SmartScreen、OCR 语言包、配置 AI、换电脑、数据位置、卸载、常见问题。 */
export default function Guide() {
  const nav = useNavigate()
  return (
    <div data-testid="guide-page" style={{ padding: 24, maxWidth: 820 }}>
      <h2 style={{ margin: '0 0 12px', color: '#1e2952' }}>安装指南</h2>
      <div data-testid="guide-body"><MarkdownView markdown={body} refs={[]} onView={() => undefined} /></div>
      <Button style={{ marginTop: 16 }} onClick={() => nav('/settings')}>回到设置</Button>
    </div>
  )
}
