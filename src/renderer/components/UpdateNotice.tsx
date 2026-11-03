import React, { useEffect, useRef } from 'react'
import { App } from 'antd'
import { useNavigate } from 'react-router-dom'
import { Btn } from '../design'
import { useUpdateState } from '../hooks/useUpdate'

/** 启动时静默检查发现新版后，右上角弹一个不挡操作的小提示（每个版本只弹一次；「以后再说」只关掉这一次，「跳过这个版本」以后不再提示这一版） */
export default function UpdateNotice(): null {
  const st = useUpdateState()
  const { notification } = App.useApp()
  const nav = useNavigate()
  const shown = useRef<string>('')
  useEffect(() => {
    if (!st?.announce || !st.latestVersion || shown.current === st.latestVersion) return
    const v = st.latestVersion
    shown.current = v
    const key = `update-${v}`
    notification.open({
      key, duration: 0, placement: 'topRight', message: `卷知有新版本 ${v}`,
      description: (
        <div data-testid="update-notice">
          {st.notes && <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 4px' }} data-testid="update-notice-notes">{st.notes}</p>}
          <a style={{ display: 'inline-block', margin: '0 0 8px', fontSize: 13 }} data-testid="update-notice-more" onClick={() => void window.api.update.openReleasePage()}>查看完整更新说明</a>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>更新不会动你的数据；由你点了才会安装。</p>
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn tone="primary" size="small" data-testid="update-notice-go" onClick={() => { notification.destroy(key); nav('/settings#about'); setTimeout(() => document.getElementById('set-about')?.scrollIntoView({ block: 'start' }), 200); void window.api.update.download() }}>更新</Btn>
            <Btn tone="quiet" size="small" data-testid="update-notice-later" onClick={() => notification.destroy(key)}>以后再说</Btn>
            <Btn tone="quiet" size="small" data-testid="update-notice-skip" onClick={() => { notification.destroy(key); void window.api.update.skip(v) }}>跳过这个版本</Btn>
          </span>
        </div>
      )
    })
  }, [st?.announce, st?.latestVersion])
  return null
}
