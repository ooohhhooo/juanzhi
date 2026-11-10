import React, { useEffect, useState } from 'react'
import { App, Drawer, Input, Popconfirm, Segmented, Select, Switch, Table, Tabs, Tag } from 'antd'
import { FileText, Image as ImageIcon, Inbox, Trash2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Btn, EmptyState, Icon, Page } from '../../design'
import '../../design/page-report.css'
import '../../design/page-library.css'
import '../../design/page-course.css'
import { useSubject } from '../../subject/SubjectContext'
import { autoApi, asDataSubject, dataSubjectName, DATA_SUBJECTS, type DataSubject } from '../../subject/autoRoute'

type Scope = 'current' | 'all'

/** 学科标签：能直接改（英语 / 语文 / 数学 / 通用） */
function SubjectTag({ value, label, onChange }: { value: DataSubject; label: string; onChange: (s: DataSubject) => void }) {
  return (
    <Select size="small" variant="filled" value={value} style={{ width: 80 }} aria-label={`${label} 的学科`} data-testid="data-subject-tag" data-subject={value}
      options={DATA_SUBJECTS.map(v => ({ value: v, label: dataSubjectName(v) }))} onChange={v => onChange(v)} />
  )
}

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const TYPE_LABEL: Record<string, string> = { integer: '整数', real: '小数', date: '日期', datetime: '日期时间', boolean: '是否', text: '文本', select: '选项', multi: '多选' }
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

interface Progress { fileName: string; phase: string; message: string; done: number; total: number }

/** 数据页：把 Excel / CSV 导入成本机的数据集，看概况和前 100 行，标记敏感列。数据只存在这台电脑上。 */
export default function DatasetsPage() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const { subject } = useSubject()
  const [scope, setScope] = useState<Scope>('current')
  const { data: rawList = [] } = useQuery({ queryKey: ['datasets', 'list', subject], queryFn: () => window.api.datasets.list() })
  const { data: rawDocs = [] } = useQuery({ queryKey: ['datasets', 'documents', subject], queryFn: () => window.api.datasets.documents() })
  // 学科由主进程写在每一项里（缺省 = 通用）；筛选在本地做：默认只看当前学科和通用
  const subjOf = (x: object): DataSubject => asDataSubject((x as { subject?: unknown }).subject)
  const keep = (x: object) => scope === 'all' || subjOf(x) === 'general' || subjOf(x) === subject
  const list = rawList.filter(keep)
  const docs = rawDocs.filter(keep)
  const hiddenCount = rawList.length + rawDocs.length - list.length - docs.length
  const [docId, setDocId] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['datasets'] })

  useEffect(() => window.api.on('datasets:progress', (p: Progress) => setProgress(p)), [])

  const doImport = async (paths: string[]) => {
    if (!paths.length || busy) return
    setBusy(true)
    setProgress({ fileName: '', phase: 'read', message: '正在读取文件…', done: 0, total: 1 })
    try {
      const rs = await window.api.datasets.import(paths)
      const ok = rs.filter(r => r.ok).length
      if (ok) message.success(`已导入 ${ok} 个文件`)
      for (const r of rs.filter(x => !x.ok)) message.error(`${r.file}：${r.error}`, 6)
    } catch (e) { message.error(clean(e)) } finally { setBusy(false); setProgress(null); refresh() }
  }
  const pick = async () => { const paths = await window.api.datasets.pick(); await doImport(paths) }
  const drop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    ;(e.nativeEvent as unknown as { __ewbHandled?: boolean }).__ewbHandled = true
    setOver(false)
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) { try { const p = window.api.getPathForFile(f); if (p) paths.push(p) } catch { /* 忽略 */ } }
    await doImport(paths)
  }
  const changeSubj = async (kind: 'doc' | 'set', id: string, s: DataSubject) => {
    try {
      if (kind === 'doc') await autoApi().datasets.setDocumentSubject(id, s)
      else await autoApi().datasets.setDatasetSubject(id, s)
      message.success(`已改为${dataSubjectName(s)}`)
    } catch (e) { message.error(clean(e)) }
    refresh()
  }
  const removeDoc = async (id: string) => { try { await window.api.datasets.removeDocument(id); message.success('已删除'); if (docId === id) setDocId(null); refresh() } catch (e) { message.error(clean(e)) } }
  const remove = async (id: string) => { try { await window.api.datasets.remove(id); message.success('已删除'); if (openId === id) setOpenId(null); refresh() } catch (e) { message.error(clean(e)) } }

  return (
    <Page data-testid="datasets-page">
      <h1 className="ewb-rep-h1">数据</h1>
      <p className="ewb-set-lead">导入表格、图片或文档，之后可以让助手查询和分析。数据只存在这台电脑上，发给 AI 前姓名、手机号等会换成代号或去掉。</p>
      <div className="ewb-rep-row" style={{ margin: '0 0 12px', alignItems: 'center' }}>
        <Segmented value={scope} onChange={v => setScope(v as Scope)} data-testid="datasets-scope"
          options={[{ label: '当前学科和通用', value: 'current' }, { label: '全部', value: 'all' }]} />
        {scope === 'current' && hiddenCount > 0 && <span className="ewb-rep-note" data-testid="datasets-hidden">另有 {hiddenCount} 项属于其他学科，切到「全部」可以看到。</span>}
      </div>
      <div
        data-testid="datasets-drop" data-over={over ? 'true' : 'false'} className="ewb-lib-drop" role="button" tabIndex={0}
        onDrop={drop} onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(true) }} onDragLeave={e => { e.preventDefault(); setOver(false) }}
        onClick={() => void pick()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void pick() } }}>
        <div className="ewb-lib-drop__icon"><Icon as={Inbox} size={32} /></div>
        <p className="ewb-lib-drop__main">拖入文件到此处，或点击选择</p>
        <p className="ewb-lib-drop__sub">表格：.xlsx、.csv（最多 50 万行）；图片、PDF、Word（.docx）、文本：读出文字后保存</p>
      </div>
      {progress && (
        <div className="ewb-lib-progress" data-testid="datasets-progress" style={{ marginBottom: 16 }}>
          <div className="ewb-lib-progress__text">{progress.fileName ? `${progress.fileName}：` : ''}{progress.message}</div>
          <div className="ewb-thinking__rail" aria-hidden><div className="ewb-thinking__fill" style={{ transform: `scaleX(${progress.total ? Math.min(1, progress.done / progress.total) : 0})` }} /></div>
        </div>
      )}
      {list.length === 0 && docs.length === 0 && !busy && hiddenCount === 0 && <EmptyState inline title="还没有数据" description="导入后会在这里列出：表格可以查看每列的概况，文档可以查看读出的文字。" />}
      {list.length > 0 && docs.length > 0 && <h3 className="ewb-rep-h2" style={{ margin: '8px 0' }}>表格</h3>}
      <div className="ewb-crs-cards" data-testid="datasets-list">
        {list.map(d => (
          <article key={d.id} className="ewb-crs-card" data-testid={`dataset-${d.id}`} data-name={d.name}>
            <div className="ewb-crs-card__head">
              <span className="ewb-crs-card__name" data-testid="dataset-name">{d.name}</span>
              <span className="ewb-rep-row">
                <SubjectTag value={subjOf(d)} label={d.name} onChange={v => void changeSubj('set', d.id, v)} />
                <Btn tone="secondary" size="small" data-testid="dataset-open" onClick={() => setOpenId(d.id)}>查看</Btn>
                <Popconfirm title="删除这个数据集？" description="数据文件会一并删除，不能恢复。" okText="删除" cancelText="取消" onConfirm={() => void remove(d.id)}>
                  <Btn tone="danger" size="small" icon={Trash2} data-testid="dataset-remove">删除</Btn>
                </Popconfirm>
              </span>
            </div>
            <p className="ewb-rep-note" data-testid="dataset-summary">
              {d.sourceFile} · {d.tables.map(t => `${t.name} ${t.rows} 行`).join('，')} · {fmtSize(d.sizeBytes)}
              {d.tables.some(t => t.columns.some(c => c.sensitive)) && <Tag style={{ marginLeft: 8 }}>含敏感列</Tag>}
            </p>
          </article>
        ))}
      </div>
      {docs.length > 0 && (
        <>
          <h3 className="ewb-rep-h2" style={{ margin: '20px 0 8px' }}>文档资料</h3>
          <div className="ewb-crs-cards" data-testid="documents-list">
            {docs.map(d => (
              <article key={d.id} className="ewb-crs-card" data-testid="document-card" data-name={d.name}>
                <div className="ewb-crs-card__head">
                  <span className="ewb-crs-card__name">{d.kind === 'image' ? <ImageIcon size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} /> : <FileText size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />}{d.name}</span>
                  <span className="ewb-rep-row">
                    <SubjectTag value={subjOf(d)} label={d.name} onChange={v => void changeSubj('doc', d.id, v)} />
                    <Btn tone="secondary" size="small" data-testid="document-open" onClick={() => setDocId(d.id)}>查看文字</Btn>
                    <Popconfirm title="删除这份文档？" description="读出的文字会一并删除（原文件不受影响）。" okText="删除" cancelText="取消" onConfirm={() => void removeDoc(d.id)}>
                      <Btn tone="danger" size="small" icon={Trash2} data-testid="document-remove">删除</Btn>
                    </Popconfirm>
                  </span>
                </div>
                <p className="ewb-rep-note">{DOC_KIND[d.kind]} · {d.chars.toLocaleString()} 字 · {d.importedAt.slice(0, 10)}{d.note ? ` · ${d.note}` : ''}</p>
              </article>
            ))}
          </div>
        </>
      )}
      <DocumentDrawer id={docId} name={docs.find(d => d.id === docId)?.name ?? ''} onClose={() => setDocId(null)} />
      <DatasetDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
    </Page>
  )
}

const DOC_KIND: Record<string, string> = { image: '图片（识别出的文字）', pdf: 'PDF', docx: 'Word', text: '文本' }

function DocumentDrawer({ id, name, onClose }: { id: string | null; name: string; onClose: () => void }) {
  const { data: text } = useQuery({ queryKey: ['datasets', 'doctext', id], queryFn: () => window.api.datasets.documentText(id!), enabled: !!id })
  return (
    <Drawer open={!!id} onClose={onClose} width={720} title={name || '文档'} destroyOnHidden data-testid="document-drawer">
      <p className="ewb-rep-note">这是软件读出来的文字，助手分析时读的就是这些（发给 AI 前手机号、身份证号等会去掉）。</p>
      <pre data-testid="document-text" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7 }}>{text ?? ''}</pre>
    </Drawer>
  )
}

function DatasetDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { message } = App.useApp()
  const { data: d } = useQuery({ queryKey: ['datasets', 'one', id], queryFn: () => window.api.datasets.profile(id!), enabled: !!id })
  const [note, setNote] = useState('')
  useEffect(() => { setNote(d?.note ?? '') }, [d?.id, d?.note])
  const setSens = async (table: string, col: string, v: boolean) => {
    try { await window.api.datasets.setSensitive(id!, table, col, v); onChanged() } catch (e) { message.error(clean(e)) }
  }
  return (
    <Drawer open={!!id} onClose={onClose} width={860} title={d?.name ?? '数据集'} destroyOnHidden data-testid="dataset-drawer">
      {d && (
        <>
          <div className="ewb-rep-row" style={{ marginBottom: 12 }}>
            <Input value={note} placeholder="备注（可选，如数据来源、时间范围）" maxLength={200} data-testid="dataset-note" onChange={e => setNote(e.target.value)}
              onBlur={() => { if (note !== d.note) void window.api.datasets.setNote(d.id, note).then(onChanged).catch(e => message.error(clean(e))) }} />
          </div>
          <Tabs items={d.tables.map(t => ({
            key: t.name, label: `${t.name}（${t.rows} 行）`,
            children: (
              <div data-testid={`dataset-table-${t.name}`}>
                {t.notes.map(n => <p key={n} className="ewb-rep-note">{n}</p>)}
                <Table size="small" pagination={false} rowKey="name" data-testid="dataset-profile" dataSource={t.columns}
                  columns={[
                    { title: '列', dataIndex: 'label', render: (_: string, c) => <span data-testid={`dataset-col-${c.name}`}>{c.label}</span> },
                    { title: '类型', dataIndex: 'type', width: 80, render: (v: string) => TYPE_LABEL[v] ?? v },
                    { title: '空值', width: 70, render: (_: unknown, c) => pct(c.profile.nullRate) },
                    { title: '取值数', width: 80, render: (_: unknown, c) => c.profile.distinct },
                    {
                      title: '范围 / 常见取值', render: (_: unknown, c) => {
                        const p = c.profile
                        if (c.sensitive) return <span className="ewb-rep-note">敏感列，不显示</span>
                        if (typeof p.min === 'number') return `${p.min} – ${p.max}，均值 ${p.mean}`
                        if (p.min !== undefined) return `${p.min} 至 ${p.max}`
                        if (p.top?.length) return p.top.slice(0, 4).map(x => `${x.value} ${pct(x.share)}`).join('、')
                        return p.examples.join(' | ')
                      }
                    },
                    { title: '用途提示', render: (_: unknown, c) => c.profile.hints[0] ?? '' },
                    {
                      title: '敏感', width: 70, render: (_: unknown, c) => (
                        <Switch size="small" checked={c.sensitive} aria-label={`${c.label} 敏感列`} data-testid={`dataset-sens-${c.name}`} onChange={v => void setSens(t.name, c.name, v)} />
                      )
                    }
                  ]} />
                <h4 style={{ margin: '16px 0 8px' }}>前 100 行</h4>
                <Preview id={d.id} table={t.name} version={t.columns.map(c => c.sensitive).join()} />
              </div>
            )
          }))} />
        </>
      )}
    </Drawer>
  )
}

function Preview({ id, table }: { id: string; table: string; version: string }) {
  const { data } = useQuery({ queryKey: ['datasets', 'preview', id, table], queryFn: () => window.api.datasets.preview(id, table) })
  if (!data) return null
  return (
    <Table size="small" pagination={false} scroll={{ x: 'max-content', y: 360 }} data-testid="dataset-preview" rowKey="__i"
      columns={data.columns.map((c, i) => ({ title: c.label, key: c.name, render: (_: unknown, r: Record<string, unknown>) => String((r.__v as unknown[])[i] ?? ''), ellipsis: true, width: 120 }))}
      dataSource={data.rows.map((r, i) => ({ __i: i, __v: r }))} />
  )
}
