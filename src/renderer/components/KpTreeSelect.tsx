import React, { useMemo } from 'react'
import { safeKpName } from '../../shared/code-guard'
import { TreeSelect } from 'antd'
import { useShowCodes } from '../hooks/useUiPrefs'
import '../design/page-review.css'

export interface KpTreeNode {
  value: string
  /** 下拉里的样子（中文名 + 斜体例词 + 白话）；文字版见 kpTitle */
  title: React.ReactNode
  /** 选中后在输入框里显示的文字（不带例词和白话，免得太长） */
  label: string
  /** 搜索用：名称、代码、例词、白话都能搜到 */
  searchText: string
  /** 渲染下拉选项用：中文名、前几个例词、一句白话、代码（见 KpOption） */
  name: string
  hints: string
  plain: string
  code: string
  showCode: boolean
  key: string
  children?: KpTreeNode[]
}

/** 例词里取前几个：「my / your / his / her / their」→「my / your / his」 */
export const shortHints = (hint: string | null | undefined, n = 3): string => (hint ?? '').split(/\s*\/\s*/).filter(Boolean).slice(0, n).join(' / ')

/** 下拉里一个节点显示成「中文名（例词）· 白话」；打开「显示内部代码」后末尾再加代码 */
export function kpTitle(k: Pick<KpNode, 'code' | 'name' | 'plain' | 'hint_words'>, showCodes: boolean): string {
  const hints = shortHints(k.hint_words)
  return `${safeKpName(k.name)}${hints ? `（${hints}）` : ''}${k.plain ? ` · ${k.plain}` : ''}${showCodes ? `  [${k.code}]` : ''}`
}

/**
 * 下拉里一个选项的样子：中文名（粗）+ 斜体例词 + 一句白话（次要色）。全部行内排版，文字连续：
 * 「物主代词（my / your / his） · 表示“谁的”…」；管理员打开「显示内部代码」后末尾再加 [代码]。
 */
export function KpOption({ n }: { n: Pick<KpTreeNode, 'name' | 'hints' | 'plain' | 'code' | 'showCode'> }) {
  return (
    <>
      <span className="ewb-kp-name">{safeKpName(n.name)}</span>
      {n.hints && <i className="ewb-kp-hint">（{n.hints}）</i>}
      {n.plain && <span className="ewb-kp-plain"> · {n.plain}</span>}
      {n.showCode && <span className="ewb-kp-code">  [{n.code}]</span>}
    </>
  )
}

/** 平铺的知识点 → 嵌套树 */
export function buildKpTree(kps: KpNode[], showCodes = false): KpTreeNode[] {
  const nodes = new Map<string, KpTreeNode>()
  for (const k0 of kps) { const k = { ...k0, name: safeKpName(k0.name) }; nodes.set(k.code, { value: k.code, key: k.code, title: <KpOption n={{ name: k.name, hints: shortHints(k.hint_words), plain: k.plain ?? '', code: k.code, showCode: showCodes }} />, name: k.name, hints: shortHints(k.hint_words), plain: k.plain ?? '', code: k.code, showCode: showCodes, label: showCodes ? `${k.name}（${k.code}）` : k.name, searchText: `${k.name} ${k.code} ${k.hint_words ?? ''} ${k.plain ?? ''}` }) }
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
  const [showCodes] = useShowCodes()
  return useMemo(() => buildKpTree(kps ?? [], showCodes), [kps, showCodes])
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

/** 单选知识点（主知识点、父节点选择）：下拉显示「中文名（例词）· 白话」，打字搜名称、例词、白话都行 */
export function KpSelect({ kps, value, onChange, placeholder, allowClear = true, disabled, testId }: Props) {
  const tree = useKpTree(kps)
  return (
    <TreeSelect
      data-testid={testId}
      style={{ width: '100%' }}
      showSearch
      treeNodeFilterProp="searchText"
      treeNodeLabelProp="label"
      treeData={tree}
      value={value ?? undefined}
      onChange={v => onChange((v as string | undefined) ?? null)}
      placeholder={placeholder ?? '选择知识点（可以直接打字搜，如“物主”“my”）'}
      allowClear={allowClear}
      disabled={disabled}
      styles={{ popup: { root: { maxHeight: 420, overflow: 'auto', minWidth: 420 } } }}
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

/** 多选知识点（还顺带考到的，最多 max 个） */
export function KpMultiSelect({ kps, value, onChange, max = 3, disabled }: MultiProps) {
  const tree = useKpTree(kps)
  return (
    <TreeSelect
      style={{ width: '100%' }}
      multiple
      showSearch
      treeNodeFilterProp="searchText"
      treeNodeLabelProp="label"
      treeData={tree}
      value={value}
      onChange={v => onChange((v as string[]).slice(0, max))}
      placeholder={`还顺带考到的知识点（最多 ${max} 个）`}
      maxCount={max}
      disabled={disabled}
      maxTagCount="responsive"
      styles={{ popup: { root: { maxHeight: 420, overflow: 'auto', minWidth: 420 } } }}
      popupMatchSelectWidth={false}
    />
  )
}
