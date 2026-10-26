import React, { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Checkbox, Descriptions, List, Modal, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { DatabaseOutlined, ExportOutlined, FolderOpenOutlined, ImportOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { requireRestart } from '../stats/restartStore'
import { useStatsFilter } from '../stats/StatsFilter'

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

type PickResult = Extract<Awaited<ReturnType<typeof window.api.data.pickPack>>, { picked: true }>

/** 设置页里和数据有关的三张卡片：数据存储（含更改数据目录）、数据包（导出 / 导入 / 备份）、示例数据 */
export default function DataSettings() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const nav = useNavigate()
  const { set: setFilter } = useStatsFilter()
  const { data: info } = useQuery({ queryKey: ['data', 'info'], queryFn: () => window.api.data.info(), staleTime: 0 })
  const { data: sample } = useQuery({ queryKey: ['data', 'sample'], queryFn: () => window.api.data.sampleStatus() })
  const [progress, setProgress] = useState('')
  useEffect(() => window.api.on('data:progress', (p: { op: string; phase?: string; bytes?: number; total?: number; entries?: number; totalEntries?: number }) => {
    if (p.op === 'export') setProgress(p.phase === 'snapshot' ? '正在整理数据库…' : p.phase === 'verify' ? '正在核对数据包…' : `正在写入数据包… ${p.total ? Math.round((p.bytes ?? 0) / p.total * 100) : 0}%`)
    else if (p.op === 'import') setProgress(p.phase === 'check' ? '正在检查数据包里的数据库…' : `正在安全解包… ${p.entries ?? 0}/${p.totalEntries ?? '?'}`)
    else if (p.op === 'move') setProgress(p.phase === 'db' ? '正在复制数据库…' : p.phase === 'backups' ? '正在复制导入前的备份…' : '正在复制试卷文件…')
  }), [])

  // ───── 更改数据目录 ─────
  const [dir, setDir] = useState<null | { token?: string; path: string; ok: boolean; kind?: 'empty' | 'existing-data'; reason?: string; existing?: { papers: number; version: number } }>(null)
  const [busyDir, setBusyDir] = useState(false)
  const chooseDir = async () => {
    try {
      const r = await window.api.data.chooseDir()
      if (r.picked) setDir(r)
    } catch (e) { message.error(clean(e)) }
  }
  const confirmDir = async () => {
    if (!dir?.ok || !dir.kind || !dir.token) return
    setBusyDir(true); setProgress('')
    try {
      const r = await window.api.data.changeDir(dir.token, dir.kind === 'empty' ? 'move' : 'use')
      setDir(null)
      if (r.restartRequired) requireRestart(r.target, r.oldDir)
    } catch (e) { setDir({ ...dir, ok: false, reason: clean(e) }) } finally { setBusyDir(false); setProgress('') }
  }
  const resetDir = async () => {
    try {
      const r = await window.api.data.resetDir()
      if (r.restartRequired) requireRestart(r.target, info?.dataDir ?? '')
    } catch (e) { message.error(clean(e)) }
  }

  // ───── 数据包 ─────
  const [exporting, setExporting] = useState(false)
  const [packMsg, setPackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const doExport = async () => {
    setExporting(true); setPackMsg(null); setProgress('')
    try {
      const r = await window.api.data.exportPack()
      if (r.saved) setPackMsg({ type: 'success', text: `已导出：${r.path}（${mb(r.bytes ?? 0)}，${r.manifest?.paperCount ?? 0} 份试卷、${r.manifest?.questionCount ?? 0} 道题）。数据包里没有 API 密钥，换电脑后需要重新填写。` })
    } catch (e) { setPackMsg({ type: 'error', text: clean(e) }) } finally { setExporting(false); setProgress('') }
  }
  const [pick, setPick] = useState<PickResult | null>(null)
  const [mode, setMode] = useState<'merge' | 'overwrite'>('merge')
  const [ack, setAck] = useState(false)
  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const doPick = async () => {
    setPicking(true); setPackMsg(null); setProgress('')
    try {
      const r = await window.api.data.pickPack()
      if (r.picked) { setPick(r); setMode('merge'); setAck(false) }
    } catch (e) { setPackMsg({ type: 'error', text: clean(e) }) } finally { setPicking(false); setProgress('') }
  }
  const cancelPick = () => { if (pick) window.api.data.discardPack(pick.token).catch(() => undefined); setPick(null) }
  const doImport = async () => {
    if (!pick) return
    setImporting(true)
    try {
      const r = await window.api.data.importPack(pick.token, mode)
      setPick(null); setReport(r)
      qc.invalidateQueries()
    } catch (e) { setPick(null); setPackMsg({ type: 'error', text: clean(e) }) } finally { setImporting(false) }
  }

  // ───── 示例数据 ─────
  const [sampleBusy, setSampleBusy] = useState(false)
  const loadSample = async () => {
    setSampleBusy(true)
    try {
      const r = await window.api.data.loadSample()
      qc.setQueryData(['data', 'sample'], { loaded: true, papers: r.papers, questions: r.questions })
      setFilter({ sample: true })
      qc.invalidateQueries({ queryKey: ['data'] }); qc.invalidateQueries({ queryKey: ['papers'] })
      message.success('示例数据已加载，看板已切到「示例数据」')
    } catch (e) { message.error(clean(e)) } finally { setSampleBusy(false) }
  }
  const clearSample = async () => {
    setSampleBusy(true)
    try {
      const r = await window.api.data.clearSample()
      qc.setQueryData(['data', 'sample'], { loaded: false, papers: 0, questions: 0 })
      setFilter({ sample: false })
      qc.invalidateQueries({ queryKey: ['data'] }); qc.invalidateQueries({ queryKey: ['papers'] })
      message.success(`已清除 ${r.papers} 份示例卷${r.reports ? `和 ${r.reports} 份基于示例数据的报告` : ''}`)
    } catch (e) { message.error(clean(e)) } finally { setSampleBusy(false) }
  }

  const s = pick?.summary
  return (
    <>
      <Card title="数据存储" size="small" style={{ marginBottom: 16 }} data-testid="data-storage">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="数据目录">
            <code style={{ fontSize: 12 }} data-testid="data-dir">{info?.dataDir}</code>
            <Button type="link" size="small" icon={<FolderOpenOutlined />} data-testid="dd-open" onClick={() => window.api.settings.openDataDir().catch(() => message.error('无法打开数据目录'))}>打开</Button>
            {info && <Tag style={{ marginLeft: 6 }}>{info.custom ? '自定义位置' : '默认位置'}</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="占用">{info ? `${info.papers} 份试卷；数据库 ${mb(info.dbBytes)}，试卷文件 ${mb(info.filesBytes)}` : '…'}</Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 6 }}>
          <Button size="small" icon={<DatabaseOutlined />} data-testid="dd-change" onClick={chooseDir}>更改数据目录…</Button>
          {info?.custom && <Popconfirm title="改回默认位置？" description={`重启后使用默认目录（${info.defaultDir}）。当前自定义目录里的数据不会被删除；如果默认目录里没有数据，会是一个空的库。`} okText="改回默认" cancelText="取消" onConfirm={resetDir}><Button size="small" data-testid="dd-reset">恢复默认位置</Button></Popconfirm>}
        </Space>
        <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>可以把数据放到别的磁盘（比如移动硬盘）。切换后需要重启才生效；原来目录里的数据不会被删除，确认新目录用得没问题后可以自己删掉。</div>
        
      </Card>

      <Card title="数据包（换电脑 / 备份）" size="small" style={{ marginBottom: 16 }} data-testid="data-pack">
        <Space wrap>
          <Button icon={<ExportOutlined />} data-testid="pack-export" loading={exporting} onClick={doExport}>导出数据包…</Button>
          <Button icon={<ImportOutlined />} data-testid="pack-import" loading={picking} onClick={doPick}>导入数据包…</Button>
          {progress && (exporting || picking) && <span style={{ fontSize: 12, color: '#1677ff' }} data-testid="pack-progress">{progress}</span>}
        </Space>
        <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>数据包（.ewb.zip）里有全部试卷、题目、标注、页面图和报告。<b>不包含 API 密钥</b>——换电脑后要在「AI 服务」里重新填写。示例数据不会进数据包。导入时可以选「合并」（保留本机已有的，只加新的）或「覆盖」（用数据包替换本机全部数据，会先自动备份）。</div>
        {packMsg && <Alert data-testid={packMsg.type === 'error' ? 'pack-error' : 'pack-done'} style={{ marginTop: 8 }} type={packMsg.type} showIcon message={packMsg.text} closable onClose={() => setPackMsg(null)} />}
        {info && info.backups.length > 0 && (
          <div style={{ marginTop: 10 }} data-testid="backup-list">
            <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>覆盖导入前的自动备份（只保留最近 2 份；备份里有当时的数据库和试卷文件）：</div>
            <List size="small" dataSource={info.backups} renderItem={b => (
              <List.Item data-testid={`backup-${b.name}`} actions={[
                <a key="o" onClick={() => window.api.data.openBackup(b.name).catch(() => undefined)}>打开</a>,
                <Popconfirm key="d" title="删除这份备份？" okText="删除" cancelText="取消" onConfirm={async () => { await window.api.data.deleteBackup(b.name); qc.invalidateQueries({ queryKey: ['data'] }) }}><a data-testid={`backup-delete-${b.name}`}>删除</a></Popconfirm>]}>
                <span style={{ fontSize: 12 }}>{b.name.replace('pre-import-', '')} · {mb(b.bytes)} · <code style={{ wordBreak: 'break-all' }} data-testid={`backup-path-${b.name}`}>{b.dir}</code></span>
              </List.Item>)} />
          </div>
        )}
      </Card>

      <Card title="示例数据" size="small" style={{ marginBottom: 16 }} data-testid="data-sample">
        <div style={{ fontSize: 13 }} data-testid="sample-status">{sample?.loaded ? `已加载：${sample.papers} 份合成示例卷、${sample.questions} 道题。` : '还没有加载。'}内置 12 份合成的小学英语试卷（四、五年级 × 3 个学年），带知识点标注，加载后看板里就有内容。</div>
        <div style={{ fontSize: 12, color: '#888', margin: '4px 0 8px' }}>示例数据和你的真实数据分开统计、互不混淆：看板里要切到「示例数据」才看得到；导出数据包时也不会带上它。随时可以一键清除。</div>
        <Space>
          <Button data-testid="sample-load" loading={sampleBusy} disabled={sample?.loaded} onClick={loadSample}>加载示例数据</Button>
          <Popconfirm title="清除全部示例数据？" description="示例卷、它们的页面图，以及基于示例数据生成的报告都会删除；你的真实数据不受影响。" okText="清除" cancelText="取消" disabled={!sample?.loaded} onConfirm={clearSample}>
            <Button data-testid="sample-clear" danger disabled={!sample?.loaded || sampleBusy}>清除示例数据</Button>
          </Popconfirm>
          {sample?.loaded && <a onClick={() => nav('/overview')}>去看板</a>}
        </Space>
      </Card>

      <Modal open={!!dir} title="更改数据目录" onCancel={() => !busyDir && setDir(null)} maskClosable={false} destroyOnHidden
        okText={dir?.kind === 'existing-data' ? '使用这个数据目录' : '复制数据并切换'} cancelText="取消" okButtonProps={{ disabled: !dir?.ok, loading: busyDir, 'data-testid': 'dd-confirm' } as any}
        onOk={confirmDir}>
        {dir && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>选择的文件夹：<code data-testid="dd-path" style={{ wordBreak: 'break-all' }}>{dir.path}</code></div>
            {!dir.ok
              ? <Alert data-testid="dd-error" type="error" showIcon message={dir.reason} />
              : dir.kind === 'existing-data'
                ? <Alert data-testid="dd-kind" type="info" showIcon message={`这个文件夹里已经有数据（${dir.existing?.papers ?? 0} 份试卷，数据库 v${dir.existing?.version}）`} description="将直接使用它。当前目录里的数据不会合并过去，也不会被删除。" />
                : <Alert data-testid="dd-kind" type="info" showIcon message="这是一个空文件夹" description="会把现有的数据库、全部试卷文件和导入前的备份复制过去，核对无误后记下新位置；原来目录里的数据保持不动。重启后生效。" />}
            {busyDir && progress && <span style={{ color: '#1677ff' }}>{progress}</span>}
          </Space>
        )}
      </Modal>

      <Modal open={!!pick} title="导入数据包" onCancel={() => !importing && cancelPick()} maskClosable={false} destroyOnHidden width={640}
        okText="开始导入" cancelText="取消" okButtonProps={{ disabled: mode === 'overwrite' && !ack, loading: importing, danger: mode === 'overwrite', 'data-testid': 'pack-confirm' } as any}
        onOk={doImport}>
        {pick && s && (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Descriptions size="small" column={1} bordered data-testid="pack-summary">
              <Descriptions.Item label="数据包">{pick.fileName}</Descriptions.Item>
              <Descriptions.Item label="导出时间 / 版本">{pick.manifest.exportedAt.replace('T', ' ').slice(0, 19)} · 软件 {pick.manifest.appVersion} · 数据库 v{pick.info.originalVersion}{pick.info.migrated ? '（旧版本，导入时自动升级）' : ''}</Descriptions.Item>
              <Descriptions.Item label="内容">{s.papersInPack} 份试卷、{s.questionsInPack} 道题、{s.pagesInPack} 页{s.customKps ? `、${s.customKps} 个自建知识点` : ''}</Descriptions.Item>
              <Descriptions.Item label="和本机比较">本机现有 {s.livePapers} 份真实试卷；数据包里有 <b>{s.papersExisting}</b> 份本机已经有了（同一条记录），<b>{s.papersNew}</b> 份是新的{s.sameFileAsExisting ? `（其中 ${s.sameFileAsExisting} 份和本机另一份是同一个文件，统计时只算一份）` : ''}</Descriptions.Item>
            </Descriptions>
            {s.samplesIgnored > 0 && <Alert type="info" showIcon message={`数据包里有 ${s.samplesIgnored} 份示例试卷，会被忽略`} />}
            {s.missingPageImages > 0 && <Alert type="warning" showIcon message={`有 ${s.missingPageImages} 页的页面图在数据包里找不到，对应的截图会显示为空`} />}
            <Radio.Group value={mode} onChange={e => { setMode(e.target.value); setAck(false) }} data-testid="pack-mode">
              <Space direction="vertical">
                <Radio value="merge" data-testid="pack-mode-merge"><b>合并</b>（推荐）：保留本机现有的全部数据，只加入数据包里本机还没有的 {s.papersNew} 份试卷；同一份卷子不会重复。</Radio>
                <Radio value="overwrite" data-testid="pack-mode-overwrite"><b>覆盖</b>：用数据包替换本机现有的全部数据（试卷、题目、标注、知识点树、报告）。会先自动备份当前数据，出错会自动恢复。</Radio>
              </Space>
            </Radio.Group>
            {mode === 'overwrite' && (
              <Alert type="warning" showIcon message={`覆盖会替换本机现有的 ${s.livePapers} 份试卷和所有标注`} description={<Checkbox data-testid="pack-ack" checked={ack} onChange={e => setAck(e.target.checked)}>我知道了：现有数据会先备份到数据目录下的 backups 文件夹，然后被数据包替换</Checkbox>} />
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>数据包按不可信的文件处理：文件名、大小、数据库内容都做了校验，数据包里的任何程序性内容（触发器、视图）都不会进入你的数据库。</Typography.Text>
          </Space>
        )}
      </Modal>

      <Modal open={!!report} title="导入完成" footer={<Button type="primary" data-testid="pack-result-ok" onClick={() => setReport(null)}>知道了</Button>} onCancel={() => setReport(null)} destroyOnHidden>
        {report && (
          <Space direction="vertical" size={6} data-testid="pack-result">
            <div data-testid="pack-result-text">{report.mode === 'merge' ? '合并' : '覆盖'}导入完成：新增 {report.papersAdded} 份试卷、{report.questionsAdded} 道题{report.mode === 'merge' ? `；跳过 ${report.papersSkipped} 份已存在的` : ''}{report.kpsAdded ? `；知识点树新增 ${report.kpsAdded} 个` : ''}{report.kpsRemapped ? `（其中 ${report.kpsRemapped} 个因编号撞车换了新编号，题目标注已跟着换）` : ''}{report.reportsAdded ? `；报告 ${report.reportsAdded} 份` : ''}。</div>
            {report.sameFileAsExisting > 0 && <Alert type="info" showIcon message={`${report.sameFileAsExisting} 份和本机另一份是同一个文件：已标为重复，统计时只算一份`} />}
            {report.promptsImported > 0 && <Alert data-testid="pack-prompts-note" type="info" showIcon message={`导入了 ${report.promptsImported} 条自定义提示词，之后的 AI 分析和报告会按它们来写；想恢复默认，到「设置 → 提示词」里逐条恢复。`} />}
            {report.promptsKeptLocal > 0 && <Alert data-testid="pack-prompts-kept" type="info" showIcon message={`数据包里有 ${report.promptsKeptLocal} 条自定义提示词，本机已经有自己的设置，保持不变（没有覆盖）。`} />}
            {report.warnings.map((w, i) => <Alert key={i} type="warning" showIcon message={w} />)}
            {report.backup && <div style={{ fontSize: 12, color: '#666' }}>导入前的数据已备份到：<code style={{ wordBreak: 'break-all' }}>{report.backup.dir}</code>（{mb(report.backup.bytes)}）</div>}
          </Space>
        )}
      </Modal>
    </>
  )
}
