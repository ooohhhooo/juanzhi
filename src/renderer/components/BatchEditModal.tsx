import React, { useEffect, useState } from 'react'
import { Modal, Select, InputNumber, Input, Checkbox, App } from 'antd'
import { BATCH_FIELDS, buildBatchMeta } from '../../shared/library-select'
import type { BatchField } from '../../shared/library-select'

const gradeOptions = ['1', '2', '3', '4', '5', '6'].map(v => ({ label: `${v}年级`, value: v }))
const semesterOptions = [{ label: '上学期', value: '上' }, { label: '下学期', value: '下' }]
const examTypeOptions = ['单元测试', '期中', '期末', '月考', '其他'].map(v => ({ label: v, value: v }))

/**
 * 批量改信息：给选中的试卷统一设置同一个值。只改打了勾的项，没勾的原样不动；
 * 在某一项里填了内容会自动打勾；勾了但留空 = 把这一项清空。
 */
export default function BatchEditModal({ open, papers, saving, onCancel, onOk }: {
  open: boolean
  /** 选中的试卷；ai = 它现在哪些项还带着「AI 猜的」标记 */
  papers: Array<{ id: string; ai: string[] }>
  saving?: boolean
  onCancel: () => void
  onOk: (meta: Record<string, unknown>) => void
}) {
  const { modal } = App.useApp()
  const [ticked, setTicked] = useState<Partial<Record<BatchField, boolean>>>({})
  const [values, setValues] = useState<Partial<Record<BatchField, unknown>>>({})
  useEffect(() => { if (open) { setTicked({}); setValues({}) } }, [open])

  const setVal = (k: BatchField, v: unknown) => {
    setValues(prev => ({ ...prev, [k]: v }))
    if (v !== undefined && v !== null && v !== '') setTicked(prev => ({ ...prev, [k]: true }))
  }
  const tick = (k: BatchField, on: boolean) => setTicked(prev => ({ ...prev, [k]: on }))

  const tickedKeys = BATCH_FIELDS.filter(f => ticked[f.key]).map(f => f.key)
  const aiHit = papers.filter(p => p.ai.some(k => tickedKeys.includes(k as BatchField))).length
  const clearing = tickedKeys.filter(k => { const v = values[k]; return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') })

  const control = (k: BatchField) => {
    const common = { 'data-testid': `batch-edit-input-${k}` }
    switch (k) {
      case 'grade': return <Select {...common} options={gradeOptions} allowClear value={values.grade as any} onChange={v => setVal(k, v)} placeholder="选年级" style={{ width: 160 }} />
      case 'semester': return <Select {...common} options={semesterOptions} allowClear value={values.semester as any} onChange={v => setVal(k, v)} placeholder="选学期" style={{ width: 160 }} />
      case 'exam_type': return <Select {...common} options={examTypeOptions} allowClear value={values.exam_type as any} onChange={v => setVal(k, v)} placeholder="选类型" style={{ width: 160 }} />
      case 'school_year_start': return <InputNumber {...common} min={2000} max={2100} precision={0} value={values.school_year_start as any} onChange={v => setVal(k, v)} placeholder="如 2025" style={{ width: 160 }} />
      default: return <Input {...common} value={(values[k] as string) ?? ''} onChange={e => setVal(k, e.target.value)} placeholder={k === 'textbook' ? '如 PEP 三年级起点' : k === 'school' ? '如 实验小学' : '如 北京'} maxLength={k === 'school' ? 200 : 100} style={{ width: 240 }} />
    }
  }

  return (
    <Modal
      title={`批量改信息（${papers.length} 份试卷）`}
      open={open}
      onCancel={onCancel}
      onOk={() => {
        const meta = buildBatchMeta(ticked, values)
        if (clearing.length === 0) { onOk(meta); return }
        // 清空是改不回来的：再确认一次，写明清哪几项、几份试卷
        modal.confirm({
          title: `会清空 ${papers.length} 份试卷的 ${clearing.map(k => BATCH_FIELDS.find(f => f.key === k)!.label).join('、')}`,
          content: <span data-testid="batch-clear-confirm">这几项会变成空的，清空后不能恢复。确定要清空吗？</span>,
          okText: '清空并保存', cancelText: '取消', okButtonProps: { danger: true, 'data-testid': 'batch-clear-ok' } as any,
          onOk: () => onOk(meta)
        })
      }}
      okText={tickedKeys.length ? `改这 ${tickedKeys.length} 项` : '保存'}
      cancelText="取消"
      okButtonProps={{ disabled: tickedKeys.length === 0, loading: saving, 'data-testid': 'batch-edit-ok' } as any}
      width={560}
      destroyOnHidden
    >
      <div data-testid="batch-edit">
        <p className="ewb-lib-batchnote">给选中的每份试卷设成同一个值。只改打了勾的项，没勾的保持原样。</p>
        <div className="ewb-lib-batchgrid">
          {BATCH_FIELDS.map(f => (
            <div className="ewb-lib-batchrow" key={f.key}>
              <Checkbox checked={!!ticked[f.key]} onChange={e => tick(f.key, e.target.checked)} data-testid={`batch-edit-tick-${f.key}`}>{f.label}</Checkbox>
              {control(f.key)}
            </div>
          ))}
        </div>
        {clearing.length > 0 && (
          <p className="ewb-lib-batchwarn" data-testid="batch-edit-clearing">
            {clearing.map(k => BATCH_FIELDS.find(f => f.key === k)!.label).join('、')}勾了但没填，会把这{clearing.length > 1 ? '几' : '一'}项清空。
          </p>
        )}
        {aiHit > 0 && <p className="ewb-lib-batchnote" data-testid="batch-edit-ai">其中 {aiHit} 份的这些项原来是「AI 猜的」，值被改掉的就不再标 AI 猜的。</p>}
      </div>
    </Modal>
  )
}
