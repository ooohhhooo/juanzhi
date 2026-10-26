import React from 'react'
import { Alert, Button } from 'antd'
import { useNavigate } from 'react-router-dom'

/** 安装指南的入口页。正文（Mac 打开未签名应用、Windows 的 SmartScreen、OCR 语言包等）在 M5 随安装包一起写；这里先放占位和现在就能说清的几件事。 */
export default function Guide() {
  const nav = useNavigate()
  return (
    <div data-testid="guide-page" style={{ padding: 24, maxWidth: 760 }}>
      <h2 style={{ margin: '0 0 16px', color: '#1e2952' }}>安装指南</h2>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="完整的安装指南还没写好" description="打包发布（Mac 的 dmg、Windows 的安装包）和随包的安装指南是下一个里程碑（M5）的内容。这一页先留作入口，M5 会把正文放在这里。" />
      <h3>现在就能说清的几件事</h3>
      <ul style={{ lineHeight: 1.9 }}>
        <li><b>换电脑 / 备份数据</b>：设置 → 数据包 → 导出，在新电脑上导入（合并或覆盖）。API 密钥不会进数据包，换电脑后需要重新填写。</li>
        <li><b>数据放在哪里</b>：设置 → 数据存储 → 更改数据目录（比如放到移动硬盘上），重启后生效。</li>
        <li><b>不想动真实数据先试试</b>：设置 → 示例数据 → 加载；示例数据不会混进真实数据的统计，随时可以一键清除。</li>
        <li><b>文字识别（OCR）</b>：Mac 使用系统自带的识别；Windows 需要系统装有中文语言包，没有时会改用视觉模型。详见设置页的「文字识别」。</li>
      </ul>
      <Button onClick={() => nav('/settings')}>回到设置</Button>
    </div>
  )
}
