import React from 'react'
import { useNavigate } from 'react-router-dom'
// 正文和随安装包发布的 docs/安装指南.md 是同一份文件（构建时内联进来），两处不会不一致
import guideMd from '../../../docs/安装指南.md?raw'
import MarkdownView from '../stats/MarkdownView'
import { Btn, Page } from '../design'
import '../design/page-library.css'

/** 去掉文件开头的「# 安装指南」一级标题（页面自己有标题） */
const body = guideMd.replace(/^﻿?# [^\n]*\n/, '')

/** 安装指南页：Mac 打开未签名应用、Windows 的 SmartScreen、OCR 语言包、配置 AI、换电脑、数据位置、卸载、常见问题。 */
export default function Guide() {
  const nav = useNavigate()
  return (
    <Page reading className="ewb-lib-doc" data-testid="guide-page">
      <div className="ewb-lib-head"><h1 className="ewb-lib-title">安装指南</h1></div>
      <div data-testid="guide-body"><MarkdownView markdown={body} refs={[]} onView={() => undefined} /></div>
      <div className="ewb-lib-doc__foot"><Btn tone="secondary" onClick={() => nav('/settings')}>回到设置</Btn></div>
    </Page>
  )
}
