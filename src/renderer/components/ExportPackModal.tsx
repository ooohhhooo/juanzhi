import React, { useEffect, useState } from 'react'
import { Alert, Checkbox, Modal, Radio, Space } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { SUBJECT_LIST } from '../../shared/subject'

type Opts = Awaited<ReturnType<typeof window.api.data.exportOptions>>
export type ExportOutcome = { type: 'success' | 'error'; text: string } | null

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * 导出数据包：自己选带哪些。范围（全部 / 某个学科 / 试卷库里选中的卷子）+ 内容勾选，每项显示数量。
 * 表格里姓名、手机号等敏感列只带代号，代号对照表不带走；其他内容里的姓名按本机表格里出现过的名单换成代号（没有名单就换不了）。
 * paperIds 有值 = 从试卷库「导出选中的卷子」进来：范围固定为这几份卷子，不带报告。
 */
export default function ExportPackModal({ open, onClose, onResult, paperIds }: {
  open: boolean; onClose: () => void; onResult: (r: ExportOutcome) => void; paperIds?: string[]
}) {
  const [subject, setSubject] = useState<string>('all')
  const [sel, setSel] = useState({ papers: true, reports: true, course: true, datasets: false, documents: false, assets: false, chats: false })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const selected = !!paperIds?.length
  useEffect(() => {
    if (!open) return
    setSubject('all')
    setSel({ papers: true, reports: !selected, course: !selected, datasets: false, documents: false, assets: false, chats: false })
  }, [open, selected])
  useEffect(() => window.api.on('data:progress', (p: { op: string; phase?: string; bytes?: number; total?: number }) => {
    if (p.op === 'export') setProgress(p.phase === 'snapshot' ? '正在整理数据…' : p.phase === 'verify' ? '正在核对数据包…' : `正在写入数据包… ${p.total ? Math.round((p.bytes ?? 0) / p.total * 100) : 0}%`)
  }), [])
  const { data: o } = useQuery<Opts>({ queryKey: ['data', 'exportOptions', subject, paperIds ?? null, open], queryFn: () => window.api.data.exportOptions(subject, paperIds), enabled: open, staleTime: 0 })

  const n = (k: keyof Opts): number => (o ? (o[k] as number) : 0)
  const row = (key: keyof typeof sel, label: string, count: number | null, hint?: React.ReactNode, testid?: string) => (
    <div key={key} style={{ marginBottom: 6 }}>
      <Checkbox data-testid={`export-${testid ?? key}`} checked={sel[key] && (count === null || count > 0)} disabled={count !== null && count === 0} onChange={e => setSel(s => ({ ...s, [key]: e.target.checked }))}>
        {label}{count !== null && <span className="ewb-rep-note" data-testid={`export-count-${testid ?? key}`}>（{count}）</span>}
      </Checkbox>
      {hint && sel[key] && (count === null || count > 0) && <div className="ewb-rep-note" style={{ marginLeft: 24 }}>{hint}</div>}
    </div>
  )

  const doExport = async () => {
    setBusy(true); setProgress(''); onResult(null)
    const on = (k: keyof typeof sel, c: number | null) => sel[k] && (c === null || c > 0)
    try {
      const r = await window.api.data.exportPack({
        subject: selected ? 'all' : subject, paperIds: selected ? paperIds : undefined,
        papers: sel.papers, reports: !selected && sel.reports, course: sel.course,   // 数量为 0 也按勾选状态传：没有就是空的，不算「部分内容」
        datasets: on('datasets', n('datasets')), documents: on('documents', n('documents')), assets: on('assets', n('skills') + n('roles')), chats: on('chats', n('chats'))
      })
      if (r.saved) {
        const m = r.manifest
        const parts = [`${m?.paperCount ?? 0} 份试卷、${m?.questionCount ?? 0} 道题`]
        if (m?.counts?.reports) parts.push(`${m.counts.reports} 份报告`)
        if (m?.courseCount) parts.push(`${m.courseCount} 个课程体系`)
        if (m?.counts?.datasets) parts.push(`${m.counts.datasets} 个数据页表格（学员信息已换成代号）`)
        if (m?.counts?.documents) parts.push(`${m.counts.documents} 份数据页文档`)
        if (m?.counts?.skills) parts.push(`${m.counts.skills} 个 Skill`)
        if (m?.counts?.roles) parts.push(`${m.counts.roles} 个角色`)
        if (m?.counts?.chats) parts.push(`${m.counts.chats} 段助手对话`)
        onResult({ type: 'success', text: `已导出：${r.path}（${mb(r.bytes ?? 0)}）。带了：${parts.join('、')}。数据包里没有 API 密钥，换电脑后需要重新填写；数据页表格里只带代号。` })
        onClose()
      }
    } catch (e) { onResult({ type: 'error', text: clean(e) }); onClose() } finally { setBusy(false); setProgress('') }
  }

  return (
    <Modal open={open} title={selected ? `导出选中的 ${paperIds!.length} 份卷子` : '导出数据包'} onCancel={() => !busy && onClose()} maskClosable={false} destroyOnHidden
      okText="选择保存位置并导出" cancelText="取消" okButtonProps={{ loading: busy, 'data-testid': 'export-confirm' } as any} onOk={doExport} width={560}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        {!selected && (
          <div>
            <div style={{ marginBottom: 4 }}><b>范围</b></div>
            <Radio.Group value={subject} onChange={e => setSubject(e.target.value)} data-testid="export-subject">
              <Radio value="all" data-testid="export-subject-all">全部学科</Radio>
              {SUBJECT_LIST.map(s => <Radio key={s.id} value={s.id} data-testid={`export-subject-${s.id}`}>只导{s.name}</Radio>)}
            </Radio.Group>
          </div>
        )}
        {selected && <div className="ewb-rep-note">只导出你在试卷库里选中的这几份卷子（连同它们的题目、标注和页面图）。</div>}
        <div>
          <div style={{ marginBottom: 4 }}><b>带哪些内容</b></div>
          {row('papers', '试卷和题目（含标注、页面图）', n('papers'))}
          {!selected && row('reports', '报告', n('reports'))}
          {row('course', '课程大纲', n('courses'), undefined, 'course')}
          {row('datasets', '数据页表格', n('datasets'), <span data-testid="export-datasets-hint">只带代号，不带学员真名：姓名、手机号、编号等敏感列的值换成代号，代号对照表不会导出。</span>)}
          {row('documents', '数据页文档', n('documents'), <span data-testid="export-documents-hint">手机号、身份证号会去掉；姓名只能按数据页表格里出现过的换成代号，文档里其他地方出现的姓名认不出来，请确认文档里没有不该带走的信息。</span>)}
          {row('assets', '助手的 Skill 和角色', n('skills') + n('roles'), `${n('skills')} 个 Skill、${n('roles')} 个角色`, 'assets')}
          {row('chats', '助手对话记录', n('chats'), '对话里的姓名按表格里出现过的名单换成代号。', 'chats')}
        </div>
        {((sel.chats && n('chats') > 0) || (sel.documents && n('documents') > 0)) && n('datasetsAll') === 0 && (
          <Alert type="warning" showIcon data-testid="export-no-roster-warn" message="没有学员名单，对话 / 文档里的姓名无法自动替换，请确认里面没有学员真名。" />
        )}
        <Alert type="info" showIcon message="数据页表格里的学员真名只带代号；其他内容里的姓名，按表格里出现过的名单换成代号（报告、课程大纲、提示词不做替换）。手机号、身份证号会去掉。API 密钥、AI 服务设置、用量记录、示例数据不带。" />
        {busy && progress && <span style={{ color: 'var(--ewb-primary)' }} data-testid="pack-progress">{progress}</span>}
      </Space>
    </Modal>
  )
}
