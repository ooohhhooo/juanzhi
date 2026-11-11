import React, { useEffect, useState } from 'react'
import { App, Checkbox, Modal, Select } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubject } from '../../subject/SubjectContext'
import { clean } from '../../components/CourseMatch'

/** 添加学校教材：从内置目录里选版本 + 年级册数（可多选），生成一份学校教材。知识点对应来自目录，不用 AI 匹配。 */
export default function TextbookAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { subject } = useSubject()
  const { data: catalog } = useQuery({ queryKey: ['course', 'catalog', subject], queryFn: () => window.api.course.catalog(subject), enabled: open })
  const [edition, setEdition] = useState<string>('')
  const [books, setBooks] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setBooks([]); setEdition('') } }, [open, subject])
  const ed = (catalog ?? []).find(e => e.id === (edition || catalog?.[0]?.id))
  const submit = async () => {
    if (!ed) return
    setBusy(true)
    try {
      const r = await window.api.course.addBuiltin({ editionId: ed.id, books })
      message.success(`已添加：${r.lessons} 个单元`)
      qc.invalidateQueries({ queryKey: ['course'] })
      onClose()
    } catch (e) { message.error(clean(e)) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onCancel={onClose} title="添加学校教材" okText="添加" cancelText="取消" destroyOnHidden data-testid="textbook-add"
      okButtonProps={{ disabled: !ed || books.length === 0, loading: busy, 'data-testid': 'textbook-add-ok' } as never} onOk={submit}>
      {catalog && catalog.length === 0 ? <p className="ewb-rep-note">这个学科暂时没有内置的教材目录。</p> : (
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            <div className="ewb-rep-note" style={{ marginBottom: 4 }}>教材版本</div>
            <Select style={{ width: '100%' }} value={ed?.id} data-testid="textbook-edition" onChange={v => { setEdition(v); setBooks([]) }}
              options={(catalog ?? []).map(e => ({ value: e.id, label: e.edition }))} />
          </label>
          <div>
            <div className="ewb-rep-note" style={{ marginBottom: 4 }}>年级和上下册（可以多选）</div>
            <Checkbox.Group value={books} onChange={v => setBooks(v as string[])} style={{ display: 'grid', gap: 6 }} data-testid="textbook-books">
              {(ed?.books ?? []).map(b => <Checkbox key={b.key} value={b.key} data-testid={`textbook-book-${b.key}`}>{b.label}（{b.units} 个单元）{b.legacy ? <span className="ewb-ana-pill ewb-ana-pill--warn" style={{ marginLeft: 6 }} title={b.note} data-testid="textbook-legacy">旧版（{b.editionYear}）</span> : b.editionYear ? <span className="ewb-ana-meta" style={{ marginLeft: 6 }}>{b.editionYear} 版</span> : null}</Checkbox>)}
            </Checkbox.Group>
          </div>
          {ed && <p className="ewb-rep-note">目录整理自公开资料（核对于 {ed.checkedAt}）；每个单元考到的知识点已经对好，不需要 AI 匹配。标“旧版”的册，新版目录还没公开，公开后会更新。</p>}
        </div>
      )}
    </Modal>
  )
}
