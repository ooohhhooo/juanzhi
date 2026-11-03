import React, { useState } from 'react'
import { App, Modal } from 'antd'
import { Bug, ClipboardCopy, Download } from 'lucide-react'
import { Btn } from '../design'

type Preview = Awaited<ReturnType<typeof window.api.diagnostics.preview>>
const kb = (n: number) => (n < 1024 ? `${n} 字节` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 设置 → 关于里的「导出诊断信息」「复制简短诊断」「反馈问题」。导出前先把将包含的内容逐项列给用户看 */
export default function DiagnosticsPanel() {
  const { message } = App.useApp()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const openPreview = async () => {
    setLoading(true)
    try { setPreview(await window.api.diagnostics.preview()) } catch (e) { message.error(clean(e)) } finally { setLoading(false) }
  }
  const save = async () => {
    setSaving(true)
    try {
      const r = await window.api.diagnostics.export()
      if (r.saved) { message.success(`已保存诊断信息（${r.files} 个文件，${kb(r.bytes ?? 0)}）：${r.path}`); setPreview(null) }
    } catch (e) { message.error(clean(e)) } finally { setSaving(false) }
  }
  const copyShort = async () => {
    try { await window.api.diagnostics.short(true); message.success('已复制简短诊断，可以粘贴到反馈里') } catch (e) { message.error(clean(e)) }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} data-testid="diagnostics-panel">
        <Btn tone="secondary" size="small" icon={Download} loading={loading} data-testid="diag-open" onClick={openPreview}>导出诊断信息</Btn>
        <Btn tone="quiet" size="small" icon={ClipboardCopy} data-testid="diag-copy-short" onClick={copyShort}>复制简短诊断</Btn>
        <Btn tone="quiet" size="small" icon={Bug} data-testid="feedback-open" onClick={() => window.api.feedback.open().catch(e => message.error(clean(e)))}>反馈问题</Btn>
      </div>
      <p className="ewb-rep-note" style={{ marginTop: 4 }}>遇到问题时：先点「导出诊断信息」存成一个压缩包，再点「反馈问题」，把压缩包拖进去。诊断信息只在这台电脑上生成，不会自动上传；里面没有学生数据和密钥。反馈里请不要写学生姓名和密钥。</p>
      <Modal open={!!preview} title="导出诊断信息" onCancel={() => setPreview(null)} width={620} destroyOnHidden
        footer={<span style={{ display: 'inline-flex', gap: 8 }}>
          <Btn tone="quiet" data-testid="diag-cancel" onClick={() => setPreview(null)}>取消</Btn>
          <Btn tone="primary" icon={Download} loading={saving} data-testid="diag-save" onClick={save}>保存到文件…</Btn>
        </span>}>
        {preview && (
          <div data-testid="diag-preview">
            <p>下面就是压缩包里的全部内容（共 {preview.entries.length} 个文件，{kb(preview.totalBytes)}）。确认没问题再保存。</p>
            <ul style={{ paddingLeft: 18, margin: '8px 0' }}>
              {preview.entries.map(e => <li key={e.name}><code>{e.name}</code>　{kb(e.bytes)}　<span style={{ opacity: 0.75 }}>{e.desc}</span></li>)}
            </ul>
            <p style={{ marginBottom: 4 }}><b>永远不会包含：</b></p>
            <ul style={{ paddingLeft: 18, margin: 0 }} data-testid="diag-never">
              {preview.neverIncluded.map(x => <li key={x}>{x}</li>)}
            </ul>
          </div>
        )}
      </Modal>
    </>
  )
}
