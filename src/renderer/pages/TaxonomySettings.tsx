import React, { useMemo, useState } from 'react'
import { Alert, App, Button, Card, Input, Modal, Popconfirm, Select, Space, Tag, Tree, TreeSelect } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'

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
  }
  const submit = () => {
    if (!dlg) return
    const n = dlg.node
    if (dlg.kind === 'add') return run([{ op: 'add', parent_code: n ? n.code : null, name, note: note || undefined, intro_grade: grade }], '已新增')
    if (dlg.kind === 'edit') return run([{ op: 'update', code: n!.code, name, note: note || null, intro_grade: grade }], '已保存')
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
      return { value: t.key, title: `${k.name}（${k.code}）`, disabled, children: conv(t.children) }
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
        {t.node.name} <span style={{ fontSize: 11, color: '#aaa' }}>{t.key}</span>
        {!t.node.builtin && <Tag color="blue" style={{ marginInlineStart: 6 }}>自建</Tag>}
        {t.node.merged_into ? <Tag style={{ marginInlineStart: 4 }}>已合并到 {all.get(t.node.merged_into)?.node.name ?? t.node.merged_into}</Tag> : t.node.deprecated ? <Tag style={{ marginInlineStart: 4 }}>已停用</Tag> : null}
      </span>)
  }))

  const dlgTitle = dlg ? { add: dlg.node ? `在「${dlg.node.name}」下新增子节点` : '新增一级知识点', edit: `修改「${dlg.node?.name}」`, move: `移动「${dlg.node?.name}」`, merge: `把「${dlg.node?.name}」合并到别的知识点` }[dlg.kind] : ''
  const n = selected?.node ?? null
  return (
    <Card title="知识点树" size="small" style={{ marginBottom: 16 }} data-testid="taxonomy-settings">
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>这棵树决定 AI 给题目标注知识点时能选哪些、也是看板统计的口径。节点的代码（ID）永远不变——改名、移动都不会影响已有的标注和统计。内置节点只能改名或停用，不能移动、合并掉或删除。改动会让看板立即刷新，已生成的 AI 分析 / 报告会标成「已过期」。</div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Input.Search data-testid="kp-search" placeholder="按名称或代码搜索" allowClear style={{ width: 220 }} value={q} onChange={e => setQ(e.target.value)} />
        <Button size="small" data-testid="kp-add-root" onClick={() => open('add', null)}>新增一级知识点</Button>
        <Button size="small" onClick={() => setExpanded(flat(tree).filter(t => t.children.length).map(t => t.key))}>全部展开</Button>
        <Button size="small" onClick={() => setExpanded([])}>全部收起</Button>
      </Space>
      <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 6 }} data-testid="kp-tree">
        <Tree treeData={toData(shown)} selectedKeys={sel ? [sel] : []} expandedKeys={filtered ? flat(shown).map(t => t.key) : expanded} onExpand={k => setExpanded(k as string[])}
          onSelect={k => { if (k[0]) setSel(k[0] as string) }} blockNode />   {/* 再点一次已选中的节点不取消选中（antd 默认会取消，操作按钮就消失了） */}
      </div>
      {n ? (
        <div style={{ marginTop: 10 }} data-testid="kp-selected" data-code={n.code}>
          <div style={{ marginBottom: 6 }}>
            <b>{n.name}</b> <code style={{ fontSize: 12 }}>{n.code}</code> · {['', '一', '二', '三'][n.level]}级{n.intro_grade ? ` · 常见引入 ${n.intro_grade} 年级` : ''}
            {n.builtin ? <Tag style={{ marginInlineStart: 6 }}>内置</Tag> : <Tag color="blue" style={{ marginInlineStart: 6 }}>自建</Tag>}
            {n.merged_into ? <Tag color="default">已合并到 {all.get(n.merged_into)?.node.name ?? n.merged_into}</Tag> : n.deprecated ? <Tag>已停用</Tag> : null}
            {n.note && <div style={{ fontSize: 12, color: '#888' }}>{n.note}</div>}
          </div>
          <Space wrap>
            <Button size="small" data-testid="kp-add-child" disabled={n.level >= 3 || !!n.deprecated} onClick={() => open('add', n)}>新增子节点</Button>
            <Button size="small" data-testid="kp-edit" onClick={() => open('edit', n)}>改名 / 改说明</Button>
            <Button size="small" data-testid="kp-move" disabled={!!n.builtin || !!n.deprecated} onClick={() => open('move', n)}>移动</Button>
            <Button size="small" data-testid="kp-merge" disabled={!!n.builtin || !!n.deprecated} onClick={() => open('merge', n)}>合并到…</Button>
            {n.merged_into ? null : n.deprecated
              ? <Button size="small" data-testid="kp-enable" onClick={() => run([{ op: 'deprecate', code: n.code, deprecated: false }], '已重新启用')}>重新启用</Button>
              : <Popconfirm title="停用这个知识点？" description="它和它的子节点不再出现在 AI 提示词和选择器里；已有题目的标注保留，统计照常。随时可以重新启用。" okText="停用" cancelText="取消" onConfirm={() => run([{ op: 'deprecate', code: n.code, deprecated: true }], '已停用')}><Button size="small" data-testid="kp-deprecate">停用</Button></Popconfirm>}
            <Popconfirm title="删除这个知识点？" description="只有没有子节点、没有题目标注的自建知识点才能删除。" okText="删除" cancelText="取消" disabled={!!n.builtin} onConfirm={() => run([{ op: 'delete', code: n.code }], '已删除').then(ok => ok && setSel(null))}>
              <Button size="small" danger data-testid="kp-delete" disabled={!!n.builtin || !!n.merged_into}>删除</Button>
            </Popconfirm>
          </Space>
          {n.builtin ? <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>内置节点：只能改名或停用。</div> : null}
        </div>
      ) : <div style={{ marginTop: 10, fontSize: 12, color: '#999' }}>点一个节点，可以新增子节点、改名、移动、合并或停用。</div>}

      <Modal open={!!dlg} title={dlgTitle} onCancel={() => setDlg(null)} onOk={submit} okText="确定" cancelText="取消" confirmLoading={busy} destroyOnHidden
        okButtonProps={{ 'data-testid': 'kp-modal-ok', disabled: dlg ? ((dlg.kind === 'add' || dlg.kind === 'edit') ? !name.trim() : dlg.kind === 'merge' ? !target : false) : true } as any}>
        {dlg && (dlg.kind === 'add' || dlg.kind === 'edit') && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input data-testid="kp-modal-name" placeholder="名称（不超过 30 个字）" maxLength={30} value={name} onChange={e => setName(e.target.value)} onPressEnter={submit} />
            <Input.TextArea data-testid="kp-modal-note" placeholder="说明 / 例词（会写进给 AI 的知识点树里）" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
            <Select data-testid="kp-modal-grade" allowClear placeholder="常见引入年级（可不选）" style={{ width: 200 }} value={grade ?? undefined} onChange={v => setGrade(v ?? null)} options={[1, 2, 3, 4, 5, 6].map(g => ({ value: g, label: `${g} 年级` }))} />
            {dlg.kind === 'edit' && dlg.node?.builtin ? <Alert type="info" showIcon message="内置节点改名后，代码不变，已有标注和统计不受影响。" /> : null}
          </Space>
        )}
        {dlg && dlg.kind === 'move' && dlg.node && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <TreeSelect data-testid="kp-modal-target" style={{ width: '100%' }} placeholder="选择新的上级（不选 = 放到最上层）" allowClear showSearch treeNodeFilterProp="title" treeData={targetTree('move', dlg.node)}
              value={target ?? undefined} onChange={v => setTarget(v ?? null)} />
            <Alert type="info" showIcon message="移动只改它在树里的位置，代码不变，已有的题目标注和统计跟着走。灰色的选项不能选（自己及子节点、已停用的、会让树超过 3 层的）。" />
          </Space>
        )}
        {dlg && dlg.kind === 'merge' && dlg.node && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <TreeSelect data-testid="kp-modal-target" style={{ width: '100%' }} placeholder="选择合并到哪个知识点" showSearch treeNodeFilterProp="title" treeData={targetTree('merge', dlg.node)}
              value={target ?? undefined} onChange={v => setTarget(v ?? undefined)} />
            <Alert type="warning" showIcon message={`「${dlg.node.name}」下所有题目的标注会改成目标知识点（一道题同时标了两者时只留一条）；它的子节点会挂到目标下面；它本身停用并记下去向。合并后不能撤销。`} />
          </Space>
        )}
      </Modal>
    </Card>
  )
}
