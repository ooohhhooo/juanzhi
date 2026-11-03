import React, { useState } from 'react'
import { App, Input, Modal } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn } from '../../design'
import { clean } from '../../components/CourseMatch'
import { lessonFull } from './format'
import '../../design/page-course.css'

/** 「我知道是哪一课」：搜索课次（标题 / 词汇 / 句型 / 主题）选一个，记为老师手工指定（确认并锁定，重新匹配不会覆盖） */
export default function LessonPicker({ open, kpName, kpCode, outlines, onClose }: { open: boolean; kpName: string; kpCode: string; outlines: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [oid, setOid] = useState<string>('')
  const ids = oid ? [oid] : outlines.map(o => o.id)
  const { data } = useQuery({ queryKey: ['course', 'search', ids, q], queryFn: () => window.api.course.search(ids, q), enabled: open && ids.length > 0 })
  const pick = async (l: CourseLessonRow) => {
    try {
      await window.api.course.mapEdit({ op: 'add', outlineId: l.outlineId, kp: kpCode, lessonId: l.id })
      message.success('已记下：这个考点对应这一课')
      qc.invalidateQueries({ queryKey: ['course'] })
      onClose()
    } catch (e) { message.error(clean(e)) }
  }
  const nameOf = (id: string) => outlines.find(o => o.id === id)?.name ?? ''
  return (
    <Modal open={open} onCancel={onClose} footer={null} title={`「${kpName}」在哪一课讲？`} width="min(640px, 92vw)" destroyOnHidden>
      <div data-testid="lesson-picker">
      <p className="ewb-rep-note">搜课的标题、词汇、句型或主题，点一课就记下来。这是老师手工指定的，之后重新匹配也不会改掉它。</p>
      <div className="ewb-rep-row" style={{ margin: '8px 0' }}>
        <Input allowClear autoFocus data-testid="lesson-picker-q" placeholder="例如：Animals、cat、过去式" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        {outlines.length > 1 && (
          <select aria-label="课程体系" data-testid="lesson-picker-outline" value={oid} onChange={e => setOid(e.target.value)} className="ant-input" style={{ width: 'auto' }}>
            <option value="">全部体系</option>
            {outlines.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </div>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {(data ?? []).map(l => (
          <div key={l.id} className="ewb-rep-row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--ewb-line)' }} data-testid="lesson-picker-item">
            <span>{lessonFull({ outlineName: nameOf(l.outlineId), levelName: l.levelName, seq: l.seq, noLabel: l.noLabel, title: l.title })}</span>
            <Btn tone="secondary" size="small" onClick={() => pick(l)}>就是这一课</Btn>
          </div>
        ))}
        {data && data.length === 0 && <p className="ewb-rep-note">没有找到，换个词试试。</p>}
      </div>
      </div>
    </Modal>
  )
}
