import React from 'react'
import { useNavigate } from 'react-router-dom'
import MarkdownView from '../stats/MarkdownView'
import { HELP_MARKDOWN } from '../../shared/roles'
import { Btn, Page } from '../design'
import '../design/page-library.css'

/** 使用说明：面向运营和辅导老师的简明说明（安装、换电脑、卸载在「设置 → 安装指南」里）。正文在 shared/roles.ts */
export default function Help() {
  const nav = useNavigate()
  return (
    <Page reading className="ewb-lib-doc" data-testid="help-page">
      <div className="ewb-lib-head"><h1 className="ewb-lib-title">使用说明</h1></div>
      <div data-testid="help-body"><MarkdownView markdown={HELP_MARKDOWN} refs={[]} onView={() => undefined} /></div>
      <div className="ewb-lib-doc__foot">
        <Btn tone="secondary" onClick={() => nav('/')}>回到试卷库</Btn>
        <Btn tone="secondary" data-testid="help-to-guide" onClick={() => nav('/guide')}>安装指南（装软件、换电脑、卸载）</Btn>
      </div>
    </Page>
  )
}
