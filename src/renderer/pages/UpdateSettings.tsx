import React, { useState } from 'react'
import { Modal, Progress } from 'antd'
import { Btn, UsageNote } from '../design'
import { useUpdateState } from '../hooks/useUpdate'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 设置 → 关于 → 软件更新：检查、下载并校验、重启完成。不会自动安装，数据不受影响。 */
export default function UpdateSettings(): React.ReactElement {
  const st = useUpdateState()
  const [busyReason, setBusyReason] = useState<{ text: string; hard: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const phase = st?.phase ?? 'idle'
  const guard = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn() } catch (e) { setErr(clean(e)) } }
  const install = (force: boolean) => guard(async () => {
    const r = await window.api.update.install(force)
    if (r.busy) setBusyReason({ text: r.busy, hard: !!r.hard })
    else { setBusyReason(null); if (!r.ok && r.message) setErr(r.message) }
  })

  const status = ((): string => {
    switch (phase) {
      case 'checking': return '正在检查更新…'
      case 'uptodate': return `已经是最新版（${st?.currentVersion}）`
      case 'available': return `有新版本 ${st?.latestVersion}`
      case 'downloading': return `正在下载 ${st?.latestVersion}…`
      case 'ready': return `${st?.latestVersion} 已下载并校验通过，重启后完成更新`
      case 'installing': return '正在重启并完成更新…'
      case 'error': return '没能完成更新'
      default: return '还没有检查过'
    }
  })()
  const canAuto = !st?.blocker

  return (
    <div data-testid="update-settings">
      <span className="ewb-rep-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Btn tone="secondary" size="small" loading={phase === 'checking'} disabled={['downloading', 'installing', 'ready'].includes(phase)} data-testid="update-check" onClick={() => void guard(() => window.api.update.check(false))}>检查更新</Btn>
        {phase === 'available' && canAuto && <Btn tone="primary" size="small" data-testid="update-download" onClick={() => void guard(() => window.api.update.download())}>下载并更新</Btn>}
        {phase === 'ready' && <Btn tone="primary" size="small" data-testid="update-install" onClick={() => void install(false)}>重启并完成更新</Btn>}
        {phase === 'downloading' && <Btn tone="quiet" size="small" data-testid="update-cancel" onClick={() => void guard(() => window.api.update.cancel())}>取消下载</Btn>}
        <span data-testid="update-status">{status}</span>
      </span>
      {phase === 'downloading' && <Progress percent={st?.progress?.percent ?? 0} size="small" style={{ maxWidth: 360, marginTop: 6 }} data-testid="update-progress" />}
      {st?.notes && ['available', 'downloading', 'ready'].includes(phase) && <p className="ewb-rep-note" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }} data-testid="update-notes">{st.notes}</p>}
      {phase === 'available' && st?.blocker && (
        <UsageNote kind="caution" title="这次需要手动更新" data-testid="update-blocker" actions={<Btn tone="secondary" size="small" data-testid="update-manual" onClick={() => void window.api.update.openReleasePage()}>手动下载</Btn>}>{st.blocker.message}</UsageNote>
      )}
      {phase === 'error' && st?.error && (
        <UsageNote kind="mistake" title="没能完成更新" data-testid="update-error" actions={st.error.manual ? <Btn tone="secondary" size="small" data-testid="update-manual" onClick={() => void window.api.update.openReleasePage()}>手动下载</Btn> : undefined}>
          {st.error.message}{st.error.manual ? '可以稍后再试，或点「手动下载」去下载页。' : '想继续的话，点「检查更新」重新来过。'}
        </UsageNote>
      )}
      {err && <p className="ewb-rep-note" data-testid="update-ipc-error">{err}</p>}
      <p className="ewb-rep-note" style={{ marginTop: 4 }}>更新只替换软件本身，你的试卷、统计和设置都在另外的数据目录里，不会被改动。卷知不会自己安装，每次都要你点了才更新；启动时每天最多悄悄查看一次有没有新版。</p>

      <Modal open={!!busyReason} centered title="还有任务在进行" data-testid="update-busy-modal" onCancel={() => setBusyReason(null)}
        footer={busyReason?.hard
          ? <Btn tone="primary" data-testid="update-busy-ok" onClick={() => setBusyReason(null)}>知道了</Btn>
          : <span style={{ display: 'inline-flex', gap: 8 }}>
            <Btn tone="secondary" data-testid="update-busy-wait" onClick={() => setBusyReason(null)}>等它做完再更新</Btn>
            <Btn tone="danger" data-testid="update-busy-force" onClick={() => void install(true)}>放弃这些任务并更新</Btn>
          </span>}>
        <p style={{ lineHeight: 1.7 }} data-testid="update-busy-text">{busyReason?.text}</p>
        {busyReason?.hard ? <p style={{ lineHeight: 1.7 }}>这时候中途退出可能损坏数据，所以现在不能更新。等它完成后再点「重启并完成更新」。</p> : <p style={{ lineHeight: 1.7 }}>现在更新会中断它们：没做完的试卷会标成失败，之后可以重新处理。已经保存的数据不受影响。可以等任务做完再点「重启并完成更新」。</p>}
      </Modal>
    </div>
  )
}
