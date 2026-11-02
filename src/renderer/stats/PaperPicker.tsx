import React, { useMemo, useState } from 'react'
import { Select } from 'antd'
import { Btn, ScopeField } from '../design'
import { MAX_SCOPE_PAPERS } from '../../shared/library-select'
import { pickerMatches, pickerOptions } from '../../shared/paper-picker'
import type { PickerPaper } from '../../shared/paper-picker'
import { useStatsFilter } from './StatsFilter'

/**
 * 筛选栏的「试卷」多选下拉：选了就等于试卷库里「只统计选中的」（selectPapers），清空 = 回到之前的维度筛选（clearSelection）。
 * 没选卷子时，年级 / 学期等筛选会缩小下拉里的可选范围；选项规则见 shared/paper-picker.ts。
 */
export default function PaperPicker({ papers }: { papers: Paper[] }) {
  const { filter, selectPapers, clearSelection } = useStatsFilter()
  const [query, setQuery] = useState('')
  const selected = filter.paperIds ?? []
  const options = useMemo(
    () => pickerOptions(papers as unknown as PickerPaper[], filter, !filter.paperIds),
    [papers, filter]
  )
  const shown = useMemo(() => options.filter(o => pickerMatches(o, query)), [options, query])
  // 选中的卷子如果已经不在可选范围里（比如状态变了），也要有个名字，不能显示成一串 id
  const allOptions = useMemo(() => {
    const have = new Set(options.map(o => o.value))
    const inShown = new Set(shown.map(o => o.value))
    // 已选的永远留在列表里（哪怕被搜索词筛掉了），不然标签会显示成一串 id
    const keep = options.filter(o => selected.includes(o.value) && !inShown.has(o.value))
    return [...shown, ...keep, ...selected.filter(id => !have.has(id)).map(id => ({ value: id, label: '（这份试卷现在不计入统计）', status: '', search: '' }))]
  }, [options, shown, selected])
  const capped = (ids: string[]) => ids.slice(0, MAX_SCOPE_PAPERS)

  const change = (ids: string[]) => {
    if (ids.length === 0) { if (filter.paperIds) clearSelection(); return }
    selectPapers(capped(ids), !!filter.sample)
  }

  return (
    <ScopeField label="试卷">
      <Select
        mode="multiple" data-testid="filter-papers" placeholder={options.length ? '全部（可多选）' : '没有可选的试卷'}
        style={{ width: 280 }} value={selected} maxTagCount="responsive" maxTagTextLength={7} allowClear showSearch={{ onSearch: setQuery, filterOption: false }}
        options={allOptions}
        optionRender={o => <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{o.label}</span><span style={{ opacity: 0.6, fontSize: 12 }}>{(o.data as { status: string }).status}</span></span>}
        popupMatchSelectWidth={false} onChange={change} onOpenChange={open => { if (!open) setQuery('') }}
        notFoundContent="没有符合的试卷"
        popupRender={menu => (
          <>
            <div style={{ display: 'flex', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--ewb-line)' }}>
              <Btn tone="quiet" size="small" data-testid="picker-all" disabled={shown.length === 0} onClick={() => change(shown.map(o => o.value))}>选中当前列表全部（{Math.min(shown.length, MAX_SCOPE_PAPERS)}）</Btn>
              <Btn tone="quiet" size="small" data-testid="picker-clear" disabled={selected.length === 0} onClick={() => change([])}>清空</Btn>
            </div>
            {menu}
          </>
        )}
      />
    </ScopeField>
  )
}
