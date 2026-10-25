import React, { useMemo } from 'react'
import { TreeSelect } from 'antd'

export interface KpTreeNode {
  value: string
  title: string
  key: string
  children?: KpTreeNode[]
}

/** 平铺的知识点 → 嵌套树。title 带上代码，方便按代码或名称搜索 */
export function buildKpTree(kps: KpNode[]): KpTreeNode[] {
  const nodes = new Map<string, KpTreeNode>()
  for (const k of kps) nodes.set(k.code, { value: k.code, key: k.code, title: `${k.name}（${k.code}）` })
  const roots: KpTreeNode[] = []
  for (const k of kps) {
    const n = nodes.get(k.code)!
    const parent = k.parent_code ? nodes.get(k.parent_code) : undefined
    if (parent) (parent.children ??= []).push(n)
    else roots.push(n)
  }
  return roots
}

export function useKpTree(kps: KpNode[] | undefined) {
  return useMemo(() => buildKpTree(kps ?? []), [kps])
}

interface Props {
  kps: KpNode[] | undefined
  value?: string | null
  onChange: (code: string | null) => void
  placeholder?: string
  allowClear?: boolean
  disabled?: boolean
  testId?: string
}

/** 单选知识点（主知识点、父节点选择） */
export function KpSelect({ kps, value, onChange, placeholder, allowClear = true, disabled, testId }: Props) {
  const tree = useKpTree(kps)
  return (
    <TreeSelect
      data-testid={testId}
      style={{ width: '100%' }}
      showSearch
      treeNodeFilterProp="title"
      treeData={tree}
      value={value ?? undefined}
      onChange={v => onChange((v as string | undefined) ?? null)}
      placeholder={placeholder ?? '选择知识点'}
      allowClear={allowClear}
      disabled={disabled}
      treeDefaultExpandedKeys={value ? undefined : undefined}
      styles={{ popup: { root: { maxHeight: 420, overflow: 'auto' } } }}
      popupMatchSelectWidth={false}
    />
  )
}

interface MultiProps {
  kps: KpNode[] | undefined
  value: string[]
  onChange: (codes: string[]) => void
  max?: number
  disabled?: boolean
}

/** 多选知识点（次知识点，最多 max 个） */
export function KpMultiSelect({ kps, value, onChange, max = 3, disabled }: MultiProps) {
  const tree = useKpTree(kps)
  return (
    <TreeSelect
      style={{ width: '100%' }}
      multiple
      showSearch
      treeNodeFilterProp="title"
      treeData={tree}
      value={value}
      onChange={v => onChange((v as string[]).slice(0, max))}
      placeholder={`次知识点（最多 ${max} 个）`}
      maxCount={max}
      disabled={disabled}
      maxTagCount="responsive"
      styles={{ popup: { root: { maxHeight: 420, overflow: 'auto' } } }}
      popupMatchSelectWidth={false}
    />
  )
}
