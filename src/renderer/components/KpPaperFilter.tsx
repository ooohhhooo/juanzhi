import React from 'react'
import { Segmented, TreeSelect } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useSubject } from '../subject/SubjectContext'
import { useKpTree } from './KpTreeSelect'
import { MAX_KP_CODES } from '../../shared/kp-filter'
import '../design/page-library.css'

export type KpMode = 'all' | 'any'

/** 按知识点筛卷子 / 对比用的「选知识点」多选：选父节点等于包含它下面所有子知识点；可以打字搜名称、例词、白话 */
export function KpPickMulti({ value, onChange, testId, placeholder }: { value: string[]; onChange: (codes: string[]) => void; testId?: string; placeholder?: string }) {
  const { subject } = useSubject()
  const { data: tax } = useQuery({ queryKey: ['taxonomy', subject], queryFn: () => window.api.taxonomy.tree({ subject }), staleTime: 60_000 })
  const tree = useKpTree(tax?.kps)
  return (
    <TreeSelect
      data-testid={testId}
      style={{ minWidth: 260, maxWidth: 520, flex: '1 1 260px' }}
      multiple showSearch allowClear
      treeNodeFilterProp="searchText" treeNodeLabelProp="label" treeData={tree}
      value={value} onChange={v => onChange((v as string[]).slice(0, MAX_KP_CODES))}
      placeholder={placeholder ?? '选知识点（可多选，选大类 = 包含它下面全部）'}
      maxTagCount="responsive" maxCount={MAX_KP_CODES}
      styles={{ popup: { root: { maxHeight: 420, overflow: 'auto', minWidth: 420 } } }}
      popupMatchSelectWidth={false}
    />
  )
}

/** 「都考了 / 考了其中任一个」切换（只选了一个知识点时没有区别，界面上也就不显示） */
export function KpModeSwitch({ value, onChange, testId }: { value: KpMode; onChange: (m: KpMode) => void; testId?: string }) {
  return (
    <Segmented data-testid={testId} size="small" value={value} onChange={v => onChange(v as KpMode)}
      options={[{ label: '都考了', value: 'all' }, { label: '考了其中任一个', value: 'any' }]} />
  )
}
