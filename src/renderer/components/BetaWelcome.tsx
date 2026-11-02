import React, { useEffect, useState } from 'react'
import { Btn, UsageNote } from '../design'

/** 第一次打开公测版时，试卷库顶部的一张说明（不是弹窗，不挡操作；点「知道了」后不再出现）：公测是什么、数据安不安全、怎么反馈 */
export default function BetaWelcome() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!window.api?.settings) return
    let alive = true
    window.api.settings.get('beta_welcome_seen').then(seen => { if (alive && seen !== true) setShow(true) }, () => undefined)
    return () => { alive = false }
  }, [])
  if (!show) return null
  const close = () => { setShow(false); window.api.settings.set('beta_welcome_seen', true).catch(() => undefined) }
  return (
    <UsageNote kind="tip" title="欢迎试用卷知公测版" data-testid="beta-welcome"
      actions={<Btn tone="primary" size="small" data-testid="beta-welcome-ok" onClick={close}>知道了</Btn>}>
      公测版：免费、开源，功能还在完善。你的数据只保存在这台电脑上，升级前会自动备份。AI 给出的难度、易错点和分析都是估计，发给家长前请先核对。
      遇到问题，到「设置 → 关于」点「导出诊断信息」和「反馈问题」告诉我们。
    </UsageNote>
  )
}
