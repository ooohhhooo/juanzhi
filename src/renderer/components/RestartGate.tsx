import React, { useEffect, useState } from 'react'
import { Button, Modal } from 'antd'
import { requireRestart, useRestartState } from '../stats/restartStore'

/** 数据目录已更改、需要重启才生效：重启前不让继续操作（继续改东西会写进旧目录，重启后就不见了） */
export default function RestartGate() {
  const st = useRestartState()
  const [notice, setNotice] = useState<{ kind: 'recovered' | 'failed'; message: string } | null>(null)
  // 「需要重启」的状态在主进程里：页面重载、macOS 关窗再点 Dock 图标新建的窗口，启动时都问一次主进程，仍然要拦住
  useEffect(() => { window.api.app.info().then(i => { if (i.restartPending) requireRestart(i.restartTarget, i.restartOldDir); if (i.startupNotice) setNotice(i.startupNotice) }).catch(() => undefined) }, [])
  return (
    <>
    <Modal open={!!notice} destroyOnHidden closable={false} maskClosable={false} keyboard={false} centered zIndex={1900} data-testid="startup-notice"
      title={notice?.kind === 'failed' ? '上次导入数据包没有恢复成功' : '上次导入数据包没有完成'}
      footer={<Button type="primary" data-testid="startup-notice-ok" onClick={() => setNotice(null)}>知道了</Button>}>
      <p data-testid="startup-notice-body" style={{ whiteSpace: 'pre-wrap' }}>{notice?.message}</p>
    </Modal>
    <Modal open={st.required} closable={false} maskClosable={false} keyboard={false} footer={null} centered title="需要重启才能使用新的数据目录" zIndex={2000} data-testid="restart-modal">
      <div data-testid="restart-body">
      <p>数据目录已经设置好了，重启之后才会生效。在重启之前请不要再导入或修改任何东西——那些改动会写进旧目录，重启后就看不到了。</p>
      {st.target && <p style={{ fontSize: 12, color: '#666', wordBreak: 'break-all' }}>新目录：<code>{st.target}</code>{st.oldDir && <><br />旧目录（里面的数据没有被删除）：<code>{st.oldDir}</code></>}</p>}
      <Button type="primary" data-testid="restart-now" onClick={() => window.api.app.restart()}>立即重启</Button>
      <span style={{ marginLeft: 12, fontSize: 12, color: '#888' }}>或者直接关闭本软件，下次打开就是新目录。</span>
      </div>
    </Modal>
    </>
  )
}
