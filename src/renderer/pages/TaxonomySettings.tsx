import React, { useMemo, useState } from 'react'
import { App, Input, Modal, Popconfirm, Select, Space, Tree, TreeSelect } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useShowCodes } from '../hooks/useUiPrefs'
import { Btn, Glossary, Panel, UsageNote } from '../design'
import '../design/page-report.css'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Dialog = null | { kind: 'add' | 'edit' | 'move' | 'merge'; node: KpNode | null }

interface TNode { key: string; node: KpNode; children: TNode[] }

function buildTree(kps: KpNode[]): TNode[] {
  const by = new Map<string | null, KpNode[]>()
  for (const k of kps) { const p = k.parent_code ?? null; if (!by.has(p)) by.set(p, []); by.get(p)!.push(k) }
  const mk = (k: KpNode): TNode => ({ key: k.code, node: k, children: (by.get(k.code) ?? []).sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1)).map(mk) })
  return (by.get(null) ?? []).sort((a, b) => a.sort - b.sort || (a.code < b.code ? -1 : 1)).map(mk)
}
const heightOf = (t: TNode): number => 1 + (t.children.length ? Math.max(...t.children.map(heightOf)) : 0)
const flat = (ts: TNode[]): TNode[] => ts.flatMap(t => [t, ...flat(t.children)])
const descendants = (t: TNode): Set<string> => new Set(flat([t]).map(x => x.key))

/** 设置页：知识点树编辑。新增 / 改名（及改说明、引入年级）/ 移动 / 合并 / 停用 / 删除；节点 ID（代码）永远不变；内置节点只能改名和停用（可逆），不能移动、合并掉、删除。 */
export default function TaxonomySettings() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['taxonomy', 'tree', 'all'], queryFn: () => window.api.taxonomy.tree({ includeDeprecated: true }) })
  const [sel, setSel] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [dlg, setDlg] = useState<Dialog>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [grade, setGrade] = useState<number | null>(null)
  const [plain, setPlain] = useState('')
  const [exEn, setExEn] = useState('')
  const [exZh, setExZh] = useState('')
  const [hints, setHints] = useState('')
  const [showCodes] = useShowCodes()
  const [target, setTarget] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const tree = useMemo(() => buildTree(data?.kps ?? []), [data])
  const all = useMemo(() => new Map(flat(tree).map(t => [t.key, t])), [tree])
  const selected = sel ? all.get(sel) ?? null : null

  const run = async (ops: TaxonomyOpInput[], ok: string, keepOpen = false): Promise<boolean> => {
    setBusy(true)
    try {
      const r = await window.api.taxonomy.save(ops)
      message.success(ok)
      qc.invalidateQueries({ queryKey: ['taxonomy'] })
      if (r.touched[0] && ops[0].op === 'add') { setSel(r.touched[0]); const p = all.get(ops[0].parent_code ?? ''); if (p) setExpanded(e => [...new Set([...e, p.key])]) }
      if (!keepOpen) setDlg(null)
      return true
    } catch (e) { message.error(clean(e)); return false } finally { setBusy(false) }
  }

  const open = (kind: 'add' | 'edit' | 'move' | 'merge', node: KpNode | null) => {
    setDlg({ kind, node })
    setName(kind === 'edit' ? node!.name : ''); setNote(kind === 'edit' ? node!.note ?? '' : ''); setGrade(kind === 'edit' ? node!.intro_grade : null); setTarget(undefined)
    setPlain(kind === 'edit' ? node!.plain ?? '' : ''); setExEn(kind === 'edit' ? node!.example_en ?? '' : ''); setExZh(kind === 'edit' ? node!.example_zh ?? '' : ''); setHints(kind === 'edit' ? node!.hint_words ?? '' : '')
  }
  const submit = () => {
    if (!dlg) return
    const n = dlg.node
    const plainFields = { plain: plain.trim() || null, example_en: exEn.trim() || null, example_zh: exZh.trim() || null, hint_words: hints.trim() || null }
    if (dlg.kind === 'add') return run([{ op: 'add', parent_code: n ? n.code : null, name, note: note || undefined, intro_grade: grade, ...plainFields }], '已新增')
    if (dlg.kind === 'edit') return run([{ op: 'update', code: n!.code, name, note: note || null, intro_grade: grade, ...plainFields }], '已保存')
    if (dlg.kind === 'move') return run([{ op: 'move', code: n!.code, parent_code: target ?? null }], '已移动')
    if (dlg.kind === 'merge' && target) return run([{ op: 'merge', code: n!.code, into: target }], '已合并，题目标注已迁到目标知识点')
  }

  // 移动 / 合并的候选目标
  const targetTree = (kind: 'move' | 'merge', node: KpNode): Array<{ value: string; title: string; disabled?: boolean; children?: any[] }> => {
    const self = all.get(node.code)!
    const bad = descendants(self)
    const h = heightOf(self)
    const conv = (ts: TNode[]): any[] => ts.map(t => {
      const k = t.node
      const tooDeep = kind === 'move' ? k.level + h > 3 : k.level + Math.max(0, h - 1) > 3
      const disabled = bad.has(t.key) || !!k.deprecated || tooDeep
      return { value: t.key, title: showCodes ? `${k.name}（${k.code}）` : k.name, searchText: `${k.name} ${k.code}`, disabled, children: conv(t.children) }
    })
    return conv(tree)
  }

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return null
    const hit = new Set<string>()
    for (const t of flat(tree)) if (t.node.name.toLowerCase().includes(kw) || t.node.code.toLowerCase().includes(kw)) {
      hit.add(t.key); let p = t.node.parent_code; while (p) { hit.add(p); p = all.get(p)?.node.parent_code ?? null }
    }
    return hit
  }, [q, tree, all])
  const prune = (ts: TNode[]): TNode[] => ts.filter(t => !filtered || filtered.has(t.key)).map(t => ({ ...t, children: prune(t.children) }))
  const shown = prune(tree)

  const toData = (ts: TNode[]): any[] => ts.map(t => ({
    key: t.key, children: toData(t.children),
    title: (
      <span data-testid={`kp-node-${t.key}`} data-deprecated={t.node.deprecated ? '1' : '0'} data-builtin={t.node.builtin ? '1' : '0'} style={{ opacity: t.node.deprecated ? 0.5 : 1 }}>
        {t.node.name} <span className="ewb-set-kpcode">{showCodes ? t.key : (t.node.hint_words ?? '').split(/\s*\/\s*/).slice(0, 3).join(' / ')}</span>
        {!t.node.builtin && <span className="ewb-set-pill ewb-set-pill--own">自建</span>}
        {t.node.merged_into ? <span className="ewb-set-pill">已合并到 {all.get(t.node.merged_into)?.node.name ?? t.node.merged_into}</span> : t.node.deprecated ? <span className="ewb-set-pill">已停用</span> : null}
      </span>)
  }))

  const dlgTitle = dlg ? { add: dlg.node ? `在「${dlg.node.name}」下新增子节点` : '新增一级知识点', edit: `修改「${dlg.node?.name}」`, move: `移动「${dlg.node?.name}」`, merge: `把「${dlg.node?.name}」合并到别的知识点` }[dlg.kind] : ''
  const n = selected?.node ?? null
  return (
    <div className="ewb-set-panel"><Panel title="知识点（考什么）" data-testid="taxonomy-settings">
      <p className="ewb-rep-note" style={{ marginBottom: 12 }}>这棵树决定 AI 给题目标注知识点时能选哪些、也是看板统计的口径。改名、移动都不会影响已有的标注和统计。白话释义和例句会显示在审核页的选择框里，也会让 AI 的报告更好懂。内置节点只能改名或停用，不能移动、合并掉或删除。改动会让看板立即刷新，已生成的 AI 分析 / 报告会标成「已过期」。</p>
      <Space style={{ marginBottom: 8 }} wrap>
        <Input.Search data-testid="kp-search" placeholder="按名称、例词搜索" allowClear style={{ width: 220 }} value={q} onChange={e => setQ(e.target.value)} />
        <Btn tone="secondary" size="small" data-testid="kp-add-root" onClick={() => open('add', null)}>新增一级知识点</Btn>
        <Btn tone="secondary" size="small" onClick={() => setExpanded(flat(tree).filter(t => t.children.length).map(t => t.key))}>全部展开</Btn>
        <Btn tone="secondary" size="small" onClick={() => setExpanded([])}>全部收起</Btn>
      </Space>
      <div className="ewb-set-tree" data-testid="kp-tree">
        <Tree treeData={toData(shown)} selectedKeys={sel ? [sel] : []} expandedKeys={filtered ? flat(shown).map(t => t.key) : expanded} onExpand={k => setExpanded(k as string[])}
          onSelect={k => { if (k[0]) setSel(k[0] as string) }} blockNode />   {/* 再点一次已选中的节点不取消选中（antd 默认会取消，操作按钮就消失了） */}
      </div>
      {n ? (
        <div style={{ marginTop: 10 }} data-testid="kp-selected" data-code={n.code}>
          <div style={{ marginBottom: 6 }}>
            <b>{n.name}</b> {showCodes && <code style={{ fontSize: 13 }} data-testid="kp-selected-code">{n.code}</code>} · {['', '一', '二', '三'][n.level]}级{n.intro_grade ? ` · 课标一般 ${n.intro_grade} 年级开始学` : ''}
            {n.builtin ? <span className="ewb-set-pill">内置</span> : <span className="ewb-set-pill ewb-set-pill--own">自建</span>}
            {n.merged_into ? <span className="ewb-set-pill">已合并到 {all.get(n.merged_into)?.node.name ?? n.merged_into}</span> : n.deprecated ? <span className="ewb-set-pill">已停用</span> : null}
            {n.plain && <div className="ewb-set-selected-plain" data-testid="kp-selected-plain">{n.plain}</div>}
            {n.example_en && <div className="ewb-set-selected-ex" data-testid="kp-selected-example"><i>{n.example_en.replace(/\*\*/g, '')}</i> {n.example_zh}</div>}
            {n.note && <div className="ewb-set-selected-ex">{n.note}</div>}
          </div>
          <Space wrap>
            <Btn tone="secondary" size="small" data-testid="kp-add-child" disabled={n.level >= 3 || !!n.deprecated} onClick={() => open('add', n)}>新增子节点</Btn>
            <Btn tone="secondary" size="small" data-testid="kp-edit" onClick={() => open('edit', n)}>改名 / 改说明和例句</Btn>
            <Btn tone="secondary" size="small" data-testid="kp-move" disabled={!!n.builtin || !!n.deprecated} onClick={() => open('move', n)}>移动</Btn>
            <Btn tone="secondary" size="small" data-testid="kp-merge" disabled={!!n.builtin || !!n.deprecated} onClick={() => open('merge', n)}>合并到…</Btn>
            {n.merged_into ? null : n.deprecated
              ? <Btn tone="secondary" size="small" data-testid="kp-enable" onClick={() => run([{ op: 'deprecate', code: n.code, deprecated: false }], '已重新启用')}>重新启用</Btn>
              : <Popconfirm title="停用这个知识点？" description="它和它的子节点不再出现在 AI 提示词和选择器里；已有题目的标注保留，统计照常。随时可以重新启用。" okText="停用" cancelText="取消" onConfirm={() => run([{ op: 'deprecate', code: n.code, deprecated: true }], '已停用')}><Btn tone="secondary" size="small" data-testid="kp-deprecate">停用</Btn></Popconfirm>}
            <Popconfirm title="删除这个知识点？" description="只有没有子节点、没有题目标注的自建知识点才能删除。" okText="删除" cancelText="取消" disabled={!!n.builtin} onConfirm={() => run([{ op: 'delete', code: n.code }], '已删除').then(ok => ok && setSel(null))}>
              <Btn tone="danger" size="small" data-testid="kp-delete" disabled={!!n.builtin || !!n.merged_into}>删除</Btn>
            </Popconfirm>
          </Space>
          {n.builtin ? <p className="ewb-rep-note" style={{ marginTop: 6 }}>内置节点：只能改名或停用。</p> : null}
        </div>
      ) : <p className="ewb-rep-note" style={{ marginTop: 10 }}>点一个节点，可以新增子节点、改名、移动、合并或停用。</p>}

      <Modal open={!!dlg} title={dlgTitle} onCancel={() => setDlg(null)} onOk={submit} okText="确定" cancelText="取消" confirmLoading={busy} destroyOnHidden
        okButtonProps={{ 'data-testid': 'kp-modal-ok', disabled: dlg ? ((dlg.kind === 'add' || dlg.kind === 'edit') ? !name.trim() : dlg.kind === 'merge' ? !target : false) : true } as any}>
        {dlg && (dlg.kind === 'add' || dlg.kind === 'edit') && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input data-testid="kp-modal-name" placeholder="名称（不超过 30 个字）" maxLength={30} value={name} onChange={e => setName(e.target.value)} onPressEnter={submit} />
            <Input.TextArea data-testid="kp-modal-note" placeholder="说明 / 例词（一行，会写进给 AI 的知识点树里；不要用竖线「|」）" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value.replace(/[\r\n]+/g, ' '))} />
            <Input data-testid="kp-modal-plain" placeholder="白话释义：一句话说清考什么（如“表示‘谁的’”，不超过 40 字）" maxLength={40} value={plain} onChange={e => setPlain(e.target.value.replace(/[\r\n|]+/g, ' '))} />
            <Input data-testid="kp-modal-example-en" placeholder="英文例句（用 ** 标出关键词，如 This is **my** book.）" maxLength={120} value={exEn} onChange={e => setExEn(e.target.value.replace(/[\r\n|]+/g, ' '))} />
            <Input data-testid="kp-modal-example-zh" placeholder="例句的中文意思（如 这是我的书。）" maxLength={80} value={exZh} onChange={e => setExZh(e.target.value.replace(/[\r\n|]+/g, ' '))} />
            <Input data-testid="kp-modal-hints" placeholder="例词，用 / 隔开（如 my / your / his）" maxLength={60} value={hints} onChange={e => setHints(e.target.value.replace(/[\r\n|]+/g, ' '))} />
            <Select data-testid="kp-modal-grade" allowClear placeholder="课标一般几年级开始学（可不选）" style={{ width: 200 }} value={grade ?? undefined} onChange={v => setGrade(v ?? null)} options={[1, 2, 3, 4, 5, 6].map(g => ({ value: g, label: `${g} 年级` }))} />
            {dlg.kind === 'edit' && dlg.node?.builtin ? <UsageNote kind="tip">内置节点改名后，代码不变，已有标注和统计不受影响。</UsageNote> : null}
          </Space>
        )}
        {dlg && dlg.kind === 'move' && dlg.node && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <TreeSelect data-testid="kp-modal-target" style={{ width: '100%' }} placeholder="选择新的上级（不选 = 放到最上层）" allowClear showSearch treeNodeFilterProp="searchText" treeData={targetTree('move', dlg.node)}
              value={target ?? undefined} onChange={v => setTarget(v ?? null)} />
            <UsageNote kind="tip">移动只改它在树里的位置，代码不变，已有的题目标注和统计跟着走。灰色的选项不能选（自己及子节点、已停用的、会让树超过 3 层的）。</UsageNote>
          </Space>
        )}
        {dlg && dlg.kind === 'merge' && dlg.node && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <TreeSelect data-testid="kp-modal-target" style={{ width: '100%' }} placeholder="选择合并到哪个知识点" showSearch treeNodeFilterProp="searchText" treeData={targetTree('merge', dlg.node)}
              value={target ?? undefined} onChange={v => setTarget(v ?? undefined)} />
            <UsageNote kind="mistake" label="注意">{`「${dlg.node.name}」下所有题目的标注会改成目标知识点（一道题同时标了两者时只留一条）；它的子节点会挂到目标下面；它本身停用并记下去向。合并后不能撤销。`}</UsageNote>
          </Space>
        )}
      </Modal>
    </Panel></div>
  )
}
