import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Checkbox, Modal, message } from 'antd'
import { Database, FileText, Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import { registerAssistantSlots } from './assistant-slots'
import type { AssistantSlotProps, Mentionable } from './assistant-slots'

/**
 * 助手页的数据接线：把数据集、连接器接到 assistant-slots 的三个位置
 *  - dataChips：对话顶部「已选数据集」标签；
 *  - mentionables：输入框打 @ 能选的数据集和企业微信群；
 *  - dataActions：「＋」菜单里的「添加数据文件…」（调用数据集导入，并自动加为本会话数据）和「选择已有数据集」。
 * 选中的数据集编号随提问一起发给主进程（agent:run 的 datasets），主进程记在会话上，用来把代号还原成真名。
 */
export interface PickedDataset { id: string; name: string }

let picked: PickedDataset[] = []
const subs = new Set<() => void>()
const emit = () => { for (const f of subs) f() }
export const getPickedDatasets = (): PickedDataset[] => picked
export function addPickedDatasets(list: PickedDataset[]): void {
  const next = [...picked]
  for (const d of list) if (!next.some(x => x.id === d.id)) next.push(d)
  picked = next; emit()
}
export function removePickedDataset(id: string): void { picked = picked.filter(d => d.id !== id); emit() }
export function clearPickedDatasets(): void { if (picked.length) { picked = []; emit() } }
function usePicked(): PickedDataset[] {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => picked)
}

// 「选择已有数据集」对话框的开关
let pickerOpen = false
const pickerSubs = new Set<() => void>()
const setPickerOpen = (v: boolean) => { pickerOpen = v; for (const f of pickerSubs) f() }
const usePickerOpen = (): boolean => useSyncExternalStore(cb => { pickerSubs.add(cb); return () => { pickerSubs.delete(cb) } }, () => pickerOpen)

const errText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 弹出文件选择、导入、自动加为本会话数据 */
async function addFiles(): Promise<void> {
  try { await importPaths(await window.api.datasets.pick()) } catch (e) { message.error(errText(e)) }
}

// ───────── 附件：图片 / PDF / Word / 文本，读出文字后跟问题一起发 ─────────
export interface Attachment { key: string; name: string; kind: AgentAttachInfo['kind'] | 'loading'; id?: string; chars?: number; truncated?: boolean }
let attachments: Attachment[] = []
const attSubs = new Set<() => void>()
const attEmit = () => { for (const f of attSubs) f() }
const setAtt = (next: Attachment[]) => { attachments = next; attEmit() }
export const getAttachmentIds = (): string[] => attachments.filter(a => a.id).map(a => a.id!)
export const attachmentsLoading = (): boolean => attachments.some(a => a.kind === 'loading')
/** 发出后清空；换对话时 resetNames = true，截图编号从 1 重新数 */
export function clearAttachments(resetNames = false): void { if (resetNames) pasteSeq = 0; if (attachments.length) setAtt([]) }
// 粘贴的截图没有文件名（都叫 image.png）：按粘贴顺序叫「截图1、截图2…」，助手才分得清、能按名字分组导入
let pasteSeq = 0
function useAttachments(): Attachment[] {
  return useSyncExternalStore(cb => { attSubs.add(cb); return () => { attSubs.delete(cb) } }, () => attachments)
}
export const useAttachmentsBusy = (): boolean => useAttachments().some(a => a.kind === 'loading')
let attSeq = 0
async function readOne(name: string, read: () => Promise<AgentAttachInfo>): Promise<void> {
  const key = `att-${++attSeq}`
  setAtt([...attachments, { key, name, kind: 'loading' }])
  try {
    const info = await read()
    setAtt(attachments.map(a => (a.key === key ? { key, name: info.name, kind: info.kind, id: info.id, chars: info.chars, truncated: info.truncated } : a)))
  } catch (e) {
    setAtt(attachments.filter(a => a.key !== key))
    message.error(`「${name}」${errText(e)}`)
  }
}

const TABLE_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i
/** 拖入 / 粘贴的文件：表格走数据集导入；图片、PDF、Word、文本当附件；粘贴的截图没有路径，直接读内容 */
export async function addDroppedFiles(files: File[]): Promise<void> {
  const tables: string[] = []
  const jobs: Array<Promise<void>> = []
  for (const f of files) {
    let p = ''
    try { p = window.api.getPathForFile(f) } catch { /* 没有路径：粘贴的截图 */ }
    if (p && TABLE_EXT.test(p)) tables.push(p)
    else if (p) jobs.push(readOne(f.name, () => window.api.agent.readAttachment(p)))
    else if (f.type.startsWith('image/')) {
      const ext = /\.(png|jpe?g|webp|gif|bmp)$/i.exec(f.name)?.[0] ?? '.png'
      const name = !f.name || /^image\.\w+$/i.test(f.name) ? `截图${++pasteSeq}${ext}` : f.name
      jobs.push(readOne(name, async () => window.api.agent.readPastedImage(name, new Uint8Array(await f.arrayBuffer()))))
    }
  }
  try { await importPaths(tables) } catch (e) { message.error(errText(e)) }
  await Promise.all(jobs)
}

async function addAttachments(): Promise<void> {
  try {
    const paths = await window.api.agent.pickAttachments()
    await Promise.all(paths.map(p => readOne(p.split(/[\\/]/).pop() ?? p, () => window.api.agent.readAttachment(p))))
  } catch (e) { message.error(errText(e)) }
}

async function importPaths(paths: string[]): Promise<void> {
  {
    if (!paths.length) return
    const hide = message.loading('正在导入数据……', 0)
    try {
      const res = await window.api.datasets.import(paths)
      const ok = res.filter(r => r.ok && r.id)
      if (ok.length) {
        const list = await window.api.datasets.list()
        addPickedDatasets(ok.map(r => ({ id: r.id!, name: String(list.find((d: any) => d.id === r.id)?.name ?? r.file) })))
        message.success(`已导入 ${ok.length} 个数据文件，已加为本次对话的数据`)
      }
      const bad = res.filter(r => !r.ok)
      if (bad.length) message.error(`${bad.length} 个文件没能导入：${bad[0].error ?? ''}`)
    } finally { hide() }
  }
}

function DatasetPicker() {
  const open = usePickerOpen()
  const cur = usePicked()
  const [list, setList] = useState<Array<{ id: string; name: string; rows: number }>>([])
  const [sel, setSel] = useState<string[]>([])
  useEffect(() => {
    if (!open) return
    setSel(cur.map(d => d.id))
    void window.api.datasets.list().then(l => setList(l.map((d: any) => ({ id: d.id, name: d.name, rows: (d.tables ?? []).reduce((n: number, t: any) => n + (t.rows ?? 0), 0) })))).catch(() => setList([]))
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={open} title="选择数据集" okText="确定" cancelText="取消" onCancel={() => setPickerOpen(false)}
      onOk={() => { picked = list.filter(d => sel.includes(d.id)).map(d => ({ id: d.id, name: d.name })); emit(); setPickerOpen(false) }} okButtonProps={{ 'data-testid': 'assistant-dataset-ok' } as any}>
      {list.length === 0 ? <p data-testid="assistant-dataset-none">还没有数据集。可以先点「添加数据文件」导入 Excel 或 CSV。</p> : (
        <Checkbox.Group value={sel} onChange={v => setSel(v as string[])} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(d => <Checkbox key={d.id} value={d.id} data-testid="assistant-dataset-option">{d.name}<small className="ewb-lib-sub">　{d.rows} 行</small></Checkbox>)}
        </Checkbox.Group>
      )}
    </Modal>
  )
}

function DataChips(_p: AssistantSlotProps) {
  const cur = usePicked()
  const atts = useAttachments()
  return (
    <>
      {atts.map(a => (
        <span key={a.key} className="ewb-as-tagchip" data-testid="assistant-attachchip" data-kind={a.kind}
          title={a.kind === 'loading' ? '正在读取文字……' : `已读出 ${a.chars} 字${a.truncated ? '（太长，只带前一部分）' : ''}，会跟问题一起发给 AI`}>
          {a.kind === 'loading' ? <LoaderCircle size={12} strokeWidth={1.9} className="ewb-spin" style={{ verticalAlign: '-2px' }} /> : a.kind === 'image' ? <ImageIcon size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /> : <FileText size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} />} {a.name}
          {a.kind !== 'loading' && <button type="button" aria-label="去掉这个附件" data-testid="assistant-attachchip-remove" onClick={() => setAtt(attachments.filter(x => x.key !== a.key))}><X size={12} /></button>}
        </span>
      ))}
      {cur.map(d => (
        <span key={d.id} className="ewb-as-tagchip" data-testid="assistant-datachip" title="这次对话用的数据集">
          <Database size={12} strokeWidth={1.9} style={{ verticalAlign: '-2px' }} /> {d.name}
          <button type="button" aria-label="去掉这个数据集" data-testid="assistant-datachip-remove" onClick={() => removePickedDataset(d.id)}><X size={12} /></button>
        </span>
      ))}
      <DatasetPicker />
    </>
  )
}

async function mentionables(): Promise<Mentionable[]> {
  const out: Mentionable[] = []
  try { for (const d of await window.api.datasets.list()) out.push({ id: d.id, label: d.name, group: 'dataset' }) } catch { /* 没有数据集 */ }
  try { for (const c of await window.api.connectors.list()) if (c.type === 'wecom') out.push({ id: c.id, label: c.name, group: 'connector' }) } catch { /* 没有连接器 */ }
  return out
}

registerAssistantSlots({
  dataChips: DataChips,
  mentionables,
  dataActions: { addFiles: () => { void addFiles() }, pickDataset: () => setPickerOpen(true), pickSendFile: () => window.api.connectors.pickSendFile().catch(() => null), addAttachments: () => { void addAttachments() }, pasteFiles: files => { void addDroppedFiles(files) } }
})
