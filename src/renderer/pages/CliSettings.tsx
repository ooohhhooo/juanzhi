import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Descriptions } from 'antd'
import { Btn, Panel, UsageNote } from '../design'

/** 设置 → 管理员设置 → 命令行工具：给 Agent（Codex、Claude Code 等）或自己在终端里用 `juanzhi` 命令。安装 = 写一个小脚本，不改卷知的数据。 */
export default function CliSettings(): React.ReactElement {
  const qc = useQueryClient()
  const { data: st } = useQuery({ queryKey: ['cli-status'], queryFn: () => window.api.cli.status() })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; hint: string; warnings: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const install = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { setResult(await window.api.cli.install()); await qc.invalidateQueries({ queryKey: ['cli-status'] }) } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } finally { setBusy(false) }
  }

  return (
    <div className="ewb-set-panel">
      <Panel title="命令行工具" data-testid="cli-settings">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="状态"><span data-testid="cli-status">{!st ? '检测中…' : !st.supported ? '当前系统不支持' : st.installed ? '已安装' : '还没安装'}</span>{st?.installed && <code className="ewb-rep-code" style={{ marginLeft: 8 }}>{st.path}</code>}</Descriptions.Item>
        </Descriptions>
        <p className="ewb-rep-note">装好后，在终端里输入 <code className="ewb-rep-code">juanzhi status</code> 就能调用卷知（导入试卷、看统计、生成报告），Agent（Codex、Claude Code 等）也能直接用。使用前要先关闭卷知窗口。</p>
        {st?.portable && <UsageNote kind="caution" title="免安装版的限制">短命令会指向这个免安装文件本身：移动或删除它之后命令就失效；每次运行都要先解压，会慢几秒。长期使用建议装安装版。</UsageNote>}
        {st && !st.packaged && <p className="ewb-rep-note">（开发版不能安装命令行工具）</p>}
        <div className="ewb-rep-row" style={{ gap: 8 }}>
          <Btn tone="secondary" size="small" loading={busy} disabled={!st?.supported || !st?.packaged} data-testid="cli-install" onClick={() => void install()}>{st?.installed ? '重新安装命令行工具' : '安装命令行工具'}</Btn>
        </div>
        {result && <UsageNote kind="tip" title="已安装" data-testid="cli-install-result">{result.hint}{result.warnings.map((w, i) => <div key={i}>{w}</div>)}</UsageNote>}
        {error && <UsageNote kind="mistake" title="没能安装" data-testid="cli-install-error">{error}</UsageNote>}
      </Panel>
    </div>
  )
}
