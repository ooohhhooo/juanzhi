import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Checkbox, Modal, message } from 'antd'
import { Database, X } from 'lucide-react'
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
  try {
    const paths = await window.api.datasets.pick()
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
  } catch (e) { message.error(errText(e)) }
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
  return (
    <>
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
  dataActions: { addFiles: () => { void addFiles() }, pickDataset: () => setPickerOpen(true) }
})
